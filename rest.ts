// rest.ts: the GitHub REST v3 surface — root, meta, user, repositories, branches, git refs,
// commits, contents, labels, issues, comments and pull requests (including squash merges).
// Every reply is JSON with a string `message` on errors; pagination follows GitHub's Link header.

import {
  ZERO_OID,
  hashObject,
  isOid,
  listAncestry,
  mergeBase,
  parseCommit,
  parseTree,
  isTreeMode,
  type ObjectStore,
} from './git.ts';
import {
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  branchTip,
  commitFiles,
  diffFiles,
  globalId,
  mergeCommitMerge,
  pullFiles,
  pullMergeState,
  squashMerge,
  treeFilesAt,
  type Forge,
  type Issue,
  type Label,
  type Pull,
  type Repo,
} from './store.ts';
import type { HttpResult } from './gitserver.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

function json(status: number, value: unknown, headers: Record<string, string> = {}): HttpResult {
  return { status, body: Buffer.from(`${JSON.stringify(value)}\n`, 'utf8'), contentType: JSON_TYPE, headers };
}

function fail(status: number, message: string): HttpResult {
  return json(status, { message });
}

function notFound(): HttpResult {
  return fail(404, 'Not Found');
}

// ---------------------------------------------------------------- object shapes

const USER_NODE_ID = Buffer.from(`04:User${VIEWER_ID}`, 'utf8').toString('base64');

export function userObject(): Record<string, unknown> {
  return {
    login: VIEWER_LOGIN,
    id: VIEWER_ID,
    node_id: USER_NODE_ID,
    type: 'User',
    name: VIEWER_NAME,
    email: VIEWER_EMAIL,
    site_admin: false,
  };
}

export function repoObject(forge: Forge, repo: Repo): Record<string, unknown> {
  const stamp = forge.isoOfSeq(repo.createdSeq);
  return {
    id: repo.dbId,
    node_id: globalId('Repository', repo.dbId),
    name: repo.name,
    full_name: `${VIEWER_LOGIN}/${repo.name}`,
    owner: userObject(),
    private: repo.isPrivate,
    html_url: `https://forge.local/${VIEWER_LOGIN}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${VIEWER_LOGIN}/${repo.name}`,
    created_at: stamp,
    updated_at: stamp,
    pushed_at: stamp,
    clone_url: `https://forge.local/${VIEWER_LOGIN}/${repo.name}.git`,
    ssh_url: `git@forge.local:${VIEWER_LOGIN}/${repo.name}.git`,
    default_branch: repo.defaultBranch,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    forks_count: 0,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? 'private' : 'public',
    topics: [],
  };
}

function labelObject(repo: Repo, label: Label): Record<string, unknown> {
  const id = [...repo.labels.keys()].indexOf(label.name) + 1;
  return {
    id,
    node_id: Buffer.from(`07:Label${id}`, 'utf8').toString('base64'),
    url: `/api/v3/repos/${VIEWER_LOGIN}/${repo.name}/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    description: label.description,
    default: false,
  };
}

export function issueObject(forge: Forge, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.globalId,
    node_id: globalId('Issue', issue.globalId),
    url: `/api/v3/repos/${VIEWER_LOGIN}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${VIEWER_LOGIN}/${repo.name}`,
    html_url: `https://forge.local/${VIEWER_LOGIN}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels
      .map((name) => repo.labels.get(name))
      .filter((label): label is Label => label !== undefined)
      .map((label) => labelObject(repo, label)),
    user: userObject(),
    comments: issue.comments.length,
    created_at: forge.isoOfSeq(issue.createdSeq),
    updated_at: forge.isoOfSeq(issue.createdSeq),
    closed_at: issue.state === 'closed' ? forge.isoOfSeq(issue.createdSeq) : null,
    pull_request: undefined,
  };
}

