# RFC-0014: Workspace decisions — the gaps the code cannot fill, offered to the user

- Status: Draft, 2026-11-02
- Related: [RFC-0011](0011-cross-repository-impact.md) (cross-repository impact), [RFC-0006](0006-configuration.md)
  (configuration), [ADR-0010](../adr/0010-trust-modes.md) (trust modes), [ADR-0013](../adr/0013-coverage-grows-only-with-evidence.md)
  (coverage grows only with evidence), [ADR-0016](../adr/0016-remote-refresh-under-trusted.md) (remote refresh)

**In short:** the engine already derives everything the code states about a workspace. This RFC adds the other half:
a deterministic **decision set** — the closed list of gaps the code does not fill, each with every valid option the
workspace can verify, the evidence behind it, and a recommendation only where a rule names one. The engine never asks;
it publishes the decision set read-only. The harness renders it as a form, the user marks, and the declaration is
persisted through the paths that already exist. The decision model is a subdomain of its own; the interaction stays
outside the core.

## The boundary

| Who | Owns | Why |
|---|---|---|
| `core/domain/decisions` | which gaps exist, which options are valid, which option a rule recommends, which answers are acceptable | pure rules over typed facts; no I/O, no environment, no prose |
| `core/application/decisions` | orchestrating the workspace read, the domain rules and the declaration | the same shape as `workspace-impact.ts` over `link-graph.ts` |
| `mcp`, `cli` | exposing the decision set read-only and rendering it in English | driving adapters; they import ports and domain, never use cases |
| the harness (Claude Code, OpenCode) | rendering the form, localizing it, asking, collecting the marks | a conversation is not a fact; the engine stays headless and read-only |
| `install` | validating the declaration and persisting the manifest, and recording trust per repository | the only writer, as today ([ADR-0010](../adr/0010-trust-modes.md)) |

An `AskUser` port inside the core would invert the dependency: the engine would depend on an interaction and could not
run under qayaba, the MCP or a CI job. It is rejected.

## The language

- **Gap**: what no repository given states, and that blocks or weakens an answer.
- **Decision**: one gap, its evidence, its valid options and whether one is recommended.
- **Recommendation**: the option a deterministic rule names, with its basis; never a guess, never a default applied.
- **Answer**: the option the user chose, or a free text the gap allows.
- **Declaration**: what the answers produce — `repos[]` with `path`, `id`, `revision`, `remote`, and `gateways[]` in
  the manifest, plus one trust record per repository. An answer maps to a declaration by its content, never by the
  decision id: the manifest does not store decision ids.

A decision is derived, never stored: the next query derives the set again from the current workspace, and an answered
gap disappears. Only the declaration is stored.

## The model

```ts
type DecisionKind =
  | "membership"   // which of the candidate clones belong to the workspace
  | "repository"   // where a name no clone serves lives
  | "library"      // which clone holds the library a cut names
  | "gateway"      // which repository a prefix routes to
  | "revision"     // which branch or sha of a repository to read
  | "remote"       // which URL is the source of truth of a repository
  | "trust";       // trusted or untrusted, per repository

type RepositoryEvidence = Evidence & { repo: string }; // path is relative to this repository

interface DecisionOption {
  value: string;                                   // a path, a URL, a branch, a repository id, a trust mode
  basis?: "exact-name" | "artifact" | "remote" | "default-branch" | "origin";
  evidence: readonly RepositoryEvidence[];
  recommended: boolean;
}

interface Decision {
  id: string;                                      // stable: `${kind}:${subject}`, scoped when a kind has two subject spaces
  kind: DecisionKind;
  subject: string;                                 // the name, the library FQN, the prefix, the repository, the clone
  evidence: readonly RepositoryEvidence[];         // repository and file:line that motivated the gap
  options: readonly DecisionOption[];
  allowsFreeText: boolean;
  required: boolean;                               // trust is required; a gateway is not
}

interface DecisionSet {
  decisions: readonly Decision[];                  // sorted by id
  repositories: readonly { repo: string; snapshot: SnapshotRef }[];
}
```

