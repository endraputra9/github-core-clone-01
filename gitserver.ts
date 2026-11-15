// gitserver.ts: git smart HTTP — info/refs advertisements (v0 and protocol v2), ls-refs, fetch
// (v2 sections and the v0 fallback) and receive-pack with report-status. The pack protocol is
// implemented in-process over the repository's own object store; there is no git binary.

import { createHash } from 'node:crypto';
import {
  PKT_FLUSH,
  ZERO_OID,
  closureOf,
  depthClosure,
  isAncestor,
  isOid,
  parseCommit,
  parsePktLines,
  peelTag,
  pktLine,
  readPack,
  writePack,
  type GitObject,
} from './git.ts';
import { headRef, type Repo } from './store.ts';

export interface HttpResult {
  status: number;
  body: Buffer;
  contentType: string;
  headers?: Record<string, string>;
}

const AGENT = 'forge/1.0.0';
const UPLOAD_CAPS_V0 = `multi_ack_detailed side-band-64k thin-pack ofs-delta shallow deepen-since deepen-not agent=${AGENT}`;
const RECEIVE_CAPS = `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;

function json(status: number, value: unknown): HttpResult {
  return { status, body: Buffer.from(`${JSON.stringify(value)}\n`, 'utf8'), contentType: 'application/json; charset=utf-8' };
}

function notFound(): HttpResult {
  return json(404, { message: 'Not Found' });
}

/** Sorted ref entries, with peeled oids for annotated tags. */
function refLines(repo: Repo): Array<{ name: string; oid: string; peeled: string | null }> {
  const names = [...repo.refs.keys()].sort();
  const out: Array<{ name: string; oid: string; peeled: string | null }> = [];
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const obj = repo.objects.get(oid);
    let peeled: string | null = null;
    if (obj !== undefined && obj.type === 'tag') peeled = peelTag(repo.objects, oid);
    out.push({ name, oid, peeled });
  }
  return out;
}

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? `${UPLOAD_CAPS_V0} symref=HEAD:${headRef(repo)}` : RECEIVE_CAPS;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = refLines(repo);
  const headOid = repo.refs.get(headRef(repo));
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}`));
  } else {
    parts.push(pktLine(`${headOid ?? ZERO_OID} HEAD\0${caps}`));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}`));
      if (ref.peeled !== null) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}`));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  const parts: Buffer[] = [
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow\n'),
    pktLine('object-format=sha1\n'),
    PKT_FLUSH,
  ];
  return Buffer.concat(parts);
}

export function handleInfoRefs(repo: Repo | null, service: string | null, protocolHeader: string | null): HttpResult {
  if (repo === null) return notFound();
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') return json(400, { message: 'unknown service' });
  if (service === 'git-upload-pack' && protocolHeader !== null && /(^|,)version=2/.test(protocolHeader)) {
    return { status: 200, body: v2Advertisement(), contentType: 'application/x-git-upload-pack-advertisement' };
  }
  return {
    status: 200,
    body: v0Advertisement(repo, service),
    contentType: `application/x-${service}-advertisement`,
  };
}

// ---------------------------------------------------------------- request parsing

interface ParsedRequest {
  command: string;
  capabilities: string[];
  args: string[];
  rest: Buffer;
}

/** Parse a v2 command request: command line, capability lines, delim, argument lines, flush. */
function parseV2Request(body: Buffer): ParsedRequest {
  const { packets, end } = parsePktLines(body);
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') {
      lines.push('\u0001');
      continue;
    }
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  const commandLine = lines[0] ?? '';
  const command = commandLine.startsWith('command=') ? commandLine.slice('command='.length) : '';
  const delimIndex = lines.indexOf('\u0001');
  const capabilities = delimIndex >= 0 ? lines.slice(1, delimIndex) : lines.slice(1);
  const args = delimIndex >= 0 ? lines.slice(delimIndex + 1) : [];
  return { command, capabilities, args, rest: body.subarray(end) };
}

// ---------------------------------------------------------------- ls-refs