export function commentObject(forge: Forge, repo: Repo, issue: Issue, comment: Issue['comments'][number]): Record<string, unknown> {
  return {
    id: comment.globalId,
    node_id: globalId('IssueComment', comment.globalId),
    url: `/api/v3/repos/${VIEWER_LOGIN}/${repo.name}/issues/comments/${comment.globalId}`,
    html_url: `https://forge.local/${VIEWER_LOGIN}/${repo.name}/issues/${issue.number}#issuecomment-${comment.globalId}`,
    issue_url: `/api/v3/repos/${VIEWER_LOGIN}/${repo.name}/issues/${issue.number}`,
    body: comment.body,
    user: userObject(),
    created_at: forge.isoOfSeq(comment.createdSeq),
    updated_at: forge.isoOfSeq(comment.createdSeq),
  };
}

function refSide(forge: Forge, repo: Repo, ref: string): Record<string, unknown> {
  return {
    label: `${VIEWER_LOGIN}:${ref}`,
    ref,
    sha: branchTip(repo, ref) ?? ZERO_OID,
    user: userObject(),
    repo: repoObject(forge, repo),
  };
}

export function pullObject(forge: Forge, repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.globalId,
    node_id: globalId('PullRequest', pull.globalId),
    url: `/api/v3/repos/${VIEWER_LOGIN}/${repo.name}/pulls/${pull.number}`,
    html_url: `https://forge.local/${VIEWER_LOGIN}/${repo.name}/pull/${pull.number}`,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    user: userObject(),
    head: refSide(forge, repo, pull.headRef),
    base: refSide(forge, repo, pull.baseRef),
    merged: pull.merged,
    merged_at: pull.merged && pull.mergedSeq !== null ? forge.isoOfSeq(pull.mergedSeq) : null,
    merge_commit_sha: pull.mergeCommitSha,
    created_at: forge.isoOfSeq(pull.createdSeq),
    updated_at: forge.isoOfSeq(pull.createdSeq),
    closed_at: pull.state === 'closed' ? forge.isoOfSeq(pull.mergedSeq ?? pull.createdSeq) : null,
    draft: false,
  };
}

function commitObject(repo: Repo, oid: string): Record<string, unknown> {
  const obj = repo.objects.get(oid)!;
  const commit = parseCommit(obj.data);
  const person = (line: string): Record<string, unknown> => {
    const match = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(line);
    if (match === null) return { name: line, email: '', date: '2026-01-01T00:00:00Z' };
    return { name: match[1], email: match[2], date: new Date(Number(match[3]) * 1000).toISOString().replace('.000Z', 'Z') };
  };
  return {
    sha: oid,
    node_id: Buffer.from(`03:Commit${oid}`, 'utf8').toString('base64'),
    url: `/api/v3/repos/${VIEWER_LOGIN}/${repo.name}/commits/${oid}`,
    html_url: `https://forge.local/${VIEWER_LOGIN}/${repo.name}/commit/${oid}`,
    commit: {
      author: person(commit.author),
      committer: person(commit.committer),
      message: commit.message,
      tree: { sha: commit.tree, url: `/api/v3/repos/${VIEWER_LOGIN}/${repo.name}/git/trees/${commit.tree}` },
      comment_count: 0,
    },
    parents: commit.parents.map((parent) => ({ sha: parent, url: `/api/v3/repos/${VIEWER_LOGIN}/${repo.name}/commits/${parent}` })),
  };
}

// ---------------------------------------------------------------- helpers

interface Page {
  perPage: number;
  page: number;
}

function pageOf(query: URLSearchParams): Page {
  const perPageRaw = Number(query.get('per_page') ?? '30');
  const pageRaw = Number(query.get('page') ?? '1');
  return {
    perPage: Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, Math.trunc(perPageRaw))) : 30,
    page: Number.isFinite(pageRaw) ? Math.max(1, Math.trunc(pageRaw)) : 1,
  };
}

/** Slice a list by the page and build the Link header (absolute, same-origin) when pages remain. */
function paginate<T>(items: T[], page: Page, host: string, pathname: string, query: URLSearchParams): { items: T[]; headers: Record<string, string> } {
  const start = (page.page - 1) * page.perPage;
  const slice = items.slice(start, start + page.perPage);
  const headers: Record<string, string> = {};
  if (start + page.perPage < items.length) {
    const next = new URLSearchParams(query);
    next.set('per_page', String(page.perPage));
    next.set('page', String(page.page + 1));
    const last = new URLSearchParams(query);
    last.set('per_page', String(page.perPage));
    last.set('page', String(Math.ceil(items.length / page.perPage)));
    headers.link = `<http://${host}${pathname}?${next.toString()}>; rel="next", <http://${host}${pathname}?${last.toString()}>; rel="last"`;
  }
  return { items: slice, headers };
}

