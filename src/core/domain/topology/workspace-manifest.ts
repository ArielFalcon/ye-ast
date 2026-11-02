import { compareText } from "../shared/code-node.ts";
import type { Result } from "../shared/result.ts";

/** One repository of a workspace manifest: where it is read from, and the name its snapshot carries. */
export interface WorkspaceRepositoryDeclaration {
  /** Path of the root of a git repository, local only; relative paths resolve against the repository that persists it. */
  path: string;
  /** The name the repository is known by; the directory name when absent. Never a path. */
  id?: string;
  /** The revision to read; HEAD when absent. */
  revision?: string;
  /** The source of truth of the repository: an absolute URL or an scp-like git address; the local clone's when absent. */
  remote?: string;
}

/**
 * The workspace one repository persists: the `workspace` request parameter without the repository the request is bound
 * to. A relative repository path stays as written and is resolved against the repository root when the manifest is read.
 */
export interface WorkspaceManifest {
  /** The other repositories, sorted by path then id. */
  repos: readonly WorkspaceRepositoryDeclaration[];
  /** The prefixes the user declares, sorted by prefix then repository. */
  gateways?: readonly { prefix: string; repo: string }[];
}

/** A manifest that is not one: `detail` names the entry, and nothing is written from it. */
export interface WorkspaceManifestFault {
  kind: "workspace-invalid";
  detail: string;
}

const MANIFEST_KEYS: ReadonlySet<string> = new Set(["repos", "gateways"]);

/**
 * The manifest a file's text states, normalized so one workspace is one file: repositories sorted by path then id,
 * gateways by prefix then repository. The format is a rule of the workspace, so it has one owner here, shared by the
 * `install` that writes it and the reader that uses it.
 */
export function parseWorkspaceManifest(text: string): Result<WorkspaceManifest, WorkspaceManifestFault> {
  let stated: unknown;
  try {
    stated = JSON.parse(text);
  } catch (error) {
    return invalid(`JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(stated)) return invalid("the manifest: an object");
  const unknown = Object.keys(stated).find((key) => !MANIFEST_KEYS.has(key));
  if (unknown !== undefined) return invalid(`${unknown}: an unknown key`);
  const repos = stated["repos"];
  if (!Array.isArray(repos) || repos.length === 0) return invalid("repos: a non-empty array");
  const repositories: WorkspaceRepositoryDeclaration[] = [];
  for (const [index, entry] of repos.entries()) {
    if (!isRecord(entry)) return invalid(`repos[${index}]: an object`);
    const { path, id, revision, remote } = entry;
    if (!isText(path)) return invalid(`repos[${index}].path: a non-empty string`);
    if (id !== undefined && !isText(id)) return invalid(`repos[${index}].id: a non-empty string`);
    if (revision !== undefined && !isText(revision)) return invalid(`repos[${index}].revision: a non-empty string`);
    if (remote !== undefined && !(isText(remote) && isRemote(remote))) return invalid(`repos[${index}].remote: a URL or an scp-like git address`);
    repositories.push({ path, ...(id === undefined ? {} : { id }), ...(revision === undefined ? {} : { revision }), ...(remote === undefined ? {} : { remote }) });
  }
  const gateways = stated["gateways"];
  if (gateways !== undefined && !Array.isArray(gateways)) return invalid("gateways: an array");
  const declared: { prefix: string; repo: string }[] = [];
  for (const [index, entry] of (gateways ?? []).entries()) {
    if (!isRecord(entry)) return invalid(`gateways[${index}]: an object`);
    const { prefix, repo } = entry;
    if (!isText(prefix)) return invalid(`gateways[${index}].prefix: a non-empty string`);
    if (!isText(repo)) return invalid(`gateways[${index}].repo: a non-empty string`);
    declared.push({ prefix, repo });
  }
  return {
    ok: true,
    value: {
      repos: [...repositories].sort((a, b) => compareText(a.path, b.path) || compareText(a.id ?? "", b.id ?? "")),
      ...(gateways === undefined ? {} : { gateways: declared.sort((a, b) => compareText(a.prefix, b.prefix) || compareText(a.repo, b.repo)) }),
    },
  };
}

/** The bytes of the manifest file: two-space JSON and a trailing newline, so the same workspace is the same file. */
export function renderWorkspaceManifest(manifest: WorkspaceManifest): string {
  return `${JSON.stringify({ repos: manifest.repos, ...(manifest.gateways === undefined ? {} : { gateways: manifest.gateways }) }, null, 2)}\n`;
}

function invalid(entry: string): Result<never, WorkspaceManifestFault> {
  return { ok: false, fault: { kind: "workspace-invalid", detail: entry } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

const SCHEME_URL = /^[a-z][a-z0-9+.-]*:\/\/\S+$/i;
const SCP_URL = /^(?:[^\s/@]+@)?[^\s/:]+:\S+$/;

/** A remote the refresh may read: an absolute URL with a scheme, or the scp-like address git also accepts. */
function isRemote(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? SCHEME_URL.test(value) : SCP_URL.test(value);
}
