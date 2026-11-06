import { unknownTargetKey } from "../../ports/impact-queries.port.ts";
import type { SourceTrivia } from "../../ports/source-trivia.port.ts";
import type { DeclarationEvidenceReader } from "../../ports/declaration-evidence.port.ts";
import { blastRadius, type BlastRadius } from "../../domain/change/blast-radius.ts";
import { isReadableFile, kindOfChangedFile } from "../../domain/change/changed-file.ts";
import { selectChange } from "../../domain/change/change-selection.ts";
import { resourceImpact, resourceOwners } from "../../domain/change/resource-impact.ts";
import type { FileChange } from "../../domain/change/diff-reader.ts";
import type { ComponentRef } from "../../domain/change/seeds.ts";
import { changedContracts, servedContracts } from "../../domain/impact/changed-contracts.ts";
import { changedEntrypoints } from "../../domain/impact/changed-entrypoints.ts";
import { unresolvedPlaceCuts, removedDeclarationCuts, unreadRelationCuts, unresolvedLinkCuts, type UnreadRelation } from "../../domain/impact/impact-cuts.ts";
import { sortedUnique, type ImportersValue } from "../../domain/impact/importers-fact.ts";
import { impactFact, type ImpactBudget, type ImpactedSymbol, type ImpactValue, type Seed } from "../../domain/impact/impact-fact.ts";
import { reachedEntrypoints } from "../../domain/impact/reached-entrypoints.ts";
import type { Relation } from "../../domain/relations/relation.ts";
import type { MemberUseOrigin } from "../../domain/relations/member-use.ts";
import { isExtractorConfiguration } from "../../domain/languages/configuration.ts";
import { isAngularTemplate, isJsonModuleResource, isTypeScriptFile, isTypeScriptSource } from "../../domain/languages/typescript.ts";
import { isJavaSource } from "../../domain/languages/java.ts";
import { moduleImpact, moduleResources } from "../../domain/impact/module-impact.ts";
import type { ModuleDependencies } from "../../domain/impact/module-dependency.ts";
import type { ModuleDependenciesReader } from "../../ports/module-dependencies.port.ts";
import { cutsCompleteness } from "../../domain/languages/uncovered.ts";
import type { Entrypoint } from "../../domain/entrypoints/entrypoint.ts";
import { declarationSpan, sortedEngines, type Cut, type DeclaredConfig, type Evidence, type Fact, type FactBase, type Finding, type IndexOrigin, type SnapshotRef, type TrustMode, type UnknownFact } from "../../domain/shared/fact.ts";
import { canonicalJson } from "../../domain/shared/canonical-json.ts";
import { exportSelection, pathSelection, sortedGlobs, type PathSelection, type ScopeRequest } from "../../domain/shared/scope.ts";
import { changedPaths, isWritten } from "../../domain/snapshot/live-export.ts";
import { contentFingerprint, declaredScope, exportCuts, holdsDeclaredSource, isInMapScope } from "../../domain/map/entrypoint-map.ts";
import type { Result } from "../../domain/shared/result.ts";
import type { AngularDeclarationReader } from "../../ports/angular-declarations.port.ts";
import type { CodeGraph, CodeGraphReader, GraphNodeId, GraphSymbol, GraphUnresolvedReference, IndexSummary } from "../../ports/code-graph.port.ts";
import type { DynamicLoad, DynamicLoadReader } from "../../ports/dynamic-loads.port.ts";
import type { Digest } from "../../ports/digest.port.ts";
import type { IndexCache } from "../../ports/index-cache.port.ts";
import type { ImpactFault, ImpactOfChangeRequest, ImpactQueries, OfChangeFault, UnknownSymbolFault } from "../../ports/impact-queries.port.ts";
import type { AtRevision, LiveSelector } from "../../ports/live-queries.port.ts";
import type { PathMatcher } from "../../ports/path-matcher.port.ts";
import { isEngineConfiguration } from "../../ports/staging-rules.ts";
import type { FieldOrigin, LocalOrigin } from "../../domain/relations/field-origin.ts";
import type { RelationExtractor } from "../relations/relation-extractor.ts";
import type { CommitExport, Vcs, VcsChanges, VcsFault } from "../../ports/vcs.port.ts";
import { ABORTED, extractCommit, factBaseOf, trustOf, withScratch, type CommitExtraction, type PreparedCommit } from "../snapshot/read-snapshot.ts";
import { createHeadReader, withLiveCapture, type FactSpec, type HeadIndex, type HeadReaderDeps, type HeadReading, type Revisioned } from "../snapshot/head-reading.ts";
import { readImporters } from "./importers.ts";
import { inboundEdgesOf } from "./inbound-origins.ts";
import type { EdgeCorrections, InboundEdges } from "./inbound-edges.ts";
import { memberProofContextOf, referenceProofsOf, unresolvedOf, type ReferenceProofs } from "./reference-origins.ts";
import { walkImpact, type Walk } from "./walk.ts";
import type { ImportOrigins, ImportOriginsReader } from "../../ports/import-origins.port.ts";
import { createEdgeTargets, edgeKey, type EdgeTargets, type EdgeTargetsDeps, type FollowedEdge } from "../navigation/edge-targets.ts";
import type { ContractRoutes } from "../../ports/contract-routes.port.ts";
import { distinctTargets, evidenceOfTarget, missingTargets, rangeChanges, requestedRanges, selectRoots, targetKey } from "../navigation/root-selection.ts";
import { prepareCommit } from "../snapshot/prepared-snapshot.ts";
import type { UnmodelledConstructsReader } from "../../ports/unmodelled-constructs.port.ts";
import { unmodelledNote } from "../../domain/shared/unmodelled.ts";