function bodyObject(body: unknown): Record<string, unknown> {
  return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

function stringField(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  return typeof value === 'string' ? value : null;
}

/** Descend a tree to the entry at `path` ('' is the root tree itself). */
function treeEntryAt(store: ObjectStore, rootTree: string, path: string): { mode: string; oid: string } | null {
  if (path === '') return { mode: '40000', oid: rootTree };
  const parts = path.split('/');
  let current = rootTree;
  for (let i = 0; i < parts.length; i += 1) {
    const tree = store.get(current);
    if (tree === undefined || tree.type !== 'tree') return null;
    const entry = parseTree(tree.data).find((candidate) => candidate.name === parts[i]);
    if (entry === undefined) return null;
    if (i === parts.length - 1) return { mode: entry.mode, oid: entry.oid };
    if (!isTreeMode(entry.mode)) return null;
    current = entry.oid;
  }
  return null;
}

/** Resolve a ref parameter (branch name or commit oid) to a commit oid. */
function resolveCommit(repo: Repo, ref: string | null): string | null {
  if (ref === null || ref === '') return branchTip(repo, repo.defaultBranch);
  const byBranch = branchTip(repo, ref);
  if (byBranch !== null) return byBranch;
  if (isOid(ref)) {
    const obj = repo.objects.get(ref);
    if (obj !== undefined && obj.type === 'commit') return ref;
    if (obj !== undefined && obj.type === 'tag') {
      const peeled = repo.objects.get(ref);
      void peeled;
    }
  }
  const byRef = repo.refs.get(ref) ?? repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(`refs/tags/${ref}`);
  return byRef ?? null;
}

// ---------------------------------------------------------------- handlers

export interface RestRequest {
  method: string;
  /** Path segments after /api/v3, decoded. */
  segments: string[];
  /** The full pathname (for Link headers). */
  pathname: string;
  query: URLSearchParams;
  body: unknown;
  host: string;
}

export function handleRest(forge: Forge, req: RestRequest): HttpResult {
  const { method, segments, query, body } = req;
  const data = bodyObject(body);

  // Root and meta.
  if (segments.length === 0) {
    if (method !== 'GET') return fail(405, 'Method Not Allowed');
    return json(200, {
      current_user_url: '/api/v3/user',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      issue_search_url: '/api/v3/search/issues',
      rate_limit_url: '/api/v3/rate_limit',
    }, { 'x-oauth-scopes': 'repo, read:org' });
  }
  if (segments[0] === 'meta' && segments.length === 1) {
    if (method !== 'GET') return fail(405, 'Method Not Allowed');
    return json(200, {
      verifiable_password_authentication: false,
      installed_version: '1.0.0',
      hooks: [],
      git: [],
      pages: [],
      importer: [],
    });
  }
  if (segments[0] === 'user' && segments.length === 1) {
    if (method !== 'GET') return fail(405, 'Method Not Allowed');
    return json(200, userObject());
  }
  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
    if (method === 'GET') {
      const all = [...forge.repos.values()].sort((a, b) => a.dbId - b.dbId).map((repo) => repoObject(forge, repo));
      const page = pageOf(query);
      const { items, headers } = paginate(all, page, req.host, req.pathname, query);
      return json(200, items, headers);
    }
    if (method === 'POST') return createRepo(forge, data);
    return fail(405, 'Method Not Allowed');
  }

  if (segments[0] === 'repos' && segments.length >= 3) {
    const owner = segments[1]!;
    const name = segments[2]!;
    const rest = segments.slice(3);
    if (rest.length === 0) {
      if (method === 'GET') {
        const repo = forge.repo(owner, name);
        return repo === null ? notFound() : json(200, repoObject(forge, repo));
      }
      if (method === 'PATCH') {
        const repo = forge.repo(owner, name);
        if (repo === null) return notFound();
        const description = stringField(data, 'description');
        if (description !== null) repo.description = description;
        if (typeof data.private === 'boolean') repo.isPrivate = data.private;
        const newName = stringField(data, 'name');
        if (newName !== null && newName !== '' && newName !== repo.name && !forge.repos.has(newName)) {
          forge.repos.delete(repo.name);
          repo.name = newName;
          forge.repos.set(newName, repo);
        }
        forge.tick();
        return json(200, repoObject(forge, repo));
      }
      if (method === 'DELETE') {
        if (!forge.deleteRepo(owner, name)) return notFound();
        return { status: 204, body: Buffer.alloc(0), contentType: JSON_TYPE };
      }
      return fail(405, 'Method Not Allowed');
    }
    const repo = forge.repo(owner, name);
    if (repo === null) return notFound();
    return handleRepoRoute(forge, repo, method, rest, req, data);
  }

  return notFound();
}

