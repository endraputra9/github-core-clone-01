// app.ts: the HTTP front door — one server, four surfaces over one Forge store. Routing, the
// bearer-token gate (every surface but /healthz), request ids for the REST surface, JSON body
// parsing for REST, and a hard guarantee that a handler error becomes a 500, never a dead process.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './store.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack, type HttpResult } from './gitserver.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 256 * 1024 * 1024;

function send(res: ServerResponse, result: HttpResult): void {
  const headers: Record<string, string> = {
    'content-type': result.contentType,
    'content-length': String(result.body.length),
    ...(result.headers ?? {}),
  };
  res.writeHead(result.status, headers);
  res.end(result.body);
}

function jsonResult(status: number, value: unknown): HttpResult {
  return { status, body: Buffer.from(`${JSON.stringify(value)}\n`, 'utf8'), contentType: JSON_TYPE };
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function createApp(): Server {
  const forge = new Forge();
  const expectedToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  let requestCounter = 0;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async (): Promise<void> => {
      try {
        const url = new URL(req.url ?? '/', 'http://entry');
        const pathname = url.pathname;
        const method = req.method ?? 'GET';

        if (method === 'GET' && pathname === '/healthz') {
          send(res, jsonResult(200, { ok: true }));
          return;
        }

        const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);

        // The token gate: everything but the boot probe needs the suite's bearer token.
        if (expectedToken !== '') {
          const header = req.headers.authorization ?? '';
          if (header !== `Bearer ${expectedToken}`) {
            if (pathname.startsWith('/api/v3')) {
              const result = jsonResult(401, { message: 'Bad credentials' });
              result.headers = { 'x-github-request-id': `req-${++requestCounter}` };
              send(res, result);
            } else if (pathname === '/api/graphql') {
              send(res, jsonResult(401, { errors: [{ message: 'Bad credentials' }] }));
            } else {
              send(res, jsonResult(401, { message: 'Bad credentials' }));
            }
            return;
          }
        }

        if (pathname === '/mcp') {
          send(res, handleMcp(forge, method, body.toString('utf8')));
          return;
        }

        if (pathname === '/api/graphql') {
          if (method !== 'POST') {
            send(res, jsonResult(404, { message: 'Not Found' }));
            return;
          }
          send(res, handleGraphQL(forge, body.toString('utf8')));
          return;
        }

        if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
          let parsedBody: unknown = undefined;
          if (body.length > 0) {
            try {
              parsedBody = JSON.parse(body.toString('utf8'));
            } catch {
              const result = jsonResult(400, { message: 'Problems parsing JSON' });
              result.headers = { 'x-github-request-id': `req-${++requestCounter}` };
              send(res, result);
              return;
            }
          }
          const segments = pathname.split('/').filter((segment) => segment !== '').slice(2).map(decodeSegment);
          const result = handleRest(forge, {
            method,
            segments,
            pathname,
            query: url.searchParams,
            body: parsedBody,
            host: req.headers.host ?? 'localhost',
          });
          result.headers = { ...(result.headers ?? {}), 'x-github-request-id': `req-${++requestCounter}` };
          send(res, result);
          return;
        }

        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(pathname);
        if (gitMatch !== null) {
          const owner = decodeSegment(gitMatch[1]!);
          const repoName = decodeSegment(gitMatch[2]!);
          const route = gitMatch[3]!;
          const repo = forge.repo(owner, repoName);
          if (route === 'info/refs' && method === 'GET') {
            send(res, handleInfoRefs(repo, url.searchParams.get('service'), req.headers['git-protocol'] ?? null));
            return;
          }
          if (route === 'git-upload-pack' && method === 'POST') {
            send(res, handleUploadPack(repo, body, req.headers['git-protocol'] ?? null));
            return;
          }
          if (route === 'git-receive-pack' && method === 'POST') {
            send(res, handleReceivePack(repo, body));
            return;
          }
          send(res, jsonResult(404, { message: 'Not Found' }));
          return;
        }

        send(res, jsonResult(404, { message: 'Not Found' }));
      } catch {
        try {
          send(res, jsonResult(500, { message: 'Internal Server Error' }));
        } catch {
          // The socket is already gone; the process lives on.
        }
      }
    })();
  });
  server.keepAliveTimeout = 120_000;
  server.headersTimeout = 130_000;
  return server;
}