export interface ImpactQueriesDeps extends HeadReaderDeps {
  /** The walk reads the change between two revisions, which no other family asks for. */
  vcs: Vcs & VcsChanges;
  angular: AngularDeclarationReader;
  contracts: ContractRoutes;
  relations: RelationExtractor;
  /** Reads the dynamic loads of the head's sources, so a load whose specifier is a literal names its module. */
  dynamicLoads: DynamicLoadReader;
  /** Version of each engine every operation runs on, by package name. */
  engines: Readonly<Record<string, string>>;
  /** Version of each engine only the operations that read Angular declarations and templates add. */
  angularEngines: Readonly<Record<string, string>>;
  /**
   * Reads the imports of one snapshot's sources, so a reference whose rooted name the file imports from outside the
   * repository stops being a cut (`RFC-0016` gap A). Without it every answer is the one ye-ast gave before.
   */
  importOrigins?: ImportOriginsReader;
  /** Tells the trivia lines of a requested range apart; without it every line of a range is code. */
  sourceTrivia?: SourceTrivia;
  moduleDependencies?: ModuleDependenciesReader;
  declarationEvidence?: DeclarationEvidenceReader;
  /** The changed or targeted files whose declarations the graph cannot place; without it no such file is cut. */
  unmodelled?: UnmodelledConstructsReader;
}

type Answer = Result<Fact<ImpactValue>, OfChangeFault>;

const NO_TRIVIA: SourceTrivia = { triviaLines: async () => new Set() };


