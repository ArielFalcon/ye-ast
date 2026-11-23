import type { CodeGraph, CodeGraphFault, CodeGraphReader, IndexSummary, MirrorSyncSummary, SyncGenerations } from "../../ports/code-graph.port.ts";
import type { IndexTreeDeviation, MirrorEntry, MirrorFault, MirrorState, MirrorUsage, MirrorVersions, LiveMirror, MirrorLocation } from "../../ports/live-mirror.port.ts";
import type { SkippedEntry } from "../../ports/vcs.port.ts";
import type { WorkingTree } from "../../ports/working-tree.port.ts";
import type { Result } from "../../domain/shared/result.ts";
import type { Digest } from "../../ports/digest.port.ts";
import type { LiveDeps } from "./live-tree.ts";

export const VERSIONS: MirrorVersions = { codegraph: "1.0.0", store: "11.27", staging: "3" };
export const NOW = 1_700_000_000_000;
const RETENTION = { keepScopes: 3, unusedForMs: 14 * 24 * 60 * 60 * 1000, maxBytes: 512 * 1024 * 1024 };

const SUMMARY: IndexSummary = { filesIndexed: 1, filesSkipped: 0, filesErrored: 0, filesNotIndexed: [], versions: { codegraph: "1.0.0", schema: 11, extraction: 27 } };

/** An in-memory working tree, mirror and engine that record every call; `tree` maps a path to its blob id. */
export interface FakeLive {
  deps: LiveDeps;
  /** The working tree: edit it between queries. */
  tree: Map<string, string>;
  /** Paths the working tree lists as skipped (a link). */
  skipped: SkippedEntry[];
  state: { current: MirrorState | null };
  calls: string[];
  held: { locks: number; released: number };
  /** Paths each `syncMirror` was asked to bring up to date, in call order. */
  syncs: string[][];
  /** Paths each `materialize` was asked to copy, in call order; a staging into the index tree is recorded in `staged`. */
  materialized: string[][];
  /** Paths each staging into the index tree copied, in call order. */
  staged: string[][];
  /** The files each `materializePinned` was asked to copy, in call order. */
  pinnedCopies: { path: string; blob: string }[][];
  /** Paths `materializePinned` answers as moved since the pin: set it to simulate a sync by another process. */
  movedSincePin: string[];
  /** Paths each `prune` was asked to remove from the index tree, in call order. */
  pruned: string[][];
  /** The written files each `verifyIndexTree` was handed, in call order. */
  verified: { path: string; blob: string }[][];
  /** Roots each build and each sync was told to index, in call order. */
  built: string[];
  synced: string[];
  /** The roots each `retireMirror` named, in call order. */
  retired: string[];
  /** The mirror root and the kept store each `adoptMirror` copied, in call order. */
  adopted: [string, string][];
  builds: number;
  objectFormat: { value: string };
  /** Every location a lock was taken for, in call order: its `scope` is the identity the sweep answers for. */
  locations: MirrorLocation[];
  /** Scopes each `discard` named, in call order. */
  discarded: string[];
  /** Entries each debris removal named, in call order. */
  debrisRemoved: string[][];
  touches: number;
  /** Whether the engine store opens; set it between queries to make the store behind a committed state unreachable. */
  openable: { value: boolean };
  /** Readers the engine opened and closed. */
  stores: { opened: number; closed: number };
  /** What an opened store answers; closing the opened reader closes it too. */
  storeReader: CodeGraphReader | undefined;
  /** The store generation each `open` named, in call order; `undefined` when it named none. */
  openedAt: (string | undefined)[];
  /** The generations each `syncMirror` was handed, in call order. */
  syncGenerations: (SyncGenerations | undefined)[];
  engine: {
    build: Result<IndexSummary, CodeGraphFault>;
    adopt: Result<IndexSummary, CodeGraphFault>;
    sync: Result<MirrorSyncSummary, CodeGraphFault>;
    lock: Result<void, { kind: "aborted" | "refused"; detail: string }>;
    /** What the retention sweep reads; set it between queries. */
    usage: Result<MirrorUsage, MirrorFault>;
    touch: Result<void, MirrorFault>;
    /** What `verifyIndexTree` finds; an exact tree by default. */
    verify: Result<IndexTreeDeviation, MirrorFault>;
  };
}

