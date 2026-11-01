# ye-ast

**Verifiable facts about a codebase, before an agent acts.**

[![npm](https://img.shields.io/npm/v/ye-ast-mcp?color=black)](https://www.npmjs.com/package/ye-ast-mcp)
[![license](https://img.shields.io/badge/license-Apache--2.0-black)](LICENSE)
[![node](https://img.shields.io/node/v/ye-ast-mcp?color=black)](package.json)

An AI agent reads a few files, greps a few names and guesses the rest: what a change touches, which screen a component
serves, what breaks if a function is renamed. ye-ast replaces the guess with **facts derived from code and git**, each
one carrying `path:line` evidence, the snapshot it was computed on and an explicit statement of how complete it is.

No LLM runs inside the engine. Same input, same bytes.

```console
$ ye-ast map .
{
  "schema": "0.3.0",
  "snapshot": { "repo": "my-app", "kind": "sha", "sha": "…" },
  "producer": { "name": "ye-ast", "version": "0.1.0" },
  "inputs": { "trust": "untrusted", "declaredScope": { … } },
  "evidence": [ { "path": "src/app/routes.ts", "line": 12 } ],
  "status": "complete",
  "value": { "entrypoints": [ … ] }
}
```

## What it answers

| Question | Fact |
|---|---|
| What does my change affect? | Bounded impact walk from the merge base to the head: the symbols that reach the change, the entrypoints they serve, and the entrypoints the change adds, removes or alters |
| Which screen or endpoint does this serve? | Entrypoints — UI routes, HTTP routes, message listeners, scheduled jobs — with the handler's `path:line` |
| Who depends on this symbol or these lines? | Callers and the entrypoints they serve |
| Is this file really unused? | Importers, users, and unresolved references, each listed |
| What is even in this repository? | The entrypoint map of a revision, as the orientation starting point |

Languages and frameworks today: **TypeScript** and **Java**, with **Angular** routes and **Spring** HTTP routes resolved.
Everything else is reported as outside the declared scope, never silently ignored.

## How it works

```
┌───────────────┐    stdio MCP     ┌────────────────────────────────────────┐
│   AI agent    │ ───────────────► │  ye-ast mcp                            │
│  Claude Code  │                  │  ye_ast_entrypoints  ye_ast_callers    │
│  OpenCode     │ ◄─────────────── │  ye_ast_impact       ye_ast_importers  │
└───────────────┘  facts + evidence└─────────────────┬──────────────────────┘
                                                     │
                       ┌─────────────────────────────┼──────────────────────────┐
                       ▼                             ▼                          ▼
                code index                   TypeScript / Java            git history
                (codegraph)                  syntax, routes, DI           revisions + diff
```

The engine is a library with ports; the CLI and the MCP server are thin adapters over it. The same core answers a
one-shot `ye-ast impact` in CI and an on-demand `ye_ast_impact` from an agent.

## Install

Requires **Node.js 24.15 or newer** and **git 2.44 or newer** on `PATH`.

```bash
npm install -g ye-ast-mcp    # or: npx ye-ast-mcp --version
ye-ast --version             # 0.1.0
```

The package is `ye-ast-mcp`; the command it installs is `ye-ast`.

## Quickstart

```bash
cd /path/to/your/repo
ye-ast install --trust untrusted .   # declares the trust mode and writes the fixed layer
ye-ast map .                         # the entrypoints of HEAD
ye-ast impact --base main .          # what your branch affects
ye-ast callers . src/checkout.ts:placeOrder     # who depends on a symbol
ye-ast importers . src/checkout.ts              # who imports a file
```

`install` records your trust declaration **outside** the repository (`$XDG_CONFIG_HOME/ye-ast/`, `~/.config/ye-ast/`
by default), writes the fixed layer under `.ye-ast/`, keeps `.ye-ast/` and `.ye-ast-graph/` out of git through
`.git/info/exclude`, and prints the MCP registration command for that repository.

## Use it from an agent

`ye-ast mcp [<repo>]` serves four read-only tools over stdio. Register it once per client.

**Claude Code** — `ye-ast install` prints the exact line for your machine:

```bash
claude mcp add ye-ast -- npx --yes ye-ast-mcp mcp /path/to/your/repo
```

**OpenCode** — in `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "ye-ast": {
      "type": "local",
      "command": ["npx", "-y", "ye-ast-mcp", "mcp", "/path/to/your/repo"]
    }
  }
}
```

Any other stdio MCP client works the same way: command `npx`, arguments `-y ye-ast-mcp mcp <repo>`.

## Trust model

The two modes describe the **repository**, not the machine, and are declared outside it. Nothing inside a repository can
raise its own mode; with no declaration the CLI and the MCP server run `untrusted`.

| Mode | What ye-ast does |
|---|---|
| `untrusted` (default) | Reads only a snapshot exported from git at a sha. No network, no repository manifest, no `.gitignore` of the repository, no repository code, no symlinks |
| `trusted` | Adds `--live`: reads the working tree, uncommitted and untracked files included, from ye-ast's own mirror. Refreshes declared remotes with your own git |

`--live` under `untrusted` is refused with exit code `1` and the `live-requires-trusted` fault. Declare `trusted` only
when you trust the repository you are pointing at.

## Reading a fact

Every answer is one envelope, and its `status` is the part that matters:

| `status` | Means |
|---|---|
| `complete` | Everything within `inputs.declaredScope` was read |
| `partial` | The answer stops at each `cuts` entry; what lies past a cut is **not known** |
| `unknown` | ye-ast cannot tell, and `reason` says why. **Never** read it as "no impact" |

An empty result is never used to mean "nothing found".

## Commands

| Command | Answers |
|---|---|
| `ye-ast map [--revision <rev> \| --live] [scope] <repo>` | Entrypoints of a revision |
| `ye-ast impact --base <rev> [--head <rev> \| --live] [scope] [budget] <repo>` | What depends on the change from the merge base to the head |
| `ye-ast callers [--revision <rev> \| --live] [scope] [budget] <repo> <file>:<symbol> \| <file>:<start>-<end> …` | What depends on symbols or line ranges |
| `ye-ast importers [--revision <rev> \| --live] [scope] <repo> <file> …` | Per file: importers, users and unresolved namers |
| `ye-ast install --trust trusted\|untrusted [<repo>]` | Declares the trust mode, writes the fixed layer, prints the MCP registration |
| `ye-ast serve` | The query protocol over stdio, one JSON-RPC 2.0 message per line |
| `ye-ast mcp [<repo>]` | The stdio MCP server, read-only, bound to one repository |

`scope` is `[--include <glob>]… [--exclude <glob>]…` over repository-relative paths; `--exclude` wins.
`budget` is `[--depth <n>] [--hub-fan-in <n>] [--expansions <n>]`; none has a default, and a bound that stops a walk is
reported as a cut. `--repo-id <id>` names the repository in every snapshot.

Exit codes: `0` ok · `1` the query failed with a typed fault · `2` usage · `70` internal fault · `130` interrupted.

## Use it as a library

For a host that embeds the engine in its own process:

```js
import { composeQueries } from "ye-ast-mcp";

const { entrypoints, impact } = composeQueries({ indexCache: "/var/cache/ye-ast" });
const result = await impact.callers({ repo: "/path/to/repo", repoId: "my-app", revision: "HEAD", targets: [{ file: "src/checkout.ts", symbol: "placeOrder" }] });
```

`composeQueries` returns the read query families and `warmLive`; nothing it exposes can write.

## Development

```bash
nvm use
npm ci
npm run check     # typecheck + architecture rules + 1000+ tests
npm run cli -- map .
```

The layers are enforced by `npm run arch:check`: domain and ports never reach a Node built-in, application never reaches
an adapter, and an entrypoint never imports another entrypoint.

## License

Apache-2.0. See [LICENSE](LICENSE).

---

# For AI agents: install and configure ye-ast

You are an agent asked to add ye-ast to a repository. Follow these steps in order. Every command is exact; every
expected result is stated. **Do not skip step 2 and do not choose `trusted` for the user.**

## 1. Check the preconditions

```bash
node --version    # must be v24.15.0 or newer
git --version     # must be 2.44 or newer
git rev-parse --show-toplevel   # must print the repository root
```

If Node is older, stop and tell the user: the engine calls `node:sqlite` and refuses to run. If the working directory is
not a git repository, stop: every fact reads git history.

## 2. Declare the trust mode

Ask the user only if you cannot decide from context. `untrusted` is the safe default and works for every read against a
committed revision.

```bash
npx --yes ye-ast-mcp install --trust untrusted /path/to/repo
```

Expected output, one item per line:

```
trust: untrusted (recorded outside the repository)
local exclude: added .ye-ast/ .ye-ast-graph/
.ye-ast/README.md: written
.ye-ast/entrypoints.json: written
register the MCP server with Claude Code:
claude mcp add ye-ast -- npx --yes ye-ast-mcp mcp /path/to/repo
```

The last line is the registration command for **this** machine. Use it verbatim in step 3.

Use `--trust trusted` only when the user explicitly says the repository content is trusted. It is the only way to enable
`--live` and working-tree reads; it also allows ye-ast to refresh declared remotes with the user's git. Never infer
consent from the fact that the repository is theirs.

## 3. Register the MCP server

**Claude Code** — user scope, so it works in every project:

```bash
claude mcp add ye-ast -s user -- npx --yes ye-ast-mcp mcp /path/to/repo
```

Project scope instead of `-s user` writes `.mcp.json` and shares the registration with the team. Replace `-s user` with
`-s project`.

**OpenCode** — merge into `opencode.json` (project) or the global config:

```json
{
  "mcp": {
    "ye-ast": {
      "type": "local",
      "command": ["npx", "-y", "ye-ast-mcp", "mcp", "/path/to/repo"],
      "enabled": true
    }
  }
}
```

One server instance is bound to **one** repository root. For a second repository, register a second entry with its own
name and its own path. Do not rely on the current working directory: an MCP client may start the server anywhere.

## 4. Verify before reporting success

Run the same query through the CLI. It is the same engine the MCP server uses:

```bash
npx --yes ye-ast-mcp map /path/to/repo
```

Expected: one JSON object on stdout with `schema`, `snapshot`, `producer`, `inputs`, `evidence`, `status` and `value`.
Then confirm `"status"` is `complete` or `partial` — both are valid answers — and that `value.entrypoints` is an object,
not `null`. A non-zero exit code means the registration is not what failed; read step 6 first.

If your client lists MCP tools, the four names below must appear.

## 5. Choose the tool

| Tool | Call it when | Key arguments |
|---|---|---|
| `ye_ast_entrypoints` | You are orienting in an unfamiliar repository, or you need the handler of a route, listener or job | `revision`, `live` |
| `ye_ast_callers` | Before changing, moving or deleting a symbol or a line range | `targets: [{ file, symbol }]` or `[{ file, start, end }]`, `budget` |
| `ye_ast_importers` | Before moving, renaming or deleting a file, or changing its exports | `files: [repo-relative paths]` |
| `ye_ast_impact` | Before reporting work done or opening a pull request | `base` (the branch the work merges into), `head`, `live` |

Prefer these over `grep` and over your own inference whenever the decision depends on **what reaches what**. Do not use
them to answer style, naming or syntax questions; they answer structure, not intent.

## 6. Read the answer correctly

- `status: "complete"` — everything inside `inputs.declaredScope` was read. Code outside that scope was not, and saying
  "nothing depends on this" is only true **inside** the declared scope.
- `status: "partial"` — the answer stops at each entry in `cuts`. What lies past a cut is unknown. Say so.
- `status: "unknown"` — `reason` explains why. Never translate it into "no impact".
- An `isError` result carries a fault kind. `live-requires-trusted` means the repository must be declared `trusted`
  before `live` works; answer from a revision meanwhile.
- The `snapshot` in the answer tells you what was read: `{ kind: "sha", sha }` for a revision, `{ kind: "live" }` for the
  working tree. Quote it when you report a fact.
- `_meta["ye-ast/live"]` on a live answer means the working tree moved during the read and the answer may be stale.

## 7. Failures and what they mean

| Symptom | Cause | Action |
|---|---|---|
| `ye-ast: unreadable: …` | The path is not readable or not a git repository | Fix the path; do not retry blindly |
| `ye-ast: live-requires-trusted` | `--live` used without a `trusted` declaration | Ask the user, or fall back to `--revision` |
| `ye-ast: unknown-symbol: …` | Nothing declares that symbol at that revision | Check the file and the name; the error lists what it found |
| `ye-ast: deadline` | The walk ran out of its bound | Raise the budget or narrow the scope |
| `ye-ast: caller-budget` | A host-set export budget stopped the read | Raise the budget set by the host |
| `ye-ast: unsupported-store: …` | An index store outside the supported schema | Let ye-ast rebuild the index |
| exit `2` | Usage error | Re-read `ye-ast --help` |
| exit `70` | Internal fault | Report the message; do not retry in a loop |

## 8. Rules you must respect

- ye-ast is **read-only** toward the repository. Never write, edit or delete files to make a query succeed.
- Never fabricate a fact. If the answer is `unknown` or cut, report that.
- Never mark a repository `trusted` on your own initiative.
- Under `untrusted` ye-ast makes no network request; do not work around that by fetching the repository yourself.
- The fixed layer under `.ye-ast/` belongs to the user's repository. Do not edit it by hand; `ye-ast install` owns it.
