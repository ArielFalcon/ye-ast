# Scoped proof uncertainty

Status: proposed design, 2026-11-05. Inspected base: `0f66550`. No production code changes with this document.

## Problem

Member-use proofs (ADR-0017 amendment) let impact follow `this.api.load()` from a component to the method of the service
it injects. On two measured Angular applications every such proof is refused, so the answers keep `unresolved-link`
cuts a proof would settle, and template calls of an injected field's member are dropped with the answer still
`complete`. The two cases that surfaced this (a `computed(() => this.api.x())` initializer, and `api.archive()` in a
template) are symptoms. The fix targets the mechanisms that produce them, so that variants of the same shapes are
covered without a rule per case.

## Owner constraints

- Fix root causes transversally, not one case at a time.
- Flexibility without losing confidence: no all-or-nothing, improve the analysis where it can be improved.
- Noise is worse than no fix: "si la solución introduce demasiado ruido o información (marca muchas cosas a la vez) es
  peor que si no se soluciona porque solo contamina y pierde el valor de la señal". Every stage states and measures the
  markers and cuts it adds; recovery of proven facts comes before any new marker.

## Evidence

Read-only sweep of the whole engine at `0f66550`, measured on two real Angular applications (A1: 1,148 TypeScript files;
A2: 376, inside a monorepo) and nine Spring repositories, with a diagnostic copy of the engine that counts each gate and
can lift or narrow it. Applications are described by shape only.

| Gate | Location | Trigger | What it switches off | Fires (A1 / A2) |
| --- | --- | --- | --- | --- |
| G1 observable mutation | `angular-metadata.extractor.ts:383-466`, `angular-metadata.adapter.ts:293` | an element write, `Object.assign`, `Reflect.*`, `.prototype`, `eval`/`with` in any file | every member proof of the project | 45 triggers in 21 files / 4 in 3; 31 of 40 in A1 write to a local object literal; one is a test-setup `Element.prototype` write |
| G2 unknown substitution | `angular-metadata.adapter.ts:243-249` | one provider token that is not provably distinct | every member proof | 1 / 0 |
| G3 single project | `angular-metadata.adapter.ts:54` | a source outside the Angular project (a nested `package.json`) | every member proof | 0 / 1 |
| G4 unsafe names | `angular-metadata.extractor.ts:449-455`, `angular-metadata.adapter.ts:292,301` | any non-call use of `this.f`, any `x.f = …`, any subclass member `f` | every field and method named `f` in every class | 1,875 / 244 names |
| G4a own-call poisoning | same | `this.save()` in any class | `save` on every class | 31 member refusals in A1 |
| G5 location rule | `angular-metadata.extractor.ts:441-461` | `this.f.x()` outside a method body (field initializers), `this.f` read or passed | field `f`, and by name through G4 everywhere | initializer calls 312 / 60, reads 592 / 82, values 1,140 / 216 |
| G6 template member calls | template reader | any `field.member()` in a template | the dependency and its route, silently `complete` | 189 / 128 candidates, 0 admitted |
| G7 unparsable Java file | `java-call-sites.adapter.ts:32-36` | a parse error | every call site of that file, silently | 2 of ~980 files |
| G8 Spring config import | `application-config.ts:122-147` | `spring.config.import` and similar | every key of the module, as explicit `undecided` | 7 of 8 modules in one repository |
| G9 shared local names | `inbound-edges.ts:86-90` | two owners in one file declare the same `inject()` local | those locals | 6 / 0, 0 calls lost |

Reproduced on a minimal fixture: each of an unrelated `a[0] = 1`, a `computed(() => this.api.load())` in another class,
an unrelated class calling its own `this.save()`, and an unrelated `class Child extends Base { api = 2 }` turns correct
`complete` answers for `Api.load` and `Api.save` into `partial` with an `unresolved-link` cut.

## Root causes

- **R1 Undirected uncertainty (G1, G2, G3).** A risk is recorded as "something somewhere is unproven" instead of being
  attached to what it can reach. With N triggers, all N must vanish before one proof survives, so narrowing one trigger
  recovers nothing.
- **R2 Uncertainty keyed by bare name (G4, G4a, G9).** The same mechanism one level down: a use of `f` in class X refuses
  `f` in class Y.
- **R3 Location instead of behavior (G5, G4a).** Calling, reading or passing `this.f` cannot change what `f` holds; only
  writing or redeclaring `f` can.
- **R4 A refusal without a trace (G6, G7).** Class-side refusals fall back to a graph `unresolved-link` row; template uses
  and unparsable Java files have none, so nothing marks them.

R1–R3 are not silent class-side: they over-cut. R4 is the silent part.

## Design