function handleLsRefs(repo: Repo, args: string[]): HttpResult {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const target = headRef(repo);
  const headOid = repo.refs.get(target);
  if (matches('HEAD')) {
    if (headOid !== undefined) {
      parts.push(pktLine(`${headOid} HEAD${symrefs ? ` symref-target:${target}` : ''}\n`));
    } else if (unborn) {
      parts.push(pktLine(`unborn HEAD${symrefs ? ` symref-target:${target}` : ''}\n`));
    }
  }
  for (const ref of refLines(repo)) {
    if (!matches(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel && ref.peeled !== null) line += ` peeled:${ref.peeled}`;
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  return { status: 200, body: Buffer.concat(parts), contentType: 'application/x-git-upload-pack-result' };
}

// ---------------------------------------------------------------- fetch

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | null;
  deepenSince: number | null;
  deepenNot: string[];
  done: boolean;
}

function parseFetchArgs(args: string[]): FetchArgs {
  const out: FetchArgs = { wants: [], haves: [], shallow: [], deepen: null, deepenSince: null, deepenNot: [], done: false };
  for (const arg of args) {
    if (arg.startsWith('want ')) out.wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) out.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) out.shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) out.deepen = Number(arg.slice(7).trim());
    else if (arg.startsWith('deepen-since ')) out.deepenSince = Number(arg.slice(13).trim());
    else if (arg.startsWith('deepen-not ')) out.deepenNot.push(arg.slice(11).trim());
    else if (arg === 'done') out.done = true;
  }
  return out;
}

interface FetchComputation {
  objects: Map<string, GitObject>;
  shallowLines: string[];
  unshallowLines: string[];
  commonHave: string | null;
}

/** Decide exactly which objects a fetch sends, per the exclusion and depth rules of the protocol. */
function computeFetch(repo: Repo, fetch: FetchArgs): FetchComputation {
  const store = repo.objects;
  const clientShallow = new Set(fetch.shallow.filter(isOid));
  const excluded = new Set<string>();
  if (fetch.haves.length > 0) {
    for (const oid of closureOf(store, fetch.haves.filter(isOid), clientShallow).keys()) excluded.add(oid);
  }
  for (const oid of clientShallow) excluded.add(oid);
  for (const not of fetch.deepenNot) {
    const tip = isOid(not) ? not : repo.refs.get(not);
    if (tip !== undefined) for (const oid of closureOf(store, [tip]).keys()) excluded.add(oid);
  }

  let objects: Map<string, GitObject>;
  let boundary: string[] = [];
  if (fetch.deepen !== null && Number.isFinite(fetch.deepen) && fetch.deepen > 0) {
    const result = depthClosure(store, fetch.wants, fetch.deepen, excluded);
    objects = result.objects;
    boundary = result.boundary;
  } else {
    const all = closureOf(store, fetch.wants, clientShallow);
    objects = new Map();
    for (const [oid, obj] of all) if (!excluded.has(oid)) objects.set(oid, obj);
  }

  const sent = new Set(objects.keys());
  const unshallowLines: string[] = [];
  for (const oid of clientShallow) {
    const obj = store.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    if (parents.length > 0 && parents.some((parent) => sent.has(parent)) && parents.every((parent) => sent.has(parent) || excluded.has(parent))) {
      unshallowLines.push(oid);
    }
  }
  let commonHave: string | null = null;
  for (const have of fetch.haves) {
    if (store.has(have)) {
      commonHave = have;
      break;
    }
  }
  return { objects, shallowLines: boundary, unshallowLines, commonHave };
}

/** Chunk pack bytes into side-band-64k band-1 pkt-lines. */
function sidebandPackets(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return parts;
}

function packSection(objects: Map<string, GitObject>): Buffer {
  const list = [...objects.entries()].map(([oid, obj]) => ({ oid, type: obj.type, data: obj.data }));
  const pack = writePack(list);
  return Buffer.concat([pktLine('packfile\n'), ...sidebandPackets(pack), PKT_FLUSH]);
}

/**
 * A fetch response is a pure function of the repository's refs and objects plus the request's
 * wants/haves/shallow/deepen. Identical repeated fetches (a clone workload issues them by the
 * hundred) are answered from this small cache instead of rebuilding the same pack; the bytes are
 * the very bytes a fresh computation would produce, so answers stay deterministic.
 */
const fetchCache = new Map<string, Buffer>();
const FETCH_CACHE_MAX = 128;

function fetchCacheKey(repo: Repo, fetch: FetchArgs, variant: string): string {
  const refs = [...repo.refs.entries()].sort().map(([name, oid]) => `${name} ${oid}`).join('\n');
  const refDigest = createHash('sha1').update(refs).digest('hex');
  return [
    repo.dbId,
    refDigest,
    repo.objects.size,
    variant,
    fetch.wants.join(','),
    fetch.haves.join(','),
    fetch.shallow.join(','),
    fetch.deepen ?? '',
    fetch.deepenSince ?? '',
    fetch.deepenNot.join(','),
  ].join('|');
}

