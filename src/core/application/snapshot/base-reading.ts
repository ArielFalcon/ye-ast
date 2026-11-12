import { isReadSource } from "../../domain/languages/profiles.ts";
import type { BuildOutputEvidence, DeclaredBuildOutput, UnreadOutputReason } from "../../domain/shared/build-outputs.ts";
import type { BuildOutputInput, Cut, FactBase, SnapshotRef } from "../../domain/shared/fact.ts";
import type { ScopeRequest } from "../../domain/shared/scope.ts";
import type { CodeGraphReader, GraphNodeId, GraphSymbol, GraphUnresolvedReference } from "../../ports/code-graph.port.ts";
import type { DeclaredMemberNames, DeclaredMemberNamesReader } from "../../ports/declared-member-names.port.ts";
import type { AbsentCapability } from "../../ports/language-pack.port.ts";
import type { ImplementedDeclarations, ImportOrigins, ImportOriginsReader } from "../../ports/import-origins.port.ts";
import type { ModuleDependenciesReader } from "../../ports/module-dependencies.port.ts";
import type { RevisionSources } from "../../ports/revision-sources.port.ts";
import type { SourceReading } from "../../domain/change/source-tokens.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { SourceTokens } from "../../ports/source-tokens.port.ts";
import type { TypeBindings, TypeTarget } from "../../ports/type-bindings.port.ts";
import { createDeclarationUses, unresolvedOncePerFile, type DeclarationUses, type UnresolvedIn } from "../navigation/declaration-uses.ts";
import { createEdgeTargets, edgeKey, NOTHING_DECLARED, type EdgeTargets } from "../navigation/edge-targets.ts";
import { implementedContractsOf } from "../navigation/implemented-contracts.ts";
import { createGraphNavigation } from "../navigation/graph-navigation.ts";
import { callsThroughOrigins, createOriginCalls, type OriginCalls } from "../navigation/origin-calls.ts";
import { typedCallsOf } from "../navigation/proven-calls.ts";
import { createReconciledCalls, linesOncePerFile, type ContradictedRecord, type ReconciledCalls } from "../navigation/reconciled-calls.ts";
import { referenceProofsOf, unresolvedOf, type ReferenceProofs } from "../navigation/reference-origins.ts";
import { createReverseCalls, type ReverseCalls } from "../navigation/reverse-calls.ts";
import type { RelationExtraction, RelationExtractor } from "../relations/relation-extractor.ts";
import { memberProofContextOf, retainedRelations } from "../relations/retained-relations.ts";
import { declaredScope } from "../../domain/map/entrypoint-map.ts";
import { canonicalJson } from "../../domain/shared/canonical-json.ts";
import type { ParseHold } from "../../ports/parse-holds.port.ts";
import type { CommitExtraction, PreparedCommit } from "./read-snapshot.ts";

/** What the type checker contributes to one answer: its bindings by call place, the declarations it read, and its cuts. */
/** B7's answer: evidence only, which `buildOutputCuts` turns into cuts (ADR-0042 decision 10). */
export interface TypedReading {
  typed?: ReadonlyMap<string, TypeTarget>;
  outputs?: readonly BuildOutputInput[];
  /** What the run states about the declared outputs; absent when none was declared. */
  buildOutputs?: BuildOutputEvidence;
  /** What reading the checker's inputs left out, as the revision sources answer it. */
  inputsLeftOut: readonly Cut[];
}

const NOT_TYPED: TypedReading = { inputsLeftOut: [] };
const CONTRADICTED_CALLS = "contradicted-calls";

/** A fact base that records the declared build outputs its answer read, if any. */
export function withOutputs(base: FactBase, outputs: readonly BuildOutputInput[] | undefined): FactBase {
  return outputs === undefined ? base : { ...base, inputs: { ...base.inputs, buildOutputs: outputs } };
}

export interface BaseReadingDeps {
  relations: RelationExtractor;
  importOrigins?: ImportOriginsReader | undefined;
  memberNames?: DeclaredMemberNamesReader | undefined;
  /** Every language's module statements, which bind a root to a declaration; without them no edge is redirected. */
  modules?: ModuleDependenciesReader | undefined;
  /** The B11 tokens stage: one reading per file, from the pack that owns its path (ADR-0043 decision 6). */
  tokens?: SourceTokens | undefined;
  typeBindings?: TypeBindings | undefined;
  /** The lockfiles and declaration files a commit's typed pass reads beside its sources; without them nothing is typed. */
  checkerInputs?: RevisionSources | undefined;
  /** The build outputs a host declared for the repository at a root, for a request that declares none itself. */
  declaredOutputs?: ((repo: string) => readonly DeclaredBuildOutput[] | undefined) | undefined;
  /** The stages each language pack declares it cannot implement, by path (ADR-0045 decision 12); none declared without it. */
  absentCapabilities?: ((path: string) => ReadonlySet<AbsentCapability>) | undefined;
}

