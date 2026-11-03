# ADR-0016: Under `trusted`, ye-ast refreshes declared remotes into its own mirrors before a query

- Status: Accepted, 2026-11-01, owner
- Decision source: the owner, 2026-11-01 (translated): "normally when someone is programming they already have access
  to GitHub on that computer with credentials. If ye-ast only reads local repos it can read very old copies and not the
  source of truth that is on GitHub. Also I don't know which branch it should read: if being on develop it should look
  for the develop equivalents, and on main or QA the same, and what to do with custom branches"; then, accepting the
  fetch and branch-resolution recommendations: "pass them to an agent with xhigh effort to review them [...] and when it
  gives you the corrected feedback then implement them". The corrections of that review are applied here under the
  owner's standing delegation of technical choices that follow agreed precedent.
- Supersedes: the network clause of [ADR-0010](0010-trust-modes.md) decision 4, for `trusted` only.
- Related: [ADR-0010](0010-trust-modes.md), [ADR-0015](0015-index-reuse-by-content.md),
  [RFC-0002](../rfc/0002-facts-contract.md), [RFC-0005](../rfc/0005-transports.md),
  [RFC-0006](../rfc/0006-configuration.md), [RFC-0011](../rfc/0011-cross-repository-impact.md)

**In short:** under `trusted`, before a cross-repository query, ye-ast lists each declared remote's refs and fetches
the commits it lacks into a mirror of its own, with the user's own git and credential setup. The refresh is a step
before the query: it pins one sha per repository, and every fact is a function of those shas only. Whether the refresh
succeeded is a status of the response, never part of a fact. Under `untrusted` nothing changes: the network is
unreachable by type and the host provides every mirror.

## Context

- A developer's local clone of another repository can be weeks behind its remote, so a fact read from it describes a
  state nobody runs. The developer's machine already holds the credentials git needs (a credential helper, an ssh
  agent).
- [ADR-0010](0010-trust-modes.md) decision 4 says that in both modes ye-ast "makes no network request". Every git call
  today runs with `GIT_ALLOW_PROTOCOL=""` (`git-vcs.adapter.ts:345`), so no transport is allowed.
- RFC-0002 rule 5: "two facts with equal `inputs` are equal". A fact whose bytes depend on whether a fetch succeeded
  breaks it. RFC-0002 rule 8 and RFC-0005 already report staleness in the response, not in the fact.
- Experiments of the review (git 2.56.0, `file://` only, no network), 2026-11-01:
  - hooks run on fetch: with a global `core.hooksPath`, one fetch ran `reference-transaction` three times, and
    `-c core.hooksPath=/dev/null` stopped it;
  - `GIT_ALLOW_PROTOCOL` applies after `url.<base>.insteadOf`: a rewrite to `file` was refused;
  - `transfer.credentialsInUrl=die` refused a URL carrying a password;
  - a clone's `origin/HEAD` stays on the old branch after the remote changes its default, even after `git fetch`;
  - on a shallow clone `git merge-base` exits 1, the same code as "no common history".

| Option | Fresh | Deterministic facts | Touches the user's clone |
|---|---|---|---|
| Read local clones only | no | yes | no |
| Fetch into the user's clone | yes | yes, if pinned | yes: its hooks run, its refs move under the IDE |
| Ask a forge API | yes | yes, if pinned | no, but ties ye-ast to one forge and needs a token |
| Fetch into ye-ast's own mirror with the user's git (chosen) | yes | yes, if pinned | no |

## Decision

1. **Scope.** Only under `trusted`, only for repositories the workspace manifest declares with a `remote` URL, and only
   for a cross-repository query. The trigger repository is read locally as today. The URL comes from the manifest
   alone, never from a query parameter and never from a clone's remote name, so a fork named `origin` never stands for
   the source of truth.
2. **By type.** The refresh is a driven port of its own. Composition wires it only for `trusted` without `--offline`;
   under `untrusted` and with `--offline` the use case receives no refresh port. Every other git call keeps
   `GIT_ALLOW_PROTOCOL=""`.
