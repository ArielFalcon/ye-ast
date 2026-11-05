# Task 2 Connect Angular template expressions to code

## Assignment

Role: investigator and implementation planner for Angular template dependencies. Establish whether expressions already parsed by Angular can recover missing public dependencies through the current engine. Start with direct component-member calls; treat field reads and writes as a separately justified extension. Return a plan, not production changes.

Workspace: `/Users/arielyumn/Desktop/TRABAJO/ye-ast`. Handoff baseline: `d35093f807c4a789cb32b50040fad31c0a73ab04`, 2026-11-05. Recheck HEAD and local changes. You are not alone: do not revert others' edits. Own only your investigation and task-specific follow-up document. No subagents, dependency changes, commits or pushes.

## Why this matters

A template can call a method that reaches an HTTP client, yet a dependency query can lack the template-to-method connection needed to justify the UI entrypoint. An AST occurrence alone is not a verified declaration binding. The useful gain is a correct public consumer or entrypoint, not the number of expressions visited.

## Read first and reconcile existing work

- `AGENTS.md`, `.claude/skills/ye-ast-testing/SKILL.md`.
- ADRs `0013-coverage-grows-only-with-evidence`, `0014-angular-and-spring-from-own-extractors`, and `0017-owner-of-a-member-expands-only-whole-type-edges`.
- RFCs `0007-extension-model`, `0010-impact-queries`, `0013-trace-and-patterns`, and the historical measurements in `0016-type-resolution`.
- `docs/superpowers/plans/2026-11-05-current-engine-mechanism-improvements.md`, especially conditional Task 7 and its Angular evidence links.
- `docs/superpowers/plans/2026-11-05-semantic-provider-migration-reassessment.md`.

This assignment refines the existing conditional Angular investigation. If that work has already closed the gap, verify it and update the disposition instead of implementing it again. Historical type-root measurements do not describe every later resolver improvement.

| Surface | Responsibility |
| --- | --- |
| `src/core/adapters/angular-compiler/template-usage.adapter.ts` | `parseTemplate`, `R3TargetBinder`, `UsageVisitor`; currently publishes component/directive/pipe uses. |
| `src/core/ports/template-usage.port.ts` | Template input and available declaration context. |
| `src/core/application/relations/angular-relations.ts` | Framework scope, template ownership and relation assembly. |
| `src/core/adapters/typescript/angular-metadata.adapter.ts` and `angular-metadata.extractor.ts` | Component declarations, metadata and existing binding context. |
| `src/core/domain/relations/relation.ts` | Existing relation vocabulary; inspect before proposing another relation. |
| `src/core/application/impact/inbound-edges.ts` and `src/core/domain/impact/edge-policy.ts` | Admission, member precision and joins. |
| `src/core/domain/shared/code-node.ts` | Current declaration-to-fact join. |
| `src/core/domain/impact/reached-entrypoints.ts` | Inspect actual UI-entrypoint association. |

## Reproduced adapter evidence

This probe used the installed Angular compiler and ye-ast adapter:

```bash
node --import tsx --input-type=module <<'JS'
import { parseTemplate, CombinedRecursiveAstVisitor } from '@angular/compiler';
import { createTemplateUsageReader } from './src/core/adapters/angular-compiler/template-usage.adapter.ts';
const unit = {
  component: { path: 'src/page.ts', symbol: 'Page', line: 1 },
  path: 'src/page.html',
  text: '<button (click)="save()">{{ order.total }}</button>',
  firstLine: 1, scope: []
};
const parsed = parseTemplate(unit.text, unit.path);
const calls = [], reads = [];
class Visitor extends CombinedRecursiveAstVisitor {
  visitCall(ast, context) {
    calls.push(ast.receiver.name ?? ast.receiver.constructor.name);
    return super.visitCall(ast, context);
  }
  visitPropertyRead(ast, context) {
    reads.push(ast.name);
    return super.visitPropertyRead(ast, context);
  }
}
const visitor = new Visitor();
for (const node of parsed.nodes) visitor.visit(node);
console.log(JSON.stringify({ errors: parsed.errors, calls, reads,
  relations: createTemplateUsageReader().read([unit]) }));
JS
```

