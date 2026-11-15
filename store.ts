// store.ts: the forge's state — repositories (each with its own git object store and refs), issues,
// pull requests, comments and labels — plus the operations every surface shares: contents commits,
// three-way merges and file diffs. One tenant: the token's owner, whose login the scenario fixes.

import {
  ZERO_OID,
  buildCommit,
  buildTreeFromMap,
  flattenTree,
  hashObject,
  identityLine,
  isAncestor,
  mergeBase,
  parseCommit,
  putObject,
  type ObjectStore,
} from './git.ts';

/** The token owner's login (the scenario's viewer): every repository lives under this owner. */
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';

export interface Label {
  name: string;
  color: string;
  description: string | null;
}

export interface Comment {
  globalId: number;
  body: string;
  createdSeq: number;
}

export interface Issue {
  globalId: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  createdSeq: number;
}

export interface Pull {
  globalId: number;
  number: number;
  title: string;
  body: string;
  headRef: string;
  baseRef: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergeCommitSha: string | null;
  mergedSeq: number | null;
  createdSeq: number;
}

export interface Repo {
  dbId: number;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  objects: ObjectStore;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  nextNumber: number;
  createdSeq: number;
}

/**
 * The forge. A logical clock seeded from MAKEFUN_TRIAL_NOW stamps every mutation (+1s each), so a
 * live trial and its replay produce identical response bytes: no wall clock reaches an answer.
 */
export class Forge {
  readonly repos = new Map<string, Repo>();
  readonly baseSec: number;
  private clockSec: number;
  private seq = 0;
  private nextRepoId = 1;
  private nextGlobalId = 1;
  private nextCommentId = 1;

  constructor() {
    const raw = process.env.MAKEFUN_TRIAL_NOW ?? '';
    const parsed = Date.parse(raw);
    this.clockSec = Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 1767225600; // 2026-01-01T00:00:00Z
    this.baseSec = this.clockSec;
  }

  /** The ISO timestamp of the mutation with sequence number `seq` (the clock ticks 1s per mutation). */
  isoOfSeq(seq: number): string {
    return this.iso(this.baseSec + seq);
  }

  /** Advance the logical clock and return the new reading, in unix seconds. */
  tick(): number {
    this.seq += 1;
    this.clockSec += 1;
    return this.clockSec;
  }

  /** The current logical reading without advancing it. */
  nowSec(): number {
    return this.clockSec;
  }

  iso(sec: number): string {
    return new Date(sec * 1000).toISOString().replace('.000Z', 'Z');
  }

