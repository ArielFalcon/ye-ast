# RFC-0047: An unproven reading reaches only what its cause can reach, and a consumer never substitutes a by-name set for the owner's "not established"

- Status: Accepted, 2026-11-17. Owner, 2026-11-17: "acepto las sugerencias para las decisiones pendientes" (I accept the suggestions for the pending decisions); every question is settled as its "Resolved questions" table states.
- Related: ADR-0141 and ADR-0142 (the decisions this RFC designs), ADR-0042, ADR-0044 (scoped vetoes; the veto table),
  ADR-0051, ADR-0072 (decisions 6 and 7), ADR-0075, ADR-0081 (decision 2), ADR-0086, ADR-0087, ADR-0089, ADR-0106
  (decision 1), RFC-0024 (rule 2), RFC-0034, RFC-0042 (call-cut causes: this RFC needs its `repository-wide` label),
  RFC-0043 (the typed-expression owner), roadmap audit finding 5

**In short:** a Java source the reader left unparsed or unread, a dynamic implementation or a call-rewriting annotation
anywhere turns every Java call of the repository into `unproven`. Each condition is measured first; where a narrower reach
is provable (the calls whose receiver can hold a runtime-made interface instance, the types a delegating class can
reach, the body-confined unparsed sources) the answer carries the cause and its reach, and where it is not, the answer
keeps the repository-wide reach and every family emits one cut that names the cause. When the owner of a receiver
reading answers "not established", no consumer lists a by-name set as the owner's answer. It moves the cut-ledger rows
that carry `repository-wide` on the Java `unresolved-link` families, and the status of `callers` and `impact`, which
today stay `complete` under a repository-wide answer.

## Problem

| Evidence | Source |
|---|---|
| `provesBinding` is one boolean over the repository: `readsEverySource(project, unparsed, unreadJvm) && no file names a dynamic implementation && no file holds a call-rewriting annotation` | `provesBinding`, `readsEverySource`, `src/core/adapters/spring/java-receiver-methods.ts` |
| When it is false, `receiverMethodAt` answers `UNPROVEN_EVERYWHERE` (`{ kind: "unproven", repositoryWide: true }`) for every call whose reading is `unproven`, and `receiverMethodOf` skips every resolver | `receiverMethodAt`, `receiverMethodOf`, `UNPROVEN_EVERYWHERE`, same file |
| The same boolean gates five other readers: `implementedDeclarations`, `createJavaArgumentCounts`, `perPlacedType`, the kept `provesFromIndex`, and the dispatch closure's global veto | `createJavaImplementedDeclarations`, `createJavaArgumentCounts`, `perPlacedType`, `provesFromIndex`, same file; `globalVeto`, `src/core/adapters/spring/java-dispatch-targets.ts` |
| The dispatch closure already scopes its vetoes (`advisedBy`, `globalVeto`) and releases one only by positive proof | `globalVeto`, `advisedBy`, `java-dispatch-targets.ts`; ADR-0044 decision 5 |
| The conditions are: an unparsed source (`UnparsedSource { path, line }`), a JVM source no extractor reads, a declaration the project could not read, a dynamic implementation name (`Proxy`, `EventHandler`, `MethodHandleProxies`, `LambdaMetafactory`), a call-rewriting annotation (`Delegate`, `ExtensionMethod`) | `UnparsedSource`, `src/core/adapters/spring/java-project.ts`; `isUncoveredJvmSource`, `src/core/domain/languages/path-class.ts`; `JavaProject.unreadable`, `src/core/adapters/spring/java-symbols.ts`; `DYNAMIC_IMPLEMENTATIONS`, `CALL_REWRITING_ANNOTATIONS`, `namesDynamicImplementation`, `src/core/adapters/spring/java-declared-types.ts` |
| A source whose syntax error is confined to member bodies already has its declarations read (`declared`, `declarationsProject`); the receiver reading stays on the stricter gate because "an unread body may hold an anonymous class or a proxy" | `HeldJavaProject.declared`, `declarations`, `java-project.ts`; ADR-0081 decision 2 |
| The answer states the repository-wide reach only as a boolean: no cause and no place | `ReceiverMethod`, `unproven` variant, `src/core/ports/import-origins.port.ts` |
| `impact` and `callers` read the boolean and keep the edge with no cut: `answer.repositoryWide !== true` is the only branch that records an `UnprovenCall` | `declaredMethodsOf`, `src/core/application/navigation/edge-targets.ts` (`else if (answer?.kind === "unproven" && answer.repositoryWide !== true)`) |
| `trace` converts the answer into a per-call cut; with no candidates it falls back to the declarations of the called name in scope | `settleDeclared`, `src/core/application/navigation/call-binding.ts` (`namedDeclarations(member, ...)` for `unproven` with no `candidates`); `unprovenOutside`, `executed`, `callCut`, `src/core/application/trace/trace-walk.ts` |
| For a nominal language, an `unproven` answer with no candidates is replaced by `binder.membersAbove(type, member)`, which is not what the owner read | `memberOfReceiver`, `call-binding.ts` (`return { candidates: offered ?? binder.membersAbove(type, member) }`) |
| The existing tests pin the repository-wide answer for each condition | `src/core/adapters/spring/java-receiver-methods.test.ts`, the tests "an annotation by which a processor adds overloads or rewrites calls proves no method; a source that does not parse, ..." and "unread sources withhold declared receiver proof, ..." |
| Whether `provesBinding` answers false on any corpus repository, and which condition does it, is not recorded anywhere | no ledger row names the condition; measured by U0 |

**Root cause.** The strict binding's gate answers one boolean per repository, so the reach of a cause (one source, one
annotation, one receiver type) is not a value the answer can carry; the consumers then either drop the answer silently
(`callers`, `impact`: no cut, so a false `complete`) or replace the owner's "not established" with a by-name list
(`trace`, the nominal receiver path).

## Design

### Owner

| Fact | Owner | Why |
|---|---|---|
| Which condition left a Java call unproven, and whom it reaches | the Java receiver reading (`createJavaReceiverMethods` and `bindingReach`, new, in `java-receiver-methods.ts`) | it holds the sources, the project and the receiver's type; ADR-0075: a language rule lives in the adapter |
| What the answer of a read says and that it is recorded once per read | `CallBindings` (`call-binding.ts`), through a new `receiverMethods` method | ADR-0041 decision 1: the one owner of what a call binds to; today five consumers call `origins.receiverMethods` directly |
| How a repository-wide cause becomes a cut | `CallBindings.causeCuts()` (new) and the one builder `repositoryWideCut` (new, `src/core/domain/impact/impact-cuts.ts`, beside `placeAt`) | one builder, no copy per family (ADR-0051 decision 7 item 2) |
| What each family does with the answer | the family (trace, callers, impact), reading the owner's sum type | the family decides steps and status, not the proof |

### Contract

`src/core/domain/shared/fact.ts`, `CUT_CAUSES` gains four members (additive; `dynamic-implementation` exists). The
cause's string stays `"<path>:<line> <member>"` (`placeAt`, `impact-cuts.ts`):