The fact carries no prose. The driving adapter renders the question from `kind`, `subject` and the options, as every
other answer renders English today (`mcp/render.ts`), so a wording change never changes fact bytes.

The set is a fact of the workspace composite, like `WorkspaceValue`: it carries the snapshot of every repository read
and is byte-identical for the same inputs.

## The gaps and their options

The list is closed. Every option comes from a fact with evidence; the engine never invents one.

| Kind | When it exists | Options | Recommendation |
|---|---|---|---|
| `membership`, one per name (`membership:name:<name>`) | an outward name has at least one candidate clone | the clones serving that name, each with its basis (`nameCandidates`) | the strongest basis; two at one basis recommend none |
| `membership`, one per clone (`membership:clone:<repo>`) | a candidate clone the request passed names nothing | keep it in the workspace, or drop it | none |
| `repository` | an outward name no clone given serves (`unserved`) | free text: a local path or a URL; "leave it unserved" | none: the engine cannot know where a name lives |
| `library` | a call-site cut names a library (`via`, `unresolvedCallSite`) | the clones given, each as a candidate to confirm; free text | none: no fact states which clone is the library a FQN names |
| `gateway` | a prefix appears in call sites, matches no repository by name, and `inferGateways` did not infer it (zero or two or more matches) | the repositories whose routes match a call another repository makes under the prefix once it is stripped (`matchBehindGateway`); "leave it unmatched" | none: zero or two or more matches, by construction |
| `revision` | a repository is read at `HEAD` while the trigger's line differs | the branches the remote's listing states; free text | the branch with the trigger's line name; otherwise the remote's default branch; otherwise none |
| `remote` | a repository is declared without a `remote` | the clone's own remote URLs as evidence; free text | none: a source of truth is a security decision, confirmed never preselected |
| `trust` | a repository of the workspace has no trust record | `trusted`, `untrusted` | none, by design |

`pattern` is not in this list yet. The join does not consume a pattern today, so a decision offering one would have
nothing to apply it to; it enters with the first call pattern that matches something, as RFC-0011 already says. Its
derivable trigger is a cut whose library source was read and still does not decide the destination.

`revision` and `remote` are delivered (slice 2, 2026-11-02) on top of the remote refresh
([ADR-0016](../adr/0016-remote-refresh-under-trusted.md)): `revision`'s options are the refs the resolution consulted
that the listing stated, and `remote`'s is the clone's own `origin`. The query carries the resolution beside the fact,
never the whole listing, so a branch the listing states and the resolution never consulted is offered as free text; open
question 12 holds the widening.

## Recommendation is a fact with a basis

A recommendation exists only when exactly one option wins the kind's rule. Two options at one basis recommend none,
and the answer says so: an ambiguous candidate is a cut, never a pick — the same rule the join already follows
(`link-match.ts:156`). A recommendation is reported, never applied: the harness may preselect it, the user may change it,
and the declaration records the chosen value with its basis.

## The surface

| Surface | Answers | Writes |
|---|---|---|
| `ye_ast_decisions` (new, read-only) | the decision set of the bound repository and the clones passed; with no clones, the bound repository alone, as `ye_ast_workspace` does | nothing |
| `ye-ast init --workspace <file>` (built; `repos[].remote` added) | validates the declaration — every repository it names is a readable repository root at its declared revision — and persists `.ye-ast/workspace.json` | the fixed layer |
| `ye-ast init --trust <mode> <repo>` (built) | records the trust of one repository, the bound one or a sibling | the trust record |
| `ye_ast_callers`, `ye_ast_impact` with `workspace` (built) | the answers the declaration enables | nothing |

