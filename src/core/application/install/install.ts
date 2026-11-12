import { INDEX_STORE_DIRECTORY } from "../../ports/code-graph.port.ts";
import type { Result } from "../../domain/shared/result.ts";
import { FIXED_LAYER_DIRECTORY, type FixedLayerFault, type FixedLayerStore } from "../../ports/fixed-layer-store.port.ts";
import type { FixedLayerAdmin } from "../../ports/fixed-layer-admin.port.ts";
import type { Install, InstallFault, BatchInstallRequest, BatchInstallReport, BatchSelectionFault } from "../../ports/install.port.ts";
import type { LocalExclude } from "../../ports/local-exclude.port.ts";
import type { TrustRecords } from "../../ports/trust-record.port.ts";
import { DEFAULT_REVISION, type Vcs, type VcsFault } from "../../ports/vcs.port.ts";
import { parseWorkspaceManifest, renderWorkspaceManifest, type WorkspaceManifest } from "../../domain/topology/workspace-manifest.ts";
import { WORKSPACE_MANIFEST_FILE, type WorkspaceDefaults } from "../../ports/workspace-defaults.port.ts";
import { compareText } from "../../domain/shared/code-node.ts";

/** What `install` keeps out of git through the repository's local exclude file. */
export const IGNORED_LINES: readonly string[] = [`${FIXED_LAYER_DIRECTORY}/`, `${INDEX_STORE_DIRECTORY}/`];
const ABORTED = { kind: "aborted" as const, detail: "interrupted by the caller" };

export interface InstallDeps {
  vcs: Pick<Vcs, "resolveCommit" | "canonicalRoot">;
  trust: Pick<TrustRecords, "write">;
  exclude: LocalExclude;
  store: FixedLayerStore;
  layer: FixedLayerAdmin;
  /** Resolves a manifest's relative repository paths against the repository, as the reader will. */
  defaults: Pick<WorkspaceDefaults, "resolve">;
}

export function createInstall({ vcs, trust, exclude, store, layer, defaults }: InstallDeps): Install {
  const install: Install = {
    async runBatch(request) { return runBatch(request, install, vcs, defaults); },
    async run({ repo, repoId, trust: mode, workspace, signal }) {
      const head = await vcs.resolveCommit(repo, DEFAULT_REVISION, signal);
      if (!head.ok) return stopped(head.fault, false, "preflight");
      if (signal?.aborted) return stopped(ABORTED, false, "preflight");
      let manifest: WorkspaceManifest | undefined;
      if (workspace !== undefined) {
        const parsed = parseWorkspaceManifest(workspace.text);
        if (!parsed.ok) return stopped({ ...parsed.fault, detail: `${workspace.path}: ${parsed.fault.detail}` }, false, "preflight");
        manifest = parsed.value;
        const readable = await everyRepositoryReadable(defaults.resolve(repo, manifest), vcs, signal);
        if (readable !== undefined) return stopped(readable, false, "preflight");
      }
      const recorded = await trust.write(repo, mode);
      if (!recorded.ok) return stopped(recorded.fault, false, "trust");
      if (signal?.aborted) return stopped(ABORTED, true, "trust");
      const excluded = await exclude.ensure(repo, IGNORED_LINES);
      if (!excluded.ok) return stopped(excluded.fault, true, "exclude");
      if (signal?.aborted) return stopped(ABORTED, true, "exclude");
      const persisted = manifest === undefined ? undefined : await persist(store, repo, manifest, signal);
      if (persisted !== undefined) {
        if (!persisted.ok) return stopped(persisted.fault, true, "workspace");
        if (signal?.aborted) return stopped(ABORTED, true, "workspace");
      }
      const written = await layer.refresh({ repo, repoId, revision: DEFAULT_REVISION, ...(signal && { signal }) });
      if (!written.ok) return stopped(written.fault, true, "layer");
      return { ok: true, value: { trust: mode, excluded: excluded.value, layer: written.value, ...(persisted === undefined ? {} : { workspace: persisted.value }) } };
    },
  };
  return install;
}

/**
 * Every repository the declaration names is checked against the filesystem before anything is written: a clone the query
 * families cannot read is a broken workspace, so the install names the entry instead of storing it. The fault is the
 * reader's own, with the entry prepended.
 */
