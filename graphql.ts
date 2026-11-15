// graphql.ts: a small GraphQL executor for the documents gh and github-mcp-server send — queries,
// mutations, variables, aliases, inline and named fragments, input objects, enums, connections
// with cursor pagination, Relay-style global ids, introspection of the checked types, and
// batched operation arrays. Validation names unknown fields the way GitHub does.

import {
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  branchTip,
  globalId,
  parseGlobalId,
  pullFiles,
  pullMergeState,
  squashMerge,
  mergeCommitMerge,
  type Forge,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';
import type { HttpResult } from './gitserver.ts';

// ---------------------------------------------------------------- lexer and parser

type ValueNode =
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'var'; name: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Map<string, ValueNode> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Map<string, ValueNode>;
  selectionSet: SelectionNode[] | null;
}

type SelectionNode =
  | FieldNode
  | { kind: 'inline'; typeCondition: string; selectionSet: SelectionNode[] }
  | { kind: 'spread'; name: string };

interface OperationNode {
  type: 'query' | 'mutation';
  name: string | null;
  selectionSet: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, { typeCondition: string; selectionSet: SelectionNode[] }>;
}

const PUNCTUATORS = '!$():=@[]{}|';

function tokenize(source: string): Array<{ kind: string; value: string }> {
  const tokens: Array<{ kind: string; value: string }> = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: '...', value: '...' });
      i += 3;
      continue;
    }
    if (PUNCTUATORS.includes(ch)) {
      tokens.push({ kind: ch, value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1]!;
          if (esc === 'n') value += '\n';
          else if (esc === 't') value += '\t';
          else if (esc === 'r') value += '\r';
          else if (esc === 'u') {
            value += String.fromCharCode(parseInt(source.slice(j + 2, j + 6), 16));
            j += 4;
          } else value += esc;
          j += 2;
        } else {
          value += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      const match = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(source.slice(i))!;
      tokens.push({ kind: match[1] !== undefined || match[2] !== undefined ? 'float' : 'int', value: match[0] });
      i += match[0].length;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      const match = /^[_0-9A-Za-z]+/.exec(source.slice(i))!;
      tokens.push({ kind: 'name', value: match[0] });
      i += match[0].length;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: Array<{ kind: string; value: string }>;

  constructor(tokens: Array<{ kind: string; value: string }>) {
    this.tokens = tokens;
  }

  private peek(): { kind: string; value: string } {
    return this.tokens[this.pos]!;
  }

  private next(): { kind: string; value: string } {
    const token = this.tokens[this.pos]!;
    this.pos += 1;
    return token;
  }

  private expect(kind: string): { kind: string; value: string } {
    const token = this.next();
    if (token.kind !== kind) throw new Error(`expected ${kind}, found ${token.kind} ${JSON.stringify(token.value)}`);
    return token;
  }

  private skip(kind: string): boolean {
    if (this.peek().kind === kind) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, { typeCondition: string; selectionSet: SelectionNode[] }>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === '{') {
        operations.push({ type: 'query', name: null, selectionSet: this.parseSelectionSet() });
      } else if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
        this.next();
        const type = token.value === 'mutation' ? 'mutation' : 'query';
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value;
        if (this.peek().kind === '(') this.parseVariableDefinitions();
        this.skipDirectives();
        operations.push({ type, name, selectionSet: this.parseSelectionSet() });
      } else if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const fragName = this.expect('name').value;
        this.expect('name'); // 'on' is lexed as a name
        const typeCondition = this.expect('name').value;
        this.skipDirectives();
        fragments.set(fragName, { typeCondition, selectionSet: this.parseSelectionSet() });
      } else {
        throw new Error(`unexpected token ${token.kind} ${JSON.stringify(token.value)}`);
      }
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): void {
    this.expect('(');
    while (this.peek().kind !== ')') {
      this.expect('$');
      this.expect('name');
      this.expect(':');
      this.parseType();
      if (this.skip('=')) this.parseValue();
      this.skipDirectives();
    }
    this.expect(')');
  }

  private parseType(): void {
    if (this.skip('[')) {
      this.parseType();
      this.expect(']');
    } else {
      this.expect('name');
    }
    this.skip('!');
  }

  private skipDirectives(): void {
    while (this.skip('@')) {
      this.expect('name');
      if (this.peek().kind === '(') this.parseArguments();
    }
  }

  private parseArguments(): Map<string, ValueNode> {
    const args = new Map<string, ValueNode>();
    this.expect('(');
    while (this.peek().kind !== ')') {
      const name = this.expect('name').value;
      this.expect(':');
      args.set(name, this.parseValue());
    }
    this.expect(')');
    return args;
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const selections: SelectionNode[] = [];
    while (this.peek().kind !== '}') selections.push(this.parseSelection());
    this.expect('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.peek().kind === '...') {
      this.next();
      const token = this.peek();
      if (token.kind === 'name' && token.value === 'on') {
        this.next();
        const typeCondition = this.expect('name').value;
        this.skipDirectives();
        return { kind: 'inline', typeCondition, selectionSet: this.parseSelectionSet() };
      }
      const name = this.expect('name').value;
      this.skipDirectives();
      return { kind: 'spread', name };
    }
    let name = this.expect('name').value;
    let alias: string | null = null;
    if (this.skip(':')) {
      alias = name;
      name = this.expect('name').value;
    }
    const args = this.peek().kind === '(' ? this.parseArguments() : new Map<string, ValueNode>();
    this.skipDirectives();
    const selectionSet = this.peek().kind === '{' ? this.parseSelectionSet() : null;
    return { kind: 'field', alias, name, args, selectionSet };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    switch (token.kind) {
      case '$':
        return { kind: 'var', name: this.expect('name').value };
      case 'string':
        return { kind: 'string', value: token.value };
      case 'int':
        return { kind: 'int', value: Number(token.value) };
      case 'float':
        return { kind: 'float', value: Number(token.value) };
      case 'name':
        if (token.value === 'true') return { kind: 'bool', value: true };
        if (token.value === 'false') return { kind: 'bool', value: false };
        if (token.value === 'null') return { kind: 'null' };
        return { kind: 'enum', value: token.value };
      case '[': {
        const items: ValueNode[] = [];
        while (this.peek().kind !== ']') items.push(this.parseValue());
        this.expect(']');
        return { kind: 'list', items };
      }
      case '{': {
        const fields = new Map<string, ValueNode>();
        while (this.peek().kind !== '}') {
          const name = this.expect('name').value;
          this.expect(':');
          fields.set(name, this.parseValue());
        }
        this.expect('}');
        return { kind: 'object', fields };
      }
      default:
        throw new Error(`unexpected value token ${token.kind}`);
    }
  }
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'string':
    case 'int':
    case 'float':
    case 'bool':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'var':
      return variables[node.name] ?? null;
    case 'list':
      return node.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of node.fields) out[key] = resolveValue(value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------- schema

type Resolver = (source: never, args: Record<string, unknown>, forge: Forge) => unknown;

interface FieldDef {
  type: string;
  list?: boolean;
  resolve: Resolver;
}

type TypeDef = Record<string, FieldDef>;

const scalar = (type: string, resolve: Resolver): FieldDef => ({ type, resolve });
const object = (type: string, resolve: Resolver): FieldDef => ({ type, resolve });
const listOf = (type: string, resolve: Resolver): FieldDef => ({ type, list: true, resolve });

interface RepoData { __typename: 'Repository'; repo: Repo }
interface IssueData { __typename: 'Issue'; repo: Repo; issue: Issue }
interface PullData { __typename: 'PullRequest'; repo: Repo; pull: Pull }
interface CommentData { __typename: 'IssueComment'; repo: Repo; issue: Issue; comment: Issue['comments'][number] }

const userData = (): { __typename: 'User' } => ({ __typename: 'User' });
const repoData = (repo: Repo): RepoData => ({ __typename: 'Repository', repo });
const issueData = (repo: Repo, issue: Issue): IssueData => ({ __typename: 'Issue', repo, issue });
const pullData = (repo: Repo, pull: Pull): PullData => ({ __typename: 'PullRequest', repo, pull });

function cursorFor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function indexAfter(after: unknown): number {
  if (typeof after !== 'string' || after === '') return 0;
  try {
    const decoded = Buffer.from(after, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(decoded);
    if (match !== null) return Number(match[1]) + 1;
  } catch {
    // fall through
  }
  return 0;
}

interface Page<T> {
  nodes: T[];
  pageInfo: { hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null };
  totalCount: number;
}

function paginate<T>(items: T[], args: Record<string, unknown>): Page<T> {
  const first = typeof args.first === 'number' && Number.isFinite(args.first) ? Math.max(0, Math.trunc(args.first)) : 100;
  const start = indexAfter(args.after);
  const slice = items.slice(start, start + first);
  return {
    nodes: slice,
    pageInfo: {
      hasNextPage: start + first < items.length,
      hasPreviousPage: start > 0,
      startCursor: slice.length > 0 ? cursorFor(start) : null,
      endCursor: slice.length > 0 ? cursorFor(start + slice.length - 1) : null,
    },
    totalCount: items.length,
  };
}

const SCHEMA: Record<string, TypeDef> = {
  Query: {
    viewer: object('User', () => userData()),
    repository: object('Repository', (_s, args, forge) => {
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const name = typeof args.name === 'string' ? args.name : '';
      const repo = forge.repo(owner, name);
      return repo === null ? null : repoData(repo);
    }),
    node: object('Node', (_s, args, forge) => {
      const id = typeof args.id === 'string' ? args.id : '';
      const parsed = parseGlobalId(id);
      if (parsed === null) return null;
      if (parsed.type === 'Repository') {
        const repo = forge.repoByDbId(parsed.numeric);
        return repo === null ? null : repoData(repo);
      }
      if (parsed.type === 'Issue') {
        const found = forge.findByGlobalId('issue', parsed.numeric);
        return found === null ? null : issueData(found.repo, found.item as Issue);
      }
      if (parsed.type === 'PullRequest') {
        const found = forge.findByGlobalId('pull', parsed.numeric);
        return found === null ? null : pullData(found.repo, found.item as Pull);
      }
      return null;
    }),
    __type: object('__Type', (_s, args) => {
      const name = typeof args.name === 'string' ? args.name : '';
      return TYPE_FIELDS[name] !== undefined || TYPE_ENUMS[name] !== undefined ? { __typename: '__Type', name } : null;
    }),
    __schema: object('__Schema', () => ({ __typename: '__Schema' })),
  },
  Mutation: {
    createIssue: object('CreateIssuePayload', (_s, args, forge) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(typeof input.repositoryId === 'string' ? input.repositoryId : '');
      if (parsed === null || parsed.type !== 'Repository') throw new Error('repositoryId is not a repository id');
      const repo = forge.repoByDbId(parsed.numeric);
      if (repo === null) throw new Error('repository not found');
      forge.tick();
      const issue: Issue = {
        globalId: forge.allocGlobalId(),
        number: repo.nextNumber,
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        labels: [],
        comments: [],
        createdSeq: forge.sequence(),
      };
      repo.nextNumber += 1;
      repo.issues.set(issue.number, issue);
      return { __typename: 'CreateIssuePayload', issue: issueData(repo, issue), clientMutationId: input.clientMutationId ?? null };
    }),
    closeIssue: object('CloseIssuePayload', (_s, args, forge) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(typeof input.issueId === 'string' ? input.issueId : '');
      if (parsed === null || parsed.type !== 'Issue') throw new Error('issueId is not an issue id');
      const found = forge.findByGlobalId('issue', parsed.numeric);
      if (found === null) throw new Error('issue not found');
      (found.item as Issue).state = 'closed';
      forge.tick();
      return { __typename: 'CloseIssuePayload', issue: issueData(found.repo, found.item as Issue), clientMutationId: input.clientMutationId ?? null };
    }),
    createPullRequest: object('CreatePullRequestPayload', (_s, args, forge) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(typeof input.repositoryId === 'string' ? input.repositoryId : '');
      if (parsed === null || parsed.type !== 'Repository') throw new Error('repositoryId is not a repository id');
      const repo = forge.repoByDbId(parsed.numeric);
      if (repo === null) throw new Error('repository not found');
      const head = typeof input.headRefName === 'string' ? input.headRefName : '';
      const base = typeof input.baseRefName === 'string' ? input.baseRefName : '';
      if (branchTip(repo, base) === null) throw new Error(`base branch '${base}' does not exist`);
      if (branchTip(repo, head) === null) throw new Error(`head branch '${head}' does not exist`);
      forge.tick();
      const pull: Pull = {
        globalId: forge.allocGlobalId(),
        number: repo.nextNumber,
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
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
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullData(repo, pull), clientMutationId: input.clientMutationId ?? null };
    }),
    mergePullRequest: object('MergePullRequestPayload', (_s, args, forge) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(typeof input.pullRequestId === 'string' ? input.pullRequestId : '');
      if (parsed === null || parsed.type !== 'PullRequest') throw new Error('pullRequestId is not a pull request id');
      const found = forge.findByGlobalId('pull', parsed.numeric);
      if (found === null) throw new Error('pull request not found');
      const pull = found.item as Pull;
      const method = typeof input.mergeMethod === 'string' ? input.mergeMethod : 'SQUASH';
      const sha = method === 'MERGE' ? mergeCommitMerge(forge, found.repo, pull) : squashMerge(forge, found.repo, pull);
      if (sha === null) throw new Error('Pull request is not mergeable');
      return { __typename: 'MergePullRequestPayload', pullRequest: pullData(found.repo, pull), clientMutationId: input.clientMutationId ?? null };
    }),
    addComment: object('AddCommentPayload', (_s, args, forge) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(typeof input.subjectId === 'string' ? input.subjectId : '');
      if (parsed === null || parsed.type !== 'Issue') throw new Error('subjectId is not an issue id');
      const found = forge.findByGlobalId('issue', parsed.numeric);
      if (found === null) throw new Error('issue not found');
      const issue = found.item as Issue;
      forge.tick();
      const comment = { globalId: forge.allocCommentId(), body: typeof input.body === 'string' ? input.body : '', createdSeq: forge.sequence() };
      issue.comments.push(comment);
      const data: CommentData = { __typename: 'IssueComment', repo: found.repo, issue, comment };
      return {
        __typename: 'AddCommentPayload',
        commentEdge: { __typename: 'CommentEdge', node: data, cursor: cursorFor(0) },
        subject: issueData(found.repo, issue),
        clientMutationId: input.clientMutationId ?? null,
      };
    }),
  },
  User: {
    login: scalar('String', () => VIEWER_LOGIN),
    id: scalar('ID', () => Buffer.from(`04:User${VIEWER_ID}`, 'utf8').toString('base64')),
    databaseId: scalar('Int', () => VIEWER_ID),
    name: scalar('String', () => VIEWER_NAME),
    email: scalar('String', () => VIEWER_EMAIL),
  },
  Repository: {
    id: scalar('ID', (s: RepoData) => globalId('Repository', s.repo.dbId)),
    databaseId: scalar('Int', (s: RepoData) => s.repo.dbId),
    name: scalar('String', (s: RepoData) => s.repo.name),
    nameWithOwner: scalar('String', (s: RepoData) => `${VIEWER_LOGIN}/${s.repo.name}`),
    owner: object('User', () => userData()),
    defaultBranchRef: object('Ref', (s: RepoData) => (branchTip(s.repo, s.repo.defaultBranch) === null ? null : { __typename: 'Ref', name: s.repo.defaultBranch })),
    viewerPermission: scalar('String', () => 'ADMIN'),
    hasIssuesEnabled: scalar('Boolean', () => true),
    hasWikiEnabled: scalar('Boolean', () => true),
    isPrivate: scalar('Boolean', (s: RepoData) => s.repo.isPrivate),
    isFork: scalar('Boolean', () => false),
    description: scalar('String', (s: RepoData) => s.repo.description),
    url: scalar('String', (s: RepoData) => `https://forge.local/${VIEWER_LOGIN}/${s.repo.name}`),
    createdAt: scalar('String', (s: RepoData, _a, forge) => forge.isoOfSeq(s.repo.createdSeq)),
    updatedAt: scalar('String', (s: RepoData, _a, forge) => forge.isoOfSeq(s.repo.createdSeq)),
    issue: object('Issue', (s: RepoData, args) => {
      const issue = typeof args.number === 'number' ? s.repo.issues.get(args.number) : undefined;
      return issue === undefined ? null : issueData(s.repo, issue);
    }),
    issues: object('IssueConnection', (s: RepoData, args) => {
      let items = [...s.repo.issues.values()];
      if (Array.isArray(args.states)) {
        const states = new Set((args.states as unknown[]).map((entry) => String(entry).toUpperCase()));
        items = items.filter((issue) => states.has(issue.state.toUpperCase()));
      }
      const orderBy = (args.orderBy ?? null) as { field?: string; direction?: string } | null;
      items.sort((a, b) => a.number - b.number);
      if (orderBy !== null && orderBy.direction === 'DESC') items.reverse();
      const page = paginate(items, args);
      return {
        __typename: 'IssueConnection',
        nodes: page.nodes.map((issue) => issueData(s.repo, issue)),
        pageInfo: { __typename: 'PageInfo', ...page.pageInfo },
        totalCount: page.totalCount,
        _items: page.nodes.map((issue) => issueData(s.repo, issue)),
        _repo: s.repo,
      };
    }),
    pullRequest: object('PullRequest', (s: RepoData, args) => {
      const pull = typeof args.number === 'number' ? s.repo.pulls.get(args.number) : undefined;
      return pull === undefined ? null : pullData(s.repo, pull);
    }),
    pullRequests: object('PullRequestConnection', (s: RepoData, args) => {
      let items = [...s.repo.pulls.values()];
      if (Array.isArray(args.states)) {
        const states = new Set((args.states as unknown[]).map((entry) => String(entry).toUpperCase()));
        items = items.filter((pull) => states.has(pull.merged ? 'MERGED' : pull.state.toUpperCase()));
      }
      items.sort((a, b) => a.number - b.number);
      const page = paginate(items, args);
      return {
        __typename: 'PullRequestConnection',
        nodes: page.nodes.map((pull) => pullData(s.repo, pull)),
        pageInfo: { __typename: 'PageInfo', ...page.pageInfo },
        totalCount: page.totalCount,
      };
    }),
  },
  Ref: {
    name: scalar('String', (s: { name: string }) => s.name),
    prefix: scalar('String', () => 'refs/heads/'),
  },
  Issue: {
    id: scalar('ID', (s: IssueData) => globalId('Issue', s.issue.globalId)),
    databaseId: scalar('Int', (s: IssueData) => s.issue.globalId),
    number: scalar('Int', (s: IssueData) => s.issue.number),
    title: scalar('String', (s: IssueData) => s.issue.title),
    state: scalar('String', (s: IssueData) => s.issue.state.toUpperCase()),
    body: scalar('String', (s: IssueData) => s.issue.body),
    bodyText: scalar('String', (s: IssueData) => s.issue.body),
    url: scalar('String', (s: IssueData) => `https://forge.local/${VIEWER_LOGIN}/${s.repo.name}/issues/${s.issue.number}`),
    createdAt: scalar('String', (s: IssueData, _a, forge) => forge.isoOfSeq(s.issue.createdSeq)),
    updatedAt: scalar('String', (s: IssueData, _a, forge) => forge.isoOfSeq(s.issue.createdSeq)),
    closedAt: scalar('String', (s: IssueData, _a, forge) => (s.issue.state === 'closed' ? forge.isoOfSeq(s.issue.createdSeq) : null)),
    closed: scalar('Boolean', (s: IssueData) => s.issue.state === 'closed'),
    author: object('User', () => userData()),
    repository: object('Repository', (s: IssueData) => repoData(s.repo)),
    labels: object('LabelConnection', (s: IssueData) => ({
      __typename: 'LabelConnection',
      nodes: s.issue.labels.map((name) => ({ __typename: 'Label', name, color: s.repo.labels.get(name)?.color ?? 'ededed' })),
      totalCount: s.issue.labels.length,
    })),
    comments: object('IssueCommentConnection', (s: IssueData, args) => {
      const page = paginate([...s.issue.comments], args);
      return {
        __typename: 'IssueCommentConnection',
        nodes: page.nodes.map((comment): CommentData => ({ __typename: 'IssueComment', repo: s.repo, issue: s.issue, comment })),
        pageInfo: { __typename: 'PageInfo', ...page.pageInfo },
        totalCount: page.totalCount,
      };
    }),
  },
  PullRequest: {
    id: scalar('ID', (s: PullData) => globalId('PullRequest', s.pull.globalId)),
    databaseId: scalar('Int', (s: PullData) => s.pull.globalId),
    number: scalar('Int', (s: PullData) => s.pull.number),
    title: scalar('String', (s: PullData) => s.pull.title),
    body: scalar('String', (s: PullData) => s.pull.body),
    state: scalar('String', (s: PullData) => (s.pull.merged ? 'MERGED' : s.pull.state.toUpperCase())),
    merged: scalar('Boolean', (s: PullData) => s.pull.merged),
    mergeable: scalar('String', (s: PullData) => {
      if (s.pull.state !== 'open') return 'UNKNOWN';
      return pullMergeState(s.repo, s.pull).mergeable ? 'MERGEABLE' : 'CONFLICTING';
    }),
    headRefName: scalar('String', (s: PullData) => s.pull.headRef),
    baseRefName: scalar('String', (s: PullData) => s.pull.baseRef),
    headRefOid: scalar('String', (s: PullData) => branchTip(s.repo, s.pull.headRef) ?? ''),
    baseRefOid: scalar('String', (s: PullData) => branchTip(s.repo, s.pull.baseRef) ?? ''),
    url: scalar('String', (s: PullData) => `https://forge.local/${VIEWER_LOGIN}/${s.repo.name}/pull/${s.pull.number}`),
    createdAt: scalar('String', (s: PullData, _a, forge) => forge.isoOfSeq(s.pull.createdSeq)),
    updatedAt: scalar('String', (s: PullData, _a, forge) => forge.isoOfSeq(s.pull.createdSeq)),
    mergedAt: scalar('String', (s: PullData, _a, forge) => (s.pull.merged && s.pull.mergedSeq !== null ? forge.isoOfSeq(s.pull.mergedSeq) : null)),
    closedAt: scalar('String', (s: PullData, _a, forge) => (s.pull.state === 'closed' ? forge.isoOfSeq(s.pull.mergedSeq ?? s.pull.createdSeq) : null)),
    author: object('User', () => userData()),
    repository: object('Repository', (s: PullData) => repoData(s.repo)),
    files: object('PullRequestFileConnection', (s: PullData, args) => {
      const files = pullFiles(s.repo, s.pull);
      const page = paginate(files, args);
      return {
        __typename: 'PullRequestFileConnection',
        nodes: page.nodes.map((file) => ({
          __typename: 'PullRequestFile',
          path: file.filename,
          additions: file.additions,
          deletions: file.deletions,
          changeType: file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'DELETED' : 'MODIFIED',
        })),
        pageInfo: { __typename: 'PageInfo', ...page.pageInfo },
        totalCount: page.totalCount,
      };
    }),
  },
  IssueComment: {
    id: scalar('ID', (s: CommentData) => globalId('IssueComment', s.comment.globalId)),
    databaseId: scalar('Int', (s: CommentData) => s.comment.globalId),
    body: scalar('String', (s: CommentData) => s.comment.body),
    bodyText: scalar('String', (s: CommentData) => s.comment.body),
    createdAt: scalar('String', (s: CommentData, _a, forge) => forge.isoOfSeq(s.comment.createdSeq)),
    updatedAt: scalar('String', (s: CommentData, _a, forge) => forge.isoOfSeq(s.comment.createdSeq)),
    author: object('User', () => userData()),
    url: scalar('String', (s: CommentData) => `https://forge.local/${VIEWER_LOGIN}/${s.repo.name}/issues/${s.issue.number}#issuecomment-${s.comment.globalId}`),
  },
  Label: {
    id: scalar('ID', (s: { name: string }) => Buffer.from(`07:Label${s.name}`, 'utf8').toString('base64')),
    name: scalar('String', (s: { name: string }) => s.name),
    color: scalar('String', (s: { color: string }) => s.color),
  },
  PageInfo: {
    hasNextPage: scalar('Boolean', (s: { hasNextPage: boolean }) => s.hasNextPage),
    hasPreviousPage: scalar('Boolean', (s: { hasPreviousPage: boolean }) => s.hasPreviousPage),
    startCursor: scalar('String', (s: { startCursor: string | null }) => s.startCursor),
    endCursor: scalar('String', (s: { endCursor: string | null }) => s.endCursor),
  },
  IssueConnection: {
    nodes: listOf('Issue', (s: { nodes: unknown }) => s.nodes),
    edges: listOf('IssueEdge', (s: { _items?: IssueData[] }) => (s._items ?? []).map((node, index) => ({ __typename: 'IssueEdge', node, cursor: cursorFor(index) }))),
    pageInfo: object('PageInfo', (s: { pageInfo: unknown }) => s.pageInfo),
    totalCount: scalar('Int', (s: { totalCount: number }) => s.totalCount),
  },
  IssueEdge: {
    node: object('Issue', (s: { node: unknown }) => s.node),
    cursor: scalar('String', (s: { cursor: string }) => s.cursor),
  },
  PullRequestConnection: {
    nodes: listOf('PullRequest', (s: { nodes: unknown }) => s.nodes),
    pageInfo: object('PageInfo', (s: { pageInfo: unknown }) => s.pageInfo),
    totalCount: scalar('Int', (s: { totalCount: number }) => s.totalCount),
  },
  PullRequestFileConnection: {
    nodes: listOf('PullRequestFile', (s: { nodes: unknown }) => s.nodes),
    pageInfo: object('PageInfo', (s: { pageInfo: unknown }) => s.pageInfo),
    totalCount: scalar('Int', (s: { totalCount: number }) => s.totalCount),
  },
  PullRequestFile: {
    path: scalar('String', (s: { path: string }) => s.path),
    additions: scalar('Int', (s: { additions: number }) => s.additions),
    deletions: scalar('Int', (s: { deletions: number }) => s.deletions),
    changeType: scalar('String', (s: { changeType: string }) => s.changeType),
  },
  IssueCommentConnection: {
    nodes: listOf('IssueComment', (s: { nodes: unknown }) => s.nodes),
    pageInfo: object('PageInfo', (s: { pageInfo: unknown }) => s.pageInfo),
    totalCount: scalar('Int', (s: { totalCount: number }) => s.totalCount),
  },
  LabelConnection: {
    nodes: listOf('Label', (s: { nodes: unknown }) => s.nodes),
    totalCount: scalar('Int', (s: { totalCount: number }) => s.totalCount),
  },
  CreateIssuePayload: {
    issue: object('Issue', (s: { issue: unknown }) => s.issue),
    clientMutationId: scalar('String', (s: { clientMutationId: unknown }) => s.clientMutationId),
  },
  CloseIssuePayload: {
    issue: object('Issue', (s: { issue: unknown }) => s.issue),
    clientMutationId: scalar('String', (s: { clientMutationId: unknown }) => s.clientMutationId),
  },
  CreatePullRequestPayload: {
    pullRequest: object('PullRequest', (s: { pullRequest: unknown }) => s.pullRequest),
    clientMutationId: scalar('String', (s: { clientMutationId: unknown }) => s.clientMutationId),
  },
  MergePullRequestPayload: {
    pullRequest: object('PullRequest', (s: { pullRequest: unknown }) => s.pullRequest),
    clientMutationId: scalar('String', (s: { clientMutationId: unknown }) => s.clientMutationId),
  },
  AddCommentPayload: {
    commentEdge: object('CommentEdge', (s: { commentEdge: unknown }) => s.commentEdge),
    subject: object('Issue', (s: { subject: unknown }) => s.subject),
    clientMutationId: scalar('String', (s: { clientMutationId: unknown }) => s.clientMutationId),
  },
  CommentEdge: {
    node: object('IssueComment', (s: { node: unknown }) => s.node),
    cursor: scalar('String', (s: { cursor: string }) => s.cursor),
  },
  __Type: {
    name: scalar('String', (s: { name: string }) => s.name),
    kind: scalar('String', (s: { name: string }) => (TYPE_ENUMS[s.name] !== undefined ? 'ENUM' : 'OBJECT')),
    fields: listOf('__Field', (s: { name: string }) => (TYPE_FIELDS[s.name] ?? []).map((name) => ({ __typename: '__Field', name }))),
    enumValues: listOf('__EnumValue', (s: { name: string }) => (TYPE_ENUMS[s.name] ?? []).map((name) => ({ __typename: '__EnumValue', name }))),
  },
  __Field: {
    name: scalar('String', (s: { name: string }) => s.name),
  },
  __EnumValue: {
    name: scalar('String', (s: { name: string }) => s.name),
  },
  __Schema: {
    queryType: object('__Type', () => ({ __typename: '__Type', name: 'Query' })),
    mutationType: object('__Type', () => ({ __typename: '__Type', name: 'Mutation' })),
    types: listOf('__Type', () => Object.keys(TYPE_FIELDS).map((name) => ({ __typename: '__Type', name }))),
  },
  Node: {
    id: scalar('ID', (s: RepoData | IssueData | PullData) => {
      if (s.__typename === 'Repository') return globalId('Repository', s.repo.dbId);
      if (s.__typename === 'Issue') return globalId('Issue', s.issue.globalId);
      return globalId('PullRequest', s.pull.globalId);
    }),
  },
};