```ts
export const CUT_CAUSES = [
  "advice", "annotation", "outside-supertype", "dynamic-implementation", "unsettled-supertype", "unplaced-class",
  "function-value", FUNCTION_VALUE_AWAITS_JDK, "other-type", "no-single-body", "reassignment",
  "unparsed-source", "unread-source", "unreadable-declaration", "call-rewriting",
] as const;
```

`src/core/ports/import-origins.port.ts`:

```ts
/** How far a cause of an unproven reading reaches: every call of the repository, or the calls the reading names. */
export type UnprovenReach = "repository" | "call";

/** One reason the reading proves less than its sources say, at the place that causes it. */
export interface UnprovenCause {
  kind: Extract<CutCause, "unparsed-source" | "unread-source" | "unreadable-declaration" | "dynamic-implementation" | "call-rewriting">;
  /** Repository-relative. */
  path: string;
  /** 1-based; 1 where the cause is a whole file (an unread source, an unreadable declaration). */
  line: number;
  reach: UnprovenReach;
}

// ReceiverMethod, the `unproven` variant:
| { kind: "unproven"; candidates?: readonly MethodPlace[]; open?: true; repositoryWide?: true; causes?: readonly UnprovenCause[] }
```

Invariants of the `unproven` variant, held by one function `unprovenOf(causes, base)` (new, `java-receiver-methods.ts`):

1. `causes` is present only when the answer is `unproven` because of a cause of this table; it is sorted by `(path, line, kind)`,
   without duplicates.
2. `repositoryWide === true` if and only if some entry of `causes` has `reach: "repository"`. A `call`-reach-only answer
   leaves `repositoryWide` absent.
3. An answer with `causes` carries no `candidates` (a cause withholds the declaration selection).

`CallBindings` (`call-binding.ts`) gains:

```ts
/** `origins.receiverMethods` for the sites of a read, recording the repository-wide causes of the answers (the one caller of the port). */
receiverMethods(sites: readonly ReceiverCallSite[], signal?: AbortSignal): Promise<readonly ReceiverMethod[]>;
/** The cut the repository-wide causes recorded by this read state: none, or one. */
causeCuts(): readonly Cut[];
```

`src/core/domain/impact/impact-cuts.ts`, the one builder (a new export beside `placeAt`; `trace` already imports from this file's domain, `trace-effects.ts`):

```ts
export function repositoryWideCut(causes: readonly { kind: CutCause; path: string; line: number }[]): Cut | undefined;
// none when causes is empty; otherwise
// { kind: "unresolved-link", at: <sorted unique placeAt(path, line)>, reason: "receiver-unproven", subReason: "repository-wide",
//   cause: <sorted unique placeAt(path, line, kind)>, reach: { kind: "anything", runtime: "java" } }
```

`"repository-wide"` is the sub-reason of RFC-0042 (`CALL_CAUSES`). The RFC-0042 unit that adds it must be on `main`;
otherwise stop (U1 stop condition).

### Rules

**R1. The conditions, their reach and the proof that the rest is unaffected.** Order of the rows is the order of the
detection in `bindingReach`.

| # | Condition (exact) | Cause `kind` | Reach | What it can invalidate | Why it cannot invalidate the rest |
|---|---|---|---|---|---|
| C1 | `unparsed` holds a path that `declared` does not hold (the syntax error is not confined to member bodies, ADR-0081 decision 1) | `unparsed-source` | `repository` | any name, type or hierarchy | an unread source may declare any type, shadow any name of its package and supply any supertype (ADR-0072 decision 6); no estimate of what an unread file touches is made (ADR-0072 decision 4 and the title of that record) |
| C2 | a path of `paths` with `isUncoveredJvmSource(path)` | `unread-source` | `repository` | as C1 | the same |
| C3 | `project.unreadable` is not empty | `unreadable-declaration` | `repository` | as C1 | the same |
| C4 | `unparsed` holds paths that `declared` also holds (body-confined) and C1 to C3 do not hold | `unparsed-source` | `call`, for the calls `mayHoldDynamic` accepts (R3) | the receiver of a call may be an instance made inside an unread body at run time | the declarations of the source are read, so every name, type and hierarchy outside bodies is settled (ADR-0081 decision 2, first bullet); an unread body declares only types local to it (ADR-0081 decision 1) and can only make runtime instances (R3) |
| C5 | a parsed file names a dynamic implementation (`namesDynamicImplementation`) | `dynamic-implementation` | `call`, for the calls `mayHoldDynamic` accepts (R3) | the receiver of a call may be a `Proxy`, `EventHandler`, `MethodHandleProxies` or `LambdaMetafactory` instance | each of these APIs makes an instance that implements interfaces and extends no repository class (R3) |
| C6 | a parsed or declared file holds `@Delegate` on a member of a class `C` | `call-rewriting` | `call`, for a call whose receiver type `T` has `C` in `{T} ∪ hierarchy(T).types`, or whose hierarchy has gaps, or whose type is unplaced (R4) | a call on `C` or a type below `C` may name a method the annotation adds | the annotation adds methods to `C` only; a call on a type outside `C`'s hierarchy names a member of its own hierarchy |
| C7 | a parsed or declared file holds `@ExtensionMethod` on a type or method | `call-rewriting` | `call`, for a call written inside the annotated declaration's lines (R4), else `repository` when the carrier cannot be determined | a call inside the annotated scope that no member accepts may run a static method of another class | the annotation applies to the code it annotates (Lombok's documented scope: the annotated class or method); a call written elsewhere is not rewritten |

C4 to C7 are evaluated only when C1 to C3 do not hold; when one of C1 to C3 holds the answer's `causes` holds the C1 to
C3 entries (all of them, every file that causes it) and the call-reach causes are not computed (the answer already
reaches every call, so computing them adds nothing).

