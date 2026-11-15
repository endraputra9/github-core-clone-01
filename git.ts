// git.ts: the git object model and wire pieces the forge needs, over node:crypto and node:zlib only.
// Objects are content-addressed buffers in a per-repository Map; packs are version 2, written with
// plain (non-delta) objects and read with full ofs/ref delta resolution.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';
export type GitType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitType;
  data: Buffer;
}

export type ObjectStore = Map<string, GitObject>;

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The object id of a typed payload: sha1 of "<type> <size>\0" followed by the bytes. */
export function hashObject(type: GitType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

/** Store an object and return its id. */
export function putObject(store: ObjectStore, type: GitType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!store.has(oid)) store.set(oid, { type, data });
  return oid;
}

export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

// ---------------------------------------------------------------- pkt-lines

/** One pkt-line: 4 hex digits of total length (header included) plus the payload. */
export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  if (length > 0xffff) throw new Error('pkt-line too long');
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

export interface PktPacket {
  kind: 'data' | 'flush' | 'delim' | 'response-end';
  payload: Buffer;
}

/** Parse a whole buffer of pkt-lines; throws on malformed framing (callers turn that into a 400). */
export function parsePktLines(buf: Buffer, offset = 0): { packets: PktPacket[]; end: number } {
  const packets: PktPacket[] = [];
  let pos = offset;
  while (pos < buf.length) {
    if (pos + 4 > buf.length) throw new Error('truncated pkt-line header');
    const headerText = buf.subarray(pos, pos + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(headerText)) throw new Error(`bad pkt-line header ${JSON.stringify(headerText)}`);
    const length = parseInt(headerText, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      pos += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      pos += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      pos += 4;
      continue;
    }
    if (length < 4 || pos + length > buf.length) throw new Error('truncated pkt-line payload');
    packets.push({ kind: 'data', payload: buf.subarray(pos + 4, pos + length) });
    pos += length;
  }
  return { packets, end: pos };
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    if (space < 0) throw new Error('malformed tree entry');
    const mode = data.subarray(pos, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('malformed tree entry');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    pos = nul + 21;
  }
  return entries;
}

/** Git's tree order: by name, directories as if their name ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function isTreeMode(mode: string): boolean {
  return mode === '40000' || mode === '040000';
}

/** Flatten a tree (recursively) into a map of path -> {mode, oid} for files (blobs and submodules). */
export function flattenTree(store: ObjectStore, treeOid: string, prefix = '', out = new Map<string, { mode: string; oid: string }>()): Map<string, { mode: string; oid: string }> {
  const tree = store.get(treeOid);
  if (tree === undefined || tree.type !== 'tree') return out;
  for (const entry of parseTree(tree.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (isTreeMode(entry.mode)) flattenTree(store, entry.oid, path, out);
    else out.set(path, { mode: entry.mode, oid: entry.oid });
  }
  return out;
}

/** Write a nested tree hierarchy for a flat path map; returns the root tree oid. */
export function buildTreeFromMap(store: ObjectStore, files: Map<string, { mode: string; oid: string }>): string {
  interface Node {
    files: Map<string, { mode: string; oid: string }>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, file] of files) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i]!;
      let next = node.dirs.get(part);
      if (next === undefined) {
        next = { files: new Map(), dirs: new Map() };
        node.dirs.set(part, next);
      }
      node = next;
    }
    node.files.set(parts[parts.length - 1]!, file);
  }
  const writeNode = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, file] of node.files) entries.push({ mode: file.mode, name, oid: file.oid });
    for (const [name, dir] of node.dirs) entries.push({ mode: '40000', name, oid: writeNode(dir) });
    return putObject(store, 'tree', buildTree(entries));
  };
  return writeNode(root);
}