async function everyRepositoryReadable(manifest: WorkspaceManifest, vcs: Pick<Vcs, "resolveCommit">, signal: AbortSignal | undefined): Promise<VcsFault | undefined> {
  for (const [index, declaration] of manifest.repos.entries()) {
    if (signal?.aborted) return { kind: "aborted", detail: "Aborted" };
    const resolved = await vcs.resolveCommit(declaration.path, declaration.revision ?? DEFAULT_REVISION, signal);
    if (signal?.aborted) return { kind: "aborted", detail: "Aborted" };
    if (!resolved.ok) return { ...resolved.fault, detail: `repos[${index}].path: ${resolved.fault.detail.trim()}` };
  }
  return undefined;
}

/** Writes the manifest when the stored bytes differ from it, so a second run of one workspace writes nothing. */
async function persist(store: FixedLayerStore, repo: string, manifest: WorkspaceManifest, signal?: AbortSignal): Promise<Result<{ outcome: "written" | "unchanged" }, FixedLayerFault | typeof ABORTED>> {
  const content = renderWorkspaceManifest(manifest);
  const stored = await store.read(repo, WORKSPACE_MANIFEST_FILE);
  if (!stored.ok) return stored;
  if (signal?.aborted) return { ok: false, fault: ABORTED };
  if (stored.value === content) return { ok: true, value: { outcome: "unchanged" } };
  const written = await store.write(repo, WORKSPACE_MANIFEST_FILE, content);
  return written.ok ? { ok: true, value: { outcome: "written" } } : written;
}

type InstallCause<T = InstallFault> = T extends InstallFault ? Omit<T, "trustRecorded" | "stage"> : never;

function stopped(fault: InstallCause, trustRecorded: boolean, stage: InstallFault["stage"]): { ok: false; fault: InstallFault } {
  return { ok: false, fault: { ...fault, trustRecorded, stage } };
}