export function createImpactQueries(deps: ImpactQueriesDeps): ImpactQueries {
  const { vcs, digest } = deps;
  const importersEngines = sortedEngines(deps.engines);
  const angularReadingEngines = sortedEngines({ ...deps.engines, ...deps.angularEngines });
  const walkBounds = (budget: ImpactBudget | undefined): Pick<DeclaredConfig, "walk"> => (budget === undefined ? {} : { walk: { ...budget } });
  /** The config a change fact records: the walk bounds, and the selection when the caller set one. */
  const changeConfig = (request: Pick<ImpactOfChangeRequest, "budget" | "changed">): DeclaredConfig => {
    const changed = request.changed === undefined || request.changed.length === 0 ? undefined : sortedGlobs(request.changed);
    return { ...walkBounds(request.budget), ...(changed === undefined ? {} : { changed }) };
  };
  const retainedOf = <T>(prepared: PreparedCommit | undefined, slot: string, produce: () => Promise<T>, signal: AbortSignal | undefined): Promise<T> =>
    prepared?.retained === undefined ? produce() : prepared.retained(slot, produce, signal);
  const relationsOf = (prepared: PreparedCommit | undefined, tree: CommitExtraction, request: { scope?: ScopeRequest; signal?: AbortSignal }) => {
    const memberProofs = memberProofContextOf(tree, declaredScope(request.scope));
    return retainedOf(prepared, canonicalJson({ output: "relations", memberProofs }), () => deps.relations.extract(tree.sources, { memberProofs }), request.signal);
  };
  const moduleDependenciesOf = (reader: ModuleDependenciesReader, prepared: PreparedCommit | undefined, tree: Pick<CommitExtraction, "sources">, signal: AbortSignal | undefined) =>
    retainedOf(prepared, canonicalJson({ output: "module-dependencies" }), () => reader.extract(tree.sources), signal);
  const headReader = createHeadReader(deps);
  const moduleSource = deps.moduleDependencies === undefined ? isInMapScope : isWritten;
  const changeDeps = { ...deps, sourceSelection: moduleSource };
  const changeReader = createHeadReader(changeDeps);
  const importerSource = (file: string): boolean => moduleSource(file) || isTypeScriptFile(file) || isJavaSource(file);
  const importerReader = createHeadReader({ ...deps, sourceSelection: importerSource });

  return {
    async ofChange(request) {
      return request.live === true ? ofChangeLive(request) : ofChangeAtRevision(request);
    },

    async callers(request) {
      const { signal } = request;
      const targets = distinctTargets(request.targets);
      const requested = targets.flatMap((target) => ("symbol" in target ? [target] : []));
      const changes = rangeChanges(targets);
      const spec: FactSpec = { declaredConfig: { ...walkBounds(request.budget), targets: targets.map(targetKey) }, engines: angularReadingEngines };

      return headReader.atHead(request, spec, async (head): Promise<Result<Fact<ImpactValue>, ImpactFault>> => {
        const headTree = head.tree;
        const content = contentFingerprint(headTree.export);
        const outside = targets.filter((target) => !head.selected(target.file));
        if (outside.length > 0) return { ok: true, value: { ...head.base(content), evidence: outside.map(evidenceOfTarget), status: "unknown", reason: "out-of-scope" } };
        const declarations = await deps.angular.read(headTree.sources);
        if (signal?.aborted) return ABORTED;
        const componentsByResource = resourceOwners(declarations);
        const fixed = [
          ...exportCuts(headTree.export),
          ...changes.filter((file) => kindOfChangedFile(file.path) !== "source" && !componentsByResource.has(file.path)).map((file): Cut => ({ kind: "no-extractor", at: [file.path] })),
        ];
        const value: ImpactValue = { seeds: [], symbols: [], entrypoints: [], cost: { expansionsUsed: 0 } };

        const needsGraph = requested.length > 0 || changes.some((file) => kindOfChangedFile(file.path) === "source" || componentsByResource.has(file.path));
        if (!needsGraph) return { ok: true, value: impactFact(head.base(content), value, fixed) };

        const index = await head.open();
        if (index === "aborted") return ABORTED;
        if (index === "unavailable") return { ok: true, value: { ...head.base(content), status: "unknown", reason: "index-unavailable" } };
        if ("fault" in index) return { ok: false, fault: index.fault };
        const { store, summary } = index;
        try {
          const unknown = missingTargets(store, requested);
          const ranges = await requestedRanges(store, changes, headTree.sources, deps.sourceTrivia ?? NO_TRIVIA);
          if (signal?.aborted) return ABORTED;
          const missing = [...unknown, ...ranges.uncovered];
          if (missing.length > 0) {
            const names = missing.map(unknownTargetKey).join(", ");
            const unmodelled = await unmodelledIn(deps, headTree, unknown.map(({ file }) => file));
            return { ok: false, fault: { kind: "unknown-symbol", detail: `no symbol at the revision for ${names}${unmodelledNote(unknown, unmodelled)}`, entries: missing } };
          }
          const { relations: found, fields, locals, memberUses } = await relationsOf(head.prepared, headTree, request);
          if (signal?.aborted) return ABORTED;
          const loads = await deps.dynamicLoads.extract(headTree.sources);
          if (signal?.aborted) return ABORTED;
          const origins = deps.importOrigins?.(headTree.sources);
          const unresolved = unresolvedOf(store, headTree);
          const proofs = await referenceProofsOf(origins, store, headTree, request.signal, unresolved);
          if (signal?.aborted) return ABORTED;
          const unmodelled = await unmodelledIn(deps, headTree, [...changes.map(({ path }) => path), ...requested.map(({ file }) => file)]);
          if (signal?.aborted) return ABORTED;
          const read = await impactOf({ store, changes: ranges.changes, requested, componentsByResource, found, fields, locals, memberUses, loads, headTree, summary, unresolved, budget: request.budget ?? {}, proofs, unmodelled, origins, modules: deps.moduleDependencies === undefined ? undefined : { reader: deps.moduleDependencies, sources: headTree.sources }, signal });
          if (signal?.aborted) return ABORTED;
          return { ok: true, value: impactFact(head.base(content, true), read.value, [...fixed, ...read.cuts]) };
        } finally {
          store.close();
        }
      });
    },

    async importers(request) {
      const files = sortedUnique(request.files);
      const spec: FactSpec = { declaredConfig: { files }, engines: importersEngines };

      return importerReader.atSources(request, spec, async (head): Promise<Result<Fact<ImportersValue>, VcsFault>> => {
        const headTree = head.tree;
        const content = contentFingerprint(headTree.export, importerSource);
        const outside = files.filter((file) => !head.selected(file));
        if (outside.length > 0) return { ok: true, value: { ...head.base(content), evidence: outside.map((path): Evidence => ({ path, line: 1 })), status: "unknown", reason: "out-of-scope" } };
        const fixed = [...exportCuts(headTree.export), ...headTree.export.files.filter((file) => importerSource(file.path) && (isReadableFile(file.path) || isJsonModuleResource(file.path)) && !file.written).map((file): Cut => ({ kind: "not-exported", at: [file.path] })), ...files.filter((file) => !(isReadableFile(file) || (deps.moduleDependencies !== undefined && isJsonModuleResource(file)))).map((file): Cut => ({ kind: "no-extractor", at: [file] }))];
        const covered = files.filter((file) => isReadableFile(file) || (deps.moduleDependencies !== undefined && isJsonModuleResource(file)));
        if (covered.length === 0) return { ok: true, value: impactFact(head.base(content), { files: [] }, fixed) };

        const index = await head.open();
        if (index === "aborted") return ABORTED;
        if (index === "unavailable") return { ok: true, value: { ...head.base(content), status: "unknown", reason: "index-unavailable" } };
        if ("fault" in index) return { ok: false, fault: index.fault };
        const { store, summary } = index;
        try {
          const written = headTree.export.files.filter((file) => file.written && isReadableFile(file.path)).map((file) => file.path);
          const held = new Set(headTree.export.files.map((file) => file.path));
          const references = store.unresolvedReferences(written);
          const modules = deps.moduleDependencies === undefined ? undefined : await moduleDependenciesOf(deps.moduleDependencies, head.prepared, headTree, request.signal);
          if (request.signal?.aborted) return ABORTED;
          const origins = deps.importOrigins?.(headTree.sources);
          const read = await readImporters(store, covered, references, modules, origins === undefined ? undefined : createEdgeTargets({ origins, store, modules }), request.signal);
          if (request.signal?.aborted) return ABORTED;
          const moduleOnly = new Set(modules?.files.filter((file) => file.moduleOnly).map((file) => file.file));
          const loadPlaces = await deps.dynamicLoads.extract(headTree.sources);
          if (request.signal?.aborted) return ABORTED;
          const cuts = [
            ...fixed,
            ...unresolvedLinkCuts(
              references.filter((reference) => kindOfChangedFile(reference.file) !== "test"),
              [],
              loadPlaces,
            ),
            ...summary.filesNotIndexed.filter((file) => !moduleOnly.has(file)).map((file): Cut => ({ kind: "no-extractor", at: [file] })),
            ...read.unheld.map((file): Cut => ({ kind: held.has(file) ? "no-extractor" : "not-exported", at: [file] })),
            ...(modules?.unread.map(({ file }): Cut => ({ kind: "no-extractor", at: [file] })) ?? []),
            ...unresolvedPlaceCuts(modules?.dependencies.filter((edge) => edge.target.kind === "unresolved").map((edge) => ({ file: edge.file, line: edge.line, reason: edge.specifier })) ?? []),
          ];
          return { ok: true, value: impactFact(head.base(content, true), { files: read.files }, cuts) };
        } finally {
          store.close();
        }
      });
    },
  };

  async function ofChangeAtRevision(request: AtRevision<ImpactOfChangeRequest>): Promise<Answer> {
    const { repo, signal } = request;
    const scope = declaredScope(request.scope);
    const selected = pathSelection(scope, deps.matcher.matches);
    const exported = exportSelection(scope, deps.matcher.matches, isExtractorConfiguration);
    const base = await vcs.resolveCommit(repo, request.base, signal);
    if (!base.ok) return base;
    const head = await vcs.resolveCommit(repo, request.head, signal);
    if (!head.ok) return head;
    const trust = await trustOf(deps, repo);
    const merge = await vcs.mergeBase(repo, base.value, head.value, signal);
    if (!merge.ok) return merge;
    const mergeBase = merge.value;

    const snapshot: SnapshotRef = { repo: request.repoId, kind: "sha", sha: head.value };
    const spec: FactSpec = { declaredConfig: changeConfig(request), engines: angularReadingEngines };
    const baseOfHead = (content: string): FactBase => changeReader.factBase(trust, snapshot, content, spec, scope, undefined);

    const diff = await vcs.diffCommits(repo, mergeBase, head.value, signal);
    if (!diff.ok) return diff.fault.kind === "git-failed" ? unknownFact(baseOfHead(JSON.stringify([mergeBase, head.value])), "source-unreadable") : diff;
    if (signal?.aborted) return ABORTED;
    const radius = blastRadius(mergeBase, diff.value.filter((file) => selected(file.path)));

    return withScratch(deps.scratch, async (directory): Promise<Answer> => {
      const preparedHead = await prepareCommit(changeDeps, repo, head.value, directory, exported, { scope, trust }, signal);
      if (!preparedHead.ok) return preparedHead;
      const headTree = await preparedHead.value.extract(signal);
      if (!headTree.ok) return headTree;
      const preparedBase = mergeBase === head.value ? preparedHead : await prepareCommit(changeDeps, repo, mergeBase, directory, exported, { scope, trust }, signal);
      if (!preparedBase.ok) return preparedBase;
      const baseTree = mergeBase === head.value ? headTree : await preparedBase.value.extract(signal);
      if (!baseTree.ok) return baseTree;
      const reading: HeadReading = {
        tree: headTree.value,
        prepared: preparedHead.value,
        selected,
        base: (content, store = false) => (store ? changeReader.factBase(trust, snapshot, content, spec, scope, { kind: "full" }) : baseOfHead(content)),
        open: () => changeReader.indexHead(preparedHead.value, directory, signal),
      };
      return readChange({ request, radius, head: reading, baseTree: baseTree.value, basePrepared: preparedBase.value, sameTree: baseTree === headTree, unreadable: JSON.stringify([mergeBase, head.value]) });
    });
  }

  async function ofChangeLive(request: Extract<ImpactOfChangeRequest, { live: true }>): Promise<Answer> {
    const { repo, repoId, signal } = request;
    const spec: FactSpec = { declaredConfig: changeConfig(request), engines: angularReadingEngines };
    let baseSha = "";
    let mergeBase = "";
    return withLiveCapture(deps, request, { use: async (held) => {
      const { tree, scope, head } = held;
      const selected = pathSelection(scope, deps.matcher.matches);
      const exported = exportSelection(scope, deps.matcher.matches, isExtractorConfiguration);
      return withScratch(deps.scratch, async (directory): Promise<Answer> => {
        const liveTree = await held.extract(signal);
        if (!liveTree.ok) return liveTree;
        const baseTree = await extractCommit(changeDeps, repo, mergeBase, await directory(), exported, signal);
        if (!baseTree.ok) return baseTree;
        const reading = headReader.liveReading(tree, liveTree.value, "trusted", scope, selected, head, repoId, spec);

        const changed = changedPaths(baseTree.value.export.files, tree.export.files).filter((path) => !isEngineConfiguration(path));
        const [before, after] = [await directory(), await directory()];
        const wanted = new Set(changed);
        const exportedBase = await vcs.exportCommit(repo, mergeBase, before, { write: (path) => wanted.has(path) }, signal);
        if (!exportedBase.ok) return exportedBase;
        const copied = await held.deps.live!.mirror.materialize(tree.location, changed, after, signal);
        if (!copied.ok) return { ok: false, fault: { kind: "live-mirror-failed", detail: `${copied.fault.kind}: ${copied.fault.detail}` } };
        const diff = await vcs.diffDirectories(before, after, signal);
        const unreadable = JSON.stringify([mergeBase, head]);
        if (!diff.ok) return diff.fault.kind === "git-failed" ? unknownFact(reading.base(unreadable), "source-unreadable") : diff;
        if (signal?.aborted) return ABORTED;
        const radius = blastRadius(mergeBase, diff.value.filter((file) => selected(file.path)));
        const sameTree = changed.length === 0 && JSON.stringify(baseTree.value.export.skipped) === JSON.stringify(tree.export.skipped);
        return readChange({ request, radius, head: reading, baseTree: baseTree.value, sameTree, unreadable });
      });
    }, unavailable: async ({ head, scope }) => {
      const unavailable = headReader.unavailableLive("trusted", scope, head, repoId, spec);
      return unknownFact(headReader.factBase("trusted", unavailable.snapshot, JSON.stringify([mergeBase, head]), spec, scope, undefined), "index-unavailable");
    }, beforeHead: async () => {
      const base = await vcs.resolveCommit(repo, request.base, signal);
      if (!base.ok) return base;
      baseSha = base.value;
      return { ok: true, value: undefined };
    }, beforeOpen: async (head) => {
      const merge = await vcs.mergeBase(repo, baseSha, head, signal);
      if (!merge.ok) return merge;
      mergeBase = merge.value;
      return { ok: true, value: undefined };
    } });
  }

  /** Everything `ofChange` does once it holds the diff and both trees; a commit and the live tree differ only in how they got here. */
  async function readChange(input: { request: ImpactOfChangeRequest; radius: BlastRadius; head: HeadReading; baseTree: CommitExtraction; basePrepared?: PreparedCommit; sameTree: boolean; unreadable: string }): Promise<Answer> {
    const { request, radius, head, baseTree, sameTree } = input;
    const { signal } = request;
    const selection = selectChange(radius.files, request.changed, deps.matcher.matches);
    if (selection.unmatched.length > 0) {
      return { ok: false, fault: { kind: "unknown-change-path", detail: `the change leaves ${radius.files.length} changed files in the answer's scope; no changed path matches ${selection.unmatched.join(", ")}`, globs: selection.unmatched } };
    }
    const changes = selection.files;
    const headTree = head.tree;
    const declarations = await deps.angular.read(headTree.sources);
    if (signal?.aborted) return ABORTED;
    const before = !sameTree && changes.some((file) => file.deleted && !isReadableFile(file.path)) ? await deps.angular.read(baseTree.sources) : [];
    if (signal?.aborted) return ABORTED;
    const { owners: componentsByResource, covered } = resourceImpact(declarations, before, changes);
    const content = JSON.stringify([radius.mergeBase, contentFingerprint(baseTree.export, moduleSource), contentFingerprint(headTree.export, moduleSource)]);
    const declared = holdsDeclaredSource(headTree.export.files);
    const fixed = [
      ...exportCuts(headTree.export),
      ...(sameTree ? [] : exportCuts(baseTree.export)),
      ...changes
        .filter((file) => cutsCompleteness(file.path, declared) || (isAngularTemplate(file.path) && !covered.has(file.path)))
        .map((file): Cut => ({ kind: "no-extractor", at: [file.path] })),
    ];
    const entrypointSelected = pathSelection({ include: request.changed ?? [], exclude: [] }, deps.matcher.matches);
    const entrypointChanges = changedEntrypoints(entrypointsOf(baseTree.findings), entrypointsOf(headTree.findings)).filter((change) => entrypointSelected(change.handler.path));
    const changedPaths = new Set(radius.files.map((file) => file.path));
    const contracts = changedContracts(deps.contracts.operations(baseTree.sources), deps.contracts.operations(headTree.sources), (path) => changedPaths.has(path) && entrypointSelected(path));
    fixed.push(...contracts.cuts);
    const value: ImpactValue = { mergeBase: radius.mergeBase, seeds: [], changedEntrypoints: entrypointChanges, ...(contracts.changes.length === 0 ? {} : { changedContracts: servedContracts(contracts.changes, baseTree.findings, headTree.findings) }), symbols: [], entrypoints: [], cost: { expansionsUsed: 0 } };

    let moduleRead: ReturnType<typeof moduleImpact> | undefined;
    const moduleReader = deps.moduleDependencies;
    if (moduleReader !== undefined && changes.some((file) => isTypeScriptSource(file.path) || isJsonModuleResource(file.path))) {
      const readSnapshot = async (tree: CommitExtraction, prepared: PreparedCommit | undefined, selectedChanges: readonly FileChange[]): Promise<ModuleDependencies | undefined> => {
        const read = moduleCoverage(await moduleDependenciesOf(moduleReader, prepared, tree, signal), tree, selectedChanges);
        if (signal?.aborted) return undefined;
        if (read.untraversed !== undefined) return read;
        const loads = await deps.dynamicLoads.extract(tree.sources);
        if (signal?.aborted) return undefined;
        return { ...read, untraversed: loads.map(({ file, line }) => ({ file, line, offset: 0, form: "dynamic-import" as const })) };
      };
      const base = await readSnapshot(baseTree, input.basePrepared, changes);
      if (base === undefined) return ABORTED;
      const current = sameTree ? base : await readSnapshot(headTree, head.prepared, changes.filter((file) => !file.deleted));
      if (current === undefined) return ABORTED;
      moduleRead = moduleImpact(changes, base, current, request.budget);
    }
    if (moduleRead !== undefined && moduleRead.value.origins.length > 0) value.modules = moduleRead.value;
    const moduleCuts = moduleRead?.cuts ?? [];
    const unaccounted = (cuts: readonly Cut[]): Cut[] => cuts.flatMap((cut) => {
      if (cut.kind !== "no-extractor" || moduleRead === undefined) return [cut];
      const at = cut.at.filter((file) => !moduleRead.covered.has(file));
      return at.length === 0 ? [] : [{ ...cut, at }];
    });

    const needsGraph = changes.some(
      (file) => (kindOfChangedFile(file.path) === "source" && (!file.deleted || file.removedNames.length > 0) && !moduleRead?.covered.has(file.path)) || componentsByResource.has(file.path),
    );
    if (!needsGraph) return { ok: true, value: impactFact(head.base(content), value, [...unaccounted(fixed), ...moduleCuts]) };

    const index = await head.open();
    if (index === "aborted") return ABORTED;
    if (index === "unavailable") return unknownFact(head.base(content), "index-unavailable");
    if ("fault" in index) return { ok: false, fault: index.fault };
    const { store, summary } = index;
    try {
      const { relations: found, fields, locals, memberUses } = await relationsOf(head.prepared, headTree, request);
      if (signal?.aborted) return ABORTED;
      const loads = await deps.dynamicLoads.extract(headTree.sources);
      if (signal?.aborted) return ABORTED;
      const origins = deps.importOrigins?.(headTree.sources);
      const unresolved = unresolvedOf(store, headTree);
      const proofs = await referenceProofsOf(origins, store, headTree, request.signal, unresolved);
      if (request.signal?.aborted) return ABORTED;
      const baseSources = new Map(baseTree.sources.map((source) => [source.path, source.content]));
      const headSources = new Map(headTree.sources.map((source) => [source.path, source.content]));
      const byPath = Map.groupBy(changes.filter((file) => file.removedNames.length > 0), (file) => file.path);
      const validated = new Map<string, ReadonlySet<string>>();
      for (const [path, files] of byPath) {
        if (deps.declarationEvidence === undefined || signal?.aborted || files.some((file) => file.deleted !== files[0]!.deleted)) continue;
        const names = [...new Set(files.flatMap((file) => file.removedNames))];
        validated.set(path, new Set(deps.declarationEvidence.validate({ path, base: baseSources.get(path), head: headSources.get(path), deleted: files[0]!.deleted, names })));
      }
      const validatedChanges = changes.map((file) => {
        const retained = validated.get(file.path);
        return retained === undefined ? file : { ...file, removedNames: file.removedNames.filter((name) => retained.has(name)) };
      });
      const unmodelled = await unmodelledIn(deps, headTree, validatedChanges.filter((file) => !file.deleted).map(({ path }) => path));
      if (signal?.aborted) return ABORTED;
      const read = await impactOf({ store, changes: validatedChanges, requested: [], componentsByResource, found, fields, locals, memberUses, loads, headTree, summary, unresolved, budget: request.budget ?? {}, proofs, unmodelled, origins, modules: deps.moduleDependencies === undefined ? undefined : { reader: deps.moduleDependencies, sources: headTree.sources }, signal });
      if (signal?.aborted) return ABORTED;
      return { ok: true, value: impactFact(head.base(content, true), { ...value, ...read.value }, [...unaccounted([...fixed, ...read.cuts]), ...moduleCuts]) };
    } finally {
      store.close();
    }
  }
}