// ---------------------------------------------------------------- commits and tags

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2) : '';
  let tree = ZERO_OID;
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith(' ')) continue; // continuation of a multi-line header (gpgsig etc.)
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(info: CommitInfo): Buffer {
  const lines = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${info.author}`);
  lines.push(`committer ${info.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${info.message}`, 'utf8');
}

/** Format an identity line: "Name <email> <unix-seconds> +0000". */
export function identityLine(name: string, email: string, unixSec: number): string {
  return `${name} <${email}> ${unixSec} +0000`;
}

/** The commit a tag object points at (following nested tags), or null. */
export function peelTag(store: ObjectStore, oid: string): string | null {
  let current = oid;
  for (let depth = 0; depth < 10; depth += 1) {
    const obj = store.get(current);
    if (obj === undefined) return null;
    if (obj.type === 'commit') return current;
    if (obj.type !== 'tag') return null;
    const match = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
    if (match === null) return null;
    current = match[1]!;
  }
  return null;
}

// ---------------------------------------------------------------- packs

const PACK_TYPE_IDS: Record<GitType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const PACK_TYPE_NAMES: Record<number, GitType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** Serialize objects as a version-2 pack of plain (non-delta) entries, with a valid trailer. */
export function writePack(objects: Array<{ oid: string; type: GitType; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    const typeId = PACK_TYPE_IDS[obj.type];
    let size = obj.data.length;
    const first = (typeId << 4) | (size & 0x0f);
    size >>= 4;
    const headBytes: number[] = [];
    if (size > 0) {
      headBytes.push(first | 0x80);
      while (size > 0) {
        let byte = size & 0x7f;
        size >>= 7;
        if (size > 0) byte |= 0x80;
        headBytes.push(byte);
      }
    } else {
      headBytes.push(first);
    }
    parts.push(Buffer.from(headBytes));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/**
 * Inflate one zlib stream starting at `offset`, finding its exact end. Zlib streams carry an
 * Adler-32 trailer, so a truncated slice throws while any longer slice (trailing bytes are
 * ignored) succeeds: "inflates" is monotonic in the slice length, and the minimal succeeding
 * length is the stream's exact end.
 */
export function inflateAt(buf: Buffer, offset: number): { data: Buffer; consumed: number } {
  const total = buf.length - offset;
  let lo = 1;
  let hi = total;
  // Confirm the full remainder inflates at all (a corrupt stream throws here, as it should).
  inflateSync(buf.subarray(offset));
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    try {
      inflateSync(buf.subarray(offset, offset + mid));
      hi = mid;
    } catch {
      lo = mid + 1;
    }
  }
  return { data: inflateSync(buf.subarray(offset, offset + lo)), consumed: lo };
}

/** Apply a git delta buffer to a base payload. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (pos >= delta.length) throw new Error('truncated delta');
      const byte = delta[pos]!;
      pos += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const targetSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (pos < delta.length) {
    const op = delta[pos]!;
    pos += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) { offset = delta[pos]!; pos += 1; }
      if (op & 0x02) { offset |= delta[pos]! << 8; pos += 1; }
      if (op & 0x04) { offset |= delta[pos]! << 16; pos += 1; }
      if (op & 0x08) { offset |= delta[pos]! << 24; pos += 1; }
      if (op & 0x10) { size = delta[pos]!; pos += 1; }
      if (op & 0x20) { size |= delta[pos]! << 8; pos += 1; }
      if (op & 0x40) { size |= delta[pos]! << 16; pos += 1; }
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op > 0) {
      out.push(delta.subarray(pos, pos + op));
      pos += op;
      produced += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (produced !== targetSize || result.length !== targetSize) throw new Error('delta target size mismatch');
  return result;
}

export interface ReadPackResult {
  objects: Array<{ oid: string; type: GitType; data: Buffer }>;
  deltaCount: number;
}

/**
 * Read a pack into full objects. `resolveExternal(oid)` supplies bases for ref-deltas whose base is
 * not in the pack (thin packs); ofs-delta bases are always inside the pack.
 */
export function readPack(pack: Buffer, resolveExternal?: (oid: string) => GitObject | undefined): ReadPackResult {
  if (pack.length < 12 + 20) throw new Error('pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack signature');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const digest = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!trailer.equals(digest)) throw new Error('pack trailer checksum mismatch');

  interface RawEntry {
    offset: number;
    typeId: number;
    data?: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let pos = 12;
  for (let i = 0; i < count; i += 1) {
    const start = pos;
    let byte = pack[pos]!;
    pos += 1;
    const typeId = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[pos]!;
      pos += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    const entry: RawEntry = { offset: start, typeId };
    if (typeId === 6) {
      // ofs-delta: base offset is a negative offset from this entry's start, specially encoded.
      let b = pack[pos]!;
      pos += 1;
      let baseOffset = b & 0x7f;
      while (b & 0x80) {
        b = pack[pos]!;
        pos += 1;
        baseOffset = ((baseOffset + 1) << 7) | (b & 0x7f);
      }
      entry.baseOffset = start - baseOffset;
    } else if (typeId === 7) {
      entry.baseOid = pack.subarray(pos, pos + 20).toString('hex');
      pos += 20;
    }
    const inflated = inflateAt(pack, pos);
    entry.data = inflated.data;
    if (entry.data.length !== size) throw new Error('pack object size mismatch');
    pos += inflated.consumed;
    raw.push(entry);
    byOffset.set(start, entry);
  }

  const resolved = new Map<number, { oid: string; type: GitType; data: Buffer }>();
  const resolveEntry = (entry: RawEntry): { oid: string; type: GitType; data: Buffer } => {
    const cached = resolved.get(entry.offset);
    if (cached !== undefined) return cached;
    let result: { oid: string; type: GitType; data: Buffer };
    if (entry.typeId >= 1 && entry.typeId <= 4) {
      const type = PACK_TYPE_NAMES[entry.typeId]!;
      result = { oid: hashObject(type, entry.data!), type, data: entry.data! };
    } else if (entry.typeId === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (baseEntry === undefined) throw new Error('ofs-delta base not in pack');
      const base = resolveEntry(baseEntry);
      const data = applyDelta(base.data, entry.data!);
      result = { oid: hashObject(base.type, data), type: base.type, data };
    } else if (entry.typeId === 7) {
      let base: { oid: string; type: GitType; data: Buffer } | undefined;
      for (const candidate of raw) {
        if (candidate.typeId >= 1 && candidate.typeId <= 4) {
          const oid = hashObject(PACK_TYPE_NAMES[candidate.typeId]!, candidate.data!);
          if (oid === entry.baseOid) {
            base = resolveEntry(candidate);
            break;
          }
        }
      }
      if (base === undefined && resolveExternal !== undefined) {
        const external = resolveExternal(entry.baseOid!);
        if (external !== undefined) base = { oid: entry.baseOid!, type: external.type, data: external.data };
      }
      if (base === undefined) throw new Error('ref-delta base not found');
      const data = applyDelta(base.data, entry.data!);
      result = { oid: hashObject(base.type, data), type: base.type, data };
    } else {
      throw new Error(`unknown pack object type ${entry.typeId}`);
    }
    resolved.set(entry.offset, result);
    return result;
  };

  const objects: Array<{ oid: string; type: GitType; data: Buffer }> = [];
  let deltaCount = 0;
  for (const entry of raw) {
    if (entry.typeId === 6 || entry.typeId === 7) deltaCount += 1;
    objects.push(resolveEntry(entry));
  }
  return { objects, deltaCount };
}

// ---------------------------------------------------------------- history walks

/** Add a tree and everything under it to `into` (objects the store holds). */
function collectTree(store: ObjectStore, treeOid: string, into: Map<string, GitObject>): void {
  if (into.has(treeOid)) return;
  const tree = store.get(treeOid);
  if (tree === undefined || tree.type !== 'tree') return;
  into.set(treeOid, tree);
  for (const entry of parseTree(tree.data)) {
    if (isTreeMode(entry.mode)) collectTree(store, entry.oid, into);
    else {
      const blob = store.get(entry.oid);
      if (blob !== undefined && !into.has(entry.oid)) into.set(entry.oid, blob);
    }
  }
}

/**
 * The full object closure of `tips` (commits plus their trees and blobs), stopping at commits in
 * `stopAt` (treated as parentless and excluded unless they are also tips' own trees... a stopAt commit
 * itself is not included). Tag tips are peeled to their commits, and the tag objects are included.
 */
export function closureOf(store: ObjectStore, tips: string[], stopAt: ReadonlySet<string> = new Set()): Map<string, GitObject> {
  const into = new Map<string, GitObject>();
  const queue: string[] = [];
  for (const tip of tips) {
    const obj = store.get(tip);
    if (obj === undefined) continue;
    if (obj.type === 'tag') {
      into.set(tip, obj);
      const peeled = peelTag(store, tip);
      if (peeled !== null) queue.push(peeled);
    } else if (obj.type === 'commit') {
      queue.push(tip);
    } else {
      into.set(tip, obj);
    }
  }
  const seenCommits = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seenCommits.has(oid) || stopAt.has(oid)) continue;
    const obj = store.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    seenCommits.add(oid);
    into.set(oid, obj);
    const commit = parseCommit(obj.data);
    collectTree(store, commit.tree, into);
    for (const parent of commit.parents) queue.push(parent);
  }
  return into;
}

/**
 * Depth-limited closure: commits within `depth` generations of the tips (depth 1 = the tips only),
 * generations counted through `excluded` commits (which the client already holds, so they are
 * traversed but never resent). Returns the objects to send and the boundary commits: sent commits
 * one of whose parents was cut (present in the store, neither sent nor already held).
 */
export function depthClosure(store: ObjectStore, tips: string[], depth: number, excluded: ReadonlySet<string> = new Set()): { objects: Map<string, GitObject>; boundary: string[] } {
  const objects = new Map<string, GitObject>();
  const included = new Set<string>();
  let frontier: string[] = [];
  for (const tip of tips) {
    const obj = store.get(tip);
    if (obj === undefined) continue;
    if (obj.type === 'tag') {
      if (!excluded.has(tip)) objects.set(tip, obj);
      const peeled = peelTag(store, tip);
      if (peeled !== null) frontier.push(peeled);
    } else if (obj.type === 'commit') {
      frontier.push(tip);
    } else if (!excluded.has(tip)) {
      objects.set(tip, obj);
    }
  }
  frontier = [...new Set(frontier)];
  const visited = new Set<string>();
  for (let generation = 0; generation < depth && frontier.length > 0; generation += 1) {
    const next: string[] = [];
    for (const oid of frontier) {
      if (visited.has(oid)) continue;
      visited.add(oid);
      const obj = store.get(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      const commit = parseCommit(obj.data);
      if (!excluded.has(oid)) {
        included.add(oid);
        objects.set(oid, obj);
        collectTree(store, commit.tree, objects);
      }
      if (generation < depth - 1) for (const parent of commit.parents) next.push(parent);
    }
    frontier = [...new Set(next)];
  }
  // Trees and blobs of held commits ride along in `objects` via collectTree only for included
  // commits; drop anything the client already holds.
  for (const oid of [...objects.keys()]) if (excluded.has(oid)) objects.delete(oid);
  const boundary: string[] = [];
  for (const oid of included) {
    const obj = store.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    const commit = parseCommit(obj.data);
    if (commit.parents.some((parent) => store.has(parent) && !included.has(parent) && !excluded.has(parent))) boundary.push(oid);
  }
  return { objects, boundary };
}

/** True when `ancestor` is reachable from `descendant` through commit parents. */
export function isAncestor(store: ObjectStore, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = store.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    const commit = parseCommit(obj.data);
    for (const parent of commit.parents) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}

/** A nearest common ancestor of two commits (BFS by generation from both sides), or null. */
export function mergeBase(store: ObjectStore, a: string, b: string): string | null {
  if (a === b) return a;
  const ancestorsOf = (tip: string): Map<string, number> => {
    const dist = new Map<string, number>();
    let frontier = [tip];
    let depth = 0;
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const oid of frontier) {
        if (dist.has(oid)) continue;
        dist.set(oid, depth);
        const obj = store.get(oid);
        if (obj === undefined || obj.type !== 'commit') continue;
        for (const parent of parseCommit(obj.data).parents) next.push(parent);
      }
      frontier = next;
      depth += 1;
    }
    return dist;
  };
  const fromA = ancestorsOf(a);
  const fromB = ancestorsOf(b);
  let best: string | null = null;
  let bestScore = Infinity;
  for (const [oid, da] of fromA) {
    const db = fromB.get(oid);
    if (db === undefined) continue;
    const score = da + db;
    if (score < bestScore) {
      bestScore = score;
      best = oid;
    }
  }
  return best;
}

/** Commit oids reachable from a tip, newest first (generation order, parents in listed order). */
export function listAncestry(store: ObjectStore, tip: string, limit = 1000): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let frontier = [tip];
  while (frontier.length > 0 && out.length < limit) {
    const next: string[] = [];
    for (const oid of frontier) {
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = store.get(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      out.push(oid);
      for (const parent of parseCommit(obj.data).parents) next.push(parent);
    }
    frontier = next;
  }
  return out;
}