`ye_ast_workspace` keeps its question (which names a repository states and who serves them); `ye_ast_decisions` answers
what is missing. One tool per question, as decision 10 of RFC-0011 requires. The decision set is MCP-only: the CLI has
no workspace command today, and a CLI twin would be a new surface nobody asked for.

A trust answer is not stored in the manifest: the harness runs the existing `init --trust <mode> <repo>` for each
chosen repository, and the next read's `trustOf` sees the record, so the gap disappears. The write path stays explicit
per root, as it is today; no new trust write is introduced.

## The loop

1. The agent calls `ye_ast_decisions` with the bound repository and the sibling clones it knows.
2. The engine answers the set: membership of the candidates, unserved names, library cuts, prefixes, revisions.
3. The harness renders the form, with recommendations preselected where they exist.
4. The user marks; the harness writes the declaration and calls `init --workspace`, and runs `init --trust` for
   each trust answer.
5. The next query derives the set again: answered gaps are gone, and the names the chain discovers appear as new
   decisions.

`install` seeds; the queries keep the chain. It is not a one-time form: the owner's words say the form appears when
`install` is run, and this RFC also shows it when a query discovers a new gap. Open question 9 keeps that divergence
visible.

Under qayaba the host passes the answers as the request parameter; no manifest is written by the MCP, and the loop is
the host's.

## Determinism and completeness

- Sorted by `id`; the same workspace and the same candidates give byte-identical decisions.
- Every option cites the evidence that makes it valid; a free text is marked as such, never disguised as a derived
  option.
- A repository the read cannot reach fails the whole set with its typed fault, as `outwardNames` already does; the set
  never guesses around an unreadable repository.
- The engine makes no network request; the options come from the snapshots and the listings it is given.

## Slices

| Slice | Delivers | Accepted by |
|---|---|---|
| 0 | the `decisions` subdomain, `ye_ast_decisions` for `membership`, `repository` and `gateway`; the render and the MCP instructions | fixtures per kind; the probe's `unserved` names and gateway gaps become decisions with their evidence; byte-identical twice |
| 1 | `library`, fed by the cuts of RFC-0011 slices 4 and 5 | the probe's 12 cuts become decisions naming the two libraries; a chosen clone turns the cut into a link or a narrower cut |
| 2 | `revision` and `remote`, after the ADR-0016 refresh; `repos[].remote` in the manifest | fixtures with `file://` remotes; a chosen branch changes the section's snapshot; a remote is confirmed, never preselected |
| 3 | the loop: answers validated by `install`, `init --trust` per repository, the declaration read back, the set re-derived | a form-shaped answer set persists and the next query drops the answered gaps |

## Open questions

| # | Question | Recommendation |
|---|---|---|
| 1 | Does `ye_ast_decisions` replace `ye_ast_workspace`? | No: the workspace tool reports the names a repository states and who serves them; the decisions tool reports what is missing. One question per tool (RFC-0011 decision 10) |
| 2 | Does the decision set live in the workspace answer instead of a new tool? | A tool of its own: the languages differ, and a growing `workspace` answer would mix "what is" with "what is missing" |
| 3 | Does the engine render English prompts, or only machine codes? | Only machine codes: the fact carries `kind`, `subject` and the options; the adapter renders English, as every other answer does |
| 4 | Who validates a free-text path or URL? | `install`, before writing: a local git root for a path, a URL shape for a remote; a rejected answer names the entry and writes nothing |
| 5 | Is `trust` a decision of this set? | Yes, as a required one with no recommendation; the answer is applied by the existing `init --trust <mode> <repo>`, not by the manifest |
| 6 | Does a decision expire? | It is derived each run; only the declaration persists. A declaration that no longer matches the code is reported as a stale answer, never silently kept |
| 7 | Should the engine search a code host for an unserved name? | No: discovery stays with the agent (RFC-0011 decision 12); a network request steered by repository content is a supply-chain vector |
| 8 | Does the harness that renders the form have write access in every deployment? | No: under qayaba the host passes the answers as the request parameter; the manifest path is the developer harness's |
| 9 | Does the form appear only when `install` runs, or also when a query discovers a new gap? | Also at query time: an install-only form goes stale as the chain discovers names. The owner's words say `install`; this RFC reads them as the seed, not the only moment. **Accepted by the owner, 2026-11-02** |
| 10 | How does a persisted answer map back to the decision it closes? | By its content, never by the decision id: a repository path, a gateway prefix, a revision, a remote URL. The manifest stores no decision ids |
| 11 | Should `init --workspace` write the trust of sibling repositories in one run? | No for now: keep the explicit per-root `init --trust`, which is already the only trust writer; revisit if the form proves too many commands. **Accepted by the owner, 2026-11-02** |
| 12 | Does a `revision` decision offer every branch of the remote's listing, or only the refs the resolution consulted? | Only the consulted refs today: the refresh carries the resolution beside the fact, not the listing, and the trigger's line plus the default branch are what a gap can act on. Widening it means carrying the listing in the response, which ADR-0016 decision 4 does not do; a branch the listing states is still answerable as free text |