function moduleCoverage(read: ModuleDependencies, tree: CommitExtraction, changes: readonly FileChange[]): ModuleDependencies {
  read = moduleResources(read, tree.sources, changes);
  const accounted = new Set([...read.files.map(({ file }) => file), ...read.unread.map(({ file }) => file)]);
  const listed = new Set(tree.export.files.map(({ path }) => path));
  const missing = changes.filter(({ path }) => (isTypeScriptSource(path) || isJsonModuleResource(path)) && !accounted.has(path)
    && !(isJsonModuleResource(path) && tree.sources.some((source) => source.path === path))
    && (listed.has(path) || tree.export.stopped !== undefined || tree.export.skipped.some((entry) => entry.path === path || path.startsWith(`${entry.path}/`))));
  return missing.length === 0 ? read : { ...read, unread: [...read.unread, ...missing.map(({ path }) => ({ file: path, reason: "source-unreadable" as const }))] };
}

function unknownFact(base: FactBase, reason: "index-unavailable" | "source-unreadable"): Result<UnknownFact, never> {
  return { ok: true, value: { ...base, status: "unknown", reason } };
}


/** Which of `files` the graph cannot place, read from the head's own sources of those files only. */
async function unmodelledIn(deps: ImpactQueriesDeps, headTree: CommitExtraction, files: readonly string[]): Promise<readonly string[]> {
  if (deps.unmodelled === undefined) return [];
  const asked = new Set(files);
  return deps.unmodelled.extract(headTree.sources.filter(({ path }) => asked.has(path)));
}

