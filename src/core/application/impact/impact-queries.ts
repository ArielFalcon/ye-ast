import { indexedDeclaration, type ModelDeclaration } from "../navigation/declaration-model.ts";
import type { FrameworkPlugin } from "../../ports/framework-plugin.port.ts";
import { compareText } from "../../domain/shared/code-node.ts";
import { unknownTargetKey } from "../../ports/impact-queries.port.ts";
import type { SourceTokens } from "../../ports/source-tokens.port.ts";
import type { DeclarationEvidenceReader } from "../../ports/declaration-evidence.port.ts";
import { blastRadius, type BlastRadius } from "../../domain/change/blast-radius.ts";
import { isReadableFile, kindOfChangedFile } from "../../domain/change/changed-file.ts";
import { selectChange } from "../../domain/change/change-selection.ts";
import { resourceImpact, resourceOwners } from "../../domain/change/resource-impact.ts";
import type { FileChange, Hunk, LineRange } from "../../domain/change/diff-reader.ts";
import { settledOf } from "../../domain/change/hunk-settling.ts";
import type { TokenReading } from "../../domain/change/source-tokens.ts";
import { triviaLinesOf } from "../../domain/change/token-lines.ts";
import type { SettledHunkChange } from "../../domain/impact/impact-fact.ts";
import { isSeedable, type ComponentRef, type SelectedSeed } from "../../domain/change/seeds.ts";
import { changedContracts, servedContracts } from "../../domain/impact/changed-contracts.ts";
import { EDGE_POLICY } from "../../domain/impact/edge-policy.ts";
import { changedEntrypoints } from "../../domain/impact/changed-entrypoints.ts";
import { attributedCallCuts, contradictedCallCuts, fileCut, isJavaTypeKind, removedDeclarationCuts, unheldCut, unreadRelationCuts, unreadTypeReferenceCut, unresolvedLinkCuts, unresolvedSpecifierCuts, type UnreadRelation, type UnresolvedUse } from "../../domain/impact/impact-cuts.ts";
import { sortedUnique, type ImportersValue } from "../../domain/impact/importers-fact.ts";
import { impactFact, impactWalk, type ImpactBudget, type ImpactedSymbol, type ImpactValue, type Seed } from "../../domain/impact/impact-fact.ts";
import { reachedEntrypoints } from "../../domain/impact/reached-entrypoints.ts";
import type { Relation } from "../../domain/relations/relation.ts";
import type { ExternalMemberUseOrigin, MemberUseOrigin } from "../../domain/relations/member-use.ts";
import { isExtractorConfiguration } from "../../domain/languages/configuration.ts";
import { isAngularTemplate, isJsonModuleResource, isTypeCheckerInput, isTypeScriptFile, isTypeScriptSource } from "../../domain/languages/typescript.ts";
import { isJavaSource } from "../../domain/languages/java.ts";
import { moduleImpact, moduleResources } from "../../domain/impact/module-impact.ts";
import type { ModuleDependencies } from "../../domain/impact/module-dependency.ts";
import type { ModuleDependenciesReader } from "../../ports/module-dependencies.port.ts";
import { cutsCompleteness } from "../../domain/languages/uncovered.ts";
import type { Entrypoint } from "../../domain/entrypoints/entrypoint.ts";
import { declarationSpan, sortedEngines, type Cut, type DeclaredConfig, type Evidence, type Fact, type FactBase, type Finding, type IndexOrigin, type SnapshotRef, type TrustMode, type UnknownFact } from "../../domain/shared/fact.ts";
import { canonicalJson } from "../../domain/shared/canonical-json.ts";
import { WORKSPACE_SCOPE, exportSelection, pathSelection, sortedGlobs, type PathSelection } from "../../domain/shared/scope.ts";
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
import { ABORTED, factBaseOf, trustOf, withScratch, type CommitExtraction, type PreparedCommit } from "../snapshot/read-snapshot.ts";
import { createHeadReader, preparedLive, withLiveCapture, type FactSpec, type HeadIndex, type HeadReaderDeps, type HeadReading, type Revisioned } from "../snapshot/head-reading.ts";
import { readImporters, type BoundInto } from "./importers.ts";
import { inboundEdgesOf } from "./inbound-origins.ts";
import type { OriginCalls } from "../navigation/origin-calls.ts";
import type { EdgeCorrections, InboundEdges } from "./inbound-edges.ts";
import { typedReferencesOf, type ReferenceProofs } from "../navigation/reference-origins.ts";
import { unresolvedReferencesIn } from "../navigation/declaration-uses.ts";
import { walkImpact, type Walk } from "./walk.ts";
import type { ImportOriginsReader } from "../../ports/import-origins.port.ts";
import type { DeclaredMemberNamesReader } from "../../ports/declared-member-names.port.ts";
import type { ReceiverSettlement } from "../../domain/impact/edge-policy.ts";
import { edgeKey, type EdgeTargets, type FollowedEdge } from "../navigation/edge-targets.ts";
import type { AttributedCall, ReverseCalls } from "../navigation/reverse-calls.ts";
import { compactSpelling } from "../../domain/shared/call-place.ts";
import type { ContractRoutes } from "../../ports/contract-routes.port.ts";
import { syntaxRootCuts, distinctTargets, evidenceOfTarget, missingTargets, rangeChanges, requestedRanges, selectRoots, settledRangeChanges, targetKey } from "../navigation/root-selection.ts";
import { absentFileEntries, heldPaths, snapshotFiles } from "../navigation/snapshot-files.ts";
import { scopeNotice } from "../snapshot/scope-selection.ts";
import { prepareCommit } from "../snapshot/prepared-snapshot.ts";
import type { UnmodelledConstructsReader } from "../../ports/unmodelled-constructs.port.ts";
import { unmodelledNote } from "../../domain/shared/unmodelled.ts";
import { buildOutputCuts, type DeclaredBuildOutput } from "../../domain/shared/build-outputs.ts";
import type { TypeBindings, TypeTarget } from "../../ports/type-bindings.port.ts";
import type { AbsentCapability } from "../../ports/language-pack.port.ts";
import { createRevisionSources } from "../snapshot/revision-sources.ts";
import { createBaseReadings, withOutputs, type BaseReading, type ContradictedCall, type ContradictedCalls, type ReadingRequest } from "../snapshot/base-reading.ts";