**R2. The per-call answer.** For the invocations of a place, `causes(place)` is the sorted union of the C1 to C3
entries and of the call-reach entries whose reach rule accepts the invocation. When `causes(place)` is empty the call is
read as today (`proves = true`). Otherwise the invocation's reading is the one `receiverMethodOf` gives with
`proves = false`, and when that reading is `unproven` the place answers `unprovenOf(causes(place))`. A reading that is
not `unproven` under `proves = false` (`unknown`, `generated`, a class-literal or creation answer the unproven branch
does not touch) keeps its value (today's behaviour). The existing rule "a place several invocations start at whose
readings differ is `unproven`" is unchanged and takes the union of the causes of its invocations.

**R3. `mayHoldDynamic(invocation, source, resolver)`: whether the receiver can be an instance a dynamic implementation
made.** Exact, first row that matches:

| The invocation | Answer | Why |
|---|---|---|
| an `object_creation_expression`, an `explicit_constructor_invocation` | `false` | it constructs a repository or library class; no receiver value |
| the `object` of a `method_invocation` or a `method_reference` is `super` | `false` | `super` runs the superclass's member, never a proxy |
| `resolver.receiverTypeOf(invocation, source)` answers a type `T` with `typeName: true` | `false` | a static call through a type name has no receiver value |
| it answers `T` with `T.kind === "class"` (a placed class or record declaration, bound or not) | `false` | a proxy class extends `java.lang.reflect.Proxy`, and a lambda or handler instance extends `Object`; neither is an instance of a repository class, so a value whose static type is a class is not one |
| it answers `T` with `T.kind` `interface`, `annotation` or `other` (an enum: kept as `other` today) | `true` | an interface and an annotation type can be implemented at run time; an enum is conservatively reached |
| it answers `"unproven"` or `undefined` (no repository type placed: a platform or library type, `var`, a chain it cannot type, an array) | `true` | the static type may be an interface or `Object` |

`receiverTypeOf` is the internal `receiverOf` of `createResolver`, exposed on its returned object unchanged (`receiverOf`,
`java-receiver-methods.ts`; its result is `{ type: TypeDecl; bound: boolean; typeName: boolean; builder?: true } | "unproven" | undefined`).

**R4. The call-rewriting reach.**

- C6 (`@Delegate`): collect the annotated classes `C` (the nearest `class_declaration`, `record_declaration` or
  `enum_declaration` around the annotation). A call is reached when `receiverTypeOf` answers `T` and either
  `T === C` for some `C`, or `project.hierarchy(T).types` contains some `C`, or `project.hierarchy(T).gaps.length > 0`;
  when it answers `"unproven"` or `undefined` the call is reached. A call with no receiver (bare or `this`) is read with the enclosing class as `T`.
- C7 (`@ExtensionMethod`): collect `(file, startLine, endLine)` of the annotated declaration (a type or a method). A call
  is reached when its place lies in some range of the same file. When the annotated node is none of a type or a method
  declaration, the cause is `repository` and stands for the whole repository.

**R5. What the consumers do with the answer.** Exact, per family. An answer that is `unproven` without `repositoryWide`
is a per-call unproven answer in every family, as an `unproven` answer is today.

| Family | A `repositoryWide` answer | An answer with only `call`-reach causes |
|---|---|---|
| `trace` | per-call cut as today (candidates dropped per ADR-0142); plus, once per query, the cut of `CallBindings.causeCuts()` | per-call cut as today, its `cause` list holding the causes' places (`placeAt(path, line, kind)`) |
| `callers`, `impact` | the edge stays (no walk step is invented); the cut of `causeCuts()` is added to the answer once; the status becomes `partial` through the reach `anything` (ADR-0042) | the edge is handled as an unproven answer without candidates (`edge-targets.ts`, the branch `answer.repositoryWide !== true`), which it is today |
| `importers`, `outline`, contracts | unchanged: they never read the causes (Not covered) | unchanged |

The cut of `causeCuts()` is emitted at most once per query: `CallBindings` records the causes of every `repositoryWide`
answer it returned (set keyed by `placeAt(path, line, kind)`), and `causeCuts()` returns `[repositoryWideCut(recorded)]`
when the set is not empty. `impactOf`, the `callers` read, and the trace query append the result to their cut list
before `factOfCuts`.

**R6. The by-name fallback (ADR-0142).** Scope: `memberOfReceiver` in `call-binding.ts`, the branch of a nominal
language. When the owner's answer is `unproven` and carries no `candidates`, the declarations returned are `[]`, not
`binder.membersAbove(type, member)`, and the binding of the receiver carries `unproven: true`. Every other branch keeps
`membersAbove`:

| Branch of `memberOfReceiver` | Answer today and after |
|---|---|
| structural language (`!hasTyping(place.file, "nominal")`): `candidates: binder.membersAbove(type, member)` | unchanged: the structural owner is the binder, its member rule answers the target; no owner said "not established" |
| `answered.kind === "method"` | unchanged |
| `answered.kind === "unproven"` with `candidates` | unchanged: the owner's own candidates |
| `answered.kind === "unproven"` without `candidates` | `candidates: []`, `unproven: true` (changed) |
| `answered` `unknown`, `capability-absent`, `generated`, `supplied`, `outside`, or `undefined` | unchanged: `membersAbove` (ADR-0087: another reader owns the form; `outside` and `generated` are answers, not "not established") |

`ReceiverMemberAnswer` gains `unproven?: true`; `CallBinding`'s `receiver` and `unbound` variants gain `unproven?: true`,
set when the owner's answer was `unproven` (here and in `settleDeclared` for an `unproven` method). `callCut` in
`trace-walk.ts` takes the reason `receiver-unproven` whenever the binding says `unproven === true`, whatever the
candidate count (this amends the ADR-0042 table row "receiver-unproven when candidates are listed" to "or when the
receiver reading answered unproven").

Kept unchanged by this rule, and stated in "Not covered": `settleDeclared`'s `namedDeclarations` fallback (ADR-0106
decision 1), because `trace` converts `outside` and a type-variable `method` into `unproven` locally
(`unprovenOutside`, `executed`) before the binding reads them, so the binding cannot tell the owner's `unproven` from a
conversion; and `membersAbove` of the structural branch.

### Soundness

| Rule | Why it cannot assert something false | The input that would break it and how the design excludes it |
|---|---|---|
| R1 C1 to C3 | unchanged from today: repository-wide stays | none: a narrower reach is not claimed |
| R1 C4 | the declarations are read; an unread body can only contain code that runs, never a declaration another file sees (ADR-0081 decision 1: braces delimit the body) | a body-confined error where the brace match is wrong: ADR-0081 consequence, outside the repository-compiles assumption; the derivation records the `unread` question, so an edit re-derives |
| R3, `class` row | a Proxy class `extends java.lang.reflect.Proxy`; instances of lambdas and handlers extend `Object`; a repository class is neither, so a receiver whose static type is a repository class cannot be one | a repository class named `Proxy` or `Object` that the project resolves instead of the JDK one: `namesDynamicImplementation` resolves the name through `resolveName` and counts an unresolved name too (`resolved === undefined`); the reach is about the receiver's type, which is placed; a repository `Proxy` class that is the receiver's static type is a class with its own members, and a JDK proxy is no instance of it |
| R3, enum | `other` is reached, so an enum receiver stays unproven | none: conservative |
| R3, `object === null` (bare call) | the receiver is the enclosing class (`this`): reached when it is not a class | a bare call inside a default method of an interface: the enclosing type is an interface, so `receiverTypeOf` answers it with kind `interface` and the call is reached |
| R4 C6 | `@Delegate` adds methods to its carrier; a type outside `{C} ∪ below(C)` does not gain them | a hierarchy with gaps (a supertype outside the repository) may place `C` above `T`: gaps count as reached; a `T` the reading cannot place is reached |
| R4 C7 | Lombok applies `@ExtensionMethod` inside the annotated declaration only | an annotation on a node that is neither a type nor a method: `repository` |
| R5 | the status becomes `partial` only through a cut that names its cause; no step is added | a repository where the cause holds and no `callers` edge is affected: the cut still states that the proofs of the whole repository are weaker; `reach: anything` is the cut's stated scope (ADR-0042) |
| R6 | the answer lists less than today and never more; the owner's `unproven` is not turned into a list | a `receiver-unproven` cut that listed a real may-run declaration drops it: the owner did not establish it, and the reverse families keep the by-name edge with a `name-only` cut (ADR-0089 decision 1) |

### What the design does not do

- It does not estimate what an unread or unparsed file may touch (ADR-0072).
- It does not change the dispatch closure's vetoes (`globalVeto`, `advisedBy`): dispatch stays separately vetoed, and the
  call-reach rules here concern only whether a call's declaration is proven.
- It does not add a cut reason, a field of `Cut`, or a schema version: `CUT_CAUSES` gains members, `ReceiverMethod`
  gains one optional field, `CallBinding` variants gain one optional flag.
- It does not change the other readers of the boolean (`implementedDeclarations`, `createJavaArgumentCounts`,
  `perPlacedType`, `provesFromIndex`'s other callers): they answer `unknown` where the gate is false, the safe direction.

## Delivery units

| Unit | Goal | Prerequisites | Built when |
|---|---|---|---|
| U0 | Measure which condition fires on which corpus repository | none | always |
| U1 | The contract: causes on the answer, one cut per answer, `CallBindings` as the one caller | RFC-0042's `repository-wide` sub-reason on `main` | always |
| U2 | C4: a body-confined unparsed source reads its declarations | U1 | U0 shows C4 firing |
| U3 | C6 and C7: call-rewriting by reach | U1 | U0 shows C6 or C7 firing |
| U4 | C5: dynamic implementation by reach | U1 | U0 shows C5 firing |
| U5 | The by-name fallback and the fitness test | U1 | always |

Every unit starts with: merge `main`, locate the symbols named below by name, stop and report if one is gone. Other
branches are converting the Java readers to per-file kept reads (ADR-0116 to ADR-0120) and moving `trace-walk.ts`'s
conversions (RFC-0043, ADR-0133): the lines drift; the symbols do not.

### U0: measurement (no code on `main`)

- **Goal:** know whether `provesBinding` answers false on any corpus repository, and which condition does it.
- **Prerequisites:** none. **Risk:** Risk: none.
- **Command:** write the script below under one `mktemp -d` directory outside the repository, run it once per Java
  workspace of the corpus manifest, from the repository checkout (so `tsx` resolves the imports):
  `node --import tsx <scratch>/prove-bindings.ts <workspace-directory>`.

```ts
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createJavaParser } from "<repo>/src/core/adapters/tree-sitter/java-parser.adapter.ts";
import { withJavaSources } from "<repo>/src/core/adapters/spring/java-project.ts";
import { createJavaProject } from "<repo>/src/core/adapters/spring/java-symbols.ts";
import { namesDynamicImplementation } from "<repo>/src/core/adapters/spring/java-declared-types.ts";
import { CALL_REWRITING_ANNOTATIONS } from "<repo>/src/core/adapters/spring/java-declared-types.ts";
import { isUncoveredJvmSource } from "<repo>/src/core/domain/languages/path-class.ts";

const root = process.argv[2]!;
const paths = execFileSync("git", ["-C", root, "ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean);
const sources = paths.filter((path) => path.endsWith(".java")).map((path) => ({ path, content: readFileSync(join(root, path), "utf8") }));
const parser = await createJavaParser();
withJavaSources(parser, (parse) => {
  const { files, unparsed, declared } = parse(sources);
  const project = createJavaProject(files);
  const confined = new Set(declared.map(({ path }) => path));
  const dynamic: string[] = [];
  const rewriting: string[] = [];
  for (const file of files) {
    const pending = [file.root];
    for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
      if (namesDynamicImplementation(node, file, project)) dynamic.push(`${file.path}:${node.startPosition.row + 1}`);
      if ((node.type === "marker_annotation" || node.type === "annotation") && CALL_REWRITING_ANNOTATIONS.has(node.childForFieldName("name")?.text.split(".").at(-1) ?? "")) rewriting.push(`${file.path}:${node.startPosition.row + 1} ${node.childForFieldName("name")?.text}`);
      for (const child of node.namedChildren) if (child !== null) pending.push(child);
    }
  }
  console.log(JSON.stringify({
    root,
    javaFiles: sources.length,
    unparsedConfined: unparsed.filter(({ path }) => confined.has(path)).map(({ path, line }) => `${path}:${line}`),
    unparsedOther: unparsed.filter(({ path }) => !confined.has(path)).map(({ path, line }) => `${path}:${line}`),
    unreadJvm: paths.filter(isUncoveredJvmSource),
    unreadable: project.unreadable.map(({ path }) => path),
    dynamic,
    rewriting,
  }, null, 2));
});
```

  Before running it, open `createJavaParser`, `withJavaSources` and `createJavaProject` and check that the signatures
  used above are the ones in the files; fix the script (not the engine) where they differ, and report the fix.
  (`createJavaParser()` and `createJavaProject(files)` are used so in `java-receiver-methods.test.ts`.)
  The script reads sources with `git ls-files`; the engine's own selection of sources may differ (test sources, declared
  outputs), so each count is an upper bound of the repository's own reading.
- **Number to read:** per repository, the length of each of the seven lists, and for `dynamic` and `rewriting` the
  distinct files and the classes that hold them.
- **Decision table (no threshold; presence decides):**

| What the run shows | Decision |
|---|---|
| `unparsedOther`, `unreadJvm` or `unreadable` is non-empty on some repository | C1 to C3 are the repositories' cause today: U1 states them; no narrower unit exists for them (R1). Record which repository and which list |
| all three are empty everywhere | U1 still builds the contract (the tests pin the repository-wide cut), and the corpus gate shows no row move for C1 to C3 |
| `unparsedConfined` is non-empty somewhere | build U2 |
| `unparsedConfined` is empty everywhere | do not build U2; record it |
| `rewriting` is non-empty somewhere | build U3 for the annotation that appears (`Delegate` → C6, `ExtensionMethod` → C7) and not for the one that does not |
| `rewriting` is empty everywhere | do not build U3 |
| `dynamic` is non-empty somewhere | build U4 |
| `dynamic` is empty everywhere | do not build U4 |
| every list is empty everywhere | `provesBinding` is true on the whole corpus; build U1 and U5 only; the narrower units have no measured use (standing owner preference: no rule without a measurement) |

### U1: the contract

- **Goal:** an unproven answer states its causes and their reach, and each family emits one cut for the repository-wide ones.
- **Prerequisites:** RFC-0042's sub-reason `repository-wide` in `CALL_CAUSES` (`fact.ts`) on `main`; stop otherwise.
- **Files to edit:**
  - `src/core/domain/shared/fact.ts`: `CUT_CAUSES` (add the four members of the Contract).
  - `src/core/ports/import-origins.port.ts`: add `UnprovenReach`, `UnprovenCause`; extend the `unproven` variant with `causes?`.
  - `src/core/adapters/spring/java-receiver-methods.ts`: add `unprovenOf`, `bindingReach` (repository causes only in this unit), change `receiverMethodAt`'s signature and the two callers of `provesBinding` and `provesFromIndex` inside `createJavaReceiverMethods`.
  - `src/core/domain/impact/impact-cuts.ts` and `src/core/domain/impact/impact-cuts.test.ts`: `repositoryWideCut` (a new export).
  - `src/core/application/navigation/call-binding.ts`: `receiverMethods`, `causeCuts` on `CallBindings`.
  - `src/core/application/navigation/edge-targets.ts`, `src/core/application/navigation/reverse-calls.ts`, `src/core/application/trace/trace-walk.ts`: replace each `origins.receiverMethods(` by `bindings.receiverMethods(`.
  - `src/core/application/impact/impact-queries.ts` (`impactOf`), `src/core/application/trace/trace-queries.ts`: append `causeCuts()` to the cuts.
  - tests: `src/core/adapters/spring/java-receiver-methods.test.ts`, `src/core/application/navigation/call-binding.test.ts`, `src/core/application/impact/impact-queries.test.ts`, `src/core/application/trace/trace-queries.test.ts` (or the trace test file that holds the existing receiver-unproven cut tests; locate with `rg "receiver-unproven" src/core/application/trace`).
  - **Must not touch:** `java-dispatch-targets.ts`, the other readers of `provesBinding`, `importers` queries.
- **Steps:**
  1. `fact.ts`: add the four causes to `CUT_CAUSES`. Run the type check; fix every exhaustive switch the compiler lists only by adding the new members where the cause's string is printed (none is expected: `Cut.cause` is `string[]`).
  2. Port: add `UnprovenReach` and `UnprovenCause` as in the Contract; add `causes?: readonly UnprovenCause[]` to the `unproven` variant; update the doc of `repositoryWide` ("`causes` states why").
  3. `java-receiver-methods.ts`:
     - `unprovenOf(causes: readonly UnprovenCause[], base: ReceiverMethod & { kind: "unproven" }): ReceiverMethod` returns `{ kind: "unproven", causes: sorted(causes), ...(causes.some(c => c.reach === "repository") ? { repositoryWide: true } : {}) }` and drops `candidates` and `open` of `base` (invariant 3).
     - `bindingReach(files, project, unparsed, unreadJvm, paths): { repository: readonly UnprovenCause[] }` (the call-reach part arrives in U2 to U4). It returns, sorted by `(path, line, kind)`: one `unparsed-source` entry per `unparsed` item (`path`, `line` from `UnparsedSource`), one `unread-source` per `paths` entry with `isUncoveredJvmSource` (`line: 1`), one `unreadable-declaration` per `project.unreadable` file (`line: 1`), every entry `reach: "repository"`. `provesBinding` is unchanged and keeps its other callers.
     - `receiverMethodAt(invocations, source, resolver, causes: readonly UnprovenCause[])` replaces the `proves: boolean` parameter: `proves = causes.length === 0`; `receiverMethodOf` still takes the boolean; the last line becomes `return !proves && reading.kind === "unproven" ? unprovenOf(causes, reading) : reading;` (it replaces `UNPROVEN_EVERYWHERE`, which is then unused and deleted).
     - In `analyze` (the non-kept path), `const causes = bindingReach(files, project, unparsed, unreadJvm, paths).repository`; pass it. In the kept derivation (`keptByReads`), `provesFromIndex` is replaced by `bindingReachFromIndex(project, asked, (at) => files.get(at), unreadJvm, paths)` with the same questions it asks today (`questions.unread()`, `questions.marked("call-rewriting")`, `questions.marked("dynamic-implementation")`) and, for the repository causes, the entries of the `unread` answer (`files` and `unreadJvm`). It must record the same questions in the same way (the kept answer is keyed by them): the RED test "a kept read derives again when an unread source appears" of `java-receiver-methods.test.ts` that exists for `provesFromIndex` is run unchanged.
     - Until U2 to U4, a `marked` call-rewriting or dynamic-implementation file contributes a `repository` entry (`call-rewriting` at the annotation's line, `dynamic-implementation` at the node's line; the line is read from the file the index names, as `provesFromIndex` already confirms dynamic files with `fileAt`).
  4. `call-binding.ts`: in `createCallBindings`, `const recorded = new Map<string, UnprovenCause>()`; `receiverMethods` calls `origins.receiverMethods(sites, signal)` and for every answer with `kind === "unproven"` and `repositoryWide === true` stores each cause with `reach === "repository"` under `placeAt(path, line, kind)`; it returns the answers unchanged. `causeCuts()` returns `[]` when `recorded` is empty, else `[repositoryWideCut([...recorded.values()])]`. Replace the three internal calls (`memberOfReceiver`, the batch in `bindCalls`, `boundCalls`) by `receiverMethods(...)`.
  5. The four other call sites listed in Files: `edge-targets.ts` (`declaredMethodsOf`, the `origins.receiverMethods(asked.map(...))` call) uses `bindings.receiverMethods` where `bindings` is `EdgeTargets.bindings` (it is defined where the code runs: the function already reads `bindings.settleDeclared` on the next line); `reverse-calls.ts` `bindAll` and `trace-walk.ts` (the `pendingReferences` line and the `receiverSites` line) use the `bindings` they already hold.
  6. `impactOf` and the trace query: after the cuts are assembled, `...(targets?.bindings?.causeCuts() ?? [])` (impact) and `...bindings.causeCuts()` (trace; `edgeTargets.bindings` is defined there: the query throws otherwise). Do not add it in `importers`, `outline` or `consumer-sources`.
- **RED tests:**
  - `java-receiver-methods.test.ts`, `an unproven answer states the causes that left the reading unproven, each at its place`: fixture `[STORE, JDBC, use("store.save(\"x\")"), broken]` with `broken = java("Broken.java", ["package app;", "", "class Broken {"])`. Compute the line: `const line = withJavaSources(await createJavaParser(), (parse) => parse([broken]).unparsed[0]!.line)`. Today: `{ kind: "unproven", repositoryWide: true }`. After: `{ kind: "unproven", repositoryWide: true, causes: [{ kind: "unparsed-source", path: broken.path, line, reach: "repository" }] }`. Same test: `methodAt(sources, "save", KOTLIN(sources))` gives `causes: [{ kind: "unread-source", path: "src/main/kotlin/Twin.kt", line: 1, reach: "repository" }]`; and the `@Delegate` fixture `delegating` (existing) gives `causes: [{ kind: "call-rewriting", path: delegating.path, line: 4, reach: "repository" }]` (line 4 is the field's annotation line in that fixture).
  - `impact-cuts.test.ts`, `the repository-wide cut names every cause once, sorted, and no cause gives no cut`: input two causes in reverse order plus a duplicate; expected one cut with `at: ["src/a/Broken.java:3", "src/b/Twin.kt:1"]`, `cause: ["src/a/Broken.java:3 unparsed-source", "src/b/Twin.kt:1 unread-source"]`, `reason: "receiver-unproven"`, `subReason: "repository-wide"`, `reach: { kind: "anything", runtime: "java" }`; `repositoryWideCut([])` is `undefined`.
  - `call-binding.test.ts`, `the repository-wide causes of the answers a read asked are recorded once`: fake `origins.receiverMethods` answering `{ kind: "unproven", repositoryWide: true, causes: [c] }` for two sites and `{ kind: "unproven", causes: [other with reach "call"] }` for a third; after reading all three, `bindings.causeCuts()` is one cut whose `cause` holds `c` once and not `other`; before any read, `[]`.
  - `impact-queries.test.ts`, `a repository-wide cause makes callers partial with one cut`: `setup` with `origins` whose `receiverMethods` answers `{ kind: "unproven", repositoryWide: true, causes: [{ kind: "unparsed-source", path: "src/Broken.java", line: 3, reach: "repository" }] }` for the one unresolved call of the fixture of the neighbouring test of that file that exercises `declaredMethodsOf` (locate with `rg "repositoryWide" src/core/application/impact/impact-queries.test.ts`; if none exists, derive it from the member-proof test near "relationReader.extract"). Today: `status: "complete"`, no cut. After: `status: "partial"` and `cuts` holds the one cut above with `at: ["src/Broken.java:3"]`.
  - `trace`: the existing test that asserts a `receiver-unproven` per-call cut for a `repositoryWide` answer keeps its assertions (the per-call cut) and gains the one cause cut (assert both are in `cuts`, the cause cut once for two calls).
- **Acceptance:** the five tests pass; the whole `java-receiver-methods.test.ts` passes after replacing `{ kind: "unproven", repositoryWide: true }` by the new value in the assertions the unit changes (lines of the two tests named in Problem); gate items:
  1. *Owner:* the Java reading decides the causes; `CallBindings` records and states them; the families only append.
  2. *Contract:* `UnprovenCause`, one optional field, four `CUT_CAUSES` members; no schema bump.
  3. *No second path:* after the unit `rg "origins\.receiverMethods\(" src --glob '!*.test.ts'` finds only `call-binding.ts` (and the port and its adapters).
  4. *No chain of special cases:* one closed `kind` set, one builder.
  5. *Fitness:* extend `src/composition/edge-targets.single-rule.test.ts` `RULES` with `{ concept: "the one caller of the receiver reading", pattern: /origins\.receiverMethods\(/, owner: "core/application/navigation/call-binding.ts", pending: [] }`.
- **Corpus gate expectation:** `--expect impact:± --expect-cuts receiver-unproven:+` (a Java repository whose answer carried a repository-wide cause gains the one cut and its status becomes `partial`); trace rows unchanged except one added cut where U0 shows a cause. If U0 shows no condition on the corpus, `--expect none` and the gate must show no difference.
- **Risk:** Risk: item 3 (a new cut on public answers, status moves from `complete` to `partial`) and item 6 (the statuses were silently `complete`; the RED tests are the guard).
- **Stop conditions:** `repository-wide` is not in `CALL_CAUSES`; `provesFromIndex`'s questions changed shape (ADR-0116 to ADR-0120 in flight): report; a consumer of `receiverMethods` outside the five listed exists; the gate moves a family the unit does not declare.

### U2: a body-confined unparsed source reads its declarations (C4)

- **Goal:** a source whose syntax error is confined to member bodies stops withholding every Java proof; it reaches only the receivers a runtime instance can stand for.
- **Prerequisites:** U1 on `main`; U0 shows `unparsedConfined` non-empty.
- **Files to edit:** `src/core/adapters/spring/java-receiver-methods.ts` (`bindingReach`, `createJavaReceiverMethods`' `analyze`, the kept derivation, `mayHoldDynamic`, the resolver's returned object), `src/core/adapters/spring/java-receiver-methods.test.ts`. **Must not touch:** `java-project.ts` (the third state is ADR-0081's), the other readers of the boolean.
- **Steps:**
  1. Expose `receiverTypeOf: receiverOf` on the object `createResolver` returns (name by symbol: the object that holds `outsideReceiverOf`).
  2. Add `mayHoldDynamic(invocation: Node, source: ReadFile, resolver: Resolver): boolean` implementing the table of R3 (an exported function of the file, tested directly).
  3. `bindingReach` gains the parameter `declared: readonly JavaFile[]` and the result `at(invocation, source, resolver): readonly UnprovenCause[]`. With `unparsed` entries all in `declared` and no C1 to C3 cause, `repository` is `[]` and `at` returns, for an invocation where `mayHoldDynamic` holds, one entry per `unparsed` item (`unparsed-source`, `reach: "call"`). Calls are then resolved over `held.declarations` (the project over `files` and `declared`) instead of `held.project` when `declared.length > 0`; the non-held path (`withJavaSources` in `resolved`) builds it with `createJavaProject([...files, ...declared], build)` (check how `declarationsProject` builds it and use the same function; do not duplicate its logic).
  4. In the kept derivation, ask `readsEveryDeclarationIn(ask)` (existing) where `provesFromIndex` asked `unread`; the confined case is `unread.files` all `declarations-only` and `!unreadJvm`.
  5. `receiverMethodAt` takes `reach` instead of `causes`: per place, `causes = [...reach.repository, ...invocations.flatMap((invocation) => reach.at(invocation, source, resolver))]`, deduplicated and sorted; `proves` per place is `causes.length === 0`. For a place whose invocations differ, the existing "differ" rule applies to the readings, then the union of causes.
- **RED tests** (`java-receiver-methods.test.ts`; the fixture `confined = java("Confined.java", ["package app;", "", "class Confined {", "  void run() { int = ; }", "}"])` has an error confined to a method body — confirm with `withJavaSources(...).declared` in the test setup that it is in `declared`; if the grammar reads it as an unconfined error, use an unclosed statement inside the body, as the tests of ADR-0081 do: `rg "declared" src/core/adapters/spring/java-project.test.ts`):
  - `a receiver typed by a repository class is proven beside a source whose error is confined to a body`: `[STORE, JDBC, plain, confined, use("plain.save(\"x\")", [], "Plain plain")]` with `plain = java("Plain.java", ["package app;", "", "class Plain {", "  void save(String value) {}", "}"])`. Today: `{ kind: "unproven", repositoryWide: true }`. After: `method(plain, 4)`.
  - `a receiver typed by an interface stays unproven with a call-reach cause`: `[STORE, JDBC, confined, use("store.save(\"x\")")]`. After: `{ kind: "unproven", causes: [{ kind: "unparsed-source", path: confined.path, line: <the unparsed item's line, computed as in U1>, reach: "call" }] }` (no `repositoryWide`).
  - `a source with an error outside a body keeps the repository-wide answer`: the U1 fixture `broken` (unchanged assertion: still `repositoryWide: true`).
  - sibling path: the existing assertions on `method(...)` for the calls of the first test of the file pass unchanged.
  - direct test of `mayHoldDynamic` for each row of R3 (creation, `super`, type-name call, class, interface, enum, `var`): one `it.each`-free assertion per row over fixtures written with `java(...)`.
- **Acceptance:** tests pass; gate items: owner (the reading), contract (no new type), no second path (`declarationsProject` is reused), no case chain (R3 is one table), fitness: not guarded mechanically beyond `provesBinding`'s remaining callers (no new pattern repeats); the test of R3 holds the rule.
- **Corpus gate expectation:** `--expect impact:± --expect-cuts receiver-unproven:-` on the repositories U0 listed under `unparsedConfined`; ledger rows `receiver-unproven` / `repository-wide` for them fall.
- **Risk:** Risk: item 6 (a wrong proof is a missed or invented dependence; R3's tests are the guard).
- **Stop conditions:** U0 listed no confined source; `declarationsProject` no longer exists or changed signature; the confined fixture is not in `declared`.

### U3: call-rewriting by reach (C6, C7)

- **Goal:** `@Delegate` and `@ExtensionMethod` leave unproven only the calls they can rewrite.
- **Prerequisites:** U1 on `main`; U0 shows `rewriting` non-empty (build only the annotation that appears).
- **Files to edit:** `java-receiver-methods.ts` (`bindingReach`: a `call-rewriting` entry list with the carrier, replaces the repository entry U1 emitted for them), `java-receiver-methods.test.ts`. **Must not touch:** `rewritesCalls` (other readers keep it).
- **Steps:**
  1. In `bindingReach` collect, for each parsed or declared file, the annotation nodes of `CALL_REWRITING_ANNOTATIONS`: for `Delegate`, `{ carrier: nearest class_declaration | record_declaration | enum_declaration node around the annotation, place }`; for `ExtensionMethod`, `{ range: [startRow + 1, endRow + 1] of the annotated declaration (the annotation's parent `modifiers` node's parent), file }`. When the carrier or declaration is not found, push a `repository` entry (`call-rewriting`, the annotation's line).
  2. `at(invocation, source, resolver)`: for each `Delegate` carrier, reached when `T` (from `resolver.receiverTypeOf`, or the enclosing class for a bare or `this` call) is the carrier's `TypeDecl`, or `project.hierarchy(T).types` contains it, or `project.hierarchy(T).gaps.length > 0`, or `receiverTypeOf` answers `"unproven"` or `undefined` for a call that has a receiver; for each `ExtensionMethod` range, reached when `source.file.path` equals the range's file and the invocation's start line lies in the range. Entries carry `reach: "call"`, `kind: "call-rewriting"`.
  3. The carrier's `TypeDecl` is found with `project.types.find((type) => type.node.id === carrier.id && type.file.path === file.path)`; none found → a `repository` entry.
  4. The kept derivation asks `questions.marked("call-rewriting")` as today and then `questions.file(path)` for each marked path (to read the annotation's carrier from the file), recording both: an edit of a marked file re-derives.
- **RED tests** (fixtures in the style of the test file):
  - `a call on a type outside a @Delegate carrier's hierarchy is proven`: `[STORE, JDBC, delegating, use("store.save(\"x\")")]` with `delegating` as in U1. Today `{ kind: "unproven", repositoryWide: true }`; after `method(STORE, 4)`.
  - `a call on the carrier, or on a type below it, is unproven with a call-reach cause`: `holder = java("Holder.java", ["package app;", "", "class Holder {", "  @lombok.experimental.Delegate private java.util.List<String> items;", "  void save(String value) {}", "}"])`, `sub = java("Sub.java", ["package app;", "", "class Sub extends Holder {}"])`; `methodAt([STORE, JDBC, holder, sub, use("holder.save(\"x\")", [], "Holder holder")])` and the same with `Sub sub` each `{ kind: "unproven", causes: [{ kind: "call-rewriting", path: holder.path, line: 4, reach: "call" }] }`.
  - `@ExtensionMethod rewrites only the calls written inside the annotated class`: `extending = java("Extending.java", ["package app;", "", "@lombok.experimental.ExtensionMethod(Util.class)", "class Extending {", "  void run(Store store) { store.save(\"x\"); }", "}"])` and `[STORE, JDBC, extending, use("store.save(\"x\")")]`: the call in `Use.java` is `method(STORE, 4)`; a `methodAt` over `extending` at line 5 (add a `file` parameter or call `createJavaNameBindings(...).receiverMethods([{ file: extending.path, line: 5, column, member: "save" }])` as `methodAt` does) is `{ kind: "unproven", causes: [{ kind: "call-rewriting", path: extending.path, line: 3, reach: "call" }] }`.
  - sibling: the existing assertion `await methodAt([...sources, delegating])` is replaced in the first test; every other `delegating` use passes.
- **Acceptance:** tests pass; gate: owner, contract (none new), no second path (the annotation scan stays in `bindingReach`; `rewritesCalls` keeps its other callers), no case chain (two annotations, two reach rules in one function), fitness: none mechanical.
- **Corpus gate expectation:** `--expect impact:± --expect-cuts receiver-unproven:-` on the repositories U0 listed under `rewriting`.
- **Risk:** Risk: item 6.
- **Stop conditions:** U0 listed neither annotation; the carrier node cannot be found for an annotation of U0's list (report the file).

### U4: dynamic implementation by reach (C5)

- **Goal:** a dynamic implementation leaves unproven only the calls whose receiver can hold a runtime-made instance.
- **Prerequisites:** U1 and U2 (`mayHoldDynamic`) on `main`; U0 shows `dynamic` non-empty.
- **Files to edit:** `java-receiver-methods.ts` (`bindingReach`), `java-receiver-methods.test.ts`.
- **Steps:**
  1. `bindingReach` collects the places where `namesDynamicImplementation(node, file, project)` holds (one `dynamic-implementation` entry per node, `placeAt`-style line `node.startPosition.row + 1`) and no longer returns them as `repository` entries.
  2. `at(invocation, source, resolver)` adds every collected entry when `mayHoldDynamic(invocation, source, resolver)` is true. Because a value made in one file can reach a call written in another, the entries of all files are returned (the cause list is the same for every reached call), sorted.
  3. The kept derivation asks `questions.marked("dynamic-implementation")` as today and confirms each path with the project resolution, as `provesFromIndex` does; the entries are computed from the confirmed files.
- **RED tests:**
  - `a call on a repository class is proven beside a dynamic proxy`: `[STORE, JDBC, plain, proxy, use("plain.save(\"x\")", [], "Plain plain")]` with `proxy` as in the existing test (`Proxy.newProxyInstance`, line 6). Today `{ kind: "unproven", repositoryWide: true }`; after `method(plain, 4)`.
  - `a call on an interface is unproven with a call-reach cause`: `[...sources, proxy]` where `sources = [STORE, JDBC, use("store.save(\"x\")")]`: after `{ kind: "unproven", causes: <the entries below>, }`, each entry `{ kind: "dynamic-implementation", path: proxy.path, line, reach: "call" }` for every line of `proxy` where `namesDynamicImplementation` holds. The fixture writes `Proxy` on line 3 (the import) and on line 6 (the call): print `causes` once, check that every printed line is a line that spells `Proxy`, and pin exactly those entries (expected `[3, 6]`; if the import's identifier is not accepted, only `[6]`). This is the one value of the unit that only a run settles; do not widen the cause to make the test pass.
  - `a repository class named Proxy that a source declares is no dynamic implementation` is the existing behaviour of `namesDynamicImplementation`; add no test.
  - sibling: the first test of the file passes unchanged.
- **Acceptance / gate / Risk / Stop:** as U3; fitness: none mechanical. Stop if U0 listed no dynamic implementation.
- **Corpus gate expectation:** `--expect impact:± --expect-cuts receiver-unproven:-` for the repositories U0 listed under `dynamic`.

### U5: the by-name fallback and its fitness test (ADR-0142)

- **Goal:** when the owner answers `unproven` with no candidates, `memberOfReceiver` lists nothing in its place.
- **Prerequisites:** U1 on `main` (RFC-0042's `cause` field of `unbound` on `main` for the label; merge and keep its names).
- **Files to edit:** `src/core/application/navigation/call-binding.ts` (`memberOfReceiver`, `ReceiverMemberAnswer`, `CallBinding`'s `receiver` and `unbound` variants, `proven`, `settleDeclared`), `src/core/application/trace/trace-walk.ts` (`callCut` callers), their tests, `src/composition/edge-targets.single-rule.test.ts`.
- **Steps:**
  1. `ReceiverMemberAnswer` gains `unproven?: true`. In `memberOfReceiver`, the final line becomes: `if (answered?.kind === "unproven" && answered.candidates === undefined) return { candidates: [], unproven: true }; return { candidates: offered ?? binder.membersAbove(type, member) };` (`offered` stays for the `candidates` case).
  2. `proven(proof, name, candidates, place)` (the function that builds a typed `receiver` binding) copies `unproven: true` onto the binding it returns, and `attributed` is `[]` (it already is when `typed` has no `target`).
  3. `settleDeclared`: where `method?.kind === "unproven"`, the returned `unbound` binding gets `unproven: true`; its `candidates` stay as today (not covered).
  4. `callCut` callers in `trace-walk.ts` (list them with `rg "callCut\(" src/core/application/trace/trace-walk.ts`): where the binding at hand has `unproven === true`, pass `"receiver-unproven"` as the reason; where the walk holds only a candidate list, nothing changes.
  5. Fitness: extend `RULES` in `edge-targets.single-rule.test.ts` with `{ concept: "the declarations a member call may run when its receiver's type is proven", pattern: /binder\.membersAbove\(/, owner: "core/application/navigation/call-binding.ts", pending: [] }`. Read the file first and copy the shape of an existing row; add `pending` entries only for files the pattern already matches outside the owner at the time of the merge, each with the reason, and report them.
- **RED tests:**
  - `call-binding.test.ts`, `an unproven receiver the owner could not read lists no declaration of the name`: use the file's `nominalReceiver()` (`Port` interface with `load3` and `load4`, `PORT_CALL`) with `receivers: { load: { kind: "unproven" } }`. Today `binding.candidates` and `binding.attributed` hold `["load3", "load4"]`; after both are `[]` and `binding.unproven === true`. A sibling assertion in the same file's neighbours: the existing test "an unproven receiver names the candidates its owner read, never the repository's set of the name" (`{ kind: "unproven", candidates: [...] }`) passes unchanged, and a `{ kind: "unknown" }` answer still lists `["load3", "load4"]`.
  - `trace` test (the file that holds the receiver-unproven cut tests): the cut for that call keeps `reason: "receiver-unproven"` and `at: [place]` with no candidates (today the reason is `receiver-unproven` with the two candidates in `at`).
  - `impact-queries.test.ts` or `reverse-calls.test.ts`: a callers read over the same call still reports the edge with a `name-only` cut (ADR-0089 decision 1): assert the existing expectation passes unchanged.
- **Acceptance:** tests pass; gate: owner (`memberOfReceiver` is the only place), contract (one optional flag), no second path (the fitness rows), no case chain (one branch added), fitness: the two rows.
- **Corpus gate expectation:** `--expect impact:± --expect trace:± --expect-cuts receiver-unproven:±` (the candidates lists shrink; no cut appears or disappears except through `name-only`); report the ledger delta and the changed places.
- **Risk:** Risk: item 3 (the places a cut lists change) and item 6.
- **Stop conditions:** `memberOfReceiver` was restructured by RFC-0043 or ADR-0133 (merge first and re-locate the `answered.kind === "unproven"` branch); the trace conversions `unprovenOutside` and `executed` were removed (then `settleDeclared`'s fallback may also drop: report instead of deciding).

## Not covered

| Case | What the engine answers | Why it stays |
|---|---|---|
| C1 to C3 on any repository | repository-wide `unproven`, one cut naming the cause and every file | an unread file may declare any type; ADR-0072 forbids estimating (ADR-0141 decision 3) |
| A package-shadow reach for C1 to C3 (an unread source only shadows names of its own package and on-demand imports) | as above | needs a shadow-aware name resolver over package scope; a later rule with its own measurement |
| `unproven` receivers typed by a library class (`outside` is not computed while a call-reach cause holds) | `unproven`, call-reach cause | whether a library type is a class cannot be read from the sources |
| `settleDeclared`'s `namedDeclarations` fallback | the by-name candidates, as today | trace converts `outside` and `bound` into `unproven` locally (ADR-0133 may change it), so the binding cannot tell the owner's `unproven` from a conversion (ADR-0106 decision 1 stays for it) |
| `importers`, `outline`, contract consumers | no cause cut | they never read the receiver reading's causes |
| The other readers of the boolean gate | `unknown` where the gate is false | the safe direction; each needs its own reach proof |
| Kotlin and other JVM sources | `unread-source`, repository-wide | no extractor reads them (ADR-0072) |

## Resolved questions (owner, 2026-11-17: "acepto las sugerencias para las decisiones pendientes")

| # | Question | Decision |
|---|---|---|
| 1 | Is the reach of an unparsed or unread source estimated (for example by package)? | No: repository-wide, stated as one cut with its causes. Discarded: a package-shadow estimate, which ADR-0072 forbids and which needs a resolver that does not exist |
| 2 | Does a body-confined unparsed source keep the repository-wide gate (ADR-0081 decision 2)? | It moves to a call-reach cause over the declarations project. Discarded: keeping the stricter gate, whose only stated reason (an unread body may hold a proxy) is exactly what the call-reach cause expresses |
| 3 | Which receivers can a dynamic implementation reach? | Those whose static type is not a placed repository class (R3). Discarded: all receivers (today), and "interface types only", which would miss `Object`, type variables and unplaced types |
| 4 | Is an enum receiver reached? | Yes (kind `other` is reached). Discarded: treating an enum as a class, which would need a kind the reader does not hold today |
| 5 | How does `@Delegate` reach? | By the receiver's hierarchy, with gaps and unplaced receivers reached. Discarded: reach by the annotated file only, which misses calls on types below the carrier from other files |
| 6 | How does `@ExtensionMethod` reach? | The lines of the annotated declaration. Discarded: the whole file (unsound for a second top-level type) and the whole repository (the measured baseline) |
| 7 | The contract of an answer: a boolean, a list of places, or a sum type? | `causes` with a closed `reach` per entry, `repositoryWide` derived. Discarded: a second answer kind, which every `switch` over `ReceiverMethod` would have to handle |
| 8 | Where are the causes recorded and the cut built? | `CallBindings.receiverMethods` and `causeCuts()`, one builder. Discarded: each family recording its own set (five copies) |
| 9 | One cut per answer or one per call? | One per query for the repository-wide causes (ADR-0042: the cut states a scope, not a call); the per-call cuts stay for the calls. Discarded: one per call, which marks every call and destroys the signal (standing owner preference) |
| 10 | The cut's reason | `receiver-unproven` with sub-reason `repository-wide` (RFC-0042), reach `anything` for `java`. Discarded: a new reason, which ADR-0042 reserves to a new emitter situation |
| 11 | Do `callers` and `impact` become `partial` under a repository-wide cause? | Yes (ADR-0042). Discarded: staying `complete`, which states that nothing weakens the answer while every Java binding is unproven. Owner may overturn |
| 12 | Which flavour does the by-name fallback keep in the nominal path? | None for `unproven` without candidates (R6). Discarded: keeping `membersAbove` labelled by-name, which needs the unbuilt `basis` field of RFC-0034 Part B; owner may overturn |
| 13 | Is `settleDeclared`'s fallback removed too? | No (Not covered): the binding cannot distinguish the owner's answer from trace's local conversions |
| 14 | Are the narrower units built without U0's evidence? | No: each is conditional on U0 showing its condition (standing owner preference: no rule without a measurement) |