## What is not decided here

- The rich manifest of RFC-0011 slice 1a (roles, declared lines, boundaries); this RFC works over the actual manifest.
- The ADR-0016 refresh itself; slice 2 depends on it.
- `pattern`, which needs the join to consume a pattern first.
- Any UI: the form is the harness's, and this RFC fixes only the data it renders.
- Naming a workspace entry after its repository: an entry keeps the directory name of its path unless it states `id`, and
  git naming is reserved for the repository a query is bound to. A workspace links *different* repositories, so two
  worktrees of one repository are never two members of it; the caller that does want one name passes `id`, and no fact
  changes for everyone else.
- A ranking that learns from past answers; the recommendation is a rule over facts, never a model.

## As built

- Slice 0 (S3, S4): the `decisions` subdomain (`DecisionKind`, `DecisionOption`, `Decision`, `DecisionSet` and the pure
  rules over typed facts), one application use case over `WorkspaceQueries` and `WorkspaceDefaults`, the driving port
  `DecisionQueries`, the read-only `ye_ast_decisions` MCP tool with its render and its `INSTRUCTIONS` entry, and the
  composition wiring. The CLI gets no twin, because the workspace family has no CLI command. The fact carries no prose;
  the adapter renders English. The set is sorted by id and identical for the same workspace and candidates.
- `membership` has two subject spaces, `membership:name:<name>` and `membership:clone:<repo>` (the ids collided in the
  first cut). Both skip the bound repository and every repository the persisted declaration holds: an answered
  membership is not asked again. The recommendation is the unique strongest basis among the options still asked; two at
  the strongest basis recommend none, and a chosen option records its `basis`.
- `repository` is one free-text decision per unserved name, with every place that writes it. A prefix a declared gateway
  routes was answered by that gateway and is no repository decision; a prefix the engine only inferred (route overlap)
  still leaves it, because only a declaration states where the name lives. A name written twice with different kinds is
  one decision with both places. On the probe workspace the 121 names no repository serves are decisions, third-party
  coordinates included: the set is complete by design, and the harness decides what it renders.
- `repository` decisions carry `outwardKinds`, the outward kinds their subject is written with, sorted. The fact still
  states every gap; the MCP answer is what turns the set into a form: it groups the gaps by kind (trust, gateway,
  library, repository, membership, remote, revision) and a summary counts the free-text-only dependency gaps, listing
  them only under `detail: "full"`. A dependency coordinate stays a decision, as above; it stops burying the gaps a
  human can answer.
- `gateway` is one decision per prefix no repository id names and no gateway in force routes. Its options are the
  repositories whose routes match a call under the prefix once it is stripped, with the matched route as evidence; there
  is no recommendation, because zero or two or more matches are what leaves the gap. The caller's own repository is
  never an option, as `inferGateways` excludes it.