interface WalkInput {
  store: CodeGraphReader;
  changes: readonly FileChange[];
  /** Symbols asked for by name; each seeds every seedable node of the file it names. */
  requested: readonly { file: string; symbol: string }[];
  componentsByResource: ReadonlyMap<string, readonly ComponentRef[]>;
  found: readonly Finding<Relation>[];
  /** The class fields whose declaration fixes what they hold. */
  fields: readonly FieldOrigin[];
  /** The locals a function or constant takes from `inject()`, and what they hold. */
  locals: readonly LocalOrigin[];
  memberUses: readonly MemberUseOrigin[] | undefined;
  /** Every dynamic load the reader found in the head's sources. */
  loads: readonly DynamicLoad[];
  headTree: CommitExtraction;
  /** The head's unresolved references, read once for the request. */
  unresolved: readonly GraphUnresolvedReference[];
  summary: Pick<IndexSummary, "filesNotIndexed">;
  budget: ImpactBudget;
  /** The changed or targeted files whose declarations the graph cannot place. */
  unmodelled: readonly string[];
  /** The two proofs the head's own imports make: what is outside the repository, and what a bare name binds to. */
  proofs?: ReferenceProofs;
  /** Where the names of the head's sources are rooted; without it every edge the graph resolved is followed. */
  origins?: ImportOrigins | undefined;
  /** The module statements that bind a name to the declaration an edge of it reaches. */
  modules?: EdgeTargetsDeps["modules"];
  signal?: AbortSignal | undefined;
}