const NO_ABSENT: ReadonlySet<AbsentCapability> = new Set();

/** The request one reading answers. */
export interface ReadingRequest {
  repo: string;
  scope?: ScopeRequest;
  signal?: AbortSignal;
  buildOutputs?: readonly DeclaredBuildOutput[];
}

/** One snapshot read with its opened index. */
export interface ReadingSource {
  tree: Pick<CommitExtraction, "export" | "sources">;
  prepared: PreparedCommit | undefined;
  /** The read's open parse hold, which owns the trees of the sources it kept; absent where nothing is held. */
  hold?: ParseHold | undefined;
  store: CodeGraphReader;
  /** The digest of the index, when the index cache keeps it by content. */
  digest?: string | undefined;
  snapshot: SnapshotRef;
  request: ReadingRequest;
}

/** How a family narrows what the reading binds; every family binds with the same proofs (ADR-0045 decision 4). */
export interface ReadingNarrowing {
  /** The snapshot's paths the import origins read as its universe; every source's by default. */
  originPaths?: readonly string[] | undefined;
  /** Whether a declaration's file is in the read's scope, for the candidates of an unbound call; every file by default. */
  inScope?: ((path: string) => boolean) | undefined;
}

/** A call record the source of its place proves writes no call, with the target the index held. */
export interface ContradictedCall {
  record: GraphUnresolvedReference;
  target: GraphSymbol;
}

/** The call edges of `sources` the reconciliation contradicts, by the key of the edge the index holds (ADR-0041 U6). */
export type ContradictedCalls = (sources: readonly GraphSymbol[]) => Promise<ReadonlyMap<string, ContradictedCall>>;

/**
 * The assembled reading of one snapshot read (ADR-0045 decision 1): every stage a family consumes, built the first time it
 * is asked and shared by every consumer of the read.
 */
export interface BaseReading {
  /** B1: what a source's syntax states, read once per file; absent without a syntax reader. */
  syntaxOf: ((path: string) => Promise<DeclaredMemberNames>) | undefined;
  /** B11: the tokens of a source, read once per read and retained per file; `unread` where no pack tokenizes it. */
  tokensOf(file: SourceFile): Promise<SourceReading>;
  /** A line of a source, split once per file. */
  lineOf(file: string, line: number): string | undefined;
  /** The unresolved references of a file, read once per file. */
  unresolvedIn: UnresolvedIn;
  /** The unresolved references of the exported sources, read once. */
  unresolved(): readonly GraphUnresolvedReference[];
  /** B2: where the names of the sources are rooted; absent without an origins reader. */
  origins(): ImportOrigins | undefined;
  /** B4: the relations of the sources, under the key every family reads them by (ADR-0026). */
  relations(): Promise<RelationExtraction>;
  /** B6: the two proofs the sources' own imports make. */
  referenceProofs(): Promise<ReferenceProofs>;
  /** B7: what the type checker binds over the declared build outputs. */
  typed(): Promise<TypedReading | "aborted">;
  /** B8: the edge targets, the binder and the base bindings, with the type checker's bindings when given; absent without origins. */
  edgeTargets(typed?: ReadonlyMap<string, TypeTarget>): EdgeTargets | undefined;
  /** B9: each declaration's calls, the index's and the syntax's aligned; absent without syntax. */
  reconciledCalls(targets: EdgeTargets, uses: DeclarationUses): ReconciledCalls | undefined;
  /** B9's contradiction policy: the call records whose source writes no call at their place; absent without syntax or origins. */
  contradictedCalls(targets: EdgeTargets): ContradictedCalls | undefined;
  /** The uses of declarations over `unresolvedIn`. */
  declarationUses(): DeclarationUses;
  /** B10: the written calls the index does not record into reached declarations; absent without bindings or syntax. */
  reverseCalls(targets: EdgeTargets): ReverseCalls | undefined;
  /** The member calls through the relations' field and `inject()` local origins into reached declarations; absent without bindings. */
  originCalls(targets: EdgeTargets): OriginCalls | undefined;
  /** The supertype declarations of each Java method of a class with a repository supertype, asked of the origins once (RFC-0024 U4); empty without origins. */
  implementedContracts(): Promise<ReadonlyMap<GraphNodeId, ImplementedDeclarations>>;
  /** The stages the language pack of `path` declares absent (ADR-0045 decision 12); none where no pack reads it. */
  absentCapabilitiesOf(path: string): ReadonlySet<AbsentCapability>;
}