/** Field name lists for introspection (what __type(name:).fields returns). */
const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'search', 'rateLimit'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id', 'databaseId', 'name', 'email', 'url', 'createdAt', 'updatedAt'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'hasWikiEnabled', 'hasProjectsEnabled', 'isPrivate', 'isFork', 'isArchived',
    'description', 'url', 'resourcePath', 'homepageUrl', 'createdAt', 'updatedAt', 'pushedAt',
    'issue', 'issues', 'pullRequest', 'pullRequests', 'stargazerCount', 'forkCount', 'primaryLanguage',
    'refs', 'ref', 'branchProtectionRules', 'labels', 'milestones', 'repositoryTopics', 'watchers',
  ],
  Issue: [
    'id', 'databaseId', 'number', 'title', 'titleHTML', 'state', 'body', 'bodyText', 'bodyHTML',
    'url', 'resourcePath', 'createdAt', 'updatedAt', 'closedAt', 'closed', 'author', 'editor',
    'repository', 'labels', 'comments', 'assignees', 'participants', 'locked', 'isPinned',
    'viewerCanReact', 'milestone', 'reactions', 'timelineItems',
  ],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'titleHTML', 'state', 'body', 'bodyText', 'bodyHTML',
    'url', 'resourcePath', 'createdAt', 'updatedAt', 'closedAt', 'mergedAt', 'merged', 'mergeable',
    'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'headRef', 'baseRef', 'files',
    'commits', 'comments', 'reviews', 'author', 'editor', 'repository', 'isDraft', 'additions',
    'deletions', 'changedFiles', 'labels', 'participants', 'mergeCommit', 'potentialMergeCommit',
  ],
  Ref: ['id', 'name', 'prefix', 'target', 'repository'],
  IssueComment: ['id', 'databaseId', 'body', 'bodyText', 'bodyHTML', 'createdAt', 'updatedAt', 'author', 'editor', 'url', 'issue', 'pullRequest'],
  Label: ['id', 'name', 'color', 'description', 'url'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestFileConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestFile: ['path', 'additions', 'deletions', 'changeType'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  LabelConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  CommentEdge: ['node', 'cursor'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'possibleTypes', 'inputFields', 'ofType'],
  __Field: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __Schema: ['types', 'queryType', 'mutationType', 'subscriptionType', 'directives'],
};

const TYPE_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'PULL_REQUEST', 'USER', 'ORGANIZATION', 'REPOSITORY', 'COMMIT'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
};

