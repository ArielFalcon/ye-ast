# Common MCP Response Modes Implementation Plan

> **For agentic workers:** Use `superpowers:executing-plans` to implement this plan task by task. Use `superpowers:subagent-driven-development` only when delegation is authorized and useful under the current project instructions. Checkboxes track execution, not work already completed.

**Goal:** Give all seven MCP tools one predictable `mode: "summary" | "details" | "full"` selector: summary identifies consequences, details supports investigation with recorded evidence, and full exposes exhaustive structured data without duplicating extensive bodies.

**Architecture:** The executable migration belongs to `src/mcp`: reuse `answer`, family renderers, query ports, `Fact<T>` and `FactRead<T>`, with shared delivery rules and family-specific output shapes. The core continues computing the same facts. [ADR-0022](../../architecture/adr/0022-typed-query-replay-and-selective-evidence.md) fixes the later capability strategy: typed selection, explicit projections, verified replay, declared-repository targeting, mixed snapshots and stateless pagination. Task 4 completes its implementation designs.

**Tech Stack:** Existing TypeScript 6.0.3, Zod 4.6.7, `@modelcontextprotocol/server` 2.4.0, `node:test` and `tsx`; no dependency changes. Use the Node version selected by `.nvmrc`.

**Spec:** The normative migration design is embedded in [Contract](#contract), [Layer ownership](#layer-ownership) and [Invariants](#invariants). [Execution tracks](#execution-tracks) separates executable work, bounded follow-up designs and deferred experiments. Read these before the task checklist; no chat history is required.

**Status:** Tasks 1–3 are implemented and verified on base `602ffe695f3e4130f8b5a603e20ccbaa85717200` with an uncommitted implementation diff. Independent checkpoint and final reviews are closed; the post-correction `npm run check` passed 1,902 tests, typecheck and architecture. Task 4 was not executed. Task 5 retains its separate historical evaluation evidence and unevaluated dimensions below. Commits are now authorized by the owner; no publication was performed. Execution reports, frozen fixtures and source identities are retained in the ignored `.superpowers/sdd/2026-11-04-common-mcp-response-modes/` workspace; Engram was unavailable.

## External evaluation evidence and limits

The inspectable [baseline index](../../../../ye-ast_test/evaluations/runs/20261104T171146Z-3e5ec6b0/index.md) and [baseline report](../../../../ye-ast_test/evaluations/runs/20261104T171146Z-3e5ec6b0/report.md) preserve the initial artifacts. The stock MCP collection used Node 24.22.2 and the captured `cfeae49b45f0839e62cba1991b84465a19116e7c` dist: 234 cases, 206 successes and 28 intentional expected tool errors; 86 complete, 113 partial and 7 unknown facts; eight of eight full-fact repeat pairs matched. Source advanced to `46380f08cc3111776710a94b05fce5b472811a05` while the executed dist stayed byte-identical. A separately frozen [current-build revalidation](../../../../ye-ast_test/evaluations/runs/20261104T175806Z-59a187e5/report.md) collected 92 full-result cases: 92 successes, 37 complete and 55 partial, all successful replies schema-valid, with eight of eight full-fact repeat pairs matching. Its [case index](../../../../ye-ast_test/evaluations/runs/20261104T175806Z-59a187e5/index.md) and paired comparison preserve the version boundary. Correctness is limited to recorded witnesses, not whole-repository recall; analysis and cache phases changed, so these versions are not a rendering-only performance comparison.

An original corpus clone also advanced during the work. Its queries used an unchanged run-owned replica and explicit SHA pins; the [drift adjudication](../../../../ye-ast_test/evaluations/runs/20261104T175806Z-59a187e5/inventory/target-drift-adjudication.json) records why those samples remain valid. The newer original HEAD is not represented as evaluated.

- Fact schema 0.12.0 includes optional `ImpactValue.modules`: origins carry file/change; modules carry file, base/head, depth, origins and optional via; cost includes `expansionsUsed`. Base is the merge base; head is the actual fact head. Keep module and symbol origins and budgets distinct in presentation and preserve module evidence in every full path and principal schema.
- A broad diff's default text was 813,446 UTF-8 bytes, including an 804,809-byte module block: 401 origins, 1,100 modules and 137,688 origin associations. Add compact grouping and repeated-support fixtures; never impose an arbitrary top-N on full data.
- A dense entrypoint inventory's default text was 655,418 bytes for 1,249 findings (1,009 known, 240 unknown), with 6,980 evidence references and 1,276 unique records. Test grouping and honest counts while preserving findings, coordinates and recovery.
- A cut list reached 615,074 bytes. Projection pages summarize global cuts and include relevant anchors; unselected full keeps all cuts and selection recovers places. Offline projection sizing is a post-collection derivative, not measured API performance. Large observed full single calls took roughly 35–110 seconds; replay repeats analysis, so cheap paging and a default page size are not established.
- Four mutated derivatives passed the advertised schema despite malformed receipt, snapshot or full shape. Actual successful replies passed their advertised schema; the probes do not show malformed outputs emitted. Harden schema and runtime validation through the planned mutation tests.
- Discovery schemas were 62,678 bytes and instructions 9,053 bytes on the wire; model-visible exposure is unknown. Scope applied to every repository in the observed pair; excluded unknown outside scope cannot count as hidden findings. The original trusted/live workspace was not queried to avoid an engine auto-index write; an untrusted committed replica was used and original trust records were unchanged. Positive trusted/live behavior, tokens, default page-size tuning and adoption remain `not_evaluated`.

## Global constraints

- Read the root `AGENTS.md`, `.claude/skills/ye-ast-testing/SKILL.md`, RFC-0002, RFC-0005, RFC-0015, RFC-0017 and RFC-0018 before changing code or tests. Follow-up designs also read RFC-0010, RFC-0011 and ADR-0020/0021/0022.
- Code, comments and documentation are English; user communication is neutral Spanish.
- Preserve the facts contract, trust boundaries, redaction, determinism and read-only query families.
- Preserve all concurrent work. Inspect the branch, HEAD and working-tree diff afresh; neither the original dirty checkout nor this revision's clean checkout is an execution assumption. Do not reset or copy older file versions over concurrent work.
- Use existing structural code tools first. The repository now has a partial graph index; use targeted source reads when its results are insufficient.
- Tasks 1–3 change MCP presentation, discovery and output validation only: no dependency, framework coverage, query capability, fact schema version, package version, CLI output or query-protocol output change. Task 4 prepares separately reviewable designs; it does not authorize their implementation.
- Preserve the authorized evaluation and its frozen identities; do not substitute an older build for the current-source revalidation. Offline in-memory SDK checks and stdio tests over disposable fixtures remain required for implementation.
- Commit only if the owner asks in the execution turn; never push unless asked. A skill's suggested commit step does not override this instruction.
- Save significant discoveries and final implementation evidence to Engram under the executing session's authoritative runtime identity.

## Quick path

1. Read the execution tracks, contract and existing public MCP tests; reconcile the current `main` baseline.
2. Execute Tasks 1–3 as one coherent adapter migration, including output contracts, public fixture tests and docs.
3. Run focused checks, realistic break proofs and `npm run check`; report deterministic correctness and byte observations separately from unmeasured adoption.
4. Prepare Task 4's bounded designs without adding their APIs. Use the recorded Task 5 baseline and retain its unevaluated dimensions.

## Execution tracks

| Track | Work and deliverable | Gate |
|---|---|---|
| A — executable migration | Tasks 1–3: common modes, consequence-first defaults, precise receipts, family-specific output shapes, truthful guidance, offline tests and docs | Current source/contracts; no real-workspace experiment required |
| B — bounded follow-up designs | Task 4: wire contracts, ownership and offline proof cases for the accepted ADR-0022 decisions and batch trust installation | Complete the bounded designs and implementation plans; do not reopen the six accepted choices or advertise unfinished APIs |
| C — empirical evaluation | Task 5: actual client exposure, real-workspace usefulness/cost and unprompted LLM adoption; use results to choose optimizations | Baseline collected with bounded correctness; client exposure, candidate comparison and adoption remain open |

The owner explicitly wants one installation action to apply the chosen `trusted` mode to all explicitly selected project repositories. Preserve an external declaration for each repository; the user does not repeat the choice repository by repository. This installation behavior is a requirement for Track B, not an MCP write or an implicit trust declaration by repository content.

### Accepted capability decisions

The owner accepted the six recommendations with "Vale, resuelvelas como recomiendas". [ADR-0022](../../architecture/adr/0022-typed-query-replay-and-selective-evidence.md) is their authoritative record. They can be fixed from semantics and current contracts without claiming measured efficiency.

| Decision | Chosen contract | Owner task |
|---|---|---|
| Recovery API | Typed `select` on existing tools with supported subjects/categories, initially impact/callers; no additional expansion tool | 4.2 |
| Selected output | A discriminated projection with source provenance, selection and page metadata. Selected `full` is the complete structured requested page; unselected `full` remains the whole public fact | 4.2 |
| Result lifecycle | Stateless query replay with model-visible `resultIdentity` and optional `expect`; continuation verifies identity. No final-result store or old-live-result retrieval | 4.2 |
| Repository targeting | Optional `repo` identifier resolved only from the externally declared set; launch repository is the omitted default. Unknown/ambiguous identifiers fail | 4.1 |
| Mixed snapshots | Per-repository mutually exclusive `revision`/`live`; capture once per operation and preserve complete per-repository provenance. Live requires its external trusted declaration | 4.3 |
| Pagination | Opaque stateless cursors bound to source identity, selection, limit and deterministic position; explicit positive safe-integer page limit, independent of analysis budgets | 4.2 |

Track A's exact receipts and whole-fact output remain the mode-only migration contract. Track B adds identity/projection metadata and input selectors through one coherent schema/version migration when implemented. Until then, discovery must keep rejecting those inputs. An identity is a verification token, not a handle that retrieves stored state. Changed live state or an incompatible cursor produces an explicit typed failure, never silent substitution or restart.

Remaining evidence-dependent choices are page-size defaults, additional selection categories, guidance/ranking refinements, and measured cost/adoption conclusions. Result handles, final-result retention, resource-based replacement and a universal pipeline language are outside this version; revisiting the accepted strategy requires an explicit later decision, not automatic selection of an empirical winner.

### Main-readiness gate

The owner confirmed the pending improvements ready and opened Track C. Record actual build and source identities for each collection; source changes during collection require explicit adjudication and cannot silently become current-build evidence.

For a comparative evaluation, freeze baseline and candidate on the same completed-main foundation and equivalent semantic inputs. Old byte notes or the pre-improvement engine are historical context, not a scored baseline for attributing gains to this refactor. A corpus or harness that is unavailable after readiness remains `not_evaluated` with its reason. No background polling or automatic real-workspace execution is part of this plan.

## Review focus

- Unknown receipts require `reason`; known receipts forbid it; both runtime validation and the advertised schema express that rule (Tasks 1.4, 2.2).
- SHA/live snapshot identities retain `sha` or `head`/`stateId`, including in receipts (Tasks 1.4, 2.2, 2.4).
- A foreign repository with the same relative path cannot be investigated through the launch-bound repository by silently reusing coordinates (Tasks 1.7, 3.1).
- An invoked destination is distinguished from an affected consumer, and recorded origin associations are not rendered as complete call chains (Task 1.7).
- A small, resolved result can finish without an unnecessary follow-up or JSON tutorial; modes are directly selectable (Tasks 1.7, 3.1).

## Context and problem

The owner observed that an agent consumes verbose JSON even when instructed to read the text. The current implementation emits both channels on every successful response:

- `detail: "summary" | "full"` controls text rendering.
- `full?: boolean` independently includes the entire fact in `structuredContent`.
- Without `full: true`, structured content is still the fact envelope, including `inputs` and `evidence`, but excluding `value` and `cuts`.
- With `full: true`, the full structured fact is added while the same text is retained.

The issue is content selection, not a reliable separation between a host's and an LLM's channels. Do not assume the client hides structured content from the model.

Historical frozen local-impact measurements were 92,574 UTF-8 bytes of summary text, 210,330 bytes of detailed text, 629,941 bytes of full structured data and 785 bytes of default envelope. These are one snapshot's observations, not token counts, performance promises, upper bounds or acceptance thresholds. JSON's larger body also contains more information; syntax alone does not explain the difference.

The subsequent impact presentation changes improved destination-handler locations and repository attribution but expanded detailed text to 881,540 bytes by listing 6,230 entrypoint-origin associations. Summary remained 93,917 bytes; the full structured fact remained 629,941 bytes. These observations use the same frozen local fact as the historical comparison.

The owner approved a common presentation standard after reviewing an illustrative summary/details example: summary identifies consequences; details explains the presented consequences with actionable recorded evidence; full retains exhaustive data for queries. This supersedes preserving the current detailed text verbatim. A file/count-only prototype demonstrated substantial size reduction but did not establish standalone investigative usefulness; its byte size is not an implementation target. The approved text redesign below is part of this migration; unrelated analysis or presentation changes remain out of scope.

## Contract

### One selector for every tool

| Mode | `content` text | `structuredContent` | Meaning |
|---|---|---|---|
| omitted / `summary` | Concise consequences, retrieval coordinates and material limitations | Minimal presentation receipt | Recognize what matters and select an investigation |
| `details` | Compact consequences plus recorded explanatory evidence and localized limitations | Minimal presentation receipt | Investigate the presented consequences without first retrieving and joining full JSON |
| `full` | A brief acknowledgment plus contextual JSON navigation, never the family listing | Full redacted fact plus response metadata and `mode: "full"` | Programmatically inspect/filter all recorded data with a guide to the relevant evidence |

All seven tools support these same modes: `ye_ast_entrypoints`, `ye_ast_impact`, `ye_ast_callers`, `ye_ast_importers`, `ye_ast_outline`, `ye_ast_workspace`, `ye_ast_decisions`. A tool can have identical summary and details text if its existing projection has nothing to elide. Do not manufacture differences.

`details` is not the former `detail: "full"` projection under a new name. It is not required to enumerate every seed, symbol, origin association or cut reference. `full` includes the entire public fact available from the query, including partial cuts and contributing read provenance; it does not extend analysis coverage or turn an unknown fact into a value.

Do not add `format`, `focus`, `sections`, pagination, result handles, files or resources in this migration. No current tool has the proposed presentation-only `focus` selector; guidance must never suggest it is available. Existing `targets`, `changed`, `files`, `scope`, `budget`, `repos`, `gateways`, `workspace`, `offline` and snapshot selectors retain their exact semantics and supported combinations.

### Composition and selection semantics

The common contract makes supported operations understandable and their coordinates reusable. It does not make arbitrary tool outputs interchangeable or create evidence by concatenating answers.

| Dimension | Meaning and boundary |
|---|---|
| Tool family | The question answered: impact of a diff, callers of targets, file shape, workspace names, or configuration gaps |
| Repository and snapshot | The declared clone and the actual SHA or live `head`/`stateId`; workspace facts preserve every contributing read |
| `changed` / `targets` | Which changes or declarations seed the query; `changed` applies only to the trigger repository |
| `scope` | Analysis coverage: files outside it are not known; workspace currently applies that same scope to every repository |
| Traversal `budget` | Analysis work bounds, with recorded cuts; it is not a response-size budget |
| Presentation selection | The accepted future `select` extension recovers already recorded evidence; it cannot reveal content outside analysis coverage |
| `mode` | Presentation of the same fact, without altering any dimension above |

Use `changed`, not a narrower `scope`, when the question is the consequences of one area of a change while retaining consumers elsewhere. A count of call sites excluded from analysis cannot be inferred from the restricted result. Do not add a `scope-hidden` cut or a guessed count. Presentation omissions are counted recorded items and never make a complete analysis partial. Filtering after traversal is not equivalent to restricting the traversal first.

For a related query, identify its owning repository and recorded snapshot as well as file/symbol/range. Current tools are launch-bound: a foreign coordinate cannot be passed directly to their `callers` or `outline`. Track A guidance can identify an available clone root and the need for an instance bound there; it must not advertise `repo` before Track B implements the accepted selector. The later selector preserves the launch default and resolves only declared identities. Neither track promises recovery of an old live state. Existing core types and query contracts remain the identity owners; no unused generic reference framework or pipeline executor is introduced.

Workspace discovery supplies candidate repositories; the workspace impact use case performs the evidence-bearing joins and walks. Combining the two tool replies does not compute that traversal. A fact contains recorded results, not the complete underlying graph. Full JSON or a future expansion cannot supply a proof or chain absent from those results.

### Common text standard: recognize, investigate, query exhaustively

Apply the same purpose to all seven tools, using each family's existing facts rather than imposing an impact-specific template:

- **Summary:** answer the tool's main question concisely. Identify consequences or findings and their useful coordinates, retain status, snapshot, declared scope, change selection and material limitations, and count repetitive supporting data. It is not a declaration inventory or a miniature copy of full JSON.
- **Details:** make the presented findings investigable on their own. Include the relevant declarations or subjects, coordinates, recorded relationship/basis and localized uncertainty needed to understand them and choose source locations to inspect. Opening the cited source is a normal next step; obtaining full JSON and joining its arrays must not be a prerequisite for understanding the findings shown here. A file/count-only inventory does not meet this rule when the fact carries explanatory evidence.
- **Full:** preserve the entire public structured fact for exhaustive inspection, joins and filtering. Its text combines a brief acknowledgment with contextual navigation that significantly helps an agent choose what to read and how to locate it in the JSON. Returning structured content alone does not implement filtering outside model context; that depends on the client.

The standard is about usefulness, not maximum length or mandatory differences between modes. Simple or already compact results can have identical summary/details text. Never invent evidence, explanatory links or extra content to distinguish modes. When the fact cannot explain a relationship further, state the recorded association and the missing evidence explicitly; full does not contain a proof that the engine never recorded.

| Tool family | Summary emphasizes | Details adds when recorded |
|---|---|---|
| Entrypoints | Supported entrypoints and handler coordinates | Handler metadata, matching basis/confidence and relevant coverage limitations |
| Impact | Affected/changed entrypoints and consequences of the diff | Change origins, recorded dependencies or origin associations, dependency locations, cross-repository destination evidence and localized cuts |
| Callers | Dependents and entrypoints reached from the requested targets | Named targets and the recorded incoming dependency evidence and locations explaining the presented findings |
| Importers | Files importing, using or only naming a requested file | File-level groups and overlapping unresolved matches; the payload has paths, not declarations or relationship line locations |
| Outline | Declarations, spans and imports needed to select source ranges | Available declaration/import detail and unheld-file limitations; identical text is valid when nothing useful was elided |
| Workspace | Outward names, candidate repositories and unresolved membership | Recorded matching basis, evidence locations, gateway information and repository-qualified limitations |
| Decisions | Configuration gaps and evidence-backed options | Supporting evidence, declared constraints and recorded recommendation basis; no inferred code-change approval |

For impact and callers, preserve consequence-before-origin ordering and explicitly requested callers targets. Explain recorded findings using available seed associations and `via` evidence; an origin association is not a complete call chain, a depth is not a service-hop count, and the first recorded origin is not a ranked or nearest origin. Show a call-site coordinate only when it is present in the fact. Preserve cross-repository basis/confidence and recorded `reach` ordering without implying runtime execution.

Consequence-first is the default, not an undiscoverable alternative view. Group backend routes and reached UI routes only through associations the fact records. Distinguish incoming affected consumers from outgoing invoked destinations: a changed caller does not by itself prove that a called service changes. A symbol view remains available in full data; do not add `blast_radius` or `impact_live` variants for an existing question. The engine reports evidence for investigation, not approval of a code change.

Compact module origin associations and repeated entrypoint evidence as well as symbol support. A module-only impact is not empty. Count known and unknown findings separately: a complete collection may contain unknown items. Preserve shown coordinates and a supported recovery path without requiring an exhaustive summary. Compact repeated support by grouping identical recorded contexts and printing shared paths or relationships once, with deterministic ordering and counted-elision rules. Keep consequence identities and actionable coordinates. Count additional origins and cut references instead of expanding every association beneath every entrypoint. Preserve cut kinds, applicable limits, owning repository/read and relevant anchors; full retains every recorded place. A cut anchored at a file does not itself prove that file is impacted. Symbol and seed counts can overlap and must not be added as disjoint totals.

Every omitted category must be identified with a truthful count and a recovery pointer to `mode: "full"` for exhaustive recorded data. Use `mode: "details"` only for evidence that details actually renders. Do not imply that `outline`, `callers` or `importers` reconstruct the same impact fact: they answer related questions. `changed`, `scope` and traversal budgets change the semantic query and are not presentation filters.

**Illustrative impact example, not a real measurement or an output grammar:** a changed `OrderService.getOrder` has a recorded caller `OrdersController.getOrderDetail` serving `GET /orders/{id}`. Summary identifies the endpoint, handler coordinate and partial status. Details additionally identifies the changed declaration, the recorded dependency and its call-site coordinate if available, and the unresolved declaration/anchor responsible for a cut. It does not repeat every origin associated with that endpoint. If only an origin association is recorded, label it as such rather than printing an invented `calls` edge.

**Acceptance:** using details and its cited source locations, an agent can identify a presented consequence, understand its recorded basis and locate the uncertainty without a full-result join. Full is needed for exhaustive questions, not to decode details. Verify this with realistic impact/callers, workspace and configuration-gap cases before accepting size improvements. Measure both text modes on the same frozen facts; restoring the old detailed listing or merely renaming it fails this design even if transport duplication is removed. No fixed byte cap, arbitrary top-N or unmeasured token-saving promise is introduced.

### Self-documenting responses in every mode

Every tool's text must make its findings, status and material limits understandable. Add contextual next operations when they recover an omission, resolve uncertainty or answer a useful related question. This applies to every mode, verified-empty and unknown facts, and explanatory faults. A resolved answer may end without a follow-up; do not append a mandatory tutorial or manufacture work for the agent.

- Derive guidance from the tool, actual findings, omissions, available evidence and limitations. Explain what can be
  investigated next, which supported tool/selector serves that question and which recorded identities or coordinates
  locate the relevant evidence. Emit the useful branches for this response rather than a complete catalog of tools.
- When relevant evidence is omitted, details explains how full locates it: give concrete payload paths, matching fields and necessary joins once per context. Do not enumerate every section or repeat guidance already supplied nearby. One example using a recorded identity is a lookup aid, not a ranking.
- Full text guides reading the JSON already delivered. It must not tell the agent to request full again or reproduce
  summary/details listings. Give actionable paths and identity/join semantics, relevant completeness checks and
  snapshot interpretation. Mention response siblings only when present and useful; do not repeat their arrays.
- Paths and selectors must match the actual public result. Distinguish local payloads from workspace sections, and
  zero-based array indexes from link IDs and display numbers. An unknown fact has reason/evidence, not an invented
  value. Verified-empty guidance states the supported scope of that emptiness and offers a next query only when it
  answers a useful different question. Absent sections must not be advertised as containing evidence.
- Follow-ups over the same result use its recorded identities. A new semantic query must retain applicable committed
  revisions, base/head, change selection and workspace pins to be comparable. A live state cannot be pinned by
  silently treating its HEAD as the same content. Scope/changed/budget are not JSON filters. Never imply that a guide
  executes a query or guarantees filtering outside model context.
- All modes are directly selectable. Do not prescribe a compulsory summary → details → full sequence. Initialization and tool descriptions own stable usage rules; response text owns answer-specific evidence and recovery. Discovery text must distinguish supported tools without repeating the complete shared contract in every description.
- Errors retain their typed kind, redacted cause, relevant offending inputs/candidates and machine-readable fault
  metadata. Add a concrete correction or supported alternative where the cause establishes one. Say when a condition
  must change, when repeating the same request cannot help, or when the cause is insufficient to prescribe a fix.
  Do not elevate trust, refresh remotes, modify repositories or fabricate a retry remedy. SDK-owned validation errors
  retain their SDK ownership; improve schemas/instructions without inventing engine fault metadata for them.

For example, when an impact answer records several origins for a reached handler, useful guidance identifies how to
match that handler in `value.entrypoints` and explains that its `seeds` are zero-based indexes into `value.seeds`.
For dependencies, match `value.symbols` by file/symbol/line and read `via.lines` in that symbol's own file. A workspace
answer instead identifies `value.sections[repo].value.impact`, checks that section's status and contributing reads,
and explains that link `reach` contains IDs to resolve through `value.links[].link.id`, not the text's display numbers.
Include only operations warranted by the recorded data; never infer an unrecorded call chain.

**Acceptance:** when recovery is useful, the answer identifies the supported operation, matching fields, necessary joins and limits without requiring schema reconstruction. A small resolved fixture does not solicit unnecessary calls. Test local/workspace, absent/unknown and fault branches through public fixture seams. Mutations of a payload path, join, repository qualification or recovery argument must fail the owner test. Measure guidance separately from findings; grouping is required, while its effect on real task cost remains deferred.

### Minimal receipt for text modes

A receipt is transport information, not a `Fact<T>` and not a provenance record. Its exact keys are:

```ts
type ReceiptBase = {
  mode: "summary" | "details";
  snapshot: Fact<unknown>["snapshot"];
};

type TextReceipt = ReceiptBase & (
  | { status: Exclude<Fact<unknown>["status"], "unknown"> }
  | { status: "unknown"; reason: Extract<Fact<unknown>, { status: "unknown" }>["reason"] }
);
```

Include `reason` exactly when the fact is unknown; it is required then and forbidden on known receipts. Express this in both runtime validation and the advertised JSON Schema. Snapshot validation must retain the existing identity fields: SHA requires `sha`; live requires `head` and `stateId`. Copy these from the redacted fact, without deriving a new completeness verdict.

No `schema`, `producer`, `inputs`, `evidence`, `value`, `cuts`, repository arrays, refresh arrays or serialized text body belongs in this receipt. The snapshot includes its complete existing SHA/live identity. A receipt must never be cast to a `Fact` to satisfy a type.

For text modes, text carries declared scope, changed selection, evidence and cuts at that projection's level, repository-root mappings, freshness/resolution and stale notices. Preserve their meaning and consequence-before-origin ordering while applying the common text standard. Do not lose response metadata because it was removed from structured text-mode output.

### Full structured result

Keep the current flattened full-result layout and append `mode` as transport metadata:

```ts
{
  ...redactedFact,
  mode: "full",
  // The existing optional siblings, when present:
  repositoryRoots,
  freshness,
  resolution,
  live,
}
```

The example identifies conditional siblings, not properties whose value should be `undefined`. Preserve current omission behavior. `mode` and response siblings are outside the deterministic fact; they never enter its `inputs`, `value`, stored representation or identity.

Continue using `withoutRepositories` for workspace: internal read locations and internal repository entrypoint bundles do not become public merely because full mode was requested. `repositorySources` remains internal in every mode. Do not broaden exposure while changing presentation.

The full-mode text starts with this acknowledgment:

```text
status: <the recorded status>
full structured result: structuredContent
```

Render this prefix from the redacted fact status, then append the contextual guide required above. This supersedes
the former two-line-only full-text rule. The guide does not repeat seeds, symbols, cut-location lists, evidence,
roots or refresh arrays; it explains useful lookups and joins over the delivered JSON and relevant limitations.
Unknown reasons, declared scope and response metadata remain available in the structured result. Neither this guide
nor the acknowledgment is a substitute for reading the evidence needed to support a conclusion.

Keep existing `_meta` behavior for `ye-ast/live` and `ye-ast/fault`. Do not move the full fact or large arrays into `_meta` as an attempted hiding mechanism.

### Why the receipt exists

Every tool currently advertises an output schema. The installed SDK rejects a successful result without `structuredContent` when that schema is registered. Preserve schema advertisement and validation rather than removing them to claim literally zero JSON in text modes.

Advertise object-root receipt/full alternatives, sharing the receipt and fact envelope while specializing full `value` by public payload family. Impact/callers accept their existing local or workspace value shapes. Do not use one universal union of every tool's payload, or require full clients to infer the family entirely from `value: z.unknown()`. Validate the envelope and principal payload collections now; exhaustive recursive schemas for every domain leaf are outside this migration. Production types/constants remain authoritative; wire validation adds no second classifier or core dependency on Zod.

The earlier SDK probe established mode-discriminated object schemas only. Repeat final schema conversion through `openSession`: `tools/list` must advertise the actual mode/status conditions and family shape, and `tools/call` must return the original object without a wrapper. A runtime refinement alone does not prove that JSON Schema publishes the condition. Reuse the local `liveSchema` refinement-plus-schema-metadata precedent and the existing `AjvJsonSchemaValidator` tests where necessary; introduce no dependency.

Client behavior remains a compatibility consideration: full mode requires a client that exposes structured content. Do not duplicate the JSON into `content` for a client that only reads text. Hosts already have library/query-protocol access; adding a legacy-client fallback is a separate product decision.

MCP's [structured-content guidance](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#structured-content) recommends a serialized text copy for backward compatibility (`SHOULD`, not `MUST`). This migration deliberately avoids that duplication. Document the requirement rather than claiming universal client compatibility; actual exposure and truncation checks are deferred to Task 5. An offline SDK test proves transport/schema behavior, not what an LLM sees.

### Migration policy

Replace the previous controls, without compatibility aliases:

| Previous call | New call |
|---|---|
| omitted `detail`, omitted/false `full` | omitted `mode` or `mode: "summary"` |
| `detail: "full"`, omitted/false `full` | `mode: "details"` |
| `full: true`, with either text detail | `mode: "full"` |

The combination of an extensive text projection and a complete JSON fact in one call is intentionally removed. A consumer needing both requests the two presentations explicitly. Migrating to details does not preserve the old exhaustive text listing: exhaustive items remain in full JSON. The engine need not guarantee cross-call cache reuse; it must keep presentation out of the fact's computation and identity.

Strict schemas reject old `detail` and boolean `full`, unsupported `format`/`focus`, and invalid modes. Even `full: false` must be rejected rather than silently accepted. Document this as an MCP API migration. Do not increment the domain `SCHEMA` for an adapter-only change; coordinate release versioning with the owner at publication, not by changing versions in this task.

## Layer ownership

| Existing surface | Responsibility after migration |
|---|---|
| `src/mcp/presentation.ts` — new, small module | Shared mode schema, inferred mode types, typed response-renderer signature |
| `src/mcp/server.ts` | Tool arguments, shared receipt/envelope and family-specific output schemas, response assembly, redaction and metadata |
| `src/mcp/render.ts` | Family-specific summary/details text, counted elisions and recovery wording |
| `src/core/ports/*queries.port.ts` | Existing semantic requests and results; unchanged |
| `src/core/domain/shared/fact.ts` | Existing fact/completeness/identity contract; unchanged |
| `src/core/application/**` | Existing analysis and orchestration; unchanged |
| CLI and query protocol | Existing full facts and requests; unchanged |

No core presentation port, strategy classes, renderer registry or universal untyped query service is needed. The current shared `answer` function is the owner of delivery. If the small presentation module grows orchestration or new domain classifications, move that logic back to its actual owner rather than expanding this module.

Counts, grouping and elisions over an existing fact are presentation. A newly inferred dependency, declaration owner, causal link or completeness decision is a domain change and falls outside this plan.

## Invariants

1. Identical semantic queries produce the same underlying fact regardless of mode; do not forward mode to a query port or add it to fact/cache inputs.
2. Summary elision never changes `complete`/`partial`/`unknown`. An unknown result retains its exact reason; verified empty remains complete and empty.
3. Text modes follow the common recognize/investigate standard. Details retains actionable coordinates and recorded explanatory evidence for presented findings, groups repeated support and identifies counted omissions; it need not list every seed, symbol, association or cut place. Explicitly requested callers targets remain identifiable. Exhaustive data remains in full JSON.
4. Existing global consequence-before-seed ordering survives for local and every workspace section.
5. Contributing `RepoImpact.reads`, composite identities, cuts, scopes and trust provenance survive unchanged in full JSON; their actionable limitations and attribution survive in text modes, even when repeated places are counted.
6. Redact the fact and response metadata before branching or rendering. Test the public result including `_meta`; do not introduce a new redaction policy.
7. Freshness, resolution, roots and live notices stay outside facts. Text modes convey them in text; full conveys them as structured siblings. Omit them when absent.
8. Application faults remain `isError`, with current typed metadata and no success receipt. SDK argument-validation failures remain SDK errors; do not fabricate `ye-ast/fault` for errors the adapter did not create.
9. Full mode renders only its acknowledgment and contextual guide, never an unused summary/details body or refresh listing. Family renderers branch before constructing extensive listings.
10. Retain deterministic ordering and counted-elision rules. No arbitrary top-N, line-count cap, deadline-based formatting or tokenizer is introduced.
11. Coverage exclusions, traversal cuts and presentation omissions remain distinct. A summary never invents excluded call-site counts or treats an outgoing destination as an affected consumer without recorded evidence.
12. Related queries preserve repository ownership and available snapshot identity; unsupported foreign targets or live/workspace combinations are not advertised as callable. Preparing a future design does not change current schemas.

## File map and execution ownership

| Action | File | Notes |
|---|---|---|
| Create | `src/mcp/presentation.ts` | Only shared mode schema/types |
| Modify | `src/mcp/server.ts` | Seven registrations, shared receipt/envelope, family output variants, `answer`, instructions |
| Modify | `src/mcp/render.ts` | Shared text standard, compact explanatory projections, `Detail` to `ResponseMode`, accurate recovery instructions |
| Modify | `src/mcp/impact-presentation.test.ts` | Standalone investigative usefulness, grouped evidence and truthful omissions |
| Modify | `src/mcp/server.test.ts` | Existing observable MCP rules and new delivery behavior |
| Modify only if needed | `src/mcp/test-session.ts` | Widen schema description type only if tests inspect `oneOf`; preserve raw JSON-RPC client |
| Modify | `src/composition/mcp.e2e.test.ts` | Actual stdio migration and CLI fact parity |
| Modify | `src/composition/compose.test.ts` | Existing full-result freshness composition consumer |
| Modify | `README.md` | User-visible mode table and examples |
| Modify | `docs/architecture/rfc/0005-transports.md` | Current transport contract and seven tools |
| Modify | `docs/architecture/rfc/0015-answer-coordinates.md` | Clarify historical measurements versus current contract |
| Modify | `docs/architecture/rfc/0017-answer-size-and-outline.md` | Mode vocabulary, channel assumption and counted-elision scope |

One implementer owns the coherent MCP migration, including its tests/docs. If using a sidekick, give that sidekick the complete contract and ownership of these files; the lead owns shared-root integration and git. Do not assign separate agents to interdependent server, renderer and fixture edits. Other active work on these files must be reconciled before editing.

## Task 1: Migrate the public MCP modes and delivery mechanism

**Files:** Create `src/mcp/presentation.ts`; modify `src/mcp/server.ts`, `src/mcp/render.ts`, `src/mcp/server.test.ts`, `src/mcp/impact-presentation.test.ts`; adjust `src/mcp/test-session.ts` only if schema inspection requires it.

**Consumes:** Existing query ports, `Fact<T>`, `FactRead<T>`, `LiveStaleNotice`, `CallToolResult`, family renderers and test `setup`/`openSession`.

**Produces:** Shared `responseModeSchema`, `ResponseMode`, `ResponseRenderer<T>`; one mode-based `answer` path; shared receipt/envelope rules with the family output schemas in Task 1.4.

- [x] **1.1 Reconcile the execution baseline.** Read current diffs in the owned files and record the initial focused-check results. Preserve concurrent fixes, especially nested/class joins, root sidecars, contributing reads and global renderer ordering. Do not edit domain/application files to make these tests pass.
- [x] **1.2 Update the existing public delivery tests to the new behavior and observe red.** Extend `TOOL_CALLS` with `ye_ast_outline` using `{ files: ["src/Order.java"] }`; it currently omits outline despite tests claiming every tool. Compare its coverage with names returned by `tools/list`. Replace the old same-text/full-boolean expectations rather than retaining contradictory tests.

The receipt assertion belongs in the existing seven-tool test, with `t.after` or the file's established cleanup approach:

```ts
const { session } = await setup();
try {
  for (const [name, args] of TOOL_CALLS) {
    for (const mode of ["summary", "details"] as const) {
      const result = await session.callTool(name, { ...args, mode });
      const receipt = result.structuredContent as Record<string, unknown>;
      assert.equal(receipt["mode"], mode, name);
      assert.deepEqual(Object.keys(receipt).toSorted(), ["mode", "snapshot", "status"], name);
      assert.ok(textOf(result).length > 0, name);
    }
    assert.deepEqual(
      await session.callTool(name, args),
      await session.callTool(name, { ...args, mode: "summary" }),
      name,
    );
    const whole = await session.callTool(name, { ...args, mode: "full" });
    const full = whole.structuredContent as Record<string, unknown>;
    assert.equal(full["mode"], "full", name);
    assert.equal("value" in full, true, name);
    assert.ok(textOf(whole).startsWith(`status: ${full["status"]}\nfull structured result: structuredContent\n`), name);
  }
} finally {
  await session.close();
}
```

Use the existing impact fixture to guard full delivery and fact identity:

```ts
const cuts = [{ kind: "depth", at: ["src/A.java::f"], limit: 1 }] as const;
const partial = impactFact({ status: "partial", cuts });
const { session, calls } = await setup({ ofChange: async () => ({ ok: true, value: partial }) });
try {
  const whole = await session.callTool("ye_ast_impact", { base: "main", mode: "full" });
  const { mode, ...fact } = whole.structuredContent as Record<string, unknown>;
  assert.equal(mode, "full");
  assert.deepEqual(fact, JSON.parse(JSON.stringify(partial)));
  assert.ok(textOf(whole).startsWith("status: partial\nfull structured result: structuredContent\n"));
  await session.callTool("ye_ast_impact", { base: "main", mode: "details" });
  assert.deepEqual(calls.ofChange[0], calls.ofChange[1]);
  assert.equal("mode" in (calls.ofChange[0] ?? {}), false);
} finally {
  await session.close();
}
```

Run `node --import tsx --test src/mcp/server.test.ts`. Verify failures identify the old input/delivery contract, not fixture errors. These snippets use current production types and existing test helpers; accommodate legitimate concurrent type additions without wholesale fixture replacement.

- [x] **1.3 Introduce the shared selector and renderer types.** Use one schema source and infer its TypeScript type; do not maintain an independent string union.

```ts
import { z } from "zod";
import type { Fact } from "../core/domain/shared/fact.ts";

export const responseModeSchema = z
  .enum(["summary", "details", "full"])
  .default("summary")
  .describe("Response presentation only: summary identifies consequences or findings; details adds recorded evidence and locations for investigation; full returns the complete structured result with contextual JSON navigation, without repeating the text projection. Coverage and traversal bounds do not change.");

export type ResponseMode = z.infer<typeof responseModeSchema>;
export type ResponseRenderer<T> = (fact: Fact<T>, mode: ResponseMode) => string;
```

In `render.ts`, import `ResponseMode`, remove exported `Detail`, update the relevant annotations and change detailed branch comparisons to `"details"`. In full mode return only the contextual guide, branching before building the family listing. Reuse guidance between text modes and full without computing an unused projection. Redesign the family projections according to the common text standard rather than mechanically renaming the old detailed branch. Recovery pointers must distinguish explanatory details from exhaustive full data. Do not rename unrelated fault `detail` fields or change any fact producer.

- [x] **1.4 Advertise precise shared delivery and family-specific output schemas.** Keep this boundary in `server.ts`; reuse the current fact/sibling definitions, production types and constants. Create strict `TEXT_OUTPUT` with the exact receipt keys and the status/reason relation from the contract. Reuse one snapshot schema that requires complete SHA/live identities. Runtime refinements and advertised JSON Schema must agree, following the existing `liveSchema` precedent when conversion needs explicit metadata.

Build `ENTRYPOINTS_OUTPUT`, `IMPACT_OUTPUT`, `IMPORTERS_OUTPUT`, `OUTLINE_OUTPUT`, `WORKSPACE_OUTPUT` and `DECISIONS_OUTPUT` from that receipt and a shared full-fact envelope. `IMPACT_OUTPUT` is reused by impact and callers and admits their actual local/workspace variants. Each full branch has `mode: "full"`; known facts require their value, partial facts require cuts, and unknown facts require reason without a value. Keep additive public fields permitted in full payloads; receipts remain strict. Update legacy selector wording.

| Output schema | Principal public shape and authoritative owner |
|---|---|
| `ENTRYPOINTS_OUTPUT` | `value.entrypoints` is a nested fact containing an array when known; `src/core/domain/map/entrypoint-map.ts` |
| `IMPACT_OUTPUT`, local | `seeds`, `symbols`, `entrypoints`, `cost`, optional change fields and optional `modules`; `src/core/domain/impact/impact-fact.ts` |
| `IMPACT_OUTPUT`, workspace | `workspace`, `repositorySnapshots`, `trigger`, `sections`, `links`; `src/core/ports/workspace-impact-queries.port.ts` |
| `IMPORTERS_OUTPUT` | `files[]` with `file`, `importers`, `users`, `unresolvedNamers`; `src/core/domain/impact/importers-fact.ts` |
| `OUTLINE_OUTPUT` | `files[]` with declarations/spans/imports and `unheld`; `src/core/domain/outline/outline-fact.ts` |
| `WORKSPACE_OUTPUT` | `workspace`, `repositorySnapshots`, `sections`, `candidates`, `unserved`; public projection of `src/core/ports/workspace-queries.port.ts`, excluding internal `repositories` |
| `DECISIONS_OUTPUT` | `decisions`, snapshot-bearing `repositories`, `source`; `src/core/ports/decision-queries.port.ts` |

Validate required containers, their array/object types, and identity/coordinate fields consumed by the guides. Reuse the shared envelope for nested facts whose status must remain interpretable. Do not recursively duplicate every domain union or add inferred classifications; document the validation boundary. One family-wide `value: z.unknown()` is insufficient. No port or fact type changes are needed.

Set the corresponding schema on each registration. Extend the public delivery test to validate real outputs against their advertised schema using the existing `AjvJsonSchemaValidator`. Reuse those outputs as decisive mutation cases: remove unknown reason, add reason to known receipt, delete the SHA/live identity, remove a required family collection, and remove partial cuts. Each must be rejected by the owned runtime schema and advertised schema. Keep accepted unknown, partial and nested-unknown variants. These guard the server's declared contract, not the validator library. Extend `test-session.ts` schema-description types only for the actual published union/conditions.

- [x] **1.5 Change the existing `answer` signature and branch after redaction.** Keep its query callback, error handling and stale callback intact:

```ts
async function answer<V, F extends { kind: string; detail: string }>(
  query: (onStale: (notice: LiveStaleNotice) => void) => Promise<Result<Fact<V> | FactRead<V>, F>>,
  mode: ResponseMode,
  render: ResponseRenderer<V>,
): Promise<CallToolResult>
```

After obtaining the existing redacted `fact`, `repositoryRoots`, `refresh` and `stale`, assemble responses using the following branches. These variables retain the meanings they have in the existing `answer`; do not introduce another query execution path.

```ts
if (mode === "full") {
  return {
    content: [{ type: "text", text: [
      `status: ${fact.status}\nfull structured result: structuredContent`,
      render(fact, mode),
      ...(repositoryRoots === undefined ? [] : ["Repository locations: match repositoryRoots[].repo to evidence ownership; repositoryRoots[].path locates the clone on disk, while evidence paths are relative to its repository at the recorded snapshot."]),
      ...(refresh === undefined ? [] : ["Remote context: inspect freshness and resolution for the repositories used; pinned revisions do not imply verified freshness."]),
      ...(stale === undefined ? [] : ["Live context: inspect live.stateId and live.changed before comparing this result with the current working tree."]),
    ].filter((part) => part !== "").join("\n") }],
    structuredContent: {
      ...fact,
      mode,
      ...(repositoryRoots === undefined ? {} : { repositoryRoots }),
      ...(refresh === undefined ? {} : { freshness: refresh.freshness, resolution: refresh.resolution }),
      ...(stale === undefined ? {} : { live: stale }),
    },
    ...(stale === undefined ? {} : { _meta: { [LIVE_META]: stale } }),
  };
}

const sidecar = [
  ...(stale === undefined ? [] : [renderStale(stale)]),
  ...(refresh === undefined ? [] : renderRefresh(refresh)),
  ...(repositoryRoots ?? []).map(({ repo, path }) => `repository root: ${repo} -> ${path}`),
];
return {
  content: [{ type: "text", text: [...sidecar, render(fact, mode)].join("\n") }],
  structuredContent: {
    mode,
    status: fact.status,
    snapshot: fact.snapshot,
    ...(fact.status === "unknown" ? { reason: fact.reason } : {}),
  },
  ...(stale === undefined ? {} : { _meta: { [LIVE_META]: stale } }),
};
```

Delete `withoutPayload` after verifying it has no consumer. Do not replace it with another envelope stripper: the receipt intentionally selects a few fields. Keep `withoutRepositories`, the internal-read exclusions and the existing failure function.

- [x] **1.6 Wire all seven registrations atomically.** Remove common `detail`/boolean `full` schemas, add `mode: responseModeSchema`, and forward `mode` only to `answer`. Both local and workspace branches of impact/callers must use it. For example, retain the existing query callback and pass `(queryCallback, mode, renderImpact)` or `(queryCallback, mode, renderWorkspaceImpact)` as appropriate. Preserve all input refinements, required semantic parameters and cancellation signals.
- [x] **1.7 Migrate renderer tests and guard the common text and self-documentation standards.** Old structured calls become `mode: "full"`; revise detailed-text expectations to the explanatory projection. Reuse existing fixtures/tests for requested targets, grouped `via`, localized cuts, unknown contributing reads, workspace basis/confidence, global ordering and index/ID joins. Details must explain shown findings without joining full arrays; omitted evidence has truthful recovery. Guidance uses redacted facts and actual metadata, not raw request echoes.

Extend the responsible public tests for the review-focus rules: an origin association without a complete chain; an outgoing destination distinguished from affected consumers; the same relative path in two repository sections retaining its owner/snapshot and no unsupported foreign-target call; path-only importer evidence with no invented line; and a small resolved result with no unnecessary next call. Full guidance uses delivered sections only and avoids a family listing. Direct details/full calls must work without an earlier summary. Do not add a new test where an existing one already guards the same rule; prove realistic mutations break the owner tests.
- [x] **1.8 Run focused checks and prove regression sensitivity.** Run `npm run typecheck`, `npm run arch:check` and `node --import tsx --test src/mcp/server.test.ts`. Temporarily restore payload spread into the receipt and verify the minimal-receipt test fails; temporarily replace the full guide with the family listing and verify the owner test rejects the duplicated listing; corrupt one guide path/join and verify its contextual-navigation test fails. Inspect the full renderer branch separately to confirm it builds the guide directly without computing and discarding the extensive projection; do not introduce a private-function spy just for that inspection. Restore each mutation before proceeding.

**Acceptance:** Every registered tool exposes the new selector, defaults to summary, retains its semantic query, and returns exactly the agreed delivery shape. Every mode meets the self-documentation standard and text modes meet the recognize/investigate standard; details is neither an exhaustive dump nor a count-only index when explanatory evidence exists. No old controls remain accepted.

## Task 2: Protect trust, status, metadata and stdio fixture compatibility

**Files:** Modify `src/mcp/server.test.ts`, `src/composition/mcp.e2e.test.ts`, `src/composition/compose.test.ts`; use `src/mcp/test-session.ts` as the public seam.

**Consumes:** Task 1's complete mode contract and existing setup factories, fake query ports, temporary Git fixtures and actual stdio process harness.

**Produces:** Public evidence that presentation preserves facts, limitations, redaction and metadata through actual stdio framing over disposable fixtures. This is not a real-client/model-exposure experiment.

- [x] **2.1 Update existing metadata tests rather than dropping them.** For `repositoryRoots`, `freshness` and `resolution`, assert exact structured siblings in full mode and the current actionable text in summary/details. Receipts must not contain those arrays. Absence remains absence. Strip transport `mode` as well as response siblings before comparing to the original fact. `repositorySources` and internal workspace `repositories` must remain absent from public full output.
- [x] **2.2 Reuse the existing unknown, partial, empty, redaction, fault and stale tests across their delivery branches.** Unknown retains exact reason/evidence without an invented value; known receipts have no reason. SHA/live receipts keep the entire snapshot, including `sha` or `head`/`stateId`. Partial full facts keep exact cuts; details retains cut kinds, limits, ownership and actionable anchors while counting repeated places. Verified-empty remains complete. Redaction covers text, structured content and `_meta`; preserve cancellation and typed faults. The schema assertions from Task 1.4 are the owner of receipt validation; do not duplicate them here.
- [x] **2.3 Add one public rejection rule for removed/unsupported presentation arguments.** With otherwise valid impact arguments, exercise `detail: "full"`, `full: true`, `full: false`, `format: "json"`, `focus: "x"` and `mode: "invalid"`. The installed SDK returns an `isError` tool result for input validation failures; it does not reject the test client's promise. Assert no semantic query ran. Do not assert SDK wording or an adapter fault kind for these SDK errors.

```ts
const { session, calls } = await setup();
try {
  for (const removed of [
    { detail: "full" }, { full: true }, { full: false },
    { format: "json" }, { focus: "x" }, { mode: "invalid" },
  ]) {
    const result = await session.callTool("ye_ast_impact", { base: "main", ...removed });
    assert.equal(result.isError, true);
  }
  assert.equal(calls.ofChange.length, 0);
} finally {
  await session.close();
}
```

- [x] **2.4 Migrate the actual stdio tests.** Replace `full: true` with `mode: "full"`. In the entrypoints/CLI parity assertion, remove the transport `mode` property before comparing to CLI JSON. Obtain the route-location text from a separate summary/details call rather than expecting a listing in full text; verify useful full JSON navigation separately. Preserve workspace link/symbol assertions and two-call determinism on full results. Verify mode receipt behavior at least once over actual stdio, not only in-memory.
- [x] **2.5 Migrate the composed freshness consumer.** In `compose.test.ts`, request full mode and exclude transport `mode` when isolating the fact. Keep the existing URL, pinned SHA, redaction and outside-fact assertions decisive. Do not edit unrelated composition logic.
- [x] **2.6 Run focused integration checks.** Execute `node --import tsx --test src/mcp/server.test.ts src/composition/mcp.e2e.test.ts src/composition/compose.test.ts`. Use the existing temporary repositories; no real repository, clock or network in automated tests.
- [x] **2.7 Perform targeted break proofs.** Remove unknown receipt reason, drop full `cuts`, omit a refresh sibling, leak internal repository reads, and bypass a redaction pass one at a time with type-correct mutations. Run the corresponding owner test and confirm it fails for that rule. Restore each mutation immediately. Reuse tests already guarding a rule; do not add redundant tests merely to match this list.

**Acceptance:** The API works over actual stdio, contextual guides refer to actual public paths and joins, explanatory faults preserve typed metadata, full facts still equal library/CLI facts after removing transport fields, no actionable uncertainty or response metadata disappears, and all data exposed through either branch is redacted.

## Task 3: Document the migration and finish verification

**Files:** Modify `README.md`, RFC-0005, RFC-0015 and RFC-0017 in the file map. Add no new ADR unless review identifies a contradiction with an accepted decision; stop and report that contradiction rather than rewriting the ADR.

**Consumes:** Observed behavior and test evidence from Tasks 1–2.

**Produces:** Tool discovery guidance, user docs, migration instructions and final verification evidence that agree with the implemented API.

- [x] **3.1 Update initialize instructions and tool descriptions in `server.ts`.** Define mode/channel semantics once; keep each description task-oriented and distinguish neighboring tools. Explain direct mode selection, `changed` versus coverage `scope`, and the launch-bound repository restriction. Provide compact examples only for ambiguous combinations already supported by discovery. Do not advertise live/workspace, foreign `repo` targets, selective retrieval or expansion before implementation. Details is explanatory and full exhaustive recorded data; neither gains coverage. Stable rules belong here and answer-specific recovery belongs in responses. Do not claim full JSON is hidden from the model or that every task should use the MCP.
- [x] **3.2 Update README and RFC-0005.** Document seven tools, common modes, exact receipt/status and snapshot rules, per-family full schemas and their validation boundary, sidecars, migration and client limitation. Distinguish coverage exclusions, traversal cuts and presentation omissions; explain cross-repository coordinates and unsupported live/workspace. Correct touched stale claims such as MCP having no scope. Retain CLI/query-protocol behavior. Link deferred capabilities as designs, never as current calls.
- [x] **3.3 Reconcile RFC-0015 and RFC-0017 carefully.** Preserve historical byte measurements with their original measured mode labels and identify them as historical. Remove the current-contract assumption that models read text while only hosts read JSON. Clarify that the byte-size guarantee concerns counted elisions within a text projection; it does not assert every summary is smaller than a different representation or full JSON. Do not compare text summary bytes with raw JSON to prove the counted-elision rule.
- [x] **3.4 Search for missed consumers and contradictory guidance.** Run the searches below and classify remaining matches. Fault `detail`, full-index terminology, historical measurements and explicit rejected-argument tests are valid; accepted old MCP inputs or recovery instructions are not.

```bash
rg -n 'full: true|full: false|detail: "full"|detail: "summary"|detail "full"|Detail|withoutPayload' src/mcp src/composition README.md docs/architecture
rg -n 'structuredContent|outputSchema|envelope|host.*reads|model.*reads' src/mcp README.md docs/architecture/rfc/0005-transports.md docs/architecture/rfc/0015-answer-coordinates.md docs/architecture/rfc/0017-answer-size-and-outline.md
rg -n 'ResponseMode|ResponseRenderer|responseModeSchema' src
```

The final mode types/schema must have no consumer under `core`, CLI or protocol. Verify no new dependency or import-layer exception was introduced. Re-read the owned-file diff against the initial shared-tree baseline, not an assumption that all dirty changes belong to this work.

- [x] **3.5 Run the required gate after the final code/docs edit.** Execute `npm run check`. Report exact observed check results and test totals. Existing counts such as 1,595 in prior chat messages are historical and must not be reused as current evidence. Investigate failures caused by the migration; report unrelated shared-tree failures without silently editing their owners' code.
- [x] **3.6 Verify fixture usefulness and bytes.** Serialize the whole public reply and its text/structured channels separately for all modes over frozen existing fixtures. Measure findings, contextual guidance and discovery schemas separately, including small results, module-only impact, broad module-origin associations, dense entrypoint inventories with unknown items, and repeated-evidence impact/workspace cases. Verify module and symbol budgets and origins remain distinct and every full path retains module evidence. Verify standalone explanatory details, lossless full facts, minimal receipts and useful supported recovery. Compare pre/post renderings of identical facts; require grouped repetition to reduce the repeated-evidence fixture without losing its explanation. Report UTF-8 bytes and omitted categories, not token estimates, fixed saving targets or client behavior. These are fixture observations, not evidence of task-level efficiency or adoption.
- [x] **3.7 Prepare the evaluation handoff.** Record the actual baseline and implementation identities, evidence limitations and unresolved hypotheses from Task 5. Automated stdio tests over disposable repositories remain required.
- [x] **3.8 Deliver migration evidence and memory handoff.** Record significant discoveries and an Engram session summary using available tools; if unavailable, disclose it without inventing persistence. Report exact checks, compatibility changes, fixture observations, Track B design state and Track C baseline and remaining gaps. Do not claim `jq` execution, token savings or model exposure without measurement. No commit, push, installation or publication is part of completion.

**Acceptance:** Documentation and discovery agree with the code, old controls have no accepted consumer, required checks pass or unrelated blockers are explicitly evidenced, and the delivered change contains only the authorized MCP presentation migration.

## Task 4: Specify the accepted capability decisions

**Status:** The six strategies are accepted in ADR-0022. Complete their wire schemas, file ownership, offline proof cases and coherent implementation plans before capability code. Report any consequential deviation instead of silently reopening the choices. Real cost/client/adoption conclusions remain deferred to Task 5. This task does not block reporting the narrower Tasks 1–3 migration complete.

**Files:** Create the four design documents named below when executing this task. Read the relevant contracts and implementation paths; do not modify core, CLI, protocol or cache behavior as part of this task.

**Consumes:** The accepted decision table and ADR-0022, composition/selection rules, RFC-0002/0010/0011/0018, ADR-0010/0020/0021, current query ports and source-backed limitations.

**Produces:** Separate scopes, exact wire interfaces consistent with ADR-0022, affected-file maps and offline acceptance scenarios. Exact fault codes, encoding and existing-port reuse are engineering details to specify here; the six architectural choices are closed. No interface is advertised as implemented.

- [ ] **4.1 Specify typed follow-ups and repository targeting.** Write `docs/superpowers/specs/2026-11-04-mcp-typed-follow-ups-design.md`. Map handoffs between workspace discovery, impact/callers, outline and source coordinates. Specify optional `repo` as the identifier of an externally declared repository; resolve it before forwarding semantic targets. Omission uses the launch repository; unknown/ambiguous identifiers fail without fallback, and selection grants no trust. Reuse current types and require complete snapshot identity and unambiguous subject selection. Define the schema and core/composition/transport wiring needed to replace today's differently bound-instance requirement. Offline scenarios cover identical relative paths in two repositories, changed live state, an unknown id and no trust escalation. Preserve evidence/cuts; add no generic pipeline executor or unused reference framework.
- [ ] **4.2 Specify selective query replay and pagination.** Write `docs/superpowers/specs/2026-11-04-mcp-selective-evidence-recovery-design.md`. Implement the accepted strategy in the design, not an options comparison. Define initial typed selections for recorded handler origins, module origins, entrypoint evidence, omitted places of a cut and workspace-link evidence, on the applicable tools. Return an explicitly discriminated projection with source provenance/status, material global cut summaries and relevant recorded anchors, selection and page metadata; do not replicate every cut place on each page. Cut places remain selectively recoverable. Summary/details render the selected page with its receipt; selected full returns that page's structured data; unselected full remains the original public fact. Include referenced seed/link records or a resolvable context, without inventing evidence.

  Specify deterministic `resultIdentity` transport metadata and the normalized replay arguments it verifies, excluding presentation controls and sidecars. Return enough model-visible pinned query context for replay without a hidden saved request. A first selection may establish a new identity; recovery can supply `expect`, and every cursor continuation verifies its source. Define `page` controls usable only with `select`, with required positive safe-integer `limit` and optional opaque `cursor`. Bind cursor version, source identity, selection, limit and next position; report counts of recorded matches and `nextCursor` only when continuation is supported. No default page size, final-result cache, handle store or new retention budget is introduced. Deadline-cut facts cannot advertise stable replay/pagination.

  The file map must reuse existing query execution and digest/normalization facilities where available. Query replay checks current trust, uses pinned committed context and captures live state afresh; a changed identity fails before emitting a page. It does not retrieve an old live state or replace it with `HEAD`. Offline proof cases cover byte-identical repeat pages, complete recorded-match coverage without duplicates, a changed source/configuration/producer, changed selector/limit, malformed cursor, unknown source, global partial cuts and no cross-request final-fact retention. These prove semantics only; actual cost/client/adoption measurement remains Task 5.
- [ ] **4.3 Specify mixed workspace snapshots.** Write `docs/superpowers/specs/2026-11-04-mixed-workspace-snapshots-design.md`. Inspect `workspace-repos.port.ts`, `workspace-impact-queries.port.ts`, `live-queries.port.ts`, `workspace-queries.ts`, `workspace-impact.ts` and composition. Specify per-repository mutually exclusive `revision`/`live`, externally declared trust and complete identities. Capture each repository once per operation for discovery, link resolution and all walks. Preserve every contributing read, per-repository staleness/failure and live `head`/`stateId`; no SHA fallback or atomic-time promise. Keep current MCP exclusions until the core and supported transports implement the capability. Define trigger base/merge-base behavior, locking/cancellation ownership and disposable-repository tests that mutate a captured live source and verify consistent reads plus explicit stale/replay failure. Keep today's shared workspace `scope` semantics unless separately decided.
- [ ] **4.4 Design batch trust installation.** Write `docs/superpowers/specs/2026-11-04-batch-workspace-trust-design.md`. First check how `ye-ast init` applies trust to selected repositories; reuse existing behavior and identify any actual gap. Trace its trust writer and document the exact writable-file map. One explicit user selection of repositories and `trusted` applies external declarations to that selected set in one operation; no repeated per-repository interaction and no repository file granting trust. Keep installation writes behind existing administration boundaries, not MCP read tools. Specify identity/canonicalization, existing declarations, partial-write failures and the resulting per-repository report; design tests via injected ports/disposable directories. This behavior is the owner's requirement, not an inference from remote membership. Do not change trust during evaluation.

**Acceptance:** Each design implements the accepted strategy at the specification level, with exact interfaces, ownership and offline proof scenarios. The six choices are not left for empirical selection. A consequential change requires a later decision; no final-result retention, expansion tool, MCP write or generic pipeline is included. Tasks 1–3 still do not implement these capability APIs.

## Task 5: Evaluate real use after the main-readiness gate

**Status:** Owner-authorized baseline collection and current-build revalidation completed with frozen, separate identities and bounded correctness reconciliation. No response-contract candidate comparison, exact model-visible exposure, positive trusted/live case, future mode/select performance or empirical adoption has been established. Task 5 remains open for those dimensions.

| Evaluation component | Evidence state |
|---|---|
| Baseline and drift | 234 initial cases and 92 current-build full-result cases; captured builds and exact inputs retained |
| Existing API technical behavior | All seven families and declared scenarios exercised; bounded independent witnesses, actual schemas, errors, recovery, bytes and sampled resources recorded |
| Client exposure | Wire discovery and both response channels retained; exact model-visible handling unavailable |
| Selection and mixed live | Unsupported APIs remain untested; offline projection examples establish sizing only |
| Task efficiency and adoption | Zero controlled model sessions; `not_evaluated` |
| Evidence handoff | Requests, complete responses, channels, metrics, logs, oracles, version comparisons and integrity inventory are externally indexed; no rerun is needed to inspect them |

**Files:** Read `.claude/skills/ye-ast-mcp-evaluation/SKILL.md` and its protocol, measurement and LLM references before collection. Keep corpus/model identities, transcripts and run artifacts in its external evaluation location, not product defaults or this repository. Update this plan's decision state only from inspected evidence.

**Consumes:** The confirmed landed-main SHA, candidate identities/diffs, current discovered schemas and instructions, frozen semantic queries/snapshots and independent source/Git oracles.

**Produces:** A reproducible report distinguishing technical validity, client exposure, task utility, unprompted adoption and deferred/unavailable dimensions. Historical measurements are context only.

- [ ] **5.1 Reconcile and freeze the post-main baseline.** Record readiness evidence and exact engine/candidate/corpus identities. Recheck source/schema drift and version cases before scoring. Keep the completed-main foundation, trust, snapshots, semantic settings, cache phase and measurement method comparable. A change in analysis between versions disqualifies a rendering-only cost attribution unless isolated explicitly.
- [ ] **5.2 Inspect actual client exposure.** Capture initialize, tools/list and result handling for the clients actually available. Record which text, structured content, output schemas and metadata reach the model, any truncation, and whether a host can filter before exposure. Test receipt/full alternatives and status conditions. A text-only client does not establish full-mode support; record the limitation without silently duplicating the payload or claiming universal compatibility.
- [ ] **5.3 Run real-workspace technical cases.** Use the authorized external corpus and pinned Git states under the evaluation protocol. Include narrow change selection with consumers elsewhere, workspace evidence, unknown/partial/empty answers, and selective questions from Task 4.2. Compare source/Git oracles independently. Test mixed live snapshots only if implemented, using disposable copies and captured state identities; do not alter original repositories, trust records, caches or remotes to make a case pass. Record unsupported features as such.
- [ ] **5.4 Run matched LLM task sessions.** Use independent clean sessions with MCP available but unprompted, and a matched unavailable control; explicit-use diagnostics are separate. Include tasks where direct source reading is appropriate. Keep ground truth/evaluation prompts outside agent context. Collect valid/invalid calls, retries, source reads, abandonment, correctness/evidence quality, time to verified answer and actual exposed-token usage when available. Include discovery, both result channels and follow-up costs. Unknown exposure/usage is missing data, never assumed zero; a directed demonstration is not spontaneous adoption evidence.
- [ ] **5.5 Evaluate the accepted design and tune only measured choices.** Compare contextual guidance against unnecessary follow-ups, direct details/full usage against forced progression, and implemented `select` replay against exhaustive retrieval. Measure both delivered-context reduction and recomputation cost. Choose page-size defaults, additional selection categories or ranking/guidance refinements only from comparable evidence. A proposal to replace the accepted strategy with handles, retention, resources or a new tool requires an explicit later decision. Do not call an unimplemented feature tested or turn one transcript into an adoption score. Host code execution/tool search remains an integration capability.
- [ ] **5.6 Close the evidence loop.** Preserve attempts, failures, schema hashes, outcomes and metric-level comparison eligibility. Report sample sizes, independent sessions and per-client limits without universal savings or a composite quality score. Reconcile findings into the relevant Track B design and a separately reviewed implementation plan. Unavailable empirical dimensions remain `not_evaluated`; they do not block truthful delivery of Tasks 1–3.

**Acceptance:** Readiness and comparable inputs are evidenced; observations are traceable to artifacts and independent truth sources; no task-level savings or adoption conclusion is inferred solely from bytes, SDK validation or evaluator opinion.

## Review checklist

- [ ] Every one of the seven tools and both local/workspace impact/callers branches use the shared selector.
- [ ] A text receipt cannot accidentally include raw facts or large metadata arrays.
- [ ] Full mode has the original public fact and response siblings, plus a useful contextual guide without the family listing.
- [ ] No `mode` is forwarded into core requests, fact inputs or stored identities.
- [ ] Summary identifies findings; details supplies actionable recorded evidence and localized uncertainty without requiring a full-result join; full preserves every public recorded item.
- [ ] Details groups repeated context, truthfully counts omissions and never fabricates an explanatory edge or a location; a file/count-only index is insufficient when explanatory evidence exists.
- [ ] Useful recovery is context-specific and repository-qualified; small resolved answers do not solicit unnecessary work, and direct details/full calls need no preceding summary.
- [ ] Unknown, partial, empty, global ordering and contributing-read reasons survive.
- [ ] Secret redaction, trust boundaries, internal-read exclusions and cancellation survive.
- [ ] Receipt status/reason and SHA/live identities agree in runtime and published schema; per-family principal payloads, including both impact variants, validate through SDK/stdio fixture seams.
- [ ] Removed inputs fail explicitly; documentation tells existing consumers how to migrate.
- [ ] Tests guard observable rules and have realistic break proofs; no new abstraction exists merely to make a test possible.
- [ ] No domain/application refactor, framework-specific exception, arbitrary truncation or body optimization outside the approved common text standard slipped into the diff.
- [ ] Coverage exclusions, recorded cuts, presentation omissions and outgoing destinations are not conflated.
- [ ] Track B strategies are accepted in ADR-0022, with implementation still pending; current discovery advertises no unfinished API and batch trust remains outside MCP writes.
- [ ] Track C baseline and remaining gaps are distinguished; fixture results are not called client/adoption evidence.

## Existing presentation work to preserve

The impact presentation work applied separately on 2026-11-04 labels an origin as one verified example, lists every
recorded entrypoint-origin association in detailed text, locates destination handlers, renders recorded reach link
numbers, groups consecutive identical `via` context, partitions cuts and depth lookups by repository, and counts
unserved names when shorter. Preserve destination evidence, reach semantics, repository attribution and truthful
counting. The exhaustive textual origin expansion is superseded by the approved common text standard: retain all
associations in full JSON and render compact explanatory evidence in details. These prior changes do not implement
the mode migration.

The approved compact impact/callers projection was subsequently applied under the existing `detail`/boolean `full`
selectors: summary counts consequences and origin associations, while detailed text retains one origin association,
the nearest recorded consequence frontier and reached-handler evidence, relevant seed coordinates and localized cut
anchors. Repeated support remains counted with `full: true` recovery. Preserve that projection when implementing the
mode migration; replace its selector/recovery vocabulary according to the common contract instead of restoring the
historical exhaustive text. Other families still need the common-standard review in Task 1.7. This does not mark any
mode-migration task complete.

Impact/callers also now append contextual JSON navigation under the existing selectors, with distinct local,
workspace, unknown and scoped-empty guidance. The shared fault renderer supplies supported corrections or missing
prerequisites while preserving typed fault metadata. Reuse these guides during migration, adjust their selector
vocabulary, and make the full branch render guidance directly without constructing the extensive text body.

Further ranking, selective retrieval and host filtering are handled by Tasks 4–5. This migration can avoid unused text rendering, but does not reduce traversal or guarantee cache hits.

## Research basis and limits

| Primary source | What it supports here |
|---|---|
| [MCP tools, 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/server/tools) | Structured output/schema contracts and the backward-compatibility recommendation; not a guarantee of model exposure |
| [Writing effective tools](https://www.anthropic.com/research/writing-tools-for-agents) | Task-oriented tools, concise/detailed selection, meaningful evidence, actionable errors and evaluation of whole workflows |
| [Code Mode](https://developers.cloudflare.com/agents/tools/codemode/) | Host-side typed composition and filtering of intermediates; it does not create missing domain evidence |
| [MCP resources](https://modelcontextprotocol.io/specification/2026-07-28/server/resources) | Application-driven retrieval whose actual inclusion in model context depends on the host |
| [Study of MCP descriptions, v3](https://arxiv.org/abs/2602.14878v3) | Description enrichment has task/model-dependent benefits and costs; no universally optimal amount of guidance |

These sources motivate designs and experiments. Their measurements are not measured gains for this engine. Source review established the current scope, binding, snapshot and cache limits; Task 5 is the only track here that can establish real task efficiency or adoption.

## Plan preparation evidence

This section records preparation only. All task checkboxes remain unchecked; neither past checks nor this documentation revision implement the API.

- The production MCP and core sources were inspected without editing them for this task.
- Historical original preparation: two in-memory SDK probes confirmed object-root discriminated output schemas and `isError` responses for strict input-validation failures. The revised schemas still need their own execution evidence.
- Plan checks covered all seven tools, existing referenced files, balanced code fences, trailing whitespace and absent placeholder markers.
- `git diff --check` passed for the tracked working-tree diff.
- Historical original-plan check: typecheck, architecture rules (310 modules, 1,655 dependencies), and 1,610 tests passed. A later discussion review observed 1,658 passing tests. Neither is current implementation evidence; repeat the required gate on the execution baseline.
- The real application/workspace was not queried during plan preparation. No commit or publication was made. Implementation tasks remain unchecked and require fresh verification after execution.
- The earlier revision reconciled typed payload owners, receipt/schema constraints, launch-bound follow-ups, scope versus change selection, mixed snapshots, cache ADRs and the owner's selected-set trust requirement. The subsequent authorized baseline is recorded near the start of this document.
- The owner subsequently accepted the six capability recommendations. ADR-0022 records them; Task 4 now specifies their wire contracts and implementation proof cases instead of choosing between expansion tools, selectors or retention. Real-MCP conclusions are bounded by the recorded evidence near the start of this document.
- After the owner's readiness confirmation, real stdio collection produced the separately identified evidence near the start of this document. `npm run check` on `46380f08cc3111776710a94b05fce5b472811a05` passed typecheck, architecture checks (335 modules, 1,793 dependencies) and 1,859 tests without failures or skips. This verifies the evaluated source baseline, not the future mode/select implementation.