function fetchCacheGet(key: string): Buffer | null {
  return fetchCache.get(key) ?? null;
}

function fetchCachePut(key: string, body: Buffer): void {
  if (fetchCache.size >= FETCH_CACHE_MAX) {
    const oldest = fetchCache.keys().next().value;
    if (oldest !== undefined) fetchCache.delete(oldest);
  }
  fetchCache.set(key, body);
}

function handleFetchV2(repo: Repo, args: string[]): HttpResult {
  const fetch = parseFetchArgs(args);
  for (const want of fetch.wants) {
    if (!isOid(want) || !repo.objects.has(want)) return json(400, { message: `unknown object ${want}` });
  }
  const cacheKey = fetch.done ? fetchCacheKey(repo, fetch, 'v2') : null;
  if (cacheKey !== null) {
    const cached = fetchCacheGet(cacheKey);
    if (cached !== null) return { status: 200, body: cached, contentType: 'application/x-git-upload-pack-result' };
  }
  const computed = computeFetch(repo, fetch);
  const parts: Buffer[] = [pktLine('acknowledgments\n')];
  if (fetch.done) {
    parts.push(pktLine(computed.commonHave !== null ? `ACK ${computed.commonHave}\n` : 'NAK\n'));
    parts.push(PKT_FLUSH);
  } else {
    // Negotiation-only answer: acknowledge what we hold in common, then stop (no packfile).
    let any = false;
    for (const have of fetch.haves) {
      if (repo.objects.has(have)) {
        parts.push(pktLine(`ACK ${have}\n`));
        any = true;
      }
    }
    if (!any) parts.push(pktLine('NAK\n'));
    else parts.push(pktLine('ready\n'));
    parts.push(PKT_FLUSH);
    return { status: 200, body: Buffer.concat(parts), contentType: 'application/x-git-upload-pack-result' };
  }
  if (computed.shallowLines.length > 0 || computed.unshallowLines.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of computed.shallowLines) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of computed.unshallowLines) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_FLUSH);
  }
  parts.push(packSection(computed.objects));
  const body = Buffer.concat(parts);
  if (cacheKey !== null) fetchCachePut(cacheKey, body);
  return { status: 200, body, contentType: 'application/x-git-upload-pack-result' };
}

function handleFetchV0(repo: Repo, body: Buffer): HttpResult {
  const { packets } = parsePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let deepen: number | null = null;
  let sideband = false;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      const caps = line.slice(nul + 1);
      if (caps.split(' ').includes('side-band-64k')) sideband = true;
      line = line.slice(0, nul);
    }
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) deepen = Number(line.slice(7).trim());
  }
  const fetch: FetchArgs = { wants, haves, shallow, deepen, deepenSince: null, deepenNot: [], done: true };
  const cacheKey = fetchCacheKey(repo, fetch, sideband ? 'v0-sideband' : 'v0-raw');
  const cached = fetchCacheGet(cacheKey);
  if (cached !== null) return { status: 200, body: cached, contentType: 'application/x-git-upload-pack-result' };
  const computed = computeFetch(repo, fetch);
  const parts: Buffer[] = [];
  for (const oid of computed.shallowLines) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of computed.unshallowLines) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(pktLine(computed.commonHave !== null ? `ACK ${computed.commonHave}\n` : 'NAK\n'));
  const list = [...computed.objects.entries()].map(([oid, obj]) => ({ oid, type: obj.type, data: obj.data }));
  const pack = writePack(list);
  if (sideband) parts.push(...sidebandPackets(pack));
  else parts.push(pack);
  parts.push(PKT_FLUSH);
  const responseBody = Buffer.concat(parts);
  fetchCachePut(cacheKey, responseBody);
  return { status: 200, body: responseBody, contentType: 'application/x-git-upload-pack-result' };
}

export function handleUploadPack(repo: Repo | null, body: Buffer, protocolHeader: string | null): HttpResult {
  if (repo === null) return notFound();
  try {
    if (protocolHeader !== null && /(^|,)version=2/.test(protocolHeader)) {
      const parsed = parseV2Request(body);
      if (parsed.command === 'ls-refs') return handleLsRefs(repo, parsed.args);
      if (parsed.command === 'fetch') return handleFetchV2(repo, parsed.args);
      return json(400, { message: `unknown command ${parsed.command}` });
    }
    return handleFetchV0(repo, body);
  } catch (error) {
    return json(400, { message: error instanceof Error ? error.message : 'bad request' });
  }
}

