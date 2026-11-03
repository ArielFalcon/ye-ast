import { blastRadius, type BlastRadius } from "../../domain/change/blast-radius.ts";
import { kindOfChangedFile } from "../../domain/change/changed-file.ts";
import type { FileChange } from "../../domain/change/diff-reader.ts";
import { isSeedable, selectSeeds, type ComponentRef, type SelectedSeed } from "../../domain/change/seeds.ts";
import { changedEntrypoints } from "../../domain/impact/changed-entrypoints.ts";
import { removedDeclarationCuts, unreadRelationCuts, unresolvedLinkCuts, type UnreadRelation } from "../../domain/impact/impact-cuts.ts";
import { sortedUnique, type ImportersValue } from "../../domain/impact/importers-fact.ts";
import { impactFact, type ImpactBudget, type ImpactedSymbol, type ImpactValue, type Seed } from "../../domain/impact/impact-fact.ts";
import { reachedEntrypoints } from "../../domain/impact/reached-entrypoints.ts";
import type { Relation } from "../../domain/relations/relation.ts";
import { isExtractorConfiguration } from "../../domain/languages/configuration.ts";
import { isAngularTemplate } from "../../domain/languages/typescript.ts";
import { cutsCompleteness } from "../../domain/languages/uncovered.ts";
import { comparePosition, compareText, joinsFact } from "../../domain/shared/code-node.ts";
import type { Entrypoint } from "../../domain/entrypoints/entrypoint.ts";
import { declarationSpan, sortedEngines, type Cut, type DeclaredConfig, type DeclaredScope, type Evidence, type Fact, type FactBase, type Finding, type IndexOrigin, type SnapshotRef, type TrustMode, type UnknownFact } from "../../domain/shared/fact.ts";
import { exportSelection, pathSelection, type PathSelection, type ScopeRequest } from "../../domain/shared/scope.ts";
import { changedPaths, liveScope } from "../../domain/snapshot/live-export.ts";
import { contentFingerprint, declaredScope, exportCuts, holdsDeclaredSource } from "../../domain/map/entrypoint-map.ts";
import type { Result } from "../../domain/shared/result.ts";
import type { AngularDeclaration, AngularDeclarationReader } from "../../ports/angular-declarations.port.ts";
import type { CodeGraph, CodeGraphReader, GraphSymbol, IndexSummary } from "../../ports/code-graph.port.ts";
import type { DynamicLoad, DynamicLoadReader } from "../../ports/dynamic-loads.port.ts";
import type { Digest } from "../../ports/digest.port.ts";
import type { IndexCache } from "../../ports/index-cache.port.ts";
import type { CallersTarget, ImpactFault, ImpactOfChangeRequest, ImpactQueries, OfChangeFault, UnknownSymbolFault } from "../../ports/impact-queries.port.ts";
import type { AtRevision, LiveSelector } from "../../ports/live-queries.port.ts";
import type { PathMatcher } from "../../ports/path-matcher.port.ts";
import { isEngineConfiguration } from "../../ports/staging-rules.ts";
import type { FieldOrigin } from "../../domain/relations/field-origin.ts";
import type { RelationExtractor } from "../relations/relation-extractor.ts";
import type { CommitExport, Vcs, VcsChanges, VcsFault } from "../../ports/vcs.port.ts";
import { openLive, type LiveDeps, type LiveTree } from "../live/live-tree.ts";
import { ABORTED, extractCommit, extractExport, factBaseOf, LIVE_REQUIRES_TRUSTED, trustOf, withScratch, type CommitExtraction, type SnapshotReaderDeps } from "../snapshot/read-snapshot.ts";
import { readImporters } from "./importers.ts";
import { createInboundEdges } from "./inbound-edges.ts";
import { walkImpact } from "./walk.ts";

export interface ImpactQueriesDeps extends SnapshotReaderDeps {
  /** The walk reads the change between two revisions, which no other family asks for. */
  vcs: Vcs & VcsChanges;
  angular: AngularDeclarationReader;
  relations: RelationExtractor;
  /** Reads the dynamic loads of the head's sources, so a load whose specifier is a literal names its module. */
  dynamicLoads: DynamicLoadReader;
  graph: CodeGraph;
  /** Keeps full indexes by content; without it every call builds its own and discards it. */
  indexes?: IndexCache;
  matcher: PathMatcher;
  /** Version of each engine every operation runs on, by package name. */
  engines: Readonly<Record<string, string>>;
  /** Version of each engine only the operations that read Angular declarations and templates add. */
  angularEngines: Readonly<Record<string, string>>;
  /** What a live query reads; without it a live query is refused as under `untrusted`. */
  live?: LiveDeps;
}