interface ImpactRead {
  value: Pick<ImpactValue, "seeds" | "symbols" | "entrypoints" | "cost">;
  cuts: Cut[];
}


async function impactOf(input: WalkInput): Promise<ImpactRead> {
  const { store, changes, requested, componentsByResource, found, fields, locals, memberUses, loads, headTree, summary, unresolved } = input;
  const selection = selectRoots(store, changes, requested, componentsByResource);

  const { seeds } = selection;
  const build = (corrections: EdgeCorrections): InboundEdges => inboundEdgesOf(store, { relations: found, fields, locals, memberUses }, input.proofs, corrections);
  const { inbound, walk } = await walkInside(seeds.map(({ symbol }) => symbol), build, input.budget, input.origins === undefined ? undefined : createEdgeTargets({ origins: input.origins, store, modules: input.modules }), input.signal);

  const walked = walk.reached.map(({ symbol }) => symbol);
  const reachedIds = new Set(walked.map((symbol) => symbol.id));
  /** Both proofs of a known target: an admitted joined settlement and an import that names something outside. */
  const knownPlaces = new Set(input.proofs?.external ?? []);
  const unread = found.flatMap((finding): UnreadRelation[] => (finding.status === "unknown" ? finding.evidence.slice(0, 1).map(({ path, line }) => ({ path, line, reason: finding.reason })) : []));

  const cuts: Cut[] = [
    ...walk.cuts,
    ...unresolvedLinkCuts(unresolved, walked, loads, inbound.settledUses(walk.expanded, reachedIds), knownPlaces, input.proofs?.bound, inbound.memberProofs(walk.expanded)),
    ...removedDeclarationCuts(unresolved, selection.removed, knownPlaces, input.proofs?.bound, input.proofs?.localParameters),
    ...unreadRelationCuts(unread, new Set(walked.map((symbol) => symbol.file)), templateOwners(componentsByResource)),
    ...summary.filesNotIndexed.map((file): Cut => ({ kind: "no-extractor", at: [file] })),
    ...selection.withoutSymbols.map((file): Cut => ({ kind: "no-extractor", at: [file] })),
    ...input.unmodelled.map((file): Cut => ({ kind: "no-extractor", at: [file] })),
  ];
  const value = {
    cost: walk.cost,
    seeds: seeds.map(({ symbol, basis }): Seed => ({ file: symbol.file, symbol: symbol.name, line: symbol.startLine, ...declarationSpan(symbol.startLine, symbol.endLine), basis })),
    symbols: walk.reached.map(({ symbol, depth, confidence, fanIn, via }): ImpactedSymbol => ({
      file: symbol.file,
      symbol: symbol.name,
      kind: symbol.kind,
      line: symbol.startLine,
      ...declarationSpan(symbol.startLine, symbol.endLine),
      depth,
      confidence,
      fanIn,
      ...(via === undefined
        ? {}
        : {
            via: {
              file: via.symbol.file,
              symbol: via.symbol.name,
              ...(via.resource === undefined ? {} : { resource: via.resource }),
              ...(via.lines.length === 0 ? {} : { lines: via.lines }),
              basis: via.basis,
              ...(via.substitutes === undefined ? {} : { substitutes: via.substitutes.map(({ class: { path, symbol, line }, at }) => ({ file: path, symbol, line, at: { file: at.path, line: at.line } })) }),
            },
          }),
    })),
    entrypoints: reachedEntrypoints(
      headTree.findings,
      walk.reached.map(({ symbol, depth, confidence, seeds: reaching }) => ({ file: symbol.file, name: symbol.name, startLine: symbol.startLine, endLine: symbol.endLine, depth, confidence, seeds: reaching })),
    ),
  };
  return { value, cuts };
}