Observed: no parse errors, `calls: ["save"]`, `reads: ["save", "total", "order"]`, and `relations: []`. This proves the parser exposes occurrences that this adapter does not publish. It does not prove that `total` belongs to a particular DTO, that `save` uniquely binds to a declaration, or that every public query misses the same path.

Angular's [expression AST source](https://github.com/angular/angular/blob/main/packages/compiler/src/expression_parser/ast.ts) contains call and property-read nodes. Its [template type-checking documentation](https://angular.dev/tools/cli/template-typecheck) demonstrates handling of bindings and template contexts. Verify signatures against installed `@angular/compiler` 22.2.4, not `main`. No whole Angular type-checker adoption follows from these capabilities.

## Investigation steps

- [ ] Reproduce the adapter result and map current template scopes, component/member identity and occurrence coordinates.
- [ ] Build a minimal Git repository under `os.tmpdir()` with a UI route, a bound component, an event calling one method, and a dependency from that method to another declaration. Query through the public family to establish the exact missing result and whether another mechanism already recovers it.
- [ ] Check both a changed callee reached from an event and a template-only edit. Distinguish current impact behavior from a future forward `trace` feature; this task does not implement that feature.
- [ ] Prove binding for a narrow supported set: direct component members, explicit `this` where supported, and inherited members only when existing evidence identifies the declaration uniquely.
- [ ] Use decisive negative controls: a shadowing template local, `@for` variable, template reference, foreign receiver, and duplicate/ambiguous declaration. Select tests by distinct guarded rule, not by checklist volume.
- [ ] Determine whether a call is a method invocation or a read of a callable value such as a signal. Preserve current category/confidence rules; do not label every call-expression receiver a method dependency.
- [ ] Propose the smallest port/domain change required to carry exact target and evidence. Confirm ownership, incoming direction, cache/version identity and ADR-0017 implications before implementation.
- [ ] Evaluate reads/writes only after the direct-call slice demonstrates useful reach. A nested property path alone cannot establish response-field provenance across repositories.

## Scope and acceptance

Reuse installed Angular parsing/binding and existing TypeScript declaration readers. Do not add Angular LS, a second index, compiler plugins, repository builds or heuristic name matching. Do not reintroduce ignored codegraph template/event synthesizers.

A successful candidate recovers a source-proven method dependency and the appropriate public entrypoint, with the correct template occurrence and repository snapshot. Shadowed or unbound expressions remain uncertain. Existing selector/pipe relations, scope rules and unrelated method consumers remain correct. Unsupported syntax has truthful coverage; it must not silently imply a complete member-binding analysis.

The choice of new public relation/port shapes or completeness semantics is a consequential design decision for the owner. Specify alternatives and the smallest recommended contract instead of silently choosing one in production.

## Measurement and return

Follow ADR-0013: a failing conformance fixture for each admitted construct, and at least two real applications for the relevant coverage addition. Keep application names, layouts and raw results outside the engine repository. Compare the same pinned snapshots and scope; account for added, missing, unknown and false relations against an offline oracle or verified source inventory.

Measure additional correct symbols, callers and UI entrypoints, plus latency and peak/retained memory. Report parser visibility separately from correct binding and public reach. Reject an approach that adds broad false reach or merely emits more occurrences.

Return a report and staged plan with overlap reconciliation, exact files and interfaces, minimal tests and break proofs, oracle method, measured or pending benefit, and implement/narrow/defer/reject recommendation. When implementing later, run focused tests, `npm run check`, `git diff --check` and a global search for competing owners of the same relations.

## Outcome

Status: investigated end to end on 2026-11-05 at `98b9cc5`; no production change. The owner authorized implementation, but the evidence rejects the direct-member slice and leaves the one recovered dependency behind a contract decision that is the owner's.

### Reproduced public behavior

Scratch repository: a routed standalone app (`provideRouter(routes)` in `main.ts`), `OrdersPage` with `templateUrl`, `save()` bound to `(click)`, an unbound `helper()`, `OrdersApi.post()` called from `save()` through `inject(OrdersApi)`, a `BasePage.reload()` called from the template of a subclass `ChildCard` rendered by `OrdersPage`, and `ArchivePage` whose inline template calls `api.archive()` on its own `api = inject(ArchiveApi)` field. Each query is `npm run cli -- callers <repo> <file>:<Type.member>`; the impact query is `npm run cli -- impact <repo> --base HEAD~1 --head HEAD`.