export interface BaseReadings {
  of(source: ReadingSource, narrowing?: ReadingNarrowing): BaseReading;
  /**
   * B11 for one source, without an index: retained per file under `prepared`, so `impact` can settle hunks before it
   * decides whether the graph is needed (ADR-0043 decisions 4 and 8). Never prebuilt; asked only for a changed file.
   */
  tokensOf(file: SourceFile, prepared: PreparedCommit | undefined): Promise<SourceReading>;
}

function once<T>(produce: () => T): () => T {
  let held: { value: T } | undefined;
  return () => (held ??= { value: produce() }).value;
}

async function tokensOfSource(deps: BaseReadingDeps, file: SourceFile, prepared: PreparedCommit | undefined): Promise<SourceReading> {
  const holder = deps.tokens;
  if (holder === undefined) return { status: "unread", reason: "capability-absent" };
  const read = (): Promise<SourceReading> => holder.tokensOf(file);
  const facts = prepared?.facts;
  return facts === undefined ? read() : facts.ofInputs("tokens", { path: file.path, content: file.content, reading: "v1" }, read);
}

function contradictionKey({ record, target }: ContradictedCall): string {
  return edgeKey({ source: record.from, target: target.id, kind: record.kind, line: record.line, column: record.column, confidence: null, provenance: null, synthesizedBy: null, resolvedFrom: null });
}