3. **Refresh, pin, compute.** Before the query, each declared remote's refs are listed (`git ls-remote --symref`); the
   listing is the authority on which branches exist and on the default branch, so a stale ref left in a mirror never
   answers "exists". A sha the mirror lacks is fetched. Then one sha per repository is chosen
   ([RFC-0011](../rfc/0011-cross-repository-impact.md) "Which snapshot of each") and every hop of the query reads those
   shas; no ref is read again during the query.
4. **What a fact holds.** A fact depends only on the pinned shas and its other inputs. The response carries, beside the
   fact and outside it:
   - the resolution record: per repository, what was asked, the rule step that chose the sha, the refs consulted with
     their shas or their absence, and any tie;
   - the freshness: per remote, `verified` in this query, or `unverified` with its reason (`failed`, `deadline`,
     `offline`, `refresh-in-progress`), with the time it was last verified as information only.

   A replay that passes the recorded shas gives byte-identical facts.
5. **Failure.** A refresh that fails or hits the caller's deadline leaves the repository resolved from its last
   recorded listing, and the freshness says so; the fact is still about pinned shas and may be stored. A repository
   with no copy of the chosen revision is a section `unknown` with reason `revision-unavailable`, a minor schema change
   (RFC-0002 rule 6), and that fact is never stored.
6. **The fetch.** Only `https` and `ssh` reach the network, and only during the refresh:
   `GIT_ALLOW_PROTOCOL=https:ssh`, `GIT_TERMINAL_PROMPT=0`, stdin an ended pipe, no controlling terminal, and
   `git -c core.hooksPath=/dev/null -c gc.auto=0 -c maintenance.auto=false -c fetch.recurseSubmodules=false
   -c transfer.credentialsInUrl=die -c transfer.fsckObjects=true fetch --no-tags --no-recurse-submodules
   --no-write-fetch-head --no-auto-maintenance --porcelain --end-of-options <url> +refs/heads/<name>:refs/ye-ast/heads/<name>`.
   A refspec is built only from a name that passes `git check-ref-format`. The user's configuration stays in force so
   their credential helper and `insteadOf` rules work; nothing else of it may run a program of ye-ast's choosing.
7. **No speculative timeout.** A prompt is impossible by construction (decision 6). The remaining wait, a stalled
   network, ends with the caller's cancellation or deadline, as RFC-0005 does for live freshness.
8. **The mirror.** A full bare repository, never shallow (a shallow one is refused, since its merge bases lie), in the
   platform's user cache directory with mode 0700, keyed by a digest of the URL, shared across workspaces. Refs live
   under `refs/ye-ast/`, never `--mirror`. The first clone is seeded from the user's local clone of the same URL when
   one exists. One refresh runs at a time per mirror: a lock file names its holder's pid, whose liveness is checked; a
   query that finds the lock held reads the current state with freshness `refresh-in-progress`.
9. **When.** Every explicit query (CLI command, MCP tool call) refreshes, and concurrent queries share one refresh.
   Hooks never touch the network: they read the last recorded listing and say so. A daemon later refreshes on events,
   never on a timer.
10. **Nothing leaks into facts.** The remote URL and git's stderr never reach a fact; stderr goes to the freshness,
    redacted.

## Consequences

- ADR-0010 decision 4 holds for `untrusted` as written; under `trusted` it reads "makes no network request except the
  refresh of declared remotes ([ADR-0016](0016-remote-refresh-under-trusted.md))". AGENTS.md and RFC-0001 follow.
- A fresh query costs one listing round trip per declared remote, run in parallel, plus a fetch only for a missing
  sha; an unchanged sha reuses every cached piece, and ADR-0015 makes a new sha with unchanged scope cost no build.
- `GIT_SSH_COMMAND` and `GIT_SSL_CAINFO` are dropped with every `GIT_*` variable (`git-vcs.adapter.ts:340`), so a setup
  that needs them fails visibly as `unverified`, not silently.
- The minimum git version rises to 2.41 (`fetch --porcelain`) when the refresh is built.

## Not decided here

- Blobless mirrors with targeted blob fetches; passing `GIT_SSH_COMMAND` and `GIT_SSL_CAINFO` through; garbage
  collection of mirrors; background refresh by the daemon.
- A coordinated branch that exists only in the user's local clone of another repository (RFC-0011 deferred list).
