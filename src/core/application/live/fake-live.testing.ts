import type { CodeGraph, CodeGraphFault, IndexSummary, MirrorSyncSummary } from "../../ports/code-graph.port.ts";
import type { MirrorEntry, MirrorState, MirrorVersions, LiveMirror } from "../../ports/live-mirror.port.ts";
import type { SkippedEntry } from "../../ports/vcs.port.ts";
import type { WorkingTree } from "../../ports/working-tree.port.ts";
import type { Result } from "../../domain/shared/result.ts";
import type { Digest } from "../../ports/digest.port.ts";
import type { LiveDeps } from "./live-tree.ts";

export const VERSIONS: MirrorVersions = { codegraph: "1.0.0", store: "11.27", staging: "3" };

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
  /** Paths each `reconcile` was told to copy again, in call order. */
  forced: string[][];
  syncs: string[][];
  /** Paths each `materialize` was asked to copy, in call order. */
  materialized: string[][];
  builds: number;
  objectFormat: { value: string };
  engine: { build: Result<IndexSummary, CodeGraphFault>; sync: Result<MirrorSyncSummary, CodeGraphFault>; lock: Result<void, { kind: "aborted" | "refused"; detail: string }> };
}

export function fakeLive(initial: Record<string, string> = {}, digest: Digest = { of: (text) => text }): FakeLive {
  const fake: FakeLive = {
    tree: new Map(Object.entries(initial)),
    skipped: [],
    state: { current: null },
    calls: [],
    held: { locks: 0, released: 0 },
    forced: [],
    syncs: [],
    materialized: [],
    builds: 0,
    objectFormat: { value: "sha1" },
    engine: { build: { ok: true, value: SUMMARY }, sync: { ok: true, value: { ...SUMMARY, filesFailed: [] } }, lock: { ok: true, value: undefined } },
    deps: undefined as unknown as LiveDeps,
  };
  const entryOf = (path: string, blob: string): MirrorEntry => ({ path, size: blob.length, mtimeNs: blob, blob });

  const workingTree: WorkingTree = {
    list: async () => {
      fake.calls.push("list");
      return { ok: true, value: { paths: [...fake.tree.keys()].sort().map((path) => ({ path, submodule: false })), objectFormat: fake.objectFormat.value } };
    },
  };
  const mirror: LiveMirror = {
    root: () => "/mirror",
    lock: async () => {
      fake.calls.push("lock");
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
    reconcile: async (_location, paths, manifest, force) => {
      fake.calls.push("reconcile");
      fake.forced.push([...force]);
      const old = new Map(manifest.map((entry) => [entry.path, entry]));
      const next = paths.map(({ path }) => entryOf(path, fake.tree.get(path) ?? ""));
      const changed = new Set<string>();
      for (const entry of next) if (old.get(entry.path)?.blob !== entry.blob || force.includes(entry.path)) changed.add(entry.path);
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
    materialize: async (_location, paths) => {
      fake.materialized.push([...paths]);
      return { ok: true, value: undefined };
    },
    discard: async () => {
      fake.calls.push("discard");
      fake.state.current = null;
      return { ok: true, value: undefined };
    },
  };
  const graph: CodeGraph = {
    index: async () => ({ ok: false, fault: { kind: "index-failed", detail: "not used" } }),
    buildMirror: async () => {
      fake.calls.push("buildMirror");
      fake.builds++;
      return fake.engine.build;
    },
    syncMirror: async (_mirror, paths) => {
      fake.calls.push("syncMirror");
      fake.syncs.push([...paths]);
      return fake.engine.sync;
    },
    open: () => ({ ok: false, fault: { kind: "store-unreadable", detail: "not used" } }),
  };
  fake.deps = { workingTree, mirror, graph, digest, versions: VERSIONS };
  return fake;
}
