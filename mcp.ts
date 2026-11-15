// mcp.ts: the Model Context Protocol endpoint — Streamable HTTP, JSON-RPC 2.0. Speaks the modern
// revision (server/discover, no handshake) and the legacy initialize handshake. The six tools act
// on the same store as REST and GraphQL; tool results carry the REST-shaped objects both as text
// and as structured content.

import { branchTip, pullMergeState, squashMerge, type Forge, type Issue, type Pull, type Repo } from './store.ts';
import { issueObject, pullObject, repoObject } from './rest.ts';
import type { HttpResult } from './gitserver.ts';

const SERVER_INFO = { name: 'github-core-clone', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  required: string[];
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name of the repository.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Get a repository by its owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by its number (squash merge).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
    required: ['owner', 'repo', 'pull_number'],
  },
];

const TOOLS_LIST_JSON = JSON.stringify({
  tools: TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
});

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function toolSuccess(payload: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: false,
  };
}

function toolFailure(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value : '';
}

function runTool(forge: Forge, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const repoOf = (): Repo | null => forge.repo(stringArg(args, 'owner'), stringArg(args, 'repo'));
  switch (name) {
    case 'create_repo': {
      const repoName = stringArg(args, 'name');
      if (forge.repos.has(repoName)) return toolFailure(`Repository ${repoName} already exists.`);
      const repo = forge.createRepo(repoName, stringArg(args, 'description'), args.private === true);
      return toolSuccess(repoObject(forge, repo));
    }
    case 'get_repo': {
      const repo = repoOf();
      if (repo === null) return toolFailure('Repository not found.');
      return toolSuccess(repoObject(forge, repo));
    }
    case 'create_issue': {
      const repo = repoOf();
      if (repo === null) return toolFailure('Repository not found.');
      forge.tick();
      const issue: Issue = {
        globalId: forge.allocGlobalId(),
        number: repo.nextNumber,
        title: stringArg(args, 'title'),
        body: stringArg(args, 'body'),
        state: 'open',
        labels: [],
        comments: [],
        createdSeq: forge.sequence(),
      };
      repo.nextNumber += 1;
      repo.issues.set(issue.number, issue);
      return toolSuccess(issueObject(forge, repo, issue));
    }
    case 'list_issues': {
      const repo = repoOf();
      if (repo === null) return toolFailure('Repository not found.');
      const state = stringArg(args, 'state');
      let issues = [...repo.issues.values()].sort((a, b) => a.number - b.number);
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      return toolSuccess(issues.map((issue) => issueObject(forge, repo, issue)));
    }
    case 'create_pull_request': {
      const repo = repoOf();
      if (repo === null) return toolFailure('Repository not found.');
      const head = stringArg(args, 'head');
      const base = stringArg(args, 'base');
      if (branchTip(repo, base) === null) return toolFailure(`Base branch '${base}' does not exist.`);
      if (branchTip(repo, head) === null) return toolFailure(`Head branch '${head}' does not exist.`);
      forge.tick();
      const pull: Pull = {
        globalId: forge.allocGlobalId(),
        number: repo.nextNumber,
        title: stringArg(args, 'title'),
        body: stringArg(args, 'body'),
        headRef: head,
        baseRef: base,
        state: 'open',
        merged: false,
        mergeCommitSha: null,
        mergedSeq: null,
        createdSeq: forge.sequence(),
      };
      repo.nextNumber += 1;
      repo.pulls.set(pull.number, pull);
      return toolSuccess(pullObject(forge, repo, pull));
    }
    case 'merge_pull_request': {
      const repo = repoOf();
      if (repo === null) return toolFailure('Repository not found.');
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
      if (pull === undefined) return toolFailure(`Pull request #${String(args.pull_number)} not found.`);
      if (!pullMergeState(repo, pull).mergeable) return toolFailure('Pull request is not mergeable.');
      const sha = squashMerge(forge, repo, pull);
      if (sha === null) return toolFailure('Pull request is not mergeable.');
      return toolSuccess(pullObject(forge, repo, pull));
    }
    default:
      return toolFailure(`Unknown tool: ${name}`);
  }
}

function handleOne(forge: Forge, message: Record<string, unknown>): Record<string, unknown> | null {
  const method = typeof message.method === 'string' ? message.method : '';
  const id = message.id;
  const isNotification = id === undefined || method.startsWith('notifications/');
  if (method.startsWith('notifications/')) return null;
  const params = (typeof message.params === 'object' && message.params !== null ? message.params : {}) as Record<string, unknown>;
  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        resultType: 'complete',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
      return rpcResult(id, {
        protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, JSON.parse(TOOLS_LIST_JSON) as unknown);
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const tool = TOOLS.find((candidate) => candidate.name === toolName);
      if (tool === undefined) return rpcError(id, -32602, `Unknown tool: ${toolName}`);
      const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
      for (const required of tool.required) {
        if (args[required] === undefined || args[required] === null || args[required] === '') {
          return rpcError(id, -32602, `Missing required argument: ${required}`);
        }
      }
      try {
        return rpcResult(id, runTool(forge, toolName, args));
      } catch (error) {
        return rpcResult(id, toolFailure(error instanceof Error ? error.message : 'Tool failed'));
      }
    }
    default:
      if (isNotification) return null;
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

export function handleMcp(forge: Forge, method: string, bodyText: string): HttpResult {
  const jsonHeaders = { 'content-type': 'application/json; charset=utf-8' };
  if (method === 'DELETE') return { status: 204, body: Buffer.alloc(0), contentType: 'application/json' };
  if (method !== 'POST') {
    return { status: 405, body: Buffer.from(`${JSON.stringify({ message: 'Method Not Allowed' })}\n`, 'utf8'), contentType: 'application/json; charset=utf-8' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    const errorBody = JSON.stringify(rpcError(null, -32700, 'Parse error'));
    return { status: 400, body: Buffer.from(`${errorBody}\n`, 'utf8'), contentType: 'application/json; charset=utf-8', headers: jsonHeaders };
  }
  if (Array.isArray(parsed)) {
    const responses: Array<Record<string, unknown>> = [];
    for (const entry of parsed) {
      if (typeof entry !== 'object' || entry === null) continue;
      const response = handleOne(forge, entry as Record<string, unknown>);
      if (response !== null) responses.push(response);
    }
    if (responses.length === 0) return { status: 202, body: Buffer.alloc(0), contentType: 'application/json' };
    return { status: 200, body: Buffer.from(`${JSON.stringify(responses)}\n`, 'utf8'), contentType: 'application/json; charset=utf-8' };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    const errorBody = JSON.stringify(rpcError(null, -32600, 'Invalid request'));
    return { status: 400, body: Buffer.from(`${errorBody}\n`, 'utf8'), contentType: 'application/json; charset=utf-8' };
  }
  const response = handleOne(forge, parsed as Record<string, unknown>);
  if (response === null) return { status: 202, body: Buffer.alloc(0), contentType: 'application/json' };
  return { status: 200, body: Buffer.from(`${JSON.stringify(response)}\n`, 'utf8'), contentType: 'application/json; charset=utf-8' };
}