/** A live query reads the working tree against the commit HEAD names. */
const LIVE_HEAD = "HEAD";

type Answer = Result<Fact<ImpactValue>, OfChangeFault>;

/** What one operation adds to the fact base of every fact it answers. */
interface FactSpec {
  declaredConfig: DeclaredConfig;
  engines: Readonly<Record<string, string>>;
}

/** The head of a query as the operation reads it: a commit's export or the mirror, with the means to index it. */
interface HeadReading {
  tree: CommitExtraction;
  selected: PathSelection;
  /** The fact base for `content`; `store` is true for a fact that read the index, which records where it came from. */
  base(content: string, store?: boolean): FactBase;
  /** The head's index; the caller closes its store. */
  open(): Promise<HeadIndex | "aborted" | "unavailable">;
}

type Revisioned = { repo: string; repoId: string; scope?: ScopeRequest; signal?: AbortSignal } & ({ revision: string; live?: undefined } | ({ revision?: undefined } & LiveSelector));

export function createImpactQueries(deps: ImpactQueriesDeps): ImpactQueries {
  const { vcs, digest } = deps;
  const importersEngines = sortedEngines(deps.engines);
  const angularReadingEngines = sortedEngines({ ...deps.engines, ...deps.angularEngines });
  const exportBudget: Pick<DeclaredConfig, "exportBudget"> = deps.budget === undefined ? {} : { exportBudget: { maxEntries: deps.budget.maxEntries, maxBytes: deps.budget.maxBytes } };
  const walkBounds = (budget: ImpactBudget | undefined): Pick<DeclaredConfig, "walk"> => (budget === undefined ? {} : { walk: { ...budget } });

  /** The head's index: the kept one for its staged content when there is a cache, otherwise one built into a store of its own. The caller closes the store. */
  async function indexHead(headTree: CommitExtraction, headDirectory: string, directory: () => Promise<string>, signal: AbortSignal | undefined): Promise<HeadIndex | "aborted" | "unavailable"> {
    if (deps.indexes !== undefined) {
      const kept = await deps.indexes.obtain({ content: digest.of(contentFingerprint(headTree.export)), snapshot: headDirectory, signal });
      if (kept.ok) return { store: kept.value.store, summary: notHeldInExport(kept.value.summary.filesNotIndexed, headTree.export) };
      if (kept.fault.kind === "aborted") return "aborted";
      if (kept.fault.kind !== "cache-unavailable") return "unavailable";
    }
    const storeDirectory = await directory();
    const indexed = await deps.graph.index(headDirectory, storeDirectory, signal);
    if (!indexed.ok) return indexed.fault.kind === "aborted" ? "aborted" : "unavailable";
    const opened = deps.graph.open(storeDirectory);
    return opened.ok ? { store: opened.value, summary: notHeldInExport(indexed.value.filesNotIndexed, headTree.export) } : "unavailable";
  }

  /** The fact base of a snapshot: a commit's carries the host's export budget, the live tree reads none. */
  function factBase(trust: TrustMode, snapshot: SnapshotRef, content: string, spec: FactSpec, scope: DeclaredScope, origin: IndexOrigin | undefined): FactBase {
    const sha = snapshot.kind === "sha" ? snapshot.sha : snapshot.kind === "live" ? snapshot.head : "";
    const declaredConfig: DeclaredConfig = { ...(snapshot.kind === "sha" ? exportBudget : {}), ...spec.declaredConfig };
    return { ...factBaseOf(deps, { repoId: snapshot.repo, sha, trust, scope, content, declaredConfig, engines: spec.engines, ...(origin === undefined ? {} : { origin }) }), snapshot };
  }

  /** The head of a live query: the mirror under the lock, its store opened where the engine left it. */
  function liveReading(tree: LiveTree, extraction: CommitExtraction, trust: TrustMode, scope: DeclaredScope, selected: PathSelection, head: string, repoId: string, spec: FactSpec): HeadReading {
    const snapshot: SnapshotRef = { repo: repoId, kind: "live", head, stateId: tree.stateId };
    return {
      tree: extraction,
      selected,
      base: (content, store = false) => factBase(trust, snapshot, content, spec, scope, store ? tree.origin : undefined),
      open: async () => {
        const opened = deps.graph.open(tree.root);
        return opened.ok ? { store: opened.value, summary: notHeldInExport(tree.notHeld, extraction.export) } : "unavailable";
      },
    };
  }

  /** What a live query answers when the refresh did not finish: `unknown`, with a state id of nothing read. */
  function unavailableLive(trust: TrustMode, scope: DeclaredScope, head: string, repoId: string, spec: FactSpec): UnknownFact {
    const unread = digest.of(JSON.stringify([head]));
    return { ...factBase(trust, { repo: repoId, kind: "live", head, stateId: unread }, unread, spec, scope, undefined), status: "unknown", reason: "index-unavailable" };
  }

  /** The one place a revisioned operation reads its head, at a commit or on the live tree, so its body is written once. */
  async function atHead<V, E>(request: Revisioned, spec: FactSpec, read: (head: HeadReading) => Promise<Result<Fact<V>, E>>): Promise<Result<Fact<V>, E | OfChangeFault>> {
    const { repo, repoId, signal } = request;
    if (request.live === true) {
      const trust = await trustOf(deps, repo);
      if (trust !== "trusted" || deps.live === undefined) return LIVE_REQUIRES_TRUSTED;
      const head = await vcs.resolveCommit(repo, LIVE_HEAD, signal);
      if (!head.ok) return head;
      const scope = liveScope(request.scope);
      const selected = pathSelection(scope, deps.matcher.matches);
      const exported = exportSelection(scope, deps.matcher.matches, isExtractorConfiguration);
      const opened = await openLive(deps.live, { repo, scope, selected: exported, store: true, signal, onStale: request.onStale }, async (tree) => {
        const extracted = await extractExport(deps, tree.root, tree.export, signal);
        return extracted.ok ? read(liveReading(tree, extracted.value, trust, scope, selected, head.value, repoId, spec)) : extracted;
      });
      if (opened.ok) return opened.value;
      const { fault } = opened;
      return fault.kind === "unavailable" ? { ok: true, value: unavailableLive(trust, scope, head.value, repoId, spec) } : { ok: false, fault };
    }

    const scope = declaredScope(request.scope);
    const selected = pathSelection(scope, deps.matcher.matches);
    const exported = exportSelection(scope, deps.matcher.matches, isExtractorConfiguration);
    const head = await vcs.resolveCommit(repo, request.revision, signal);
    if (!head.ok) return head;
    const trust = await trustOf(deps, repo);
    const snapshot: SnapshotRef = { repo: repoId, kind: "sha", sha: head.value };
    return withScratch(deps.scratch, async (directory) => {
      const headDirectory = await directory();
      const headTree = await extractCommit(deps, repo, head.value, headDirectory, exported, signal);
      if (!headTree.ok) return headTree;
      return read({
        tree: headTree.value,
        selected,
        base: (content, store = false) => factBase(trust, snapshot, content, spec, scope, store ? { kind: "full" } : undefined),
        open: () => indexHead(headTree.value, headDirectory, directory, signal),
      });
    });
  }

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

      return atHead(request, spec, async (head): Promise<Result<Fact<ImpactValue>, ImpactFault>> => {
        const headTree = head.tree;
        const content = contentFingerprint(headTree.export);
        const outside = targets.filter((target) => !head.selected(target.file));
        if (outside.length > 0) return { ok: true, value: { ...head.base(content), evidence: outside.map(evidenceOfTarget), status: "unknown", reason: "out-of-scope" } };
        const declarations = await deps.angular.read(headTree.sources);
        if (signal?.aborted) return ABORTED;
        const componentsByResource = resourcesOf(declarations);
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
        const { store, summary } = index;
        try {
          const { relations: found, fields } = await deps.relations.extract(headTree.sources);
          const loads = await deps.dynamicLoads.extract(headTree.sources);
          if (signal?.aborted) return ABORTED;
          const read = impactOf({ store, changes, requested, componentsByResource, found, fields, loads, headTree, summary, budget: request.budget ?? {} });
          if (read.missing.length > 0) {
            const names = read.missing.map(({ file, symbol }) => `${file}:${symbol}`).join(", ");
            return { ok: false, fault: { kind: "unknown-symbol", detail: `no symbol at the revision for ${names}`, entries: read.missing } };
          }
          return { ok: true, value: impactFact(head.base(content, true), read.value, [...fixed, ...read.cuts]) };
        } finally {
          store.close();
        }
      });
    },

    async importers(request) {
      const files = sortedUnique(request.files);
      const isCovered = (path: string): boolean => ["source", "test"].includes(kindOfChangedFile(path));
      const spec: FactSpec = { declaredConfig: { files }, engines: importersEngines };

      return atHead(request, spec, async (head): Promise<Result<Fact<ImportersValue>, VcsFault>> => {
        const headTree = head.tree;
        const content = contentFingerprint(headTree.export);
        const outside = files.filter((file) => !head.selected(file));
        if (outside.length > 0) return { ok: true, value: { ...head.base(content), evidence: outside.map((path): Evidence => ({ path, line: 1 })), status: "unknown", reason: "out-of-scope" } };
        const fixed = [...exportCuts(headTree.export), ...files.filter((file) => !isCovered(file)).map((file): Cut => ({ kind: "no-extractor", at: [file] }))];
        const covered = files.filter(isCovered);
        if (covered.length === 0) return { ok: true, value: impactFact(head.base(content), { files: [] }, fixed) };

        const index = await head.open();
        if (index === "aborted") return ABORTED;
        if (index === "unavailable") return { ok: true, value: { ...head.base(content), status: "unknown", reason: "index-unavailable" } };
        const { store, summary } = index;
        try {
          const written = headTree.export.files.filter((file) => file.written && isCovered(file.path)).map((file) => file.path);
          const held = new Set(headTree.export.files.map((file) => file.path));
          const references = store.unresolvedReferences(written);
          const read = readImporters(store, covered, references);
          const loadPlaces = await deps.dynamicLoads.extract(headTree.sources);
          const cuts = [
            ...fixed,
            ...unresolvedLinkCuts(
              references.filter((reference) => kindOfChangedFile(reference.file) !== "test"),
              [],
              loadPlaces,
            ),
            ...summary.filesNotIndexed.map((file): Cut => ({ kind: "no-extractor", at: [file] })),
            ...read.unheld.map((file): Cut => ({ kind: held.has(file) ? "no-extractor" : "not-exported", at: [file] })),
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
    const spec: FactSpec = { declaredConfig: walkBounds(request.budget), engines: angularReadingEngines };
    const baseOfHead = (content: string): FactBase => factBase(trust, snapshot, content, spec, scope, undefined);

    const diff = await vcs.diffCommits(repo, mergeBase, head.value, signal);
    if (!diff.ok) return diff.fault.kind === "git-failed" ? unknownFact(baseOfHead(JSON.stringify([mergeBase, head.value])), "source-unreadable") : diff;
    if (signal?.aborted) return ABORTED;
    const radius = blastRadius(mergeBase, diff.value.filter((file) => selected(file.path)));

    return withScratch(deps.scratch, async (directory): Promise<Answer> => {
      const headDirectory = await directory();
      const headTree = await extractCommit(deps, repo, head.value, headDirectory, exported, signal);
      if (!headTree.ok) return headTree;
      const baseTree = mergeBase === head.value ? headTree : await extractCommit(deps, repo, mergeBase, await directory(), exported, signal);
      if (!baseTree.ok) return baseTree;
      const reading: HeadReading = {
        tree: headTree.value,
        selected,
        base: (content, store = false) => (store ? factBase(trust, snapshot, content, spec, scope, { kind: "full" }) : baseOfHead(content)),
        open: () => indexHead(headTree.value, headDirectory, directory, signal),
      };
      return readChange({ request, radius, head: reading, baseTree: baseTree.value, sameTree: baseTree === headTree, unreadable: JSON.stringify([mergeBase, head.value]) });
    });
  }

  async function ofChangeLive(request: Extract<ImpactOfChangeRequest, { live: true }>): Promise<Answer> {
    const { repo, repoId, signal } = request;
    const trust = await trustOf(deps, repo);
    const live = deps.live;
    if (trust !== "trusted" || live === undefined) return LIVE_REQUIRES_TRUSTED;
    const scope = liveScope(request.scope);
    const selected = pathSelection(scope, deps.matcher.matches);
    const exported = exportSelection(scope, deps.matcher.matches, isExtractorConfiguration);
    const base = await vcs.resolveCommit(repo, request.base, signal);
    if (!base.ok) return base;
    const head = await vcs.resolveCommit(repo, LIVE_HEAD, signal);
    if (!head.ok) return head;
    const merge = await vcs.mergeBase(repo, base.value, head.value, signal);
    if (!merge.ok) return merge;
    const mergeBase = merge.value;
    const spec: FactSpec = { declaredConfig: walkBounds(request.budget), engines: angularReadingEngines };

    const opened = await openLive(live, { repo, scope, selected: exported, store: true, signal, onStale: request.onStale }, (tree) =>
      withScratch(deps.scratch, async (directory): Promise<Answer> => {
        const liveTree = await extractExport(deps, tree.root, tree.export, signal);
        if (!liveTree.ok) return liveTree;
        const baseTree = await extractCommit(deps, repo, mergeBase, await directory(), exported, signal);
        if (!baseTree.ok) return baseTree;
        const reading = liveReading(tree, liveTree.value, trust, scope, selected, head.value, repoId, spec);

        const changed = changedPaths(baseTree.value.export.files, tree.export.files).filter((path) => !isEngineConfiguration(path));
        const [before, after] = [await directory(), await directory()];
        const wanted = new Set(changed);
        const exportedBase = await vcs.exportCommit(repo, mergeBase, before, { write: (path) => wanted.has(path) }, signal);
        if (!exportedBase.ok) return exportedBase;
        const copied = await live.mirror.materialize(tree.location, changed, after, signal);
        if (!copied.ok) return { ok: false, fault: { kind: "live-mirror-failed", detail: `${copied.fault.kind}: ${copied.fault.detail}` } };
        const diff = await vcs.diffDirectories(before, after, signal);
        const unreadable = JSON.stringify([mergeBase, head.value]);
        if (!diff.ok) return diff.fault.kind === "git-failed" ? unknownFact(reading.base(unreadable), "source-unreadable") : diff;
        if (signal?.aborted) return ABORTED;
        const radius = blastRadius(mergeBase, diff.value.filter((file) => selected(file.path)));
        const sameTree = changed.length === 0 && JSON.stringify(baseTree.value.export.skipped) === JSON.stringify(tree.export.skipped);
        return readChange({ request, radius, head: reading, baseTree: baseTree.value, sameTree, unreadable });
      }),
    );
    if (opened.ok) return opened.value;
    const { fault } = opened;
    return fault.kind === "unavailable" ? { ok: true, value: unavailableLive(trust, scope, head.value, repoId, spec) } : { ok: false, fault };
  }

  /** Everything `ofChange` does once it holds the diff and both trees; a commit and the live tree differ only in how they got here. */
  async function readChange(input: { request: ImpactOfChangeRequest; radius: BlastRadius; head: HeadReading; baseTree: CommitExtraction; sameTree: boolean; unreadable: string }): Promise<Answer> {
    const { request, radius, head, baseTree, sameTree } = input;
    const { signal } = request;
    const headTree = head.tree;
    const declarations = await deps.angular.read(headTree.sources);
    if (signal?.aborted) return ABORTED;
    const componentsByResource = resourcesOf(declarations);
    const content = JSON.stringify([contentFingerprint(baseTree.export), contentFingerprint(headTree.export)]);
    const declared = holdsDeclaredSource(headTree.export.files);
    const fixed = [
      ...exportCuts(headTree.export),
      ...(sameTree ? [] : exportCuts(baseTree.export)),
      ...radius.files
        .filter((file) => cutsCompleteness(file.path, declared) || (isAngularTemplate(file.path) && !componentsByResource.has(file.path)))
        .map((file): Cut => ({ kind: "no-extractor", at: [file.path] })),
    ];
    const entrypointChanges = changedEntrypoints(entrypointsOf(baseTree.findings), entrypointsOf(headTree.findings));
    const value: ImpactValue = { mergeBase: radius.mergeBase, seeds: [], changedEntrypoints: entrypointChanges, symbols: [], entrypoints: [], cost: { expansionsUsed: 0 } };

    const needsGraph = radius.files.some(
      (file) => (kindOfChangedFile(file.path) === "source" && (!file.deleted || file.removedNames.length > 0)) || componentsByResource.has(file.path),
    );
    if (!needsGraph) return { ok: true, value: impactFact(head.base(content), value, fixed) };

    const index = await head.open();
    if (index === "aborted") return ABORTED;
    if (index === "unavailable") return unknownFact(head.base(content), "index-unavailable");
    const { store, summary } = index;
    try {
      const { relations: found, fields } = await deps.relations.extract(headTree.sources);
      const loads = await deps.dynamicLoads.extract(headTree.sources);
      if (signal?.aborted) return ABORTED;
      const read = impactOf({ store, changes: radius.files, requested: [], componentsByResource, found, fields, loads, headTree, summary, budget: request.budget ?? {} });
      return { ok: true, value: impactFact(head.base(content, true), { ...value, ...read.value }, [...fixed, ...read.cuts]) };
    } finally {
      store.close();
    }
  }
}

function unknownFact(base: FactBase, reason: "index-unavailable" | "source-unreadable"): Result<UnknownFact, never> {
  return { ok: true, value: { ...base, status: "unknown", reason } };
}

interface HeadIndex {
  store: CodeGraphReader;
  summary: Pick<IndexSummary, "filesNotIndexed">;
}

/**
 * The files of the index's universe the store did not hold, limited to what the head export staged: the engine reads
 * the whole mirror and a commit's whole listing, so a path the export never wrote could not be read by this answer.
 */
function notHeldInExport(notHeld: readonly string[], exported: CommitExport): Pick<IndexSummary, "filesNotIndexed"> {
  const staged = new Set(exported.files.filter((file) => file.written).map((file) => file.path));
  return { filesNotIndexed: notHeld.filter((path) => staged.has(path)) };
}

/** The targets once each, in a fixed order, so the same request in any order is the same fact. */
function distinctTargets(targets: readonly CallersTarget[]): CallersTarget[] {
  const byKey = new Map(targets.map((target) => [JSON.stringify(target), target]));
  return [...byKey].sort(([a], [b]) => compareText(a, b)).map(([, target]) => target);
}

function targetKey(target: CallersTarget): string {
  return "start" in target ? `${target.file}:${target.start}-${target.end}` : `${target.file}:${target.symbol}`;
}

function evidenceOfTarget(target: CallersTarget): Evidence {
  return "start" in target ? { path: target.file, line: target.start, endLine: target.end } : { path: target.file, line: 1 };
}

/** The requested line ranges as the added lines of unchanged files, so they seed as changed lines do. */
function rangeChanges(targets: readonly CallersTarget[]): FileChange[] {
  const ranges = targets.flatMap((target) => ("start" in target ? [target] : []));
  return [...Map.groupBy(ranges, ({ file }) => file)]
    .map(([path, inFile]): FileChange => ({ path, deleted: false, binary: false, added: inFile.map(({ start, end }) => ({ start, end })), removals: [], removedNames: [] }))
    .sort((a, b) => compareText(a.path, b.path));
}

/** What a file declares that a request can seed, so a symbol that names no node tells the caller what does. */
function candidatesOf(symbols: readonly GraphSymbol[]): string[] {
  return [...new Set(symbols.filter(isSeedable).map((symbol) => symbol.name))].sort(compareText);
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
  /** Every dynamic load the reader found in the head's sources. */
  loads: readonly DynamicLoad[];
  headTree: CommitExtraction;
  summary: Pick<IndexSummary, "filesNotIndexed">;
  budget: ImpactBudget;
}

interface ImpactRead {
  value: Pick<ImpactValue, "seeds" | "symbols" | "entrypoints" | "cost">;
  cuts: Cut[];
  /** The requested symbols that name no node, with what their file declares; the walk does not run when there is one. */
  missing: UnknownSymbolFault["entries"];
}

function impactOf(input: WalkInput): ImpactRead {
  const { store, changes, requested, componentsByResource, found, fields, loads, headTree, summary } = input;
  const isTest = (path: string): boolean => kindOfChangedFile(path) === "test";
  const sourceChanges = changes.filter((file) => kindOfChangedFile(file.path) === "source" && !file.deleted).map((file) => file.path);
  const componentFiles = changes.flatMap((file) => (componentsByResource.get(file.path) ?? []).map((component) => component.file));
  const symbols = store.symbolsInFiles([...new Set([...sourceChanges, ...componentFiles, ...requested.map(({ file }) => file)])]);
  const symbolsByFile = Map.groupBy(symbols, (symbol) => symbol.file);
  const asked = requested.map((target) => ({ target, found: (symbolsByFile.get(target.file) ?? []).filter((symbol) => isSeedable(symbol) && joinsFact(symbol, { path: target.file, line: symbol.startLine, symbol: target.symbol })) }));
  const missing = asked.filter(({ found: nodes }) => nodes.length === 0).map(({ target }) => ({ ...target, candidates: candidatesOf(symbolsByFile.get(target.file) ?? []) }));
  if (missing.length > 0) return { value: { seeds: [], symbols: [], entrypoints: [], cost: { expansionsUsed: 0 } }, cuts: [], missing };

  const selection = selectSeeds({ files: changes }, symbolsByFile, componentsByResource);
  const requestedSymbols = new Set(asked.flatMap(({ found: nodes }) => nodes));
  const chosen = [...[...requestedSymbols].map((symbol): SelectedSeed<GraphSymbol> => ({ symbol, basis: "requested" })), ...selection.seeds.filter(({ symbol }) => !requestedSymbols.has(symbol))];
  const seeds = chosen.toSorted((a, b) => comparePosition(a.symbol, b.symbol));
  const inbound = createInboundEdges(store, isTest, found.flatMap((finding) => (finding.status === "complete" ? [finding.value] : [])), fields);
  const walk = walkImpact(seeds.map(({ symbol }) => symbol), inbound, input.budget);

  const sourceFiles = headTree.export.files.filter((file) => file.written && kindOfChangedFile(file.path) === "source").map((file) => file.path);
  const unresolved = store.unresolvedReferences(sourceFiles);
  const walked = walk.reached.map(({ symbol }) => symbol);
  const unread = found.flatMap((finding): UnreadRelation[] => (finding.status === "unknown" ? finding.evidence.slice(0, 1).map(({ path, line }) => ({ path, line, reason: finding.reason })) : []));

  const cuts: Cut[] = [
    ...walk.cuts,
    ...unresolvedLinkCuts(unresolved, walked, loads, inbound.settledUses()),
    ...removedDeclarationCuts(unresolved, selection.removed),
    ...unreadRelationCuts(unread, new Set(walked.map((symbol) => symbol.file)), templateOwners(componentsByResource)),
    ...summary.filesNotIndexed.map((file): Cut => ({ kind: "no-extractor", at: [file] })),
    ...selection.withoutSymbols.map((file): Cut => ({ kind: "no-extractor", at: [file] })),
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
              ...(via.lines.length === 0 ? {} : { lines: via.lines }),
              basis: via.basis,
            },
          }),
    })),
    entrypoints: reachedEntrypoints(
      headTree.findings,
      walk.reached.map(({ symbol, depth, confidence, seeds: reaching }) => ({ file: symbol.file, name: symbol.name, startLine: symbol.startLine, endLine: symbol.endLine, depth, confidence, seeds: reaching })),
    ),
  };
  return { value, cuts, missing: [] };
}

function resourcesOf(declarations: readonly AngularDeclaration[]): Map<string, ComponentRef[]> {
  const byResource = new Map<string, ComponentRef[]>();
  for (const declaration of declarations) {
    for (const resource of declaration.resources) byResource.set(resource, [...(byResource.get(resource) ?? []), { file: declaration.file, name: declaration.name, line: declaration.line }]);
  }
  return byResource;
}

function templateOwners(componentsByResource: ReadonlyMap<string, readonly ComponentRef[]>): Map<string, string[]> {
  return new Map([...componentsByResource].map(([resource, components]) => [resource, components.map((component) => component.file)]));
}

function entrypointsOf(findings: readonly Finding<Entrypoint>[]): Entrypoint[] {
  return findings.flatMap((finding) => (finding.status === "complete" ? [finding.value] : []));
}