async function runBatch(request: BatchInstallRequest, install: Install, vcs: InstallDeps["vcs"], defaults: InstallDeps["defaults"]): Promise<BatchInstallReport> {
  type Target = Omit<BatchInstallReport["targets"][number], "requestedPaths"> & { requestedPaths: string[] };
  const targets: Target[] = request.repositories.map(({ path, id }) => ({
    requestedPaths: [path], id, status: "not-attempted", trust: "not-recorded",
  }));
  const selectionTargets = [...targets];
  const roots = new Map<string, Target[]>();
  const ids = new Map<string, Target[]>();
  const invalid = (detail: string): BatchSelectionFault => ({ kind: "invalid-selection", detail });
  const fail = (target: Target, fault: BatchSelectionFault | InstallFault) => {
    target.status = "failed";
    target.stage = "preflight";
    target.fault = fault;
  };
  const launchEntry = () => {
    let target = targets.find((item) => item.id === request.launch.id && item.requestedPaths.includes(request.launch.path));
    if (!target) {
      target = { requestedPaths: [request.launch.path], id: request.launch.id, status: "not-attempted", trust: "not-recorded" };
      targets.push(target);
    }
    return target;
  };
  const aborted = (): BatchInstallReport => ({ targets, termination: "aborted" });
  let active: Target | undefined;
  if (request.signal?.aborted) return aborted();
  if (targets.length === 0 || !request.launch.path.trim() || !request.launch.id.trim()) {
    fail(launchEntry(), invalid("Invalid or empty selection"));
    return { targets };
  }
  let launchRoot: string;
  let launchTarget: Target | undefined;
  try {
    active = targets.find((item) => item.id === request.launch.id && item.requestedPaths.includes(request.launch.path));
    const launch = await vcs.canonicalRoot(request.launch.path, request.signal);
    if (request.signal?.aborted) return aborted();
    if (!launch.ok) {
      fail(active ?? launchEntry(), { ...launch.fault, stage: "preflight", trustRecorded: false });
      return { targets, ...(launch.fault.kind === "aborted" ? { termination: "aborted" as const } : {}) };
    }
    launchRoot = launch.value;
    for (const target of selectionTargets) {
      active = target;
      const path = target.requestedPaths[0]!;
      if (!path.trim() || !target.id.trim()) {
        fail(target, invalid("Invalid repository binding"));
        continue;
      }
      const canonical = await vcs.canonicalRoot(path, request.signal);
      if (request.signal?.aborted) return aborted();
      if (!canonical.ok) {
        fail(target, { ...canonical.fault, stage: "preflight", trustRecorded: false });
        if (canonical.fault.kind === "aborted") return aborted();
        continue;
      }
      target.canonicalRoot = canonical.value;
      const sameRoot = roots.get(canonical.value) ?? [];
      const sameId = ids.get(target.id) ?? [];
      const alias = sameRoot.find((item) => item.id === target.id);
      if (alias) {
        alias.requestedPaths.push(path);
        targets.splice(targets.indexOf(target), 1);
        continue;
      }
      const conflictingRoot = sameRoot.filter((item) => item.id !== target.id);
      const conflictingId = sameId.filter((item) => item.canonicalRoot !== canonical.value);
      if (conflictingRoot.length) {
        const fault: BatchSelectionFault = { kind: "conflicting-repository-alias", detail: "Root has multiple IDs" };
        fail(target, fault);
        for (const other of conflictingRoot) if (other.status !== "failed") fail(other, fault);
      }
      if (conflictingId.length) {
        const fault: BatchSelectionFault = { kind: "duplicate-repository-id", detail: "ID has multiple roots" };
        if (target.status !== "failed") fail(target, fault);
        for (const other of conflictingId) if (other.status !== "failed") fail(other, fault);
      }
      roots.set(canonical.value, [...sameRoot, target]);
      ids.set(target.id, [...sameId, target]);
    }
    launchTarget = roots.get(launchRoot)?.find((target) => target.id === request.launch.id);
    if (!launchTarget) {
      const target = launchEntry();
      target.canonicalRoot = launchRoot;
      fail(target, invalid("Launch binding is not selected"));
    }
    for (const target of targets) {
      if (!target.canonicalRoot || target.status === "failed") continue;
      active = target;
      const head = await vcs.resolveCommit(target.canonicalRoot, DEFAULT_REVISION, request.signal);
      if (request.signal?.aborted) return aborted();
      if (!head.ok) {
        fail(target, { ...head.fault, stage: "preflight", trustRecorded: false });
        if (head.fault.kind === "aborted") return aborted();
      }
    }
    if (launchTarget && request.workspace && launchTarget.status !== "failed") {
      active = launchTarget;
      const parsed = parseWorkspaceManifest(request.workspace.text);
      if (!parsed.ok) {
        fail(launchTarget, { ...parsed.fault, detail: `${request.workspace.path}: ${parsed.fault.detail}`, stage: "preflight", trustRecorded: false });
      } else {
        const readable = await everyRepositoryReadable(defaults.resolve(launchRoot, parsed.value), vcs, request.signal);
        if (request.signal?.aborted) return aborted();
        if (readable) {
          fail(launchTarget, { ...readable, stage: "preflight", trustRecorded: false });
          if (readable.kind === "aborted") return aborted();
        }
      }
    }
  } catch {
    const target = active ?? launchEntry();
    target.status = "failed";
    target.stage = "preflight";
    return { targets, termination: "unexpected" };
  }
  targets.sort((a, b) => {
    const left = a.canonicalRoot ?? a.requestedPaths[0]!;
    const right = b.canonicalRoot ?? b.requestedPaths[0]!;
    return compareText(left, right);
  });
  if (targets.some((target) => target.status === "failed")) return { targets };
  for (const target of targets) {
    if (request.signal?.aborted) return aborted();
    try {
      const result = await install.run({
        repo: target.canonicalRoot!, repoId: target.id, trust: request.trust,
        ...(target === launchTarget && request.workspace ? { workspace: request.workspace } : {}),
        ...(request.signal ? { signal: request.signal } : {}),
      });
      if (result.ok) {
        target.status = "completed";
        target.trust = "recorded";
        target.outcome = result.value;
      } else {
        target.status = "failed";
        target.trust = result.fault.trustRecorded ? "recorded" : "not-recorded";
        target.stage = result.fault.stage;
        target.fault = result.fault;
        if (result.fault.kind === "aborted") return aborted();
      }
      if (request.signal?.aborted) return aborted();
    } catch {
      target.status = "failed";
      target.trust = "unknown";
      return { targets, termination: "unexpected" };
    }
  }
  return { targets };
}
