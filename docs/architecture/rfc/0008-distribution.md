# RFC-0008: Distribution and packaging

- Status: Draft, 2026-10-29
- Related: [ADR-0001](../adr/0001-product-scope-and-priority.md), [ADR-0002](../adr/0002-project-name.md),
  [ADR-0006](../adr/0006-qayaba-graph-state-per-run.md), [ADR-0007](../adr/0007-dependency-versions.md),
  [RFC-0003](0003-codegraph-integration.md)

**In short:** npm is the primary channel for libraries, hosts and developer machines, a Docker image is the channel for
servers that run the CLI, and a Homebrew tap may follow for running the daemon as a service. All channels wrap the same
artifact. A host such as qayaba installs the npm package in its own image.

## Channels

| Channel | For | Shape |
|---|---|---|
| npm `ye-ast` | Hosts embedding the library or running ye-ast as a child process, qayaba included; developers using the CLI and MCP | `npm i ye-ast`; `npx ye-ast mcp`, `ye-ast map`, `ye-ast init` |
| Docker image | Servers that run the CLI | The CLI and library with pinned Node |
| Homebrew tap (later) | Developers who want the daemon as a service | Formula installing the CLI; service when the daemon exists |

qayaba consumes ye-ast as a dependency ([ADR-0001](../adr/0001-product-scope-and-priority.md) decision 4) and runs it
as a child of its own sandboxed run ([ADR-0006](../adr/0006-qayaba-graph-state-per-run.md)), so the npm package belongs
in qayaba's own image and the Docker image is not part of that path.

## Constraints

- codegraph ships its runtime in per-platform optional dependencies; installs with `--omit=optional` or some corporate
  mirrors break it. The Docker image avoids this on the servers it serves; ye-ast reports a missing platform bundle
  explicitly.
- Without the platform package the SDK loads a bundle the CLI shim may have downloaded into `~/.codegraph/bundles`,
  outside the lockfile (codegraph 1.6.2 `npm-sdk.js:38-75`). ye-ast refuses any bundle not resolved from
  `node_modules` ([RFC-0003](0003-codegraph-integration.md)), so a missing platform package is a typed failure, never a
  download.
- The platform package carries an in-process native kernel (`lib/kernel/codegraph-kernel.node`, about 34 MB) that adds
  to each platform's install size. It is optional: when it cannot load, extraction falls back to the WebAssembly
  pipeline, and `CODEGRAPH_KERNEL=0` disables it (codegraph 1.6.2 platform bundle
  `lib/dist/extraction/kernel/loader.js`). A packaging that cannot load native addons runs with the kernel off.
- Node ≥ 22.13 for `node:sqlite` without a flag: it was added in 22.5.0 behind `--experimental-sqlite` and unflagged in
  22.13.0 and 23.4.0 ([history](https://nodejs.org/docs/latest-v24.x/api/sqlite.html)). Node 24.11.0 still prints
  `ExperimentalWarning: SQLite is an experimental feature` (local run, 2026-10-29). codegraph uses `node:sqlite`
  `DatabaseSync` (codegraph 1.6.2 platform bundle `lib/dist/db/sqlite-adapter.js:31`). The project targets Node 24 LTS.
- A build step (TypeScript emit) is introduced with the first publication.
- Third-party notices ship with every artifact.

## Open questions

The owner chose the license on 2026-10-30 (translated): "Apache 2.0 for the license looks good to me". The repository
carries the license text (`LICENSE`) and `package.json` declares `Apache-2.0`.

| # | Question | Recommendation |
|---|---|---|
| 1 | Will ye-ast be published publicly, and under which license? | License decided: Apache-2.0. Publication stays the owner's decision, and code extracted from qayaba must be cleared for relicensing before it moves |
| 2 | Under which account or organization are the npm name and GitHub organization registered? | Owner decision; reserve them before the first publication |
