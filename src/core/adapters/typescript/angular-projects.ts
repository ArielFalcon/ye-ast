import { isPackageManifest } from "../../domain/languages/typescript.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import { manifestDependencies, manifestPackages, type ManifestPackages } from "./module-resolver.ts";

const FRAMEWORK_PACKAGES = ["@angular/core", "@angular/router"];

/** The directory of a `package.json` (`""` is the repository root) and what it depends on. */
export interface AngularProject {
  directory: string;
  dependencies: ReadonlySet<string>;
  /** What its sources resolve packages against: its own dependencies, and every package the snapshot declares. */
  packages: ManifestPackages;
}

/** Every directory that holds a `package.json` outside `node_modules`, with its dependencies. */
export function manifestsOf(files: readonly SourceFile[]): AngularProject[] {
  const manifests = files.filter((file) => isPackageManifest(file.path));
  const { declared } = manifestPackages(manifests);
  return manifests.map((file) => {
    const dependencies = manifestDependencies(file.content);
    return { directory: file.path.slice(0, Math.max(0, file.path.length - "package.json".length - 1)), dependencies, packages: { dependencies, declared } };
  });
}

/** The manifests that name the Angular framework, which bound the sources they hold. */
export function angularProjects(files: readonly SourceFile[]): AngularProject[] {
  return manifestsOf(files).filter((project) => FRAMEWORK_PACKAGES.some((name) => project.dependencies.has(name)));
}

/** The nearest project above `path`, or none. */
export function projectOf(path: string, projects: readonly AngularProject[]): AngularProject | undefined {
  const holders = projects.filter(({ directory }) => directory === "" || path.startsWith(`${directory}/`));
  return holders.reduce<AngularProject | undefined>((nearest, project) => (nearest === undefined || project.directory.length > nearest.directory.length ? project : nearest), undefined);
}

/** The paths grouped by the nearest project above them, and the ones no project holds. */
export interface ProjectPaths {
  /** The paths of each Angular project that names `framework`, by the nearest Angular project above them. */
  byProject: Map<AngularProject, string[]>;
  /** The paths no `package.json` above them holds, so nothing can say whether the framework reads them. */
  orphaned: string[];
}

/**
 * The paths of each Angular project that names `framework`, by the nearest Angular project above them, and the paths
 * no `package.json` above them holds. A manifest that names no Angular package still bounds its sources: nothing says
 * the framework reads them, so they are neither grouped nor orphaned.
 */
export function pathsByProject(paths: readonly string[], files: readonly SourceFile[], framework: string): ProjectPaths {
  const manifests = manifestsOf(files);
  const projects = angularProjects(files);
  const byProject = new Map<AngularProject, string[]>();
  const orphaned: string[] = [];
  for (const path of paths) {
    if (projectOf(path, manifests) === undefined) {
      orphaned.push(path);
      continue;
    }
    const project = projectOf(path, projects);
    if (project?.dependencies.has(framework) === true) byProject.set(project, [...(byProject.get(project) ?? []), path]);
  }
  return { byProject, orphaned };
}

/** Source roots explicitly declared by Angular workspace files above the source. */
export async function legacyRoots(file: string, read: (path: string) => Promise<string | undefined>): Promise<string[]> {
  const directories = file.split("/").slice(0, -1);
  for (let length = directories.length; length >= 0; length--) {
    const prefix = directories.slice(0, length).join("/");
    for (const name of ["angular.json", ".angular-cli.json"]) {
      const content = await read(prefix === "" ? name : `${prefix}/${name}`);
      if (content === undefined) continue;
      let workspace: { projects?: Record<string, { sourceRoot?: string }>; apps?: { root?: string }[] };
      try { workspace = JSON.parse(content); } catch { return []; }
      const roots = [...Object.values(workspace.projects ?? {}).map((project) => project.sourceRoot), ...(workspace.apps ?? []).map((app) => app.root)];
      return [...new Set(roots.filter((root): root is string => typeof root === "string").map((root) => [prefix, root].filter(Boolean).join("/")))].sort();
    }
  }
  return [];
}