export interface ImpactQueriesDeps extends HeadReaderDeps {
  frameworks?: readonly FrameworkPlugin[];
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
  /**
   * Reads what a source's syntax states, so a graph edge the index matched on a value receiver is settled by what the
   * sources bind the receiver to (ADR-0036); without it every kept edge counts as the index resolved it.
   */
  memberNames?: DeclaredMemberNamesReader;
  /** Tells the trivia lines of a requested range apart; without it every line of a range is code. */
  tokens?: SourceTokens;
  moduleDependencies?: ModuleDependenciesReader;
  /**
   * The reader of every language's module statements, whose bindings prove the declaration a graph edge's root reaches
   * (`edge-targets.ts`); without it `moduleDependencies` alone proves it.
   */
  moduleReader?: ModuleDependenciesReader;
  declarationEvidence?: DeclarationEvidenceReader;
  /** The changed or targeted files whose declarations the graph cannot place; without it no such file is cut. */
  unmodelled?: UnmodelledConstructsReader;
  /**
   * The type checker over the build outputs a host declared (ADR-0037); without it, or with none declared, every answer
   * is the one ye-ast gave before.
   */
  typeBindings?: TypeBindings;
  /** The build outputs a host declared for the repository at a root, for a request that declares none itself. */
  declaredOutputs?: (repo: string) => readonly DeclaredBuildOutput[] | undefined;
  /** The stages each language pack declares it cannot implement, by path (ADR-0045 decision 12). */
  absentCapabilities?: (path: string) => ReadonlySet<AbsentCapability>;
}

