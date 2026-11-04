# Common MCP Response Modes Implementation Plan

> **For agentic workers:** Use `superpowers:executing-plans` to implement this plan task by task. Use `superpowers:subagent-driven-development` only when delegation is authorized and useful under the current project instructions. Checkboxes track execution, not work already completed.

**Goal:** Give all seven MCP tools one predictable `mode: "summary" | "details" | "full"` selector: summary identifies consequences, details supports investigation with recorded evidence, and full exposes exhaustive structured data without duplicating extensive bodies.

**Architecture:** Presentation belongs to `src/mcp`. Reuse the existing `answer` function, family renderers, query ports, `Fact<T>` and `FactRead<T>`. Domain and application continue computing the same facts; no presentation port, service hierarchy or generic query abstraction is introduced.

**Tech Stack:** Existing TypeScript 6.0.3, Zod 4.6.7, `@modelcontextprotocol/server` 2.4.0, `node:test` and `tsx`; no dependency changes. Use the Node version selected by `.nvmrc`.

**Spec:** The normative design is embedded in [Contract](#contract), [Layer ownership](#layer-ownership) and [Invariants](#invariants) below. Read those sections before the task checklist. They capture the design conversation so execution requires no chat history.

**Status:** Implementation plan only. Writing this document does not implement the API, authorize commits or authorize publication. Source locations describe the shared working tree inspected on November 4, 2026; relocate symbols if concurrent changes move lines.

## Global constraints

- Read the root `AGENTS.md`, `.claude/skills/ye-ast-testing/SKILL.md`, RFC-0002, RFC-0005, RFC-0015 and RFC-0017 before changing code or tests.
- Code, comments and documentation are English; user communication is neutral Spanish.
- Preserve the facts contract, trust boundaries, redaction, determinism and read-only query families.
- Preserve all concurrent work. The inspected checkout has substantial uncommitted changes in MCP, composition, query ports, application and domain. Do not reset, replace whole files or copy older worktree versions over it.
- Use existing structural code tools first when available. At plan-writing time, the graph service did not have this repository indexed, so targeted source reads were necessary.
- No dependencies, framework coverage, query capabilities, fact schema version, package version, CLI output or query-protocol output are changed by this plan.
- Commit only if the owner asks in the execution turn; never push unless asked. A skill's suggested commit step does not override this instruction.
- Save significant discoveries and final implementation evidence to Engram under the executing session's authoritative runtime identity.

## Quick path

1. Read the contract and the existing public MCP tests.
2. Implement one coherent migration across the shared selector, compact evidence-bearing text projections, response assembly and seven registrations.
3. Update public in-memory tests, actual stdio tests and documentation together.
4. Run focused checks, realistic break proofs and `npm run check`; report observed results and remaining limits.

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
| Importers | Files importing, using or only naming a requested file | Separation of resolved import/use evidence from unresolved naming, with recorded declarations and locations |
| Outline | Declarations, spans and imports needed to select source ranges | Available declaration/import detail and unheld-file limitations; identical text is valid when nothing useful was elided |
| Workspace | Outward names, candidate repositories and unresolved membership | Recorded matching basis, evidence locations, gateway information and repository-qualified limitations |
| Decisions | Configuration gaps and evidence-backed options | Supporting evidence, declared constraints and recorded recommendation basis; no inferred code-change approval |

For impact and callers, preserve consequence-before-origin ordering and explicitly requested callers targets. Explain recorded findings using available seed associations and `via` evidence; an origin association is not a complete call chain, a depth is not a service-hop count, and the first recorded origin is not a ranked or nearest origin. Show a call-site coordinate only when it is present in the fact. Preserve cross-repository basis/confidence and recorded `reach` ordering without implying runtime execution.

Compact repeated support by grouping identical recorded contexts and printing shared paths or relationships once, with deterministic ordering and counted-elision rules. Keep consequence identities and actionable coordinates. Count additional origins and cut references instead of expanding every association beneath every entrypoint. Preserve cut kinds, applicable limits, owning repository/read and relevant anchors; full retains every recorded place. A cut anchored at a file does not itself prove that file is impacted. Symbol and seed counts can overlap and must not be added as disjoint totals.

Every omitted category must be identified with a truthful count and a recovery pointer to `mode: "full"` for exhaustive recorded data. Use `mode: "details"` only for evidence that details actually renders. Do not imply that `outline`, `callers` or `importers` reconstruct the same impact fact: they answer related questions. `changed`, `scope` and traversal budgets change the semantic query and are not presentation filters.

**Illustrative impact example, not a real measurement or an output grammar:** a changed `OrderService.getOrder` has a recorded caller `OrdersController.getOrderDetail` serving `GET /orders/{id}`. Summary identifies the endpoint, handler coordinate and partial status. Details additionally identifies the changed declaration, the recorded dependency and its call-site coordinate if available, and the unresolved declaration/anchor responsible for a cut. It does not repeat every origin associated with that endpoint. If only an origin association is recorded, label it as such rather than printing an invented `calls` edge.

**Acceptance:** using details and its cited source locations, an agent can identify a presented consequence, understand its recorded basis and locate the uncertainty without a full-result join. Full is needed for exhaustive questions, not to decode details. Verify this with realistic impact/callers, workspace and configuration-gap cases before accepting size improvements. Measure both text modes on the same frozen facts; restoring the old detailed listing or merely renaming it fails this design even if transport duplication is removed. No fixed byte cap, arbitrary top-N or unmeasured token-saving promise is introduced.

### Self-documenting responses in every mode

Every tool's text must help the agent discover useful next operations in the context of that particular answer.
This applies to summary, details, full, verified-empty and unknown facts, and explanatory fault responses. It is a
public presentation requirement, not optional documentation that only appears in initialize instructions.

- Derive guidance from the tool, actual findings, omissions, available evidence and limitations. Explain what can be
  investigated next, which supported tool/selector serves that question and which recorded identities or coordinates
  locate the relevant evidence. Emit the useful branches for this response rather than a complete catalog of tools.
- Details also guides queries over full: give the concrete payload path, matching fields and required joins for the
  question suggested by the findings. Do not enumerate rows under every JSON section or merely print all section
  names. One clearly labeled example lookup using a recorded identity can clarify the operation; it is not a ranking.
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

**Acceptance:** a reader can discover an applicable operation from the answer itself, identify the fields to filter
and any joins needed, and understand the limits of the result without reconstructing the schema from a large JSON.
Test real local/workspace, absent/unknown and fault branches through public seams. Mutations of a payload path, join,
repository qualification or recovery argument must fail the responsible test. Keep guidance proportional by grouping
operations once per relevant context, not once per record; measure bytes without fixed production caps.

### Minimal receipt for text modes

A receipt is transport information, not a `Fact<T>` and not a provenance record. Its exact keys are:

```ts
type TextReceipt = {
  mode: "summary" | "details";
  status: Fact<unknown>["status"];
  snapshot: Fact<unknown>["snapshot"];
  reason?: string;
};
```

Include `reason` exactly when the fact is unknown. Copy the status, snapshot and reason from the redacted fact; do not derive a new completeness verdict.

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

Advertise a discriminated union of the receipt and full-result schemas. The installed SDK was probed through `openSession` with an object-valued `z.discriminatedUnion("mode", ...)`: `tools/list` advertised an object-root `oneOf`, and `tools/call` returned the original structured object without adding a `result` wrapper. Repeat this through the final production schema in public tests; do not rely on assumptions about a future SDK.

Client behavior remains a compatibility consideration: full mode requires a client that exposes structured content. Do not duplicate the JSON into `content` for a client that only reads text. Hosts already have library/query-protocol access; adding a legacy-client fallback is a separate product decision.

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
| `src/mcp/server.ts` | Tool arguments, public output schema, mode-based response assembly, redaction and response metadata |
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

## File map and execution ownership

| Action | File | Notes |
|---|---|---|
| Create | `src/mcp/presentation.ts` | Only shared mode schema/types |
| Modify | `src/mcp/server.ts` | All seven registrations, output union, `answer`, instructions |
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

**Produces:** Shared `responseModeSchema`, `ResponseMode`, `ResponseRenderer<T>`; all seven tools wired to one mode-based `answer` path and output schema.

- [ ] **1.1 Reconcile the execution baseline.** Read current diffs in the owned files and record the initial focused-check results. Preserve concurrent fixes, especially nested/class joins, root sidecars, contributing reads and global renderer ordering. Do not edit domain/application files to make these tests pass.
- [ ] **1.2 Update the existing public delivery tests to the new behavior and observe red.** Extend `TOOL_CALLS` with `ye_ast_outline` using `{ files: ["src/Order.java"] }`; it currently omits outline despite tests claiming every tool. Compare its coverage with names returned by `tools/list`. Replace the old same-text/full-boolean expectations rather than retaining contradictory tests.

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

- [ ] **1.3 Introduce the shared selector and renderer types.** Use one schema source and infer its TypeScript type; do not maintain an independent string union.

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

- [ ] **1.4 Advertise a mode-aware output contract.** Keep the existing fact and sibling schemas in `server.ts`. Rename the old `FACT_OUTPUT` to `FULL_FACT_OUTPUT`; update descriptions that refer to `full: true`. Define the receipt using its existing snapshot/status/reason schemas, then the union:

```ts
const TEXT_OUTPUT = z.strictObject({
  mode: z.enum(["summary", "details"]),
  snapshot: FULL_FACT_OUTPUT.shape.snapshot,
  status: FULL_FACT_OUTPUT.shape.status,
  reason: FULL_FACT_OUTPUT.shape.reason,
});

const TOOL_OUTPUT = z.discriminatedUnion("mode", [
  TEXT_OUTPUT,
  FULL_FACT_OUTPUT.extend({ mode: z.literal("full") }),
]);
```

`reason` is optional in the reused shape, but production includes it exactly for unknown facts. Reuse the current full-fact schema rather than creating a second taxonomy of statuses, cuts or snapshots. Keep its existing loose family payload fields. Do not widen `TEXT_OUTPUT` to allow accidentally copied payloads.

Set `outputSchema: TOOL_OUTPUT` on every tool. Through `tools/list`, verify an object root and mode-specific branches; do not keep asserting the previous root-level `required` envelope fields. Extend the test helper's schema type to describe `oneOf` only if inspection needs it; do not use casts to pretend the old schema shape still applies.

- [ ] **1.5 Change the existing `answer` signature and branch after redaction.** Keep its query callback, error handling and stale callback intact:

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

- [ ] **1.6 Wire all seven registrations atomically.** Remove common `detail`/boolean `full` schemas, add `mode: responseModeSchema`, and forward `mode` only to `answer`. Both local and workspace branches of impact/callers must use it. For example, retain the existing query callback and pass `(queryCallback, mode, renderImpact)` or `(queryCallback, mode, renderWorkspaceImpact)` as appropriate. Preserve all input refinements, required semantic parameters and cancellation signals.
- [ ] **1.7 Migrate renderer tests and guard the common text and self-documentation standards.** Old structured calls become `mode: "full"`; revise old detailed-text expectations to the approved explanatory projection instead of preserving exhaustive origin listings. Tests requiring both channels must make explicit separate calls and assert each intended behavior. Keep requested callers targets, actionable locations, consequence-before-origin ordering, unknown contributing reads and repository-qualified evidence decisive. Through the existing public seams, cover a recorded origin association without a complete call chain, shared `via` context, a localized cut and a workspace link with matching basis/confidence. Assert the evidence needed to investigate each presented finding is in details without joining full arrays, that details also explains how to locate additional evidence in full, repeated associations are counted truthfully, and no unrecorded edge/call-site is invented. Exercise equivalent investigation and contextual-navigation rules for all seven tools, reusing existing fixtures. Check local versus workspace paths, index/ID joins, unknown/absent branches, useful full guidance without a family listing, and actionable faults without fabricated metadata. Guidance is derived from the redacted fact and actual transport metadata; do not echo raw request content into text. Follow the project testing skill and prove realistic mutations break the guarded rules.
- [ ] **1.8 Run focused checks and prove regression sensitivity.** Run `npm run typecheck`, `npm run arch:check` and `node --import tsx --test src/mcp/server.test.ts`. Temporarily restore payload spread into the receipt and verify the minimal-receipt test fails; temporarily replace the full guide with the family listing and verify the owner test rejects the duplicated listing; corrupt one guide path/join and verify its contextual-navigation test fails. Inspect the full renderer branch separately to confirm it builds the guide directly without computing and discarding the extensive projection; do not introduce a private-function spy just for that inspection. Restore each mutation before proceeding.

**Acceptance:** Every registered tool exposes the new selector, defaults to summary, retains its semantic query, and returns exactly the agreed delivery shape. Every mode meets the self-documentation standard and text modes meet the recognize/investigate standard; details is neither an exhaustive dump nor a count-only index when explanatory evidence exists. No old controls remain accepted.

## Task 2: Protect trust, status, metadata and real transport compatibility

**Files:** Modify `src/mcp/server.test.ts`, `src/composition/mcp.e2e.test.ts`, `src/composition/compose.test.ts`; use `src/mcp/test-session.ts` as the public seam.

**Consumes:** Task 1's complete mode contract and existing setup factories, fake query ports, temporary Git fixtures and actual stdio process harness.

**Produces:** Public evidence that changing presentation preserves facts, limitations, redaction and response metadata, including real MCP framing.

- [ ] **2.1 Update existing metadata tests rather than dropping them.** For `repositoryRoots`, `freshness` and `resolution`, assert exact structured siblings in full mode and the current actionable text in summary/details. Receipts must not contain those arrays. Absence remains absence. Strip transport `mode` as well as response siblings before comparing to the original fact. `repositorySources` and internal workspace `repositories` must remain absent from public full output.
- [ ] **2.2 Reuse the existing unknown, partial, empty, redaction, fault and stale tests across the delivery branches they protect.** Full unknown must preserve reason/evidence and have no invented value; unknown text receipts must include the exact reason. Partial facts must keep exact cuts in full; details must retain cut kinds, applicable limits, owning repository/read and actionable anchors while counting repetitive places. Verified-empty must remain complete. Redaction must remove the secret fixture from text, structured content and `_meta` in each branch. Preserve cancellation and typed-fault assertions through the existing public query seam.
- [ ] **2.3 Add one public rejection rule for removed/unsupported presentation arguments.** With otherwise valid impact arguments, exercise `detail: "full"`, `full: true`, `full: false`, `format: "json"`, `focus: "x"` and `mode: "invalid"`. The installed SDK returns an `isError` tool result for input validation failures; it does not reject the test client's promise. Assert no semantic query ran. Do not assert SDK wording or an adapter fault kind for these SDK errors.

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

- [ ] **2.4 Migrate the actual stdio tests.** Replace `full: true` with `mode: "full"`. In the entrypoints/CLI parity assertion, remove the transport `mode` property before comparing to CLI JSON. Obtain the route-location text from a separate summary/details call rather than expecting a listing in full text; verify useful full JSON navigation separately. Preserve workspace link/symbol assertions and two-call determinism on full results. Verify mode receipt behavior at least once over actual stdio, not only in-memory.
- [ ] **2.5 Migrate the composed freshness consumer.** In `compose.test.ts`, request full mode and exclude transport `mode` when isolating the fact. Keep the existing URL, pinned SHA, redaction and outside-fact assertions decisive. Do not edit unrelated composition logic.
- [ ] **2.6 Run focused integration checks.** Execute `node --import tsx --test src/mcp/server.test.ts src/composition/mcp.e2e.test.ts src/composition/compose.test.ts`. Use the existing temporary repositories; no real repository, clock or network in automated tests.
- [ ] **2.7 Perform targeted break proofs.** Remove unknown receipt reason, drop full `cuts`, omit a refresh sibling, leak internal repository reads, and bypass a redaction pass one at a time with type-correct mutations. Run the corresponding owner test and confirm it fails for that rule. Restore each mutation immediately. Reuse tests already guarding a rule; do not add redundant tests merely to match this list.

**Acceptance:** The API works over actual stdio, contextual guides refer to actual public paths and joins, explanatory faults preserve typed metadata, full facts still equal library/CLI facts after removing transport fields, no actionable uncertainty or response metadata disappears, and all data exposed through either branch is redacted.

## Task 3: Document the migration and finish verification

**Files:** Modify `README.md`, RFC-0005, RFC-0015 and RFC-0017 in the file map. Add no new ADR unless review identifies a contradiction with an accepted decision; stop and report that contradiction rather than rewriting the ADR.

**Consumes:** Observed behavior and test evidence from Tasks 1–2.

**Produces:** Tool discovery guidance, user docs, migration instructions and final verification evidence that agree with the implemented API.

- [ ] **3.1 Update MCP initialize instructions and tool descriptions in `server.ts`.** Define the common recognize/investigate/exhaustive-query and self-documentation standards and channels once in shared guidance; keep family descriptions about when that tool earns a call. State that modes change presentation, not coverage or budgets. Point to details for the explanatory evidence it renders and to full for exhaustive recorded data. Explain that related follow-up queries are not filters over the same fact. Do not tell an agent that full JSON is exclusively for hosts or automatically outside model context.
- [ ] **3.2 Update the README and RFC-0005 current contract.** List all seven tools, common modes, the receipt/full output variants, metadata channel behavior, raw-only client limitation, contextual navigation and explanatory-error examples, and the migration table. Correct touched stale claims such as MCP having no scope. Keep CLI and query-protocol examples unchanged.
- [ ] **3.3 Reconcile RFC-0015 and RFC-0017 carefully.** Preserve historical byte measurements with their original measured mode labels and identify them as historical. Remove the current-contract assumption that models read text while only hosts read JSON. Clarify that the byte-size guarantee concerns counted elisions within a text projection; it does not assert every summary is smaller than a different representation or full JSON. Do not compare text summary bytes with raw JSON to prove the counted-elision rule.
- [ ] **3.4 Search for missed consumers and contradictory guidance.** Run the searches below and classify remaining matches. Fault `detail`, full-index terminology, historical measurements and explicit rejected-argument tests are valid; accepted old MCP inputs or recovery instructions are not.

```bash
rg -n 'full: true|full: false|detail: "full"|detail: "summary"|detail "full"|Detail|withoutPayload' src/mcp src/composition README.md docs/architecture
rg -n 'structuredContent|outputSchema|envelope|host.*reads|model.*reads' src/mcp README.md docs/architecture/rfc/0005-transports.md docs/architecture/rfc/0015-answer-coordinates.md docs/architecture/rfc/0017-answer-size-and-outline.md
rg -n 'ResponseMode|ResponseRenderer|responseModeSchema' src
```

The final mode types/schema must have no consumer under `core`, CLI or protocol. Verify no new dependency or import-layer exception was introduced. Re-read the owned-file diff against the initial shared-tree baseline, not an assumption that all dirty changes belong to this work.

- [ ] **3.5 Run the required gate after the final code/docs edit.** Execute `npm run check`. Report exact observed check results and test totals. Existing counts such as 1,595 in prior chat messages are historical and must not be reused as current evidence. Investigate failures caused by the migration; report unrelated shared-tree failures without silently editing their owners' code.
- [ ] **3.6 Verify usefulness and size without inventing token savings.** From deterministic existing fixtures, serialize the entire public result as well as `content` and `structuredContent` separately for the three modes. Confirm text-mode structured content contains only the receipt, full contains helpful contextual navigation without the family listing, and full retains the fact. For realistic broad impact/callers and workspace cases, verify details identifies a consequence, its recorded basis and localized uncertainty without a full-result join, and that details/full guides identify applicable paths, filters and joins, then measure both text projections against the same pre-migration facts. Require substantial reduction of the verbose baseline through grouped evidence and counted repetition; a count-only prototype or a shorter text that loses the explanation is not acceptance evidence. Report UTF-8 bytes and what was omitted. Do not impose fixed production size thresholds, promise the prototype's size or compare different snapshots as an optimization proof.
- [ ] **3.7 Optionally confirm on the previously authorized real workspace.** The owner authorized read-only impact probes on `/Users/arielyumn/Desktop/TRABAJO/nname/name-webapp` and associated services. Use existing externally declared trust/workspace information and explicit pinned Git SHAs; record the actual base/head and repository snapshots. Do not infer refs, start a live index, rewrite trust, modify the repositories or refresh network remotes just to run this check. Use offline committed reads and a temporary engine-owned scratch space where supported. If that setup is unavailable, report the real-project probe as unperformed; public stdio fixture tests remain mandatory. Compare the same semantic query across modes, checking receipts, full provenance/links and contextual text guidance. Keep the environment-specific probe out of product defaults.
- [ ] **3.8 Deliver the result and memory handoff.** Record significant decisions/discoveries and an Engram session summary. Report the migration, preserved capabilities, exact verification, compatibility impact and any unperformed optional probe. Do not claim execution of `jq`, savings in model tokens, or client-specific context behavior unless actually measured. No commit, push, dependency install or publication is part of completion.

**Acceptance:** Documentation and discovery agree with the code, old controls have no accepted consumer, required checks pass or unrelated blockers are explicitly evidenced, and the delivered change contains only the authorized MCP presentation migration.

## Review checklist

- [ ] Every one of the seven tools and both local/workspace impact/callers branches use the shared selector.
- [ ] A text receipt cannot accidentally include raw facts or large metadata arrays.
- [ ] Full mode has the original public fact and response siblings, plus a useful contextual guide without the family listing.
- [ ] No `mode` is forwarded into core requests, fact inputs or stored identities.
- [ ] Summary identifies findings; details supplies actionable recorded evidence and localized uncertainty without requiring a full-result join; full preserves every public recorded item.
- [ ] Details groups repeated context, truthfully counts omissions and never fabricates an explanatory edge or a location; a file/count-only index is insufficient when explanatory evidence exists.
- [ ] Every mode discovers useful operations from actual response context; details/full explain applicable payload paths, identity filters and index/ID joins without enumerating the JSON. Unknown/empty/absent states and typed faults have truthful, actionable guidance.
- [ ] Unknown, partial, empty, global ordering and contributing-read reasons survive.
- [ ] Secret redaction, trust boundaries, internal-read exclusions and cancellation survive.
- [ ] Output schema validation succeeds through the public SDK/stdio seam; its advertised branches match real output.
- [ ] Removed inputs fail explicitly; documentation tells existing consumers how to migrate.
- [ ] Tests guard observable rules and have realistic break proofs; no new abstraction exists merely to make a test possible.
- [ ] No domain/application refactor, framework-specific exception, arbitrary truncation or body optimization outside the approved common text standard slipped into the diff.

## Follow-ups deliberately left separate

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

- Choose a more representative origin only if evidence establishes a meaningful ranking; the current first origin
  makes no nearest-origin claim.
- Further optimizations beyond the approved grouping/counting and explanatory projections require measured benefit, recoverable evidence and deterministic order.
- Design a presentation-only focus selector only if actual tasks show the current selectors are insufficient.
- Design out-of-context structured filtering or stable resource retrieval only with client support and a demonstrated need. Returning JSON alone does not provide it.
- Profile shared snapshot/extraction work separately. This migration can skip unused full-text rendering but does not reduce analysis traversal or guarantee cache hits.

## Plan preparation evidence

This section records plan preparation only; it is not evidence that the proposed API has been implemented.

- The production MCP and core sources were inspected without editing them for this task.
- Two in-memory probes against the installed SDK confirmed object-root discriminated output schemas and `isError` responses for strict input-validation failures.
- Plan checks covered all seven tools, existing referenced files, balanced code fences, trailing whitespace and absent placeholder markers.
- `git diff --check` passed for the tracked working-tree diff.
- `npm run check` passed on the shared working tree: typecheck, architecture rules (310 modules, 1,655 dependencies), and 1,610 tests passed with no failures or skips.
- The real application/workspace was not queried during plan preparation. No commit or publication was made. Implementation tasks remain unchecked and require fresh verification after execution.