function createRepo(forge: Forge, data: Record<string, unknown>): HttpResult {
  const name = stringField(data, 'name');
  if (name === null || name === '') return fail(422, 'Repository creation failed: name is required.');
  if (forge.repos.has(name)) return fail(422, 'Repository creation failed: name already exists on this account.');
  const description = stringField(data, 'description') ?? '';
  const isPrivate = data.private === true;
  const repo = forge.createRepo(name, description, isPrivate);
  if (data.auto_init === true) {
    commitFiles(forge, repo, repo.defaultBranch, new Map([[ 'README.md', Buffer.from(`# ${name}\n`, 'utf8') ]]), 'Initial commit');
  }
  return json(201, repoObject(forge, repo));
}

function handleRepoRoute(forge: Forge, repo: Repo, method: string, rest: string[], req: RestRequest, data: Record<string, unknown>): HttpResult {
  const { query } = req;
  const head = rest[0]!;

  if (head === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const branches = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha, url: `/api/v3/repos/${VIEWER_LOGIN}/${repo.name}/commits/${sha}` }, protected: false }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      const page = pageOf(query);
      const { items, headers } = paginate(branches, page, req.host, req.pathname, query);
      return json(200, items, headers);
    }
    if (rest.length >= 2 && method === 'GET') {
      const branch = rest.slice(1).join('/');
      const tip = branchTip(repo, branch);
      if (tip === null) return notFound();
      return json(200, { name: branch, commit: commitObject(repo, tip), protected: false });
    }
    return fail(405, 'Method Not Allowed');
  }

  if (head === 'git' && rest[1] === 'refs') {
    if (rest.length === 2 && method === 'POST') {
      const ref = stringField(data, 'ref');
      const sha = stringField(data, 'sha');
      if (ref === null || !ref.startsWith('refs/')) return fail(422, 'Invalid ref.');
      if (sha === null || !repo.objects.has(sha)) return fail(422, 'Object does not exist.');
      if (repo.refs.has(ref)) return fail(422, 'Reference already exists.');
      repo.refs.set(ref, sha);
      forge.tick();
      const obj = repo.objects.get(sha)!;
      return json(201, { ref, node_id: '', url: `/api/v3/repos/${VIEWER_LOGIN}/${repo.name}/git/${ref}`, object: { type: obj.type, sha, url: '' } });
    }
    if (rest.length >= 3 && method === 'GET') {
      const tail = rest.slice(2).join('/');
      const full = tail.startsWith('refs/') ? tail : `refs/${tail}`;
      const sha = repo.refs.get(full);
      if (sha === undefined) return notFound();
      const obj = repo.objects.get(sha);
      return json(200, { ref: full, node_id: '', url: `/api/v3/repos/${VIEWER_LOGIN}/${repo.name}/git/${full}`, object: { type: obj?.type ?? 'commit', sha, url: '' } });
    }
    return fail(405, 'Method Not Allowed');
  }

  if (head === 'commits' && rest.length === 1 && method === 'GET') {
    const tip = resolveCommit(repo, query.get('sha'));
    if (tip === null) return fail(409, 'Git Repository is empty.');
    const all = listAncestry(repo.objects, tip, 10000).map((oid) => commitObject(repo, oid));
    const page = pageOf(query);
    const { items, headers } = paginate(all, page, req.host, req.pathname, query);
    return json(200, items, headers);
  }

  if (head === 'contents') {
    const path = rest.slice(1).join('/');
    if (method === 'GET') return getContents(forge, repo, path, query);
    if (method === 'PUT') return putContents(forge, repo, path, data);
    if (method === 'DELETE') return deleteContents(forge, repo, path, data);
    return fail(405, 'Method Not Allowed');
  }

  if (head === 'labels') {
    if (rest.length === 1 && method === 'GET') {
      return json(200, [...repo.labels.values()].map((label) => labelObject(repo, label)));
    }
    if (rest.length === 1 && method === 'POST') {
      const name = stringField(data, 'name');
      if (name === null || name === '') return fail(422, 'Validation Failed: name is required.');
      if (repo.labels.has(name)) return fail(422, 'Validation Failed: label already exists.');
      const colorRaw = stringField(data, 'color') ?? 'ededed';
      const label: Label = { name, color: colorRaw.replace(/^#/, ''), description: stringField(data, 'description') };
      repo.labels.set(name, label);
      forge.tick();
      return json(201, labelObject(repo, label));
    }
    return fail(405, 'Method Not Allowed');
  }

  if (head === 'issues') {
    if (rest.length === 1 && method === 'GET') {
      const state = query.get('state') ?? 'open';
      const direction = query.get('direction') ?? 'desc';
      let issues = [...repo.issues.values()];
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      issues.sort((a, b) => a.number - b.number);
      if (direction !== 'asc') issues.reverse();
      const page = pageOf(query);
      const { items, headers } = paginate(issues.map((issue) => issueObject(forge, repo, issue)), page, req.host, req.pathname, query);
      return json(200, items, headers);
    }
    if (rest.length === 1 && method === 'POST') return createIssue(forge, repo, data);
    if (rest.length >= 2) {
      const number = Number(rest[1]);
      const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;
      if (rest.length === 2 && method === 'GET') {
        return issue === undefined ? notFound() : json(200, issueObject(forge, repo, issue));
      }
      if (rest.length === 2 && method === 'PATCH') {
        if (issue === undefined) return notFound();
        const state = stringField(data, 'state');
        if (state === 'closed' || state === 'open') issue.state = state;
        const title = stringField(data, 'title');
        if (title !== null) issue.title = title;
        const bodyText = stringField(data, 'body');
        if (bodyText !== null) issue.body = bodyText;
        const labels = data.labels;
        if (Array.isArray(labels)) {
          const names = labels.filter((entry): entry is string => typeof entry === 'string');
          for (const labelName of names) if (!repo.labels.has(labelName)) return fail(422, `Validation Failed: label '${labelName}' does not exist.`);
          issue.labels = names;
        }
        forge.tick();
        return json(200, issueObject(forge, repo, issue));
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (issue === undefined) return notFound();
        if (method === 'GET') {
          const comments = [...issue.comments].sort((a, b) => a.globalId - b.globalId).map((comment) => commentObject(forge, repo, issue, comment));
          const page = pageOf(query);
          const { items, headers } = paginate(comments, page, req.host, req.pathname, query);
          return json(200, items, headers);
        }
        if (method === 'POST') {
          const text = stringField(data, 'body');
          if (text === null) return fail(422, 'Validation Failed: body is required.');
          forge.tick();
          const comment = { globalId: forge.allocCommentId(), body: text, createdSeq: forge.sequence() };
          issue.comments.push(comment);
          return json(201, commentObject(forge, repo, issue, comment));
        }
        return fail(405, 'Method Not Allowed');
      }
    }
    return notFound();
  }

  if (head === 'pulls') {
    if (rest.length === 1 && method === 'GET') {
      const state = query.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
      else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
      pulls.sort((a, b) => a.number - b.number);
      const page = pageOf(query);
      const { items, headers } = paginate(pulls.map((pull) => pullObject(forge, repo, pull)), page, req.host, req.pathname, query);
      return json(200, items, headers);
    }
    if (rest.length === 1 && method === 'POST') return createPull(forge, repo, data);
    if (rest.length >= 2) {
      const number = Number(rest[1]);
      const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
      if (rest.length === 2 && method === 'GET') {
        return pull === undefined ? notFound() : json(200, pullObject(forge, repo, pull));
      }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        if (pull === undefined) return notFound();
        const files = pullFiles(repo, pull).map((file) => ({
          sha: '',
          filename: file.filename,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          changes: file.changes,
        }));
        const page = pageOf(query);
        const { items, headers } = paginate(files, page, req.host, req.pathname, query);
        return json(200, items, headers);
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        if (pull === undefined) return notFound();
        return mergePull(forge, repo, pull, data);
      }
    }
    return notFound();
  }

  return notFound();
}