// ---------------------------------------------------------------- execution

interface GqlError {
  message: string;
}

class FieldError extends Error {}

function expandSelections(selections: SelectionNode[], doc: DocumentNode, typeName: string, out: FieldNode[]): void {
  for (const selection of selections) {
    if (selection.kind === 'field') out.push(selection);
    else if (selection.kind === 'inline') {
      if (selection.typeCondition === typeName) expandSelections(selection.selectionSet, doc, typeName, out);
    } else {
      const fragment = doc.fragments.get(selection.name);
      if (fragment !== undefined && fragment.typeCondition === typeName) expandSelections(fragment.selectionSet, doc, typeName, out);
    }
  }
}

function validateSelections(selections: SelectionNode[], doc: DocumentNode, typeName: string, errors: GqlError[]): void {
  const fields: FieldNode[] = [];
  expandSelections(selections, doc, typeName, fields);
  const typeDef = SCHEMA[typeName];
  for (const field of fields) {
    if (field.name === '__typename') continue;
    const def = typeDef?.[field.name];
    if (def === undefined) {
      errors.push({ message: `Field '${field.name}' doesn't exist on type '${typeName}'` });
      continue;
    }
    if (field.selectionSet !== null && SCHEMA[def.type] !== undefined) {
      validateSelections(field.selectionSet, doc, def.type, errors);
    }
  }
}