export function fakeLive(initial: Record<string, string> = {}, digest: Digest = { of: (text) => text }): FakeLive {
  const fake: FakeLive = {
    tree: new Map(Object.entries(initial)),
    skipped: [],
    state: { current: null },
    calls: [],
    held: { locks: 0, released: 0 },
    syncs: [],
    materialized: [],
    staged: [],
    pinnedCopies: [],
    movedSincePin: [],
    pruned: [],
    verified: [],
    built: [],
    synced: [],
    adopted: [],
    retired: [],
    builds: 0,
    objectFormat: { value: "sha1" },
    locations: [],
    discarded: [],
    debrisRemoved: [],
    touches: 0,
    openable: { value: true },
    stores: { opened: 0, closed: 0 },
    storeReader: undefined,
    openedAt: [],
    syncGenerations: [],
    engine: {
      build: { ok: true, value: SUMMARY },
      adopt: { ok: true, value: SUMMARY },
      sync: { ok: true, value: { ...SUMMARY, filesFailed: [], filesUnparsed: [] } },
      lock: { ok: true, value: undefined },
      usage: { ok: true, value: { scopes: [], debris: [] } },
      touch: { ok: true, value: undefined },
      verify: { ok: true, value: { missing: [], foreign: [] } },
    },
    deps: undefined as unknown as LiveDeps,
  };
  let generations = 0;
  const entryOf = (path: string, blob: string): MirrorEntry => ({ path, size: blob.length, mtimeNs: blob, ctimeNs: blob, ino: "1", blob });

  const workingTree: WorkingTree = {
    list: async () => {
      fake.calls.push("list");
      return { ok: true, value: { paths: [...fake.tree.keys()].sort().map((path) => ({ path, submodule: false })), objectFormat: fake.objectFormat.value } };
    },
  };
  const mirror: LiveMirror = {
    root: () => "/mirror",
    indexRoot: () => "/index",
    lock: async (location) => {
      fake.calls.push("lock");
      fake.locations.push(location);
      if (!fake.engine.lock.ok) return { ok: false, fault: fake.engine.lock.fault };
      fake.held.locks++;
      return { ok: true, value: { release: async () => void fake.held.released++ } };
    },
    readState: async () => ({ ok: true, value: fake.state.current }),
    writeState: async (_location, state) => {
      fake.calls.push("writeState");
      fake.state.current = structuredClone(state);
      return { ok: true, value: undefined };
    },
    reconcile: async (_location, paths, manifest) => {
      fake.calls.push("reconcile");
      const old = new Map(manifest.map((entry) => [entry.path, entry]));
      const next = paths.map(({ path }) => entryOf(path, fake.tree.get(path) ?? ""));
      const changed = new Set<string>();
      for (const entry of next) if (old.get(entry.path)?.blob !== entry.blob) changed.add(entry.path);
      for (const entry of manifest) if (!next.some((candidate) => candidate.path === entry.path)) changed.add(entry.path);
      return { ok: true, value: { manifest: next, skipped: [...fake.skipped], changed: [...changed].sort() } };
    },
    changedSince: async (_location, paths, state) => {
      fake.calls.push("changedSince");
      const known = new Map(state.manifest.map((entry) => [entry.path, entry.blob]));
      const changed = paths.filter(({ path }) => known.get(path) !== fake.tree.get(path)).map(({ path }) => path);
      for (const path of known.keys()) if (!paths.some((entry) => entry.path === path)) changed.push(path);
      return { ok: true, value: changed.sort() };
    },
    materialize: async (_location, paths, destination) => {
      if (destination === "/index") fake.staged.push([...paths]);
      else fake.materialized.push([...paths]);
      return { ok: true, value: undefined };
    },
    verifyIndexTree: async (_location, files) => {
      fake.calls.push("verifyIndexTree");
      fake.verified.push(files.map(({ path, blob }) => ({ path, blob })));
      return fake.engine.verify;
    },
    materializePinned: async (_location, files) => {
      fake.pinnedCopies.push(files.map((file) => ({ ...file })));
      return { ok: true, value: files.map(({ path }) => path).filter((path) => fake.movedSincePin.includes(path)) };
    },
    prune: async (_location, paths) => {
      fake.calls.push("prune");
      fake.pruned.push([...paths]);
      return { ok: true, value: undefined };
    },
    discard: async (location) => {
      fake.calls.push("discard");
      fake.discarded.push(location.scope);
      fake.state.current = null;
      return { ok: true, value: undefined };
    },
    discardIfIdle: async (location) => {
      fake.calls.push("discardIfIdle");
      fake.discarded.push(location.scope);
      fake.state.current = null;
      return { ok: true, value: undefined };
    },
    usage: async () => {
      fake.calls.push("usage");
      return fake.engine.usage;
    },
    touch: async () => {
      fake.calls.push("touch");
      if (fake.engine.touch.ok) fake.touches++;
      return fake.engine.touch;
    },
    discardDebris: async (_repo, entries) => {
      fake.calls.push("discardDebris");
      fake.debrisRemoved.push([...entries]);
      return { ok: true, value: undefined };
    },
  };
  const graph: CodeGraph = {
    index: async () => ({ ok: false, fault: { kind: "index-failed", detail: "not used" } }),
    buildMirror: async (mirrorRoot) => {
      fake.calls.push("buildMirror");
      fake.built.push(mirrorRoot);
      fake.builds++;
      return fake.engine.build;
    },
    adoptMirror: async (mirrorRoot, store) => {
      fake.calls.push("adoptMirror");
      fake.adopted.push([mirrorRoot, store]);
      return fake.engine.adopt;
    },
    syncMirror: async (mirrorRoot, paths, _signal, generations) => {
      fake.calls.push("syncMirror");
      fake.syncGenerations.push(generations);
      fake.synced.push(mirrorRoot);
      fake.syncs.push([...paths]);
      return fake.engine.sync;
    },
    retireMirror: (mirrorRoot) => void fake.retired.push(mirrorRoot),
    open: ((_store: string, generation?: string) => {
      if (!fake.openable.value) return { ok: false, fault: { kind: "store-unreadable", detail: "the store cannot be opened" } };
      fake.stores.opened++;
      fake.openedAt.push(generation);
      const reader = fake.storeReader;
      return { ok: true, value: { ...reader, close: () => { fake.stores.closed++; reader?.close(); } } };
    }) as CodeGraph["open"],
  };
  fake.deps = { workingTree, mirror, graph, digest, versions: VERSIONS, retention: RETENTION, now: () => NOW, newStoreGeneration: () => `generation-${++generations}` };
  return fake;
}
