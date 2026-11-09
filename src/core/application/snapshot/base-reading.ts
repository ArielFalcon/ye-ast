import { isReadSource } from "../../domain/languages/profiles.ts";
import type { BuildOutputEvidence, DeclaredBuildOutput, UnreadOutputReason } from "../../domain/shared/build-outputs.ts";
import type { BuildOutputInput, Cut, SnapshotRef } from "../../domain/shared/fact.ts";
import type { ScopeRequest } from "../../domain/shared/scope.ts";
import type { CodeGraphReader, GraphSymbol, GraphUnresolvedReference } from "../../ports/code-graph.port.ts";
import type { DeclaredMemberNames, DeclaredMemberNamesReader } from "../../ports/declared-member-names.port.ts";
import type { ImportOrigins, ImportOriginsReader } from "../../ports/import-origins.port.ts";
import type { ModuleDependenciesReader } from "../../ports/module-dependencies.port.ts";
import type { RevisionSources } from "../../ports/revision-sources.port.ts";
import type { TypeBindings, TypeTarget } from "../../ports/type-bindings.port.ts";
import { createDeclarationUses, unresolvedOncePerFile, type DeclarationUses, type UnresolvedIn } from "../navigation/declaration-uses.ts";
import { createEdgeTargets, NOTHING_DECLARED, type EdgeTargets } from "../navigation/edge-targets.ts";
import { createGraphNavigation } from "../navigation/graph-navigation.ts";
import { typedCallsOf } from "../navigation/proven-calls.ts";
import { createReconciledCalls, linesOncePerFile, type ReconciledCalls } from "../navigation/reconciled-calls.ts";
import { referenceProofsOf, unresolvedOf, type ReferenceProofs } from "../navigation/reference-origins.ts";
import { createReverseCalls, type ReverseCalls } from "../navigation/reverse-calls.ts";
import type { RelationExtraction, RelationExtractor } from "../relations/relation-extractor.ts";
import { retainedRelations } from "../relations/retained-relations.ts";
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

export interface BaseReadingDeps {
  relations: RelationExtractor;
  importOrigins?: ImportOriginsReader | undefined;
  memberNames?: DeclaredMemberNamesReader | undefined;
  typeBindings?: TypeBindings | undefined;
  /** The lockfiles and declaration files a commit's typed pass reads beside its sources; without them nothing is typed. */
  checkerInputs?: RevisionSources | undefined;
  /** The build outputs a host declared for the repository at a root, for a request that declares none itself. */
  declaredOutputs?: ((repo: string) => readonly DeclaredBuildOutput[] | undefined) | undefined;
}

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
  store: CodeGraphReader;
  /** The digest of the index, when the index cache keeps it by content. */
  digest?: string | undefined;
  snapshot: SnapshotRef;
  request: ReadingRequest;
}

/** The proofs a family binds with until every family reads the full reading (ADR-0045 decision 4). */
export interface ProofSelection {
  /** The paths whose import origins are read; every source's by default. */
  originPaths?: readonly string[] | undefined;
  /** The reader of module statements that bind a root to a declaration; without it no edge is redirected. */
  modules?: ModuleDependenciesReader | undefined;
  /** Whether a declaration's file is in the read's scope, for the candidates of an unbound call. */
  inScope?: ((path: string) => boolean) | undefined;
}

/**
 * The assembled reading of one snapshot read (ADR-0045 decision 1): every stage a family consumes, built the first time it
 * is asked and shared by every consumer of the read.
 */
export interface BaseReading {
  /** B1: what a source's syntax states, read once per file; absent without a syntax reader. */
  syntaxOf: ((path: string) => Promise<DeclaredMemberNames>) | undefined;
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
  /** The uses of declarations over `unresolvedIn`. */
  declarationUses(): DeclarationUses;
  /** B10: the written calls the index does not record into reached declarations; absent without bindings or syntax. */
  reverseCalls(targets: EdgeTargets): ReverseCalls | undefined;
}

export interface BaseReadings {
  of(source: ReadingSource, selection: ProofSelection): BaseReading;
}

function once<T>(produce: () => T): () => T {
  let held: { value: T } | undefined;
  return () => (held ??= { value: produce() }).value;
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
    const outputs = request.buildOutputs ?? deps.declaredOutputs?.(request.repo) ?? [];
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
    of(source, selection) {
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
      const unresolvedIn = unresolvedOncePerFile(store);
      const navigation = once(() => createGraphNavigation(store, () => false));
      const origins = once(() => deps.importOrigins?.(tree.sources, selection.originPaths, facts));
      const unresolved = once(() => unresolvedOf(store, tree));
      const relations = once(() => retainedRelations(deps.relations, prepared, tree, request));
      const declarationUses = once(() => createDeclarationUses(store, navigation(), unresolvedIn));
      const retained = facts === undefined || source.digest === undefined ? undefined : { facts, index: source.digest };
      const reconciledCalls = (targets: EdgeTargets, uses: DeclarationUses): ReconciledCalls | undefined =>
        syntaxOf === undefined ? undefined : createReconciledCalls({ store, uses, syntaxOf, lineOf, importedDeclarations: targets.importedDeclarations });

      return {
        syntaxOf,
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
          return createEdgeTargets({ origins: read, store, modules: selection.modules === undefined ? undefined : { reader: selection.modules, sources: tree.sources }, syntaxOf, proofs: relations, typed, inScope: selection.inScope });
        },
        reconciledCalls,
        declarationUses,
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