// ---------------------------------------------------------------- contents

function getContents(forge: Forge, repo: Repo, path: string, query: URLSearchParams): HttpResult {
  void forge;
  const commit = resolveCommit(repo, query.get('ref'));
  if (commit === null) return notFound();
  const commitObj = repo.objects.get(commit)!;
  const rootTree = parseCommit(commitObj.data).tree;
  const entry = treeEntryAt(repo.objects, rootTree, path);
  if (entry === null) return notFound();
  if (!isTreeMode(entry.mode)) {
    const blob = repo.objects.get(entry.oid);
    if (blob === undefined) return notFound();
    const name = path.split('/').pop() ?? path;
    return json(200, {
      type: 'file',
      encoding: 'base64',
      size: blob.data.length,
      name,
      path,
      content: blob.data.toString('base64'),
      sha: entry.oid,
      url: `/api/v3/repos/${VIEWER_LOGIN}/${repo.name}/contents/${path}`,
      html_url: `https://forge.local/${VIEWER_LOGIN}/${repo.name}/blob/${repo.defaultBranch}/${path}`,
      download_url: `https://forge.local/${VIEWER_LOGIN}/${repo.name}/raw/${path}`,
    });
  }
  const tree = repo.objects.get(entry.oid);
  if (tree === undefined) return notFound();
  const entries = parseTree(tree.data).map((child) => {
    const childPath = path === '' ? child.name : `${path}/${child.name}`;
    const childObj = repo.objects.get(child.oid);
    return {
      type: isTreeMode(child.mode) ? 'dir' : 'file',
      encoding: isTreeMode(child.mode) ? undefined : 'base64',
      size: !isTreeMode(child.mode) && childObj !== undefined ? childObj.data.length : 0,
      name: child.name,
      path: childPath,
      sha: child.oid,
      url: `/api/v3/repos/${VIEWER_LOGIN}/${repo.name}/contents/${childPath}`,
    };
  });
  entries.sort((a, b) => (a.name < b.name ? -1 : 1));
  return json(200, entries);
}