function executeSelectionSet(
  typeName: string,
  source: unknown,
  selections: SelectionNode[],
  doc: DocumentNode,
  variables: Record<string, unknown>,
  forge: Forge,
  errors: GqlError[],
): Record<string, unknown> {
  const fields: FieldNode[] = [];
  expandSelections(selections, doc, typeName, fields);
  const out: Record<string, unknown> = {};
  const typeDef = SCHEMA[typeName] ?? {};
  for (const field of fields) {
    const key = field.alias ?? field.name;
    if (field.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    const def = typeDef[field.name];
    if (def === undefined) {
      out[key] = null;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const [argName, valueNode] of field.args) args[argName] = resolveValue(valueNode, variables);
    let value: unknown;
    try {
      value = (def.resolve as (s: unknown, a: Record<string, unknown>, f: Forge) => unknown)(source, args, forge);
    } catch (error) {
      errors.push({ message: error instanceof Error ? error.message : String(error) });
      out[key] = null;
      continue;
    }
    out[key] = completeValue(def, value, field, doc, variables, forge, errors);
  }
  return out;
}

function completeValue(
  def: FieldDef,
  value: unknown,
  field: FieldNode,
  doc: DocumentNode,
  variables: Record<string, unknown>,
  forge: Forge,
  errors: GqlError[],
): unknown {
  if (value === null || value === undefined) return null;
  if (def.list) {
    const items = Array.isArray(value) ? value : [value];
    return items.map((item) => completeSingle(def, item, field, doc, variables, forge, errors));
  }
  return completeSingle(def, value, field, doc, variables, forge, errors);
}

function completeSingle(
  def: FieldDef,
  value: unknown,
  field: FieldNode,
  doc: DocumentNode,
  variables: Record<string, unknown>,
  forge: Forge,
  errors: GqlError[],
): unknown {
  if (value === null || value === undefined) return null;
  if (field.selectionSet === null || SCHEMA[def.type] === undefined) return value;
  const typename = typeof value === 'object' && value !== null && '__typename' in value ? String((value as { __typename: unknown }).__typename) : def.type;
  return executeSelectionSet(typename, value, field.selectionSet, doc, variables, forge, errors);
}

function executeOperation(doc: DocumentNode, operation: OperationNode, variables: Record<string, unknown>, forge: Forge): Record<string, unknown> {
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const validationErrors: GqlError[] = [];
  validateSelections(operation.selectionSet, doc, rootType, validationErrors);
  if (validationErrors.length > 0) return { data: null, errors: validationErrors };
  const errors: GqlError[] = [];
  const data = executeSelectionSet(rootType, null, operation.selectionSet, doc, variables, forge, errors);
  const envelope: Record<string, unknown> = { data };
  if (errors.length > 0) envelope.errors = errors;
  return envelope;
}

// ---------------------------------------------------------------- HTTP

export function handleGraphQL(forge: Forge, bodyText: string): HttpResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { status: 400, body: Buffer.from(`${JSON.stringify({ errors: [{ message: 'Invalid JSON body' }] })}\n`, 'utf8'), contentType: 'application/json; charset=utf-8' };
  }
  const isBatch = Array.isArray(parsed);
  const requests = isBatch ? (parsed as unknown[]) : [parsed];
  const results: Array<Record<string, unknown>> = [];
  for (const request of requests) {
    results.push(executeRequest(forge, request));
  }
  const payload = isBatch ? results : results[0]!;
  return { status: 200, body: Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8'), contentType: 'application/json; charset=utf-8' };
}