// ---------------------------------------------------------------- receive-pack

interface RefCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Parse receive-pack's command list pkt-lines; the pack (if any) follows the flush. */
function parseReceiveBody(body: Buffer): { commands: RefCommand[]; caps: Set<string>; pack: Buffer } {
  const commands: RefCommand[] = [];
  const caps = new Set<string>();
  let pos = 0;
  let first = true;
  for (;;) {
    if (pos + 4 > body.length) throw new Error('truncated receive-pack body');
    const headerText = body.subarray(pos, pos + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(headerText)) throw new Error('bad pkt-line in receive-pack body');
    const length = parseInt(headerText, 16);
    if (length === 0) {
      pos += 4;
      break;
    }
    if (length < 4 || pos + length > body.length) throw new Error('truncated receive-pack command');
    let line = body.subarray(pos + 4, pos + length).toString('utf8').replace(/\n$/, '');
    pos += length;
    if (first) {
      first = false;
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        for (const cap of line.slice(nul + 1).split(' ')) if (cap !== '') caps.add(cap);
        line = line.slice(0, nul);
      }
    }
    const fields = line.split(' ');
    if (fields.length < 3) throw new Error('malformed ref command');
    commands.push({ oldOid: fields[0]!, newOid: fields[1]!, ref: fields.slice(2).join(' ') });
  }
  return { commands, caps, pack: body.subarray(pos) };
}

export function handleReceivePack(repo: Repo | null, body: Buffer): HttpResult {
  if (repo === null) return notFound();
  let parsed: { commands: RefCommand[]; caps: Set<string>; pack: Buffer };
  try {
    parsed = parseReceiveBody(body);
  } catch (error) {
    return json(400, { message: error instanceof Error ? error.message : 'bad request' });
  }
  const { commands, caps, pack } = parsed;
  let unpackError: string | null = null;
  if (pack.length > 0) {
    try {
      const read = readPack(pack, (oid) => repo.objects.get(oid));
      for (const obj of read.objects) {
        if (!repo.objects.has(obj.oid)) repo.objects.set(obj.oid, { type: obj.type, data: obj.data });
      }
    } catch (error) {
      unpackError = error instanceof Error ? error.message : 'unpack failed';
    }
  }

  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    const { oldOid, newOid, ref } = command;
    if (unpackError !== null) {
      results.push({ ref, ok: false, reason: 'unpack failed' });
      continue;
    }
    if (!ref.startsWith('refs/') || ref.includes('..') || ref.includes(' ')) {
      results.push({ ref, ok: false, reason: 'invalid ref name' });
      continue;
    }
    const current = repo.refs.get(ref) ?? ZERO_OID;
    if (newOid === ZERO_OID) {
      // Delete: idempotent, and deleting the ref the client just created is a normal flow.
      repo.refs.delete(ref);
      results.push({ ref, ok: true, reason: '' });
      continue;
    }
    if (!repo.objects.has(newOid)) {
      results.push({ ref, ok: false, reason: 'invalid object' });
      continue;
    }
    if (oldOid !== current) {
      results.push({ ref, ok: false, reason: oldOid === ZERO_OID ? 'reference already exists' : 'stale info' });
      continue;
    }
    if (oldOid !== ZERO_OID && oldOid !== newOid) {
      const newObj = repo.objects.get(newOid);
      const oldObj = repo.objects.get(oldOid);
      if (newObj?.type === 'commit' && oldObj?.type === 'commit' && !isAncestor(repo.objects, oldOid, newOid)) {
        results.push({ ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
    }
    repo.refs.set(ref, newOid);
    results.push({ ref, ok: true, reason: '' });
  }

  if (!caps.has('report-status')) {
    return { status: 200, body: Buffer.alloc(0), contentType: 'application/x-git-receive-pack-result' };
  }
  const reportParts: Buffer[] = [pktLine(unpackError === null ? 'unpack ok\n' : `unpack ${unpackError}\n`)];
  for (const result of results) {
    reportParts.push(pktLine(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`));
  }
  reportParts.push(PKT_FLUSH);
  const report = Buffer.concat(reportParts);
  let responseBody: Buffer;
  if (caps.has('side-band-64k')) {
    const wrapped = sidebandPackets(report);
    wrapped.push(PKT_FLUSH);
    responseBody = Buffer.concat(wrapped);
  } else {
    responseBody = report;
  }
  return { status: 200, body: responseBody, contentType: 'application/x-git-receive-pack-result' };
}
