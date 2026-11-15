# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/endraputra9/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/endraputra9/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in a single Node process, built for make.fun's "Build a GitHub-compatible git forge" bounty. One in-memory git object store backs four surfaces: git smart HTTP (protocol v2 ls-refs/fetch, v0 receive-pack with report-status, shallow clones and deepen), the GitHub REST v3 API (repositories, branches, commits, contents, labels, issues, comments, pull requests with squash merges), a GraphQL v4 endpoint covering the query and mutation shapes `gh` and github-mcp-server send, and an MCP server (server/discover plus the legacy initialize handshake) whose tools act on the same store. No dependencies, no git binary, no UI: Node's standard library only.

## Run it

```sh
node main.ts
```

The process expects the harness environment (`MAKEFUN_ENV_URL`, `MAKEFUN_SHOP_TOKEN`, `MAKEFUN_TRIAL_NOW`): it binds an ephemeral port, registers it with the env, serves until the env reports the trial done, and exits 0.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