function executeRequest(forge: Forge, request: unknown): Record<string, unknown> {
  if (typeof request !== 'object' || request === null) return { errors: [{ message: 'Invalid request' }] };
  const { query, variables, operationName } = request as { query?: unknown; variables?: unknown; operationName?: unknown };
  if (typeof query !== 'string') return { errors: [{ message: 'Must provide query string' }] };
  let vars: Record<string, unknown> = {};
  if (typeof variables === 'object' && variables !== null) vars = variables as Record<string, unknown>;
  else if (typeof variables === 'string') {
    try {
      const parsedVars: unknown = JSON.parse(variables);
      if (typeof parsedVars === 'object' && parsedVars !== null) vars = parsedVars as Record<string, unknown>;
    } catch {
      // leave vars empty
    }
  }
  let doc: DocumentNode;
  try {
    doc = new Parser(tokenize(query)).parseDocument();
  } catch (error) {
    return { errors: [{ message: error instanceof Error ? error.message : 'Parse error' }] };
  }
  if (doc.operations.length === 0) return { errors: [{ message: 'No operation found' }] };
  let operation = doc.operations[0]!;
  if (typeof operationName === 'string' && operationName !== '') {
    const named = doc.operations.find((candidate) => candidate.name === operationName);
    if (named !== undefined) operation = named;
  } else if (doc.operations.length > 1) {
    return { errors: [{ message: 'Must provide operation name if query contains multiple operations' }] };
  }
  return executeOperation(doc, operation, vars, forge);
}