| Question | Expected from source | Observed |
| --- | --- | --- |
| `OrdersPage.save` (template-bound) | `/orders` | `/orders` at depth 0 through `contains`; `complete` |
| `OrdersPage.helper` (no template use, negative control) | `/orders` would be an over-approximation, not a template fact | `/orders` at depth 0 through `contains`; identical shape to `save` |
| `OrdersApi.post` | `OrdersPage.save`, `/orders` | both at depth 1 (`call`, then `contains`); `partial` only for the unrelated `this.http.post` name cut |
| `BasePage.reload` (inherited, bound in `ChildCard`) | `ChildCard`, `OrdersPage`, `/orders` | all reached through `extends` and `uses-component` |
| `ChildCard.refresh` (unbound control) | same reach by containment | same reach |
| Template-only edit of `orders.page.html` | `OrdersPage`, `/orders` | seed `OrdersPage` (`resource`), entrypoint `/orders` |
| `ArchiveApi.archive`, used only as `api.archive()` in the template | `ArchivePage`, `/archive` | **`complete`, no caller, no entrypoint, no cut** |

Source reason: a reached member enters its owner at the same depth (`src/core/application/impact/walk.ts:77-82`) and fields are member kinds too (`src/core/domain/impact/edge-policy.ts:33`), so every own-member call, read or write of a component already reaches the component and its route; binding it adds evidence, not reach. A template use of an injected field's member is different: ADR-0017 stops `injects` from a type reached through a member, and the amendment's member-use join requires exactly one graph reference row at the proven site (`src/core/application/impact/inbound-edges.ts:421-437`). Templates have no graph rows, so the dependency vanishes and the answer still claims completeness, against the "empty never stands for no impact" invariant.

Adapter evidence: the brief's probe still returns `[]`. With installed `@angular/compiler` 22.2.4, `R3TargetBinder.getExpressionTarget` returns `null` (component) for `api.archive()`, `this.api.archive()` and `count()`, and a template entity for each local control, one control per template: `@let api` → `LetDeclaration`, `@for (api of …)` and `<ng-template let-api>` → `Variable`, `#api` → `Reference`. A top-level `@let` shadows the whole block, including uses before it. `count()` binds to a component member but the binder cannot tell a method from a callable field; that needs declaration metadata.

Real applications (rough text counts, not bound facts): one local Angular application has 424 dotted template calls in 61 of 152 templates, 69 on an injected `store` field; another has 158 in 29 of 87, mostly form API calls on local fields. Many `store.x()` are signal reads on signal-store members that are not class methods, which method binding could not resolve. Gain is plausible but unmeasured.

### Disposition

- **Rejected: direct own-member call binding.** No additional symbol, caller or entrypoint in any probe; the only change would be the `via` evidence of an already reached owner. Using bindings to drop unbound members such as `helper` would contract ADR-0017 reach without proof that no other use exists.
- **Rejected for now: own field reads/writes.** Same containment reason; response-field provenance is outside this task.
- **Needs owner decision: template uses of an injected field's member.** Reproduced missing dependency. Two contracts follow the precedent:
  1. *Recommended:* the template reader emits a member-use proof for `field.member(...)` whose head binds to the component (binder target `null`) and whose field has a source-proven injection origin in the existing metadata. The inbound join admits it with the component class as `from`, the template file and line as evidence, at the relation confidence, only for a unique member of the receiver class. It needs a new port field or relation kind toward a method, an `EDGE_POLICY` change, and therefore a producer version bump.
  2. *Truthful uncertainty only:* the template reader reports bound-but-unjoinable member names and the walk turns them into the existing `unresolved-link` cut for that member name. No new reach is claimed, but answers become `partial` wherever a template names a reached member.

  Template locals, unresolvable receivers and callable fields stay unknown in both options. Before either lands, ADR-0013 requires a failing conformance fixture and a measured comparison on two real applications.
- Forward template → method → HTTP tracing belongs to a future `trace` feature, not this task.

Checks: `npm run check` passed before and after this documentation update. Scratch evidence is under `/tmp/ye-ast-t2-hXcq` and was not removed.