  /** The creation-order sequence number of the last mutation (orders issues and pulls). */
  sequence(): number {
    return this.seq;
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo {
    const repo: Repo = {
      dbId: this.nextRepoId,
      name,
      description,
      isPrivate,
      defaultBranch: 'main',
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      createdSeq: this.seq,
    };
    this.nextRepoId += 1;
    this.tick();
    repo.createdSeq = this.seq;
    this.repos.set(name, repo);
    return repo;
  }

  /** Look a repository up by owner/name; any owner but the viewer's is a 404, never a 403. */
  repo(owner: string, name: string): Repo | null {
    if (owner !== VIEWER_LOGIN) return null;
    return this.repos.get(name) ?? null;
  }

  deleteRepo(owner: string, name: string): boolean {
    if (owner !== VIEWER_LOGIN) return false;
    const gone = this.repos.delete(name);
    if (gone) this.tick();
    return gone;
  }

  allocGlobalId(): number {
    const id = this.nextGlobalId;
    this.nextGlobalId += 1;
    return id;
  }

  allocCommentId(): number {
    const id = this.nextCommentId;
    this.nextCommentId += 1;
    return id;
  }

  /** Find an issue or pull anywhere by its forge-wide global id (GraphQL node/close/merge lookups). */
  findByGlobalId(kind: 'issue' | 'pull', globalId: number): { repo: Repo; item: Issue | Pull } | null {
    for (const repo of this.repos.values()) {
      const map = kind === 'issue' ? repo.issues : repo.pulls;
      for (const item of map.values()) {
        if (item.globalId === globalId) return { repo, item };
      }
    }
    return null;
  }

  repoByDbId(dbId: number): Repo | null {
    for (const repo of this.repos.values()) if (repo.dbId === dbId) return repo;
    return null;
  }
}

// ---------------------------------------------------------------- global ids (GraphQL)

/** Relay-style global ids: base64 of "<prefix>:<Type><numeric id>", opaque and stable. */
const GID_PREFIX: Record<string, string> = { Repository: '05', Issue: '04', PullRequest: '09', IssueComment: '06' };

export function globalId(type: 'Repository' | 'Issue' | 'PullRequest' | 'IssueComment', numeric: number): string {
  return Buffer.from(`${GID_PREFIX[type]}:${type}${numeric}`, 'utf8').toString('base64');
}

export function parseGlobalId(value: string): { type: string; numeric: number } | null {
  try {
    const decoded = Buffer.from(value, 'base64').toString('utf8');
    const match = /^\d+:([A-Za-z]+)(\d+)$/.exec(decoded);
    if (match === null) return null;
    return { type: match[1]!, numeric: Number(match[2]) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- git-side repo operations

export function headRef(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

/** The commit a branch name points at, or null when the branch does not exist. */
export function branchTip(repo: Repo, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

/** The tree flattened at a commit (empty map for an unborn or missing commit). */
export function treeFilesAt(repo: Repo, commitOid: string | null): Map<string, { mode: string; oid: string }> {
  if (commitOid === null) return new Map();
  const commit = repo.objects.get(commitOid);
  if (commit === undefined || commit.type !== 'commit') return new Map();
  return flattenTree(repo.objects, parseCommit(commit.data).tree);
}

/**
 * Commit a set of path changes (Buffer content, or null to delete) onto a branch, creating the
 * branch (and the repository's first commit) when needed. Returns the new commit oid.
 */
export function commitFiles(forge: Forge, repo: Repo, branch: string, changes: Map<string, Buffer | null>, message: string): string {
  const ref = `refs/heads/${branch}`;
  const parent = repo.refs.get(ref) ?? null;
  const files = treeFilesAt(repo, parent);
  for (const [path, content] of changes) {
    if (content === null) files.delete(path);
    else {
      const blobOid = putObject(repo.objects, 'blob', content);
      const existing = files.get(path);
      files.set(path, { mode: existing?.mode ?? '100644', oid: blobOid });
    }
  }
  const treeOid = buildTreeFromMap(repo.objects, files);
  const stamp = forge.tick();
  const ident = identityLine(VIEWER_NAME, VIEWER_EMAIL, stamp);
  const commitOid = putObject(repo.objects, 'commit', buildCommit({
    tree: treeOid,
    parents: parent === null ? [] : [parent],
    author: ident,
    committer: ident,
    message,
  }));
  repo.refs.set(ref, commitOid);
  return commitOid;
}

// ---------------------------------------------------------------- merges and diffs

export interface MergeOutcome {
  ok: boolean;
  treeOid?: string;
  conflicts: string[];
}

/** Three-way merge of flattened trees: base, ours (the base branch), theirs (the head branch). */
export function threeWayMergeTrees(
  repo: Repo,
  baseFiles: Map<string, { mode: string; oid: string }>,
  ourFiles: Map<string, { mode: string; oid: string }>,
  theirFiles: Map<string, { mode: string; oid: string }>,
): { merged: Map<string, { mode: string; oid: string }> | null; conflicts: string[] } {
  const merged = new Map<string, { mode: string; oid: string }>();
  const conflicts: string[] = [];
  const paths = new Set<string>([...baseFiles.keys(), ...ourFiles.keys(), ...theirFiles.keys()]);
  for (const path of paths) {
    const base = baseFiles.get(path);
    const ours = ourFiles.get(path);
    const theirs = theirFiles.get(path);
    const same = (a?: { mode: string; oid: string }, b?: { mode: string; oid: string }): boolean =>
      a === undefined && b === undefined ? true : a !== undefined && b !== undefined && a.oid === b.oid && a.mode === b.mode;
    if (same(ours, theirs)) {
      if (ours !== undefined) merged.set(path, ours);
    } else if (same(base, ours)) {
      if (theirs !== undefined) merged.set(path, theirs);
    } else if (same(base, theirs)) {
      if (ours !== undefined) merged.set(path, ours);
    } else {
      conflicts.push(path);
    }
  }
  void repo;
  return { merged: conflicts.length === 0 ? merged : null, conflicts };
}

/** Whether a pull request can merge cleanly into its base right now, and its merge base. */
export function pullMergeState(repo: Repo, pull: Pull): { mergeable: boolean; base: string | null; headTip: string | null; baseTip: string | null } {
  const headTip = branchTip(repo, pull.headRef);
  const baseTip = branchTip(repo, pull.baseRef);
  if (headTip === null || baseTip === null) return { mergeable: false, base: null, headTip, baseTip };
  if (isAncestor(repo.objects, headTip, baseTip)) return { mergeable: true, base: baseTip, headTip, baseTip }; // already contained
  const base = mergeBase(repo.objects, baseTip, headTip);
  if (base === null) return { mergeable: false, base: null, headTip, baseTip };
  const { conflicts } = threeWayMergeTrees(repo, treeFilesAt(repo, base), treeFilesAt(repo, baseTip), treeFilesAt(repo, headTip));
  return { mergeable: conflicts.length === 0, base, headTip, baseTip };
}

/**
 * Squash-merge a pull request: one commit on the base branch whose tree is the three-way merge,
 * parented on the base tip. Returns the merge commit oid, or null on conflict.
 */
export function squashMerge(forge: Forge, repo: Repo, pull: Pull): string | null {
  const state = pullMergeState(repo, pull);
  if (!state.mergeable || state.baseTip === null || state.headTip === null) return null;
  let treeOid: string;
  if (isAncestor(repo.objects, state.headTip, state.baseTip)) {
    const commit = repo.objects.get(state.baseTip);
    treeOid = parseCommit(commit!.data).tree;
  } else {
    const { merged } = threeWayMergeTrees(repo, treeFilesAt(repo, state.base), treeFilesAt(repo, state.baseTip), treeFilesAt(repo, state.headTip));
    if (merged === null) return null;
    treeOid = buildTreeFromMap(repo.objects, merged);
  }
  const stamp = forge.tick();
  const ident = identityLine(VIEWER_NAME, VIEWER_EMAIL, stamp);
  const message = `${pull.title} (#${pull.number})\n${pull.body === '' ? '' : `\n${pull.body}\n`}`;
  const commitOid = putObject(repo.objects, 'commit', buildCommit({
    tree: treeOid,
    parents: [state.baseTip],
    author: ident,
    committer: ident,
    message,
  }));
  repo.refs.set(`refs/heads/${pull.baseRef}`, commitOid);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergeCommitSha = commitOid;
  pull.mergedSeq = forge.sequence();
  return commitOid;
}

/** Merge (two-parent) variant, used when merge_method asks for it. */
export function mergeCommitMerge(forge: Forge, repo: Repo, pull: Pull): string | null {
  const state = pullMergeState(repo, pull);
  if (!state.mergeable || state.baseTip === null || state.headTip === null) return null;
  const { merged } = threeWayMergeTrees(repo, treeFilesAt(repo, state.base), treeFilesAt(repo, state.baseTip), treeFilesAt(repo, state.headTip));
  if (merged === null) return null;
  const treeOid = buildTreeFromMap(repo.objects, merged);
  const stamp = forge.tick();
  const ident = identityLine(VIEWER_NAME, VIEWER_EMAIL, stamp);
  const commitOid = putObject(repo.objects, 'commit', buildCommit({
    tree: treeOid,
    parents: [state.baseTip, state.headTip],
    author: ident,
    committer: ident,
    message: `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}\n`,
  }));
  repo.refs.set(`refs/heads/${pull.baseRef}`, commitOid);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergeCommitSha = commitOid;
  pull.mergedSeq = forge.sequence();
  return commitOid;
}

export interface FileDiff {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

function splitLines(data: Buffer): string[] {
  const text = data.toString('utf8');
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** A line diff count via LCS (files in this forge are small). */
function lineDiffCounts(before: Buffer, after: Buffer): { additions: number; deletions: number } {
  const a = splitLines(before);
  const b = splitLines(after);
  const m = a.length;
  const n = b.length;
  // LCS length with two rows.
  let prev = new Array<number>(n + 1).fill(0);
  let curr = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, curr[j - 1]!);
    }
    [prev, curr] = [curr, prev];
    curr.fill(0);
  }
  const lcs = prev[n]!;
  return { additions: n - lcs, deletions: m - lcs };
}

/** The file diff between two flattened trees (merge-base tree -> head tree for pull requests). */
export function diffFiles(repo: Repo, fromFiles: Map<string, { mode: string; oid: string }>, toFiles: Map<string, { mode: string; oid: string }>): FileDiff[] {
  const out: FileDiff[] = [];
  const paths = new Set<string>([...fromFiles.keys(), ...toFiles.keys()]);
  for (const path of [...paths].sort()) {
    const from = fromFiles.get(path);
    const to = toFiles.get(path);
    if (from !== undefined && to !== undefined && from.oid === to.oid) continue;
    const blobText = (entry?: { mode: string; oid: string }): Buffer => {
      if (entry === undefined) return Buffer.alloc(0);
      const obj = repo.objects.get(entry.oid);
      return obj !== undefined && obj.type === 'blob' ? obj.data : Buffer.alloc(0);
    };
    if (from === undefined) {
      const additions = splitLines(blobText(to)).length;
      out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (to === undefined) {
      const deletions = splitLines(blobText(from)).length;
      out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else {
      const { additions, deletions } = lineDiffCounts(blobText(from), blobText(to));
      out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return out;
}

/** The changed-file list of a pull request: merge-base tree against head tree. */
export function pullFiles(repo: Repo, pull: Pull): FileDiff[] {
  const headTip = branchTip(repo, pull.headRef);
  const baseTip = branchTip(repo, pull.baseRef);
  if (headTip === null || baseTip === null) return [];
  const base = mergeBase(repo.objects, baseTip, headTip) ?? baseTip;
  return diffFiles(repo, treeFilesAt(repo, base), treeFilesAt(repo, headTip));
}

export { ZERO_OID, hashObject };
