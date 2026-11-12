import { posix } from "node:path";
import { isAngularWorkspace, nxConfigurationOf } from "../../domain/languages/typescript.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";

export interface BuildScope {
  directory: string;
  root: string;
  target: Record<string, unknown> | undefined;
}

export interface BuildContext {
  documents: readonly { root: string; value: unknown }[];
  scopes: readonly BuildScope[];
}

export function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function supportedBuild(target: Record<string, unknown> | undefined): boolean {
  const builder = target?.["builder"] ?? target?.["executor"];
  return typeof builder === "string" && [":application", ":browser-esbuild"].some((suffix) => builder.endsWith(suffix));
}

export function angularBuildContext(files: readonly SourceFile[]): BuildContext | undefined {
  const roots = files.filter(({ path }) => nxConfigurationOf(path) === "workspace").map(({ path }) => posix.dirname(path)).sort((a, b) => b.length - a.length);
  const documents: { root: string; value: unknown }[] = [];
  const scopes: BuildScope[] = [];
  const defaultRoots: string[] = [];
  for (const file of files.filter(({ path }) => isAngularWorkspace(path) || nxConfigurationOf(path) !== undefined)) {
    const kind = nxConfigurationOf(file.path);
    const root = kind === "project" ? roots.find((dir) => dir === "." || file.path.startsWith(`${dir}/`)) : posix.dirname(file.path);
    let value: unknown;
    try { value = JSON.parse(file.content); } catch { return undefined; }
    const parsed = recordOf(value);
    if (parsed === undefined) return undefined;
    if (root === undefined) {
      if (typeof parsed["$schema"] === "string" && parsed["$schema"].endsWith("/nx/schemas/project-schema.json")) return undefined;
      continue;
    }
    documents.push({ root, value });
    if (kind === "workspace" && parsed["targetDefaults"] !== undefined) defaultRoots.push(root);
    const add = (project: unknown, defaultRoot: string): boolean => {
      const declared = recordOf(project);
      if (declared === undefined) return false;
      const projectRoot = declared["root"] ?? defaultRoot;
      if (typeof projectRoot !== "string" || !safePath(projectRoot)) return false;
      const targets = recordOf(declared["architect"] ?? declared["targets"]);
      const target = targets?.["build"];
      if (target !== undefined && recordOf(target) === undefined) return false;
      scopes.push({ directory: posix.join(root, projectRoot).replace(/^\.$/, ""), root, target: recordOf(target) });
      return true;
    };
    if (isAngularWorkspace(file.path)) {
      if (parsed["projects"] !== undefined) {
        const projects = recordOf(parsed["projects"]);
        if (projects === undefined || !Object.values(projects).every((project) => add(project, ""))) return undefined;
      }
    } else if (kind === "project" && !add(parsed, posix.relative(root, posix.dirname(file.path)))) return undefined;
  }
  return { documents, scopes: scopes.map((scope) => defaultRoots.includes(scope.root) && scope.target !== undefined ? { ...scope, target: {} } : scope) };
}

function safePath(path: string): boolean {
  return !posix.isAbsolute(path) && !path.split("/").includes("..") && !path.includes("\\");
}

/** All supported declared build entrypoints; undefined when a build cannot be proven. */
export function buildEntrypoints(files: readonly SourceFile[]): ReadonlySet<string> | undefined {
  const context = angularBuildContext(files);
  if (context === undefined) return undefined;
  const paths = new Set<string>();
  for (const { root, directory, target } of context.scopes) {
    if (target === undefined) continue;
    if (!supportedBuild(target)) return undefined;
    const options = recordOf(target["options"]);
    if (target["options"] !== undefined && options === undefined) return undefined;
    const configurations = recordOf(target["configurations"]);
    if (target["configurations"] !== undefined && configurations === undefined) return undefined;
    const states = [options ?? {}, ...Object.values(configurations ?? {}).map(recordOf)];
    for (const state of states) {
      if (state === undefined) return undefined;
      for (const key of ["browser", "main"]) {
        const path = Object.hasOwn(state, key) ? state[key] : options?.[key];
        if (path === undefined) continue;
        if (typeof path !== "string" || path === "" || !safePath(path)) return undefined;
        const resolved = posix.join(root, path);
        if (directory !== "" && resolved !== directory && !resolved.startsWith(`${directory}/`)) return undefined;
        paths.add(resolved);
      }
    }
  }
  return paths;
}