### Principles

1. **Uncertainty has a target.** Each risk signal records the identity it can affect (a class, an injection token, an
   `(owner, field)` pair, a `(receiver, member)` pair) and its source location. A proof consults only the signals that can
   reach its receiver. A signal whose reach cannot be bounded is bounded to what the code holding it can touch, never to
   the project.
2. **A use is judged by what it does.** Uses are classified as call, read, value (escape) or write. Only a write,
   `++`/`--`, `delete` or a redeclaration of a field makes it unsafe; where the use sits does not matter.
3. **Recover before marking.** A stage that only adds markers lands after the stages that recover proofs, and only with
   a measured per-answer volume.
4. **Markers and cuts are anchored narrowly.** A cut names the member or the site it concerns, so it appears only in
   answers that walk that member.

### Stages

Each stage enters with a failing fixture taken from the measured shapes (ADR-0013 decision 5), a measured comparison on
the two applications (decision 4), hand-sampling of at least 10 newly admitted proofs per application for false
associations, and the count of cuts and markers it adds and removes. The `edge-policy` version identity moves with each
stage that changes admission.

1. **S1 Scoped risks (M1 + M2).** Replace the project-wide booleans G1–G3 and the global name set G4 with targeted
   signals:
   - a write to a local object literal, or to a value that holds no source class, reaches nothing;
   - a prototype write reaches only the class it names, and a platform class (`Element`) is not a source class;
   - a substitution of token X affects only injections of X; when the substitute is a known class, the proof is admitted
     with a qualifier naming the substitution site (`may be replaced by Y at app.config.ts:12`), which the renderer shows
     with one symbol and one legend; measured volume is 1 site in A1 and 0 in A2;
   - a source outside the project contributes its evidence instead of disabling proofs;
   - the unsafe set is keyed by `(owner, field)` and `(receiver, member)`; the owner-local `unsafeFields` set already
     exists and is reused.
   Measured with the diagnostic copy: class-side proofs 0 → 238 (A1) / 112 (A2); adds no cut or marker beyond the
   qualifier, and settles existing cuts.
2. **S2 Behavior rule (M3).** Reclassify G5: calls in field initializers and closures (`computed`, `effect`,
   `linkedSignal`, `resource`, `toSignal`) are uses of the owner; reads and calls never make a field unsafe; writes
   through aliases are covered by break-proof tests. Measured: 238 → 431 / 112 → 153; adds no marker.
3. **S3 Unparsable Java files (M6).** Emit `unknown` with `source-unreadable` for a Java file the parser rejects, as
   `spring-routes` already does. Adds 2 items in 9 repositories.
4. **S4 Hierarchy-scoped subclass members (M4).** A subclass member makes unsafe only the members of its own hierarchy.
   Upper bound measured by dropping the rule: ≤ 665 / ≤ 228; to be measured properly scoped before landing.
5. **S5 Template member uses.** Rebase the template proof path (branch `t3/2a7cab47`, ADR-0025) on S1–S4 and measure
   recovered template proofs. Then, only for uses still refused, an `unresolved-link` cut anchored to the receiver
   member (`Api::archive`). Estimated residual 70–90 / 25–40 sites per application, each visible only in answers that
   walk that member; it lands only if the per-answer volume measured on real queries is low. A file-level anchor, or
   cutting before S1–S4, is rejected as noise.

### Deferred

- **G8**: today's explicit module-wide `undecided` under `spring.config.import` is truthful; a qualified value on every
  key of 7 modules would be noise.
- **G9**: keying shared locals by owner recovers 6 locals and 0 calls.

## Decisions for the owner, with recommendations

1. **Test files as mutation evidence.** Recommended: production member proofs ignore test-only files as evidence, as the
   member-use join already ignores test-file callers.
2. **Unscoped remainder of S1** (5 local-other writes and 2 parameters in A1). Recommended: keep it a narrow per-class
   unknown; do not pay the type-checker cost (ADR-0018) for 7 sites.
3. **S5 residual cuts.** Recommended: decide after S1–S4 with the per-answer volume measured.
4. **G8 semantics.** Recommended: keep as is.

## Affected decisions

ADR-0017 and its amendment stay in force; S1–S2 change how the proof gates are scoped, not what a proof is. If the
amendment's wording restricts proofs to method bodies, S2 adds an ADR that amends that wording. ADR-0025 lives on the
template branch and enters with S5. ADR-0013 governs the evidence for every stage.

## Measurement artifacts

Diagnostic copy, fixtures and outputs of the sweep: `/tmp/ye-ast-sweep-EroI` (local scratch, not part of the
repository). Template branch measurement: `/tmp/ye-ast-t2impl-WZvb`.