export function createBaseReadings(deps: BaseReadingDeps): BaseReadings {
  /**
   * What the type checker binds at a commit over the declared build outputs: the sources with the lockfiles and
   * declaration files a second read of the same commit takes, which the index's export never holds. A live tree is not
   * typed (ADR-0037, Gate): its answer keeps the derivation it had. Neither is any declaration when one the lockfile
   * contradicts, one that would not be read, or a failing checker withholds them all; then every declaration is named
   * in a `build-output` cut, at what withheld it where that is known.
   */
  async function typedReading({ request, snapshot, tree, prepared }: ReadingSource): Promise<TypedReading | "aborted"> {
    const bindings = deps.typeBindings;
    const inputs = deps.checkerInputs;
    const outputs = (request.buildOutputs ?? deps.declaredOutputs?.(request.repo) ?? []).filter(({ kind }) => kind === "node-modules");
    if (bindings === undefined || inputs === undefined || outputs.length === 0) return NOT_TYPED;
    const { signal } = request;
    const unread = (reason: UnreadOutputReason, named?: ReadonlyMap<string, readonly string[]>): BuildOutputEvidence => ({ used: false, outputs, reason, ...(named === undefined ? {} : { named }) });
    if (snapshot.kind === "live") return { buildOutputs: unread("live-tree"), inputsLeftOut: [] };
    const read = await inputs.filesAt({ repo: { path: request.repo }, scope: { exclude: request.scope?.exclude ?? [] }, ...(signal === undefined ? {} : { signal }) }, snapshot.sha);
    if (!read.ok) return read.fault.kind === "aborted" ? "aborted" : { buildOutputs: unread("inputs-unreadable"), inputsLeftOut: [] };
    let answer;
    try {
      answer = await bindings.of([...tree.sources, ...read.value.files], outputs, signal, prepared?.facts);
    } catch (error) {
      if (signal?.aborted) return "aborted";
      throw error;
    }
    const inputsLeftOut = read.value.cuts;
    if (answer.status === "unused") return { buildOutputs: unread("version-mismatch", new Map(answer.outputs.map(({ at, stale }) => [at, stale.map(({ path }) => path)]))), inputsLeftOut };
    if (answer.status === "fault") return { buildOutputs: answer.fault.kind === "unreadable" ? unread("outputs-unreadable", new Map(answer.fault.outputs.map(({ at, paths }) => [at, paths]))) : unread("checker-failed"), inputsLeftOut };
    return { typed: typedCallsOf(answer.bindings), outputs: answer.outputs, buildOutputs: { used: true, refused: answer.refused }, inputsLeftOut };
  }

  return {
    tokensOf: (file, prepared) => tokensOfSource(deps, file, prepared),
    of(source, narrowing = {}) {
      const { tree, prepared, store, request } = source;
      const facts = prepared?.facts;
      const sources = new Map(tree.sources.map((file) => [file.path, file]));
      const reader = deps.memberNames;
      const syntax = new Map<string, Promise<DeclaredMemberNames>>();
      const syntaxOf =
        reader === undefined
          ? undefined
          : (path: string): Promise<DeclaredMemberNames> => {
              const file = sources.get(path);
              if (file === undefined) return Promise.resolve(NOTHING_DECLARED);
              let read = syntax.get(path);
              if (read === undefined) {
                read = reader.memberNames(file, facts);
                syntax.set(path, read);
              }
              return read;
            };
      const lineOf = linesOncePerFile(sources);
      const tokens = new Map<string, Promise<SourceReading>>();
      const tokensOf = (file: SourceFile): Promise<SourceReading> => {
        let read = tokens.get(file.path);
        if (read === undefined) {
          read = tokensOfSource(deps, file, prepared);
          tokens.set(file.path, read);
        }
        return read;
      };
      const unresolvedIn = unresolvedOncePerFile(store);
      const navigation = once(() => createGraphNavigation(store, () => false));
      const origins = once(() => deps.importOrigins?.(tree.sources, narrowing.originPaths, facts, source.hold));
      const implementedContracts = once(() => implementedContractsOf(store, tree.sources.map(({ path }) => path), navigation(), origins()));
      const unresolved = once(() => unresolvedOf(store, tree));
      const relations = once(() => retainedRelations(deps.relations, prepared, tree, request, source.hold));
      const declarationUses = once(() => createDeclarationUses(store, navigation(), unresolvedIn));
      const retained = facts === undefined || source.digest === undefined ? undefined : { facts, index: source.digest };
      /** Kept between requests under the index it read and the relations its origins come from. */
      const throughOrigins = once(async () => {
        const origins = await relations();
        const produce = async () => callsThroughOrigins(store, origins);
        if (prepared?.retained === undefined || source.digest === undefined) return produce();
        const memberProofs = memberProofContextOf(deps.relations, tree, declaredScope(request.scope));
        return prepared.retained(canonicalJson({ output: "origin-calls", index: source.digest, memberProofs }), produce, request.signal);
      });
      let reconciled: { targets: EdgeTargets; calls: ReconciledCalls } | undefined;
      const reconciledCalls = (targets: EdgeTargets, uses: DeclarationUses): ReconciledCalls | undefined => {
        if (syntaxOf === undefined) return undefined;
        if (reconciled?.targets !== targets) reconciled = { targets, calls: createReconciledCalls({ store, uses, syntaxOf, lineOf, importedDeclarations: targets.importedDeclarations }) };
        return reconciled.calls;
      };

      return {
        syntaxOf,
        tokensOf,
        lineOf,
        unresolvedIn,
        unresolved,
        origins,
        relations,
        referenceProofs: once(() => referenceProofsOf(origins(), store, tree, request.signal, unresolved())),
        typed: once(() => typedReading(source)),
        edgeTargets(typed) {
          const read = origins();
          if (read === undefined) return undefined;
          return createEdgeTargets({ origins: read, store, modules: deps.modules === undefined ? undefined : { reader: deps.modules, sources: tree.sources }, syntaxOf, proofs: relations, typed, inScope: narrowing.inScope });
        },
        reconciledCalls,
        contradictedCalls(targets) {
          const calls = reconciledCalls(targets, declarationUses());
          if (calls === undefined) return undefined;
          const contents = new Map<string, string>();
          const recordsIn = (file: string): Promise<readonly ContradictedRecord[]> => {
            const written = sources.get(file);
            if (retained === undefined || written === undefined) return calls.contradictedIn(file);
            let content = contents.get(file);
            if (content === undefined) {
              content = retained.facts.fingerprint({ content: written.content });
              contents.set(file, content);
            }
            return retained.facts.ofInputs(CONTRADICTED_CALLS, { index: retained.index, path: file, content }, () => calls.contradictedIn(file));
          };
          return async (bodies) => {
            const found = new Map<string, ContradictedCall>();
            for (const file of new Set(bodies.map((body) => body.file))) {
              for (const { record, target } of await recordsIn(file)) {
                if (target !== undefined) found.set(contradictionKey({ record, target }), { record, target });
              }
            }
            return found;
          };
        },
        declarationUses,
        originCalls: (targets) => (targets.bindings === undefined ? undefined : createOriginCalls(targets.bindings, throughOrigins)),
        implementedContracts,
        absentCapabilitiesOf: (path) => deps.absentCapabilities?.(path) ?? NO_ABSENT,
        reverseCalls(targets) {
          const reconciled = reconciledCalls(targets, declarationUses());
          if (targets.bindings === undefined || reconciled === undefined || syntaxOf === undefined) return undefined;
          const constructs = async (node: GraphSymbol): Promise<boolean> => (await syntaxOf(node.file)).callables.some((callable) => callable.construction && callable.name === node.name && callable.start <= node.startLine && node.startLine <= callable.nameLine);
          const readable = tree.sources.filter((file) => isReadSource(file.path));
          return createReverseCalls({ store, navigation: navigation(), reconciled, bindings: targets.bindings, importedDeclarations: targets.importedDeclarations, sources: readable, constructs, ...(retained === undefined ? {} : { retained }) });
        },
      };
    },
  };
}
