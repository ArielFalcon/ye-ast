import { isPackageManifest } from "../../domain/languages/typescript.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import { manifestDependencies } from "./module-resolver.ts";

const FRAMEWORK_PACKAGES = ["@angular/core", "@angular/router"];

/** The directory of a `package.json` that names the Angular framework (`""` is the repository root) and what it depends on. */
export interface AngularProject {
  directory: string;
  dependencies: ReadonlySet<string>;
}

export function angularProjects(files: readonly SourceFile[]): AngularProject[] {
  return files.filter((file) => isPackageManifest(file.path)).flatMap((file) => {
    const dependencies = manifestDependencies(file.content);
    return FRAMEWORK_PACKAGES.some((name) => dependencies.has(name)) ? [{ directory: file.path.slice(0, Math.max(0, file.path.length - "package.json".length - 1)), dependencies }] : [];
  });
}

/** The nearest project above `path`, or none. */
export function projectOf(path: string, projects: readonly AngularProject[]): AngularProject | undefined {
  const holders = projects.filter(({ directory }) => directory === "" || path.startsWith(`${directory}/`));
  return holders.reduce<AngularProject | undefined>((nearest, project) => (nearest === undefined || project.directory.length > nearest.directory.length ? project : nearest), undefined);
}

/** The paths of each project that names `framework`, by the nearest project above them. */
export function pathsByProject(paths: readonly string[], projects: readonly AngularProject[], framework: string): Map<AngularProject, string[]> {
  const grouped = new Map<AngularProject, string[]>();
  for (const path of paths) {
    const project = projectOf(path, projects);
    if (project?.dependencies.has(framework) === true) grouped.set(project, [...(grouped.get(project) ?? []), path]);
  }
  return grouped;
}