function putContents(forge: Forge, repo: Repo, path: string, data: Record<string, unknown>): HttpResult {
  if (path === '') return fail(422, 'Validation Failed: path is required.');
  const contentRaw = stringField(data, 'content');
  if (contentRaw === null) return fail(422, 'Validation Failed: content is required.');
  const content = Buffer.from(contentRaw.replace(/\s+/g, ''), 'base64');
  const branch = stringField(data, 'branch') ?? repo.defaultBranch;
  const message = stringField(data, 'message') ?? `Update ${path}`;
  const files = treeFilesAt(repo, branchTip(repo, branch));
  const existing = files.get(path);
  const sha = stringField(data, 'sha');
  if (existing !== undefined && sha !== null && sha !== existing.oid) {
    return fail(409, `${path} does not match the given sha.`);
  }
  const commitOid = commitFiles(forge, repo, branch, new Map([[path, content]]), message);
  const blobOid = hashObject('blob', content);
  return json(existing !== undefined ? 200 : 201, {
    content: {
      type: 'file',
      encoding: 'base64',
      size: content.length,
      name: path.split('/').pop() ?? path,
      path,
      sha: blobOid,
      url: `/api/v3/repos/${VIEWER_LOGIN}/${repo.name}/contents/${path}`,
    },
    commit: { sha: commitOid, message, author: { name: VIEWER_NAME, email: VIEWER_EMAIL }, committer: { name: VIEWER_NAME, email: VIEWER_EMAIL } },
  });
}