/**
 * Walks from the seeds with the edges as `EdgeTargets` judges them: the edges each walk read, and the edges an import
 * proves reach a symbol it reached. When a verdict changes what a symbol depends on, the walk runs again, because a bound
 * it frees, or an edge it moves, can read edges no earlier walk read.
 */
async function walkInside(seeds: readonly GraphSymbol[], build: (corrections: EdgeCorrections) => InboundEdges, budget: ImpactBudget, targets?: EdgeTargets, signal?: AbortSignal): Promise<{ inbound: InboundEdges; walk: Walk }> {
  const dropped = new Set<string>();
  const into = new Map<GraphNodeId, Map<string, FollowedEdge>>();
  const checked = new Set<string>();
  const probed = new Set<GraphNodeId>();
  const moveTo = (to: GraphSymbol, followed: FollowedEdge): boolean => {
    const held = into.get(to.id) ?? new Map<string, FollowedEdge>();
    into.set(to.id, held);
    if (held.has(edgeKey(followed.edge))) return false;
    held.set(edgeKey(followed.edge), { ...followed, target: to });
    return true;
  };
  for (;;) {
    const inbound = build({ dropped, into: new Map([...into].map(([id, edges]) => [id, [...edges.values()]])) });
    const walk = walkImpact(seeds, inbound, budget);
    if (targets === undefined || signal?.aborted) return { inbound, walk };
    const fresh = inbound.followed().filter(({ edge }) => !checked.has(edgeKey(edge)));
    const reached = [...seeds, ...walk.reached.map(({ symbol }) => symbol)].filter((symbol) => !probed.has(symbol.id));
    if (fresh.length === 0 && reached.length === 0) return { inbound, walk };
    for (const { edge } of fresh) checked.add(edgeKey(edge));
    for (const symbol of reached) probed.add(symbol.id);
    let changed = false;
    const verdicts = await targets.verdictsOf(fresh, signal);
    for (const [index, followed] of fresh.entries()) {
      const verdict = verdicts[index]!;
      if (verdict.kind === "keep") continue;
      dropped.add(edgeKey(followed.edge));
      changed = true;
      if (verdict.kind === "redirect") moveTo(verdict.to, followed);
    }
    for (const symbol of reached) {
      for (const followed of await targets.redirectedInto(symbol, signal)) {
        dropped.add(edgeKey(followed.edge));
        if (moveTo(symbol, followed)) changed = true;
      }
    }
    if (!changed) return { inbound, walk };
  }
}

function templateOwners(componentsByResource: ReadonlyMap<string, readonly ComponentRef[]>): Map<string, string[]> {
  return new Map([...componentsByResource].map(([resource, components]) => [resource, components.map((component) => component.file)]));
}

function entrypointsOf(findings: readonly Finding<Entrypoint>[]): Entrypoint[] {
  return findings.flatMap((finding) => (finding.status === "complete" ? [finding.value] : []));
}