type Answer = Result<Fact<ImpactValue>, OfChangeFault>;


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
  /** Every path of the snapshot, written or not, skipped entries included; none once a budget stopped the export. */
  const listingOf = ({ export: listed }: Pick<CommitExtraction, "export">): readonly string[] | undefined => heldPaths(listed);
  /**
   * The module statements of a tree. With `across`, the other snapshot of a change, a specifier names no file only when no
   * path of either snapshot could be its target: one the change deleted or added is still a module the walk reaches.
   */
  const moduleDependenciesOf = (reader: ModuleDependenciesReader, prepared: PreparedCommit | undefined, tree: Pick<CommitExtraction, "export" | "sources">, signal: AbortSignal | undefined, across?: Pick<CommitExtraction, "export">) => {
    const own = listingOf(tree);
    const other = across === undefined ? [] : listingOf(across);
    const held = new Set(own);
    const alsoListed = other?.filter((path) => !held.has(path)).toSorted(compareText);
    const listing = own === undefined || alsoListed === undefined ? undefined : [...own, ...alsoListed];
    const slot = canonicalJson(alsoListed === undefined || alsoListed.length === 0 ? { output: "module-dependencies" } : { output: "module-dependencies", alsoListed });
    return retainedOf(prepared, slot, () => reader.extract(tree.sources, listing === undefined ? undefined : { listing }), signal);
  };
  const headReader = createHeadReader(deps);
  const bindingModules = deps.moduleReader ?? deps.moduleDependencies;
  const moduleSource = deps.moduleDependencies === undefined ? isInMapScope : isWritten;
  const changeDeps = { ...deps, sourceSelection: moduleSource };
  const changeReader = createHeadReader(changeDeps);
  const importerSource = (file: string): boolean => moduleSource(file) || isTypeScriptFile(file) || isJavaSource(file);
  const importerReader = createHeadReader({ ...deps, sourceSelection: importerSource });
  const readings = createBaseReadings({ ...deps, modules: bindingModules, checkerInputs: deps.typeBindings === undefined ? undefined : createRevisionSources({ ...deps, sourceSelection: isTypeCheckerInput }) });
  const readingOf = (head: HeadReading<Pick<CommitExtraction, "export" | "sources">>, index: HeadIndex, snapshot: SnapshotRef, request: ReadingRequest): BaseReading =>
    readings.of({ tree: head.tree, prepared: head.prepared, hold: head.hold, store: index.store, digest: index.digest, snapshot, request });

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
        const listing = heldPaths(headTree.export) ?? headTree.export.files.map(({ path }) => path);
        const listed = new Set(listing);
        const fixed = [
          ...exportCuts(headTree.export),
          ...changes.filter((file) => kindOfChangedFile(file.path) !== "source" && !componentsByResource.has(file.path)).map((file) => fileCut("no-extractor", file.path, "not-source")),
        ];
        const value: ImpactValue = { seeds: [], symbols: [], entrypoints: [], cost: { expansionsUsed: 0 } };

        const needsGraph = requested.length > 0 || targets.some(({ file }) => !listed.has(file)) || changes.some((file) => kindOfChangedFile(file.path) === "source" || componentsByResource.has(file.path));
        if (!needsGraph) return { ok: true, value: impactFact(head.base(content), value, fixed, impactWalk(targets.map(({ file }) => file), value)) };

        const index = await head.open();
        if (index === "aborted") return ABORTED;
        if (index === "unavailable") return { ok: true, value: { ...head.base(content), status: "unknown", reason: "index-unavailable" } };
        if ("fault" in index) return { ok: false, fault: index.fault };
        const { store, summary } = index;
        try {
          const snapshot = snapshotFiles(store, listing);
          const reading = readingOf(head, index, head.base(content).snapshot, request);
          const unknown = await missingTargets(reading.declarations, requested, isSeedable);
          const ranges = await requestedRanges(changes, headTree.sources, { tokensOf: (file) => readings.tokensOf(file, head.prepared) }, snapshot, reading.declarations);
          if (signal?.aborted) return ABORTED;
          const missing = snapshot.describe([...unknown, ...ranges.uncovered]);
          if (missing.length > 0) {
            const names = missing.map(unknownTargetKey).join(", ");
            const unmodelled = await unmodelledIn(deps, headTree, unknown.map(({ file }) => file));
            return { ok: false, fault: { kind: "unknown-symbol", detail: `no symbol at the revision for ${names}${unmodelledNote(unknown, unmodelled)}`, entries: missing } };
          }
          const { relations: found, fields, locals, memberUses, externalUses, cuts: relationCuts = [], unresolved: unresolvedRelations = [] } = await reading.relations();
          if (signal?.aborted) return ABORTED;
          const loads = await deps.dynamicLoads.extract(headTree.sources);
          if (signal?.aborted) return ABORTED;
          const unresolved = reading.unresolved();
          const proofs = await reading.referenceProofs();
          if (signal?.aborted) return ABORTED;
          const unmodelled = await unmodelledIn(deps, headTree, [...changes.map(({ path }) => path), ...requested.map(({ file }) => file)]);
          if (signal?.aborted) return ABORTED;
          const typed = await reading.typed();
          if (typed === "aborted") return ABORTED;
          const read = await impactOf({ store, changes: ranges.changes, requested, componentsByResource, found, relationCuts, unresolvedRelations, fields, locals, memberUses, externalUses, loads, headTree, summary, unresolved, budget: request.budget ?? {}, proofs, unmodelled, reading, typed: typed.typed, signal });
          if (signal?.aborted) return ABORTED;
          const settled = settledRangeChanges(ranges.settled);
          const value = settled.length === 0 ? read.value : { ...read.value, settled };
          return { ok: true, value: impactFact(withOutputs(head.base(content, true), typed.outputs), value, [...fixed, ...typed.inputsLeftOut, ...buildOutputCuts(typed.buildOutputs), ...read.cuts], impactWalk(targets.map(({ file }) => file), value)) };
        } finally {
          store.close();
        }
      });
    },

    async importers(request) {
      const files = sortedUnique(request.files);
      const spec: FactSpec = { declaredConfig: { files }, engines: importersEngines };

      return importerReader.atSources({ ...request, synthesized: true }, spec, async (head): Promise<Result<Fact<ImportersValue>, ImpactFault>> => {
        const headTree = head.tree;
        const content = contentFingerprint(headTree.export, importerSource);
        const outside = files.filter((file) => !head.selected(file));
        if (outside.length > 0) return { ok: true, value: { ...head.base(content), evidence: outside.map((path): Evidence => ({ path, line: 1 })), status: "unknown", reason: "out-of-scope" } };
        const listing = heldPaths(headTree.export);
        if (listing !== undefined) {
          const absent = absentFileEntries(files, listing);
          if (absent.length > 0) return { ok: false, fault: { kind: "unknown-symbol", detail: `no file at the revision for ${absent.map((entry) => entry.file).join(", ")}`, entries: absent } };
        }
        const fixed = [...exportCuts(headTree.export), ...headTree.export.files.filter((file) => importerSource(file.path) && (isReadableFile(file.path) || isJsonModuleResource(file.path)) && !file.written).map((file) => fileCut("not-exported", file.path, "unwritten")), ...files.filter((file) => !(isReadableFile(file) || (deps.moduleDependencies !== undefined && isJsonModuleResource(file)))).map((file) => fileCut("no-extractor", file, "language"))];
        const covered = files.filter((file) => isReadableFile(file) || (deps.moduleDependencies !== undefined && isJsonModuleResource(file)));
        if (covered.length === 0) return { ok: true, value: impactFact(head.base(content), { files: [] }, fixed, { kind: "dependents", files }) };

        const index = await head.open();
        if (index === "aborted") return ABORTED;
        if (index === "unavailable") return { ok: true, value: { ...head.base(content), status: "unknown", reason: "index-unavailable" } };
        if ("fault" in index) return { ok: false, fault: index.fault };
        const { store, summary } = index;
        try {
          const written = headTree.export.files.filter((file) => file.written && isReadableFile(file.path)).map((file) => file.path);
          const held = new Set(listing ?? headTree.export.files.map((file) => file.path));
          const references = unresolvedReferencesIn(store, written);
          const modules = deps.moduleDependencies === undefined ? undefined : await moduleDependenciesOf(deps.moduleDependencies, head.prepared, headTree, request.signal);
          if (request.signal?.aborted) return ABORTED;
          const reading = readingOf(head, index, head.base(content).snapshot, request);
          const typed = await reading.typed();
          if (typed === "aborted") return ABORTED;
          const targets = reading.edgeTargets(typed.typed);
          const read = await readImporters(store, covered, references, modules, targets, targets === undefined ? undefined : boundInto(reading, targets), request.signal);
          if (request.signal?.aborted) return ABORTED;
          const moduleOnly = new Set(modules?.files.filter((file) => file.moduleOnly).map((file) => file.file));
          const loadPlaces = await deps.dynamicLoads.extract(headTree.sources);
          if (request.signal?.aborted) return ABORTED;
          const cuts = [
            ...fixed,
            ...typed.inputsLeftOut,
            ...buildOutputCuts(typed.buildOutputs),
            ...unresolvedLinkCuts(
              references.filter((reference) => kindOfChangedFile(reference.file) !== "test"),
              [],
              loadPlaces,
            ),
            ...summary.filesNotIndexed.filter((file) => !moduleOnly.has(file)).map((file) => fileCut("no-extractor", file, "not-indexed")),
            ...read.unheld.map((file) => unheldCut(file, held)),
            ...(modules?.unread.map(({ file }) => fileCut("no-extractor", file, "module-unread")) ?? []),
            ...unresolvedSpecifierCuts(modules?.dependencies.filter((edge) => edge.target.kind === "unresolved") ?? []),
          ];
          return { ok: true, value: impactFact(withOutputs(head.base(content, true), typed.outputs), { files: read.files }, cuts, { kind: "dependents", files }) };
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

    return withScratch(deps, async (readScope): Promise<Answer> => {
      const preparedHead = await prepareCommit(changeDeps, repo, head.value, readScope, exported, { scope, trust }, signal);
      if (!preparedHead.ok) return preparedHead;
      const notice = scopeNotice(scope, deps.matcher.matches, request[WORKSPACE_SCOPE] ? undefined : heldPaths(preparedHead.value.tree.export)?.filter(selected));
      if (!notice.ok) return notice;
      const headTree = await preparedHead.value.extract(signal);
      if (!headTree.ok) return headTree;
      const preparedBase = mergeBase === head.value ? preparedHead : await prepareCommit(changeDeps, repo, mergeBase, readScope, exported, { scope, trust }, signal);
      if (!preparedBase.ok) return preparedBase;
      const baseTree = mergeBase === head.value ? headTree : await preparedBase.value.extract(signal);
      if (!baseTree.ok) return baseTree;
      const reading: HeadReading = {
        tree: headTree.value,
        prepared: preparedHead.value,
        hold: preparedHead.value.hold,
        selected,
        base: (content, store = false) => ({ ...(store ? changeReader.factBase(trust, snapshot, content, spec, scope, { kind: "full" }) : baseOfHead(content)), ...(notice.value === undefined ? {} : { scopeSelection: notice.value }) }),
        open: () => changeReader.indexHead(preparedHead.value, readScope.directory, signal),
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
      return withScratch(deps, async (readScope): Promise<Answer> => {
        const notice = scopeNotice(scope, deps.matcher.matches, request[WORKSPACE_SCOPE] ? undefined : heldPaths(tree.export)?.filter(selected));
        if (!notice.ok) return notice;
        const liveTree = await held.extract(signal);
        if (!liveTree.ok) return liveTree;
        const preparedBase = await prepareCommit(changeDeps, repo, mergeBase, readScope, exported, { scope: declaredScope(request.scope), trust: "trusted" }, signal);
        if (!preparedBase.ok) return preparedBase;
        const baseTree = await preparedBase.value.extract(signal);
        if (!baseTree.ok) return baseTree;
        const liveReading = headReader.liveReading(tree, liveTree.value, "trusted", scope, selected, head, repoId, spec);
        const reading = { ...liveReading, base: (content: string, store?: boolean) => ({ ...liveReading.base(content, store), ...(notice.value === undefined ? {} : { scopeSelection: notice.value }) }), prepared: preparedLive(held), hold: held.hold };

        const changed = changedPaths(baseTree.value.export.files, tree.export.files).filter((path) => !isEngineConfiguration(path));
        const [before, after] = [await readScope.directory(), await readScope.directory()];
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
        return readChange({ request, radius, head: reading, baseTree: baseTree.value, basePrepared: preparedBase.value, sameTree, unreadable });
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
    const { changes: settledChanges, settled } = await settledHunks(readings, changes, headTree.sources, baseTree.sources, head.prepared, input.basePrepared);
    if (signal?.aborted) return ABORTED;
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
        .map((file) => fileCut("no-extractor", file.path, cutsCompleteness(file.path, declared) ? "language" : "template-uncovered")),
    ];
    const entrypointSelected = pathSelection({ include: request.changed ?? [], exclude: [] }, deps.matcher.matches);
    const entrypointChanges = changedEntrypoints(entrypointsOf(baseTree.findings), entrypointsOf(headTree.findings)).filter((change) => entrypointSelected(change.handler.path));
    const changedPaths = new Set(radius.files.map((file) => file.path));
    const contracts = changedContracts(deps.contracts.operations(baseTree.sources), deps.contracts.operations(headTree.sources), (path) => changedPaths.has(path) && entrypointSelected(path));
    fixed.push(...contracts.cuts);
    const value: ImpactValue = { mergeBase: radius.mergeBase, seeds: [], changedEntrypoints: entrypointChanges, ...(contracts.changes.length === 0 ? {} : { changedContracts: servedContracts(contracts.changes, baseTree.findings, headTree.findings) }), ...(settled.length === 0 ? {} : { settled }), symbols: [], entrypoints: [], cost: { expansionsUsed: 0 } };

    let moduleRead: ReturnType<typeof moduleImpact> | undefined;
    const moduleReader = deps.moduleDependencies;
    if (moduleReader !== undefined && changes.some((file) => isTypeScriptSource(file.path) || isJsonModuleResource(file.path))) {
      const readSnapshot = async (tree: CommitExtraction, prepared: PreparedCommit | undefined, selectedChanges: readonly FileChange[], across: CommitExtraction): Promise<ModuleDependencies | undefined> => {
        const read = moduleCoverage(await moduleDependenciesOf(moduleReader, prepared, tree, signal, across), tree, selectedChanges);
        if (signal?.aborted) return undefined;
        if (read.untraversed !== undefined) return read;
        const loads = await deps.dynamicLoads.extract(tree.sources);
        if (signal?.aborted) return undefined;
        return { ...read, untraversed: loads.map(({ file, line }) => ({ file, line, offset: 0, form: "dynamic-import" as const })) };
      };
      const base = await readSnapshot(baseTree, input.basePrepared, changes, headTree);
      if (base === undefined) return ABORTED;
      const current = sameTree ? base : await readSnapshot(headTree, head.prepared, changes.filter((file) => !file.deleted), baseTree);
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
    if (!needsGraph) return { ok: true, value: impactFact(head.base(content), value, [...unaccounted(fixed), ...moduleCuts], impactWalk(changes.map(({ path }) => path), value)) };

    const index = await head.open();
    if (index === "aborted") return ABORTED;
    if (index === "unavailable") return unknownFact(head.base(content), "index-unavailable");
    if ("fault" in index) return { ok: false, fault: index.fault };
    const { store, summary } = index;
    try {
      const reading = readingOf(head, index, head.base(content).snapshot, request);
      const { relations: found, fields, locals, memberUses, externalUses, cuts: relationCuts = [], unresolved: unresolvedRelations = [] } = await reading.relations();
      if (signal?.aborted) return ABORTED;
      const loads = await deps.dynamicLoads.extract(headTree.sources);
      if (signal?.aborted) return ABORTED;
      const unresolved = reading.unresolved();
      const proofs = await reading.referenceProofs();
      if (request.signal?.aborted) return ABORTED;
      const baseSources = new Map(baseTree.sources.map((source) => [source.path, source.content]));
      const headSources = new Map(headTree.sources.map((source) => [source.path, source.content]));
      const byPath = Map.groupBy(settledChanges.filter((file) => file.removedNames.length > 0), (file) => file.path);
      const validated = new Map<string, ReadonlySet<string>>();
      for (const [path, files] of byPath) {
        if (deps.declarationEvidence === undefined || signal?.aborted || files.some((file) => file.deleted !== files[0]!.deleted)) continue;
        const names = [...new Set(files.flatMap((file) => file.removedNames))];
        validated.set(path, new Set(deps.declarationEvidence.validate({ path, base: baseSources.get(path), head: headSources.get(path), deleted: files[0]!.deleted, names })));
      }
      const validatedChanges = settledChanges.map((file) => {
        const retained = validated.get(file.path);
        return retained === undefined ? file : { ...file, removedNames: file.removedNames.filter((name) => retained.has(name)) };
      });
      const unmodelled = await unmodelledIn(deps, headTree, validatedChanges.filter((file) => !file.deleted).map(({ path }) => path));
      if (signal?.aborted) return ABORTED;
      const typed = await reading.typed();
      if (typed === "aborted") return ABORTED;
      const read = await impactOf({ store, changes: validatedChanges, requested: [], componentsByResource, found, relationCuts, unresolvedRelations, fields, locals, memberUses, externalUses, loads, headTree, summary, unresolved, budget: request.budget ?? {}, proofs, unmodelled, reading, typed: typed.typed, signal });
      if (signal?.aborted) return ABORTED;
      const reached = { ...value, ...read.value };
      return { ok: true, value: impactFact(withOutputs(head.base(content, true), typed.outputs), reached, [...unaccounted([...fixed, ...typed.inputsLeftOut, ...buildOutputCuts(typed.buildOutputs), ...read.cuts]), ...moduleCuts], impactWalk(changes.map(({ path }) => path), reached)) };
    } finally {
      store.close();
    }
  }
}

/** The hunks of the selected source files whose tokens did not change, and the change with each settled hunk removed (ADR-0043 decisions 1 and 5). */
async function settledHunks(
  readings: ReturnType<typeof createBaseReadings>,
  files: readonly FileChange[],
  headSources: readonly { path: string; content: string }[],
  baseSources: readonly { path: string; content: string }[],
  headPrepared: PreparedCommit | undefined,
  basePrepared: PreparedCommit | undefined,
): Promise<{ changes: FileChange[]; settled: SettledHunkChange[] }> {
  const baseByPath = new Map(baseSources.map((source) => [source.path, source]));
  const headByPath = new Map(headSources.map((source) => [source.path, source]));
  const settled: SettledHunkChange[] = [];
  const changes: FileChange[] = [];
  for (const file of files) {
    if (kindOfChangedFile(file.path) !== "source" || file.deleted || file.binary) {
      changes.push(file);
      continue;
    }
    const baseSource = baseByPath.get(file.path);
    const headSource = headByPath.get(file.path);
    if (baseSource === undefined || headSource === undefined) {
      changes.push(file);
      continue;
    }
    const base = await readings.tokensOf(baseSource, basePrepared);
    const head = await readings.tokensOf(headSource, headPrepared);
    if (head.status !== "read") {
      changes.push(file);
      continue;
    }
    const left = new Set<Hunk>();
    for (const hunk of file.hunks) {
      const outcome = settledOf(base, head, hunk);
      if (outcome.settled === undefined) continue;
      left.add(hunk);
      settled.push({
        basis: "hunk",
        file: file.path,
        ...(hunk.base === undefined ? {} : { base: hunk.base }),
        ...(hunk.head === undefined ? {} : { head: hunk.head }),
        reason: outcome.settled,
      });
    }
    changes.push(settleFile(file, left, head, headSource.content));
  }
  settled.sort((a, b) => compareText(a.file, b.file) || firstLine(a) - firstLine(b));
  return { changes, settled };
}

/**
 * `file` without the settled hunks and without the lines of an unsettled hunk that hold no token (ADR-0043 decisions 1
 * and 3); a hunk left with no such line seeds as a removal at its place, and the removal rule keeps the base side.
 */
function settleFile(file: FileChange, left: ReadonlySet<Hunk>, head: TokenReading, content: string): FileChange {
  const quiet = triviaLinesOf(head, content.split("\n").length);
  const removedNames = new Set([...left].flatMap((hunk) => hunk.removedNames));
  const added: LineRange[] = [];
  const removals: { after: number }[] = [];
  let removal = 0;
  for (const hunk of file.hunks) {
    const place = hunk.head === undefined ? file.removals[removal] : undefined;
    if (hunk.head === undefined) removal += 1;
    if (left.has(hunk)) continue;
    if (hunk.head === undefined) {
      if (place !== undefined) removals.push(place);
      continue;
    }
    const ranges = tokenLinesIn(hunk.head, quiet);
    if (ranges.length === 0) removals.push({ after: hunk.head.start - 1 });
    else added.push(...ranges);
  }
  return {
    ...file,
    added,
    removals,
    removedNames: removedNames.size === 0 ? file.removedNames : file.removedNames.filter((name) => !removedNames.has(name)),
  };
}

/** The runs of `range` whose lines hold a token. */
function tokenLinesIn(range: LineRange, quiet: ReadonlySet<number>): LineRange[] {
  const runs: LineRange[] = [];
  for (let line = range.start; line <= range.end; line += 1) {
    if (quiet.has(line)) continue;
    const last = runs.at(-1);
    if (last !== undefined && last.end === line - 1) last.end = line;
    else runs.push({ start: line, end: line });
  }
  return runs;
}

function firstLine(change: SettledHunkChange): number {
  return change.base?.start ?? change.head?.start ?? 0;
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
  relationCuts?: readonly Cut[];
  unresolvedRelations?: readonly UnresolvedUse[];
  /** The class fields whose declaration fixes what they hold. */
  fields: readonly FieldOrigin[];
  /** The locals a function or constant takes from `inject()`, and what they hold. */
  locals: readonly LocalOrigin[];
  memberUses: readonly MemberUseOrigin[] | undefined;
  externalUses: readonly ExternalMemberUseOrigin[] | undefined;
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
  /** The read's assembled stages: its edge targets and the calls the index does not record. */
  reading: BaseReading;
  /** What the type checker binds each call to, consulted first. */
  typed?: ReadonlyMap<string, TypeTarget> | undefined;
  signal?: AbortSignal | undefined;
}

interface ImpactRead {
  value: Pick<ImpactValue, "seeds" | "symbols" | "entrypoints" | "cost">;
  cuts: Cut[];
}


/**
 * The Java type targets among `seeds` whose language pack declares type references absent (RFC-0027 U0): each is one
 * cut at the declaration, so its dependents are never asserted complete while no stage reads them. A seed that only
 * holds a removed member starts the walk at that member's place and is no target: the removal is cut on its own.
 */
function unreadTypeReferenceCuts(seeds: readonly SelectedSeed<GraphSymbol>[], removalHolders: readonly GraphSymbol[], reading: BaseReading): Cut[] {
  const held = new Set(removalHolders);
  return seeds
    .filter(({ symbol }) => !held.has(symbol) && isJavaTypeKind(symbol.kind, symbol.file) && reading.absentCapabilitiesOf(symbol.file).has("relations"))
    .map(({ symbol }) => unreadTypeReferenceCut(symbol));
}

async function impactOf(input: WalkInput): Promise<ImpactRead> {
  const { store, changes, requested, componentsByResource, found, fields, locals, memberUses, externalUses, loads, headTree, summary, unresolved } = input;
  const selection = await selectRoots(input.reading.declarations, changes, requested, componentsByResource);

  const { seeds } = selection;
  const implemented = await input.reading.implementedContracts();
  const build = (corrections: EdgeCorrections): InboundEdges => inboundEdgesOf(store, { relations: found, fields, locals, memberUses }, input.proofs, { ...corrections, implemented });
  const targets = input.reading.edgeTargets(input.typed);
  const typedReferences = input.typed === undefined ? undefined : typedReferencesOf(store, unresolved, input.typed);
  const originCalls = targets === undefined ? undefined : input.reading.originCalls(targets);
  const contradictions = targets === undefined ? undefined : input.reading.contradictedCalls(targets);
  const reverse = targets === undefined ? undefined : input.reading.reverseCalls(targets);
  const syntax = reverse === undefined ? undefined : await reverse.intoDeclarations(selection.syntaxSeeds.map(({ symbol }) => symbol), input.signal);
  const syntaxCallers = new Map<string, import("./inbound-edges.ts").InboundEdge[]>();
  for (const call of syntax?.callers ?? []) {
    const found = syntaxCallers.get(call.declaration.id) ?? [];
    const prior = found.find((edge) => edge.from.id === call.from.id && edge.basis === (call.kind === "references" ? "reference" : "call"));
    if (prior === undefined) found.push({ from: call.from, confidence: 1, lines: [call.line], basis: call.kind === "references" ? "reference" : "call", derivation: "proven", hasCall: call.kind !== "references" });
    else prior.lines = [...new Set([...prior.lines, call.line])].sort((a, b) => a - b);
    syntaxCallers.set(call.declaration.id, found);
  }
  const syntaxWalk = { seeds: selection.syntaxSeeds.map(({ symbol }) => symbol), callers: syntaxCallers };
  const { inbound, walk, attributed, cuts: contradictedCuts } = await walkInside(seeds.map(({ symbol }) => symbol), build, input.budget, targets, input.signal, typedReferences?.edges, targets === undefined ? undefined : input.reading.reverseCalls(targets), originCalls, contradictions, syntaxWalk);

  const walked = walk.reached.flatMap(({ symbol }) => indexedDeclaration(symbol) ?? []);
  const reachedIds = new Set(walked.map((symbol) => symbol.id));
  /** Both proofs of a known target: an admitted joined settlement and an import that names something outside. */
  const knownPlaces = new Set([...(input.proofs?.external ?? []), ...(typedReferences?.settled ?? [])]);
  const unread = found.flatMap((finding): UnreadRelation[] => (finding.status === "unknown" ? finding.evidence.slice(0, 1).map(({ path, line }) => ({ path, line, reason: finding.reason })) : []));

  const cuts: Cut[] = [
    ...(syntax === undefined ? syntaxRootCuts(selection.syntaxSeeds) : syntax.cuts),
    ...walk.cuts,
    ...input.relationCuts ?? [],
    ...unreadTypeReferenceCuts(seeds, selection.removalHolders, input.reading),
    ...contradictedCuts,
    ...attributedCallCuts(attributed.map(({ node, call: { reference } }) => ({ declaration: node, place: { ...reference, name: compactSpelling(reference.name) } }))),
    ...unresolvedLinkCuts(unresolved, walked, loads, inbound.settledUses(walk.expanded, reachedIds), knownPlaces, input.proofs?.bound, inbound.memberProofs(walk.expanded)),
    ...unresolvedLinkCuts(input.unresolvedRelations ?? [], walked.filter((symbol) => walk.wholeDeclarations.has(symbol.id) && (EDGE_POLICY.typeReferences.to as readonly string[]).includes(symbol.kind)), []),
    ...removedDeclarationCuts(unresolved, selection.removed, knownPlaces, input.proofs?.bound, input.proofs?.localParameters),
    ...unreadRelationCuts(unread, new Set(walked.map((symbol) => symbol.file)), templateOwners(componentsByResource)),
    ...summary.filesNotIndexed.map((file) => fileCut("no-extractor", file, "not-indexed")),
    ...selection.withoutSymbols.map((file) => fileCut("no-extractor", file, "no-symbols")),
    ...input.unmodelled.map((file) => fileCut("no-extractor", file, "unmodelled")),
  ];
  const value = {
    cost: walk.cost,
    seeds: [...seeds, ...selection.syntaxSeeds].map(({ symbol, basis }): Seed => ({ file: symbol.file, symbol: symbol.name, line: symbol.startLine, ...declarationSpan(symbol.startLine, symbol.endLine), basis })),
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
              derivation: via.derivation,
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
 * Walks from the seeds with the edges as `EdgeTargets` judges them: the edges each walk read, the edges an import
 * proves reach a symbol it reached, the `typed` edges the checker made of unresolved calls, the member calls through a
 * field's or an `inject()` local's origin the base binds into a symbol it reached (`originCalls`), and the written calls the
 * index does not record that the base binds into a symbol it reached (`ReverseCalls`). When a verdict changes what a
 * symbol depends on, the walk runs again, because a bound it frees, or an edge it moves, can read edges no earlier walk
 * read. `attributed` holds the unbound written calls attributed to a symbol it reached.
 */
async function walkInside(seeds: readonly GraphSymbol[], build: (corrections: EdgeCorrections) => InboundEdges, budget: ImpactBudget, targets?: EdgeTargets, signal?: AbortSignal, typedEdges: readonly FollowedEdge[] = [], reverse?: ReverseCalls, originCalls?: OriginCalls, contradictions?: ContradictedCalls, syntax?: { seeds: readonly ModelDeclaration[]; callers: ReadonlyMap<string, readonly import("./inbound-edges.ts").InboundEdge[]> }): Promise<{ inbound: InboundEdges; walk: Walk; attributed: readonly AttributedCall[]; cuts: readonly Cut[] }> {
  const attributed: AttributedCall[] = [];
  const contradictedByEdge = new Map<string, ContradictedCall>();
  const contradicted: ContradictedCall[] = [];
  const cutKeys = new Set<string>();
  const dropped = new Set<string>();
  const settled = new Map<string, ReceiverSettlement>();
  const into = new Map<GraphNodeId, Map<string, FollowedEdge>>();
  const checked = new Set<string>();
  const probed = new Set<GraphNodeId>();
  /** The record an edge would be when the source of its place proves it writes no call (ADR-0041 U6). */
  const contradicts = (followed: FollowedEdge): ContradictedCall | undefined => contradictedByEdge.get(edgeKey(followed.edge));
  /** Drops a contradicted edge's cut once; the edge itself is rejected every time the walk asks for it. */
  const dropContradicted = (followed: FollowedEdge): boolean => {
    const call = contradicts(followed);
    if (call === undefined) return false;
    const key = edgeKey(followed.edge);
    dropped.add(key);
    if (cutKeys.has(key)) return false;
    cutKeys.add(key);
    contradicted.push(call);
    return true;
  };
  const readContradictions = async (edges: readonly FollowedEdge[]): Promise<void> => {
    if (contradictions === undefined || edges.length === 0) return;
    const sources = [...new Map(edges.map(({ source }) => [source.id, source])).values()];
    for (const [key, call] of await contradictions(sources)) contradictedByEdge.set(key, call);
  };
  const moveTo = (to: GraphSymbol, followed: FollowedEdge): boolean => {
    const held = into.get(to.id) ?? new Map<string, FollowedEdge>();
    into.set(to.id, held);
    if (held.has(edgeKey(followed.edge))) return false;
    held.set(edgeKey(followed.edge), { ...followed, target: to });
    return true;
  };
  for (const followed of typedEdges) {
    moveTo(followed.target, followed);
    settled.set(edgeKey(followed.edge), "typed");
  }
  const cuts = (): readonly Cut[] => contradictedCallCuts(contradicted);
  for (;;) {
    const inbound = build({ dropped, into: new Map([...into].map(([id, edges]) => [id, [...edges.values()]])), settled });
    const walk = walkImpact(seeds, inbound, budget, syntax);
    if (targets === undefined || signal?.aborted) return { inbound, walk, attributed, cuts: cuts() };
    const fresh = inbound.followed().filter(({ edge }) => !checked.has(edgeKey(edge)));
    const reached = [...seeds, ...walk.reached.flatMap(({ symbol }) => indexedDeclaration(symbol) ?? [])].filter((symbol) => !probed.has(symbol.id));
    if (fresh.length === 0 && reached.length === 0) return { inbound, walk, attributed, cuts: cuts() };
    for (const { edge } of fresh) checked.add(edgeKey(edge));
    for (const symbol of reached) probed.add(symbol.id);
    let changed = false;
    await readContradictions(fresh);
    const judged = fresh.filter((followed) => {
      if (contradicts(followed) === undefined) return true;
      changed = dropContradicted(followed) || changed;
      return false;
    });
    const verdicts = await targets.verdictsOf(judged, signal);
    for (const [index, followed] of judged.entries()) {
      const verdict = verdicts[index]!;
      if (verdict.kind === "keep") {
        if (verdict.derivation !== undefined) {
          settled.set(edgeKey(followed.edge), verdict.derivation);
          changed = true;
        }
        continue;
      }
      dropped.add(edgeKey(followed.edge));
      changed = true;
      if (verdict.kind === "redirect") {
        moveTo(verdict.to, followed);
        if (verdict.derivation !== undefined) settled.set(edgeKey(followed.edge), verdict.derivation);
      }
    }
    const moved = await targets.redirectedInto(reached, signal);
    await readContradictions(moved);
    const relocated = moved.filter((followed) => {
      if (contradicts(followed) === undefined) return true;
      changed = dropContradicted(followed) || changed;
      return false;
    });
    const movedVerdicts = await targets.verdictsOf(relocated, signal);
    for (const [index, followed] of relocated.entries()) {
      const verdict = movedVerdicts[index]!;
      dropped.add(edgeKey(followed.edge));
      if (verdict.kind === "redirect" && verdict.derivation !== undefined) settled.set(edgeKey(followed.edge), verdict.derivation);
      if (moveTo(followed.target, followed)) changed = true;
    }
    if (originCalls !== undefined && reached.length > 0) for (const followed of await originCalls.into(reached, signal)) if (moveTo(followed.target, followed)) changed = true;
    if (reverse !== undefined && reached.length > 0) {
      const recovered = await reverse.into(reached, signal);
      for (const followed of recovered.edges) if (moveTo(followed.target, followed)) changed = true;
      attributed.push(...recovered.attributed);
    }
    if (!changed) return { inbound, walk, attributed, cuts: cuts() };
  }
}

/**
 * What the base binds into declarations an importers answer asks about (ADR-0041 U5), the one level of `walkInside`: the
 * edges an import proves reach them, the member calls through a field's or an `inject()` local's origin, and the written
 * calls the index does not record, bound or attributed.
 */
function boundInto(reading: BaseReading, targets: EdgeTargets): BoundInto {
  const reverse = reading.reverseCalls(targets);
  const originCalls = reading.originCalls(targets);
  return async (nodes, signal) => {
    const redirected = await targets.redirectedInto(nodes, signal);
    const throughOrigins = (await originCalls?.into(nodes, signal)) ?? [];
    const recovered = (await reverse?.into(nodes, signal)) ?? { edges: [], attributed: [] };
    return { edges: [...redirected, ...throughOrigins, ...recovered.edges], attributed: recovered.attributed };
  };
}

function templateOwners(componentsByResource: ReadonlyMap<string, readonly ComponentRef[]>): Map<string, string[]> {
  return new Map([...componentsByResource].map(([resource, components]) => [resource, components.map((component) => component.file)]));
}

function entrypointsOf(findings: readonly Finding<Entrypoint>[]): Entrypoint[] {
  return findings.flatMap((finding) => (finding.status === "complete" ? [finding.value] : []));
}