- `trust` is one required decision per repository with no record, offering both modes and no recommendation. The answer
  is applied by the existing `init --trust <mode> <repo>`, never by the manifest (open question 11, accepted).
- Slice 1 (`library`): one decision per distinct library a cut names (`library:<fqn>`), the places of every cut naming it
  as evidence, every clone given as an option, none recommended, free text allowed. A cut names a library through
  `unresolvedPlace`, which already carries both guards (target unknown, `via` present). The kind has no write path that
  closes it yet: the declaration stores no per-library mapping and the options are clones already read, so the next query
  derives it again. It stays as the discovery answer the harness consumes; closing it needs a declaration field the join
  reads, and that is not built.
- Slice 2 (`revision`, `remote`): `repos[].remote` landed with the loop, validated as an absolute URL with a scheme or an
  scp-like git address and persisted by `init --workspace`; `repos[].revision` was already there. The two kinds landed
  with the ADR-0016 refresh as its own feature (the owner chose A, 2026-11-02). `revision` is one decision per refreshed
  repository the query could not read at the trigger's line (the resolution diverged, or nothing could be pinned): the
  consulted refs that carry a sha are the options, the pinned branch is recommended, free text covers any other name; an
  explicit revision, the trigger's own line, or a default with no other line consulted leaves no gap. `remote` is one
  decision per repository in force the declaration gives no `remote`, other than the bound one, whose clone states a
  remote: each remote the declaration would accept is an option — `upstream` included, since a fork's source of truth is
  the project it forked from — with basis `origin`, the `.git/config` place that states it as evidence, and never a
  recommendation. The decisions use case reads those remotes through the same git adapter the workspace read uses; a
  fault fails the set. `DecisionBasis` gained `default-branch` and `origin`; `same-line` never had a rule that emitted it
  and was dropped. The decisions fact carries the remote URL by design (S8's "the URL
  never reaches a fact" scopes the refreshed workspace and impact facts); the MCP redacts it before it leaves, and a
  remote that is a local path, which the manifest would reject as a remote, is masked by that redaction. `pattern` stays
  deferred.
- Slice 3 (the loop): `init --workspace` persists the declaration and `init --trust` records trust per root; every
  query re-derives the set. The e2e starts from nine gaps over a trigger and three clones (a three-way gateway, two clone
  memberships, a name a clone serves, an unserved prefix and four trust records), writes a form-shaped manifest that
  carries a `remote`, installs trust for every root, and answers no decision on the next query that names no
  repositories; the stored remote is asserted too.
- The loop probe (`odd/probes/cross-repo/probe.mjs`, git-ignored) over the cross-repo workspace: the 15 library cuts the
  read sees (the inventory's 12 among them) are library decisions with their `path:line` evidence; the 121 unserved
  names are repository decisions, and no repository decision names a name the read does not state; the five clones
  passed with an `origin` are five `remote` decisions offering it and recommending none, and no `revision` is asked
  because no repository declares a `remote`; two runs are byte-identical. That workspace's set: 2 gateway, 3 library, 5
  membership, 5 remote, 121 repository, 6 trust.
- `init --workspace` (then `install`) validates every entry before it writes: the root and each `repos[].path` are resolved
  at the declared revision, so a path inside its repository, or one that is no repository root at all, answers its fault
  naming the entry and nothing is recorded. Open question 4 is closed as built
  (`src/core/application/install/install.ts`, `everyRepositoryReadable`).
- The `remote` kind offers every remote its clone states — `origin` and `upstream` alike — with the `.git/config` place
  that states each one, and only an address `init` would accept; a clone whose only remote is a local path keeps the gap
  with free text and no option. A `remote` basis candidate cites the remote that matched and never the clone's other
  remotes: `sortEvidence` keeps one place per `path:line` and the way it was reached, so two remotes at one configuration
  line stay two places.
- Determinism: sorted by id, no prose in the fact, no network request; an unreadable repository or declaration answers its
  typed fault and no partial set.