function deleteContents(forge: Forge, repo: Repo, path: string, data: Record<string, unknown>): HttpResult {
  const branch = stringField(data, 'branch') ?? repo.defaultBranch;
  const message = stringField(data, 'message') ?? `Delete ${path}`;
  const files = treeFilesAt(repo, branchTip(repo, branch));
  const existing = files.get(path);
  if (existing === undefined) return notFound();
  const sha = stringField(data, 'sha');
  if (sha !== null && sha !== existing.oid) return fail(409, `${path} does not match the given sha.`);
  const commitOid = commitFiles(forge, repo, branch, new Map([[path, null]]), message);
  return json(200, { content: null, commit: { sha: commitOid, message } });
}

// ---------------------------------------------------------------- issues and pulls

export function createIssue(forge: Forge, repo: Repo, data: Record<string, unknown>): HttpResult {
  const title = stringField(data, 'title');
  if (title === null || title === '') return fail(422, 'Validation Failed: title is required.');
  const labelNames: string[] = [];
  if (Array.isArray(data.labels)) {
    for (const entry of data.labels) {
      const labelName = typeof entry === 'string' ? entry : (typeof entry === 'object' && entry !== null && typeof (entry as { name?: unknown }).name === 'string' ? (entry as { name: string }).name : null);
      if (labelName === null) return fail(422, 'Validation Failed: labels must be names.');
      if (!repo.labels.has(labelName)) return fail(422, `Validation Failed: label '${labelName}' does not exist.`);
      labelNames.push(labelName);
    }
  }
  forge.tick();
  const issue: Issue = {
    globalId: forge.allocGlobalId(),
    number: repo.nextNumber,
    title,
    body: stringField(data, 'body') ?? '',
    state: 'open',
    labels: labelNames,
    comments: [],
    createdSeq: forge.sequence(),
  };
  repo.nextNumber += 1;
  repo.issues.set(issue.number, issue);
  return json(201, issueObject(forge, repo, issue));
}

function createPull(forge: Forge, repo: Repo, data: Record<string, unknown>): HttpResult {
  const title = stringField(data, 'title');
  let head = stringField(data, 'head');
  let base = stringField(data, 'base');
  if (title === null || title === '' || head === null || base === null) return fail(422, 'Validation Failed: title, head and base are required.');
  if (head.includes(':')) head = head.split(':').pop()!;
  if (base.includes(':')) base = base.split(':').pop()!;
  if (branchTip(repo, base) === null) return fail(422, `Validation Failed: base branch '${base}' does not exist.`);
  if (branchTip(repo, head) === null) return fail(422, `Validation Failed: head branch '${head}' does not exist.`);
  for (const existing of repo.pulls.values()) {
    if (existing.state === 'open' && existing.headRef === head && existing.baseRef === base) {
      return fail(422, `Validation Failed: A pull request already exists for ${VIEWER_LOGIN}:${head}.`);
    }
  }
  forge.tick();
  const pull: Pull = {
    globalId: forge.allocGlobalId(),
    number: repo.nextNumber,
    title,
    body: stringField(data, 'body') ?? '',
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
  return json(201, pullObject(forge, repo, pull));
}

function mergePull(forge: Forge, repo: Repo, pull: Pull, data: Record<string, unknown>): HttpResult {
  if (pull.merged) return fail(409, 'Pull Request has already been merged.');
  if (pull.state !== 'open') return fail(405, 'Pull Request is not mergeable.');
  const state = pullMergeState(repo, pull);
  if (!state.mergeable) return fail(405, 'Pull Request is not mergeable.');
  const method = stringField(data, 'merge_method') ?? 'merge';
  const sha = method === 'merge' ? mergeCommitMerge(forge, repo, pull) : squashMerge(forge, repo, pull);
  if (sha === null) return fail(405, 'Pull Request is not mergeable.');
  return json(200, { sha, merged: true, message: 'Pull Request successfully merged' });
}

