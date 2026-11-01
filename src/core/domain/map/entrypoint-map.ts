import type { Entrypoint } from "../entrypoints/entrypoint.ts";
import { isJavaSource } from "../languages/java.ts";
import { isJvmBuildFile } from "../languages/jvm-build.ts";
import { isUncoveredSource } from "../languages/uncovered.ts";
import { isSpringConfigFile } from "../languages/spring-config.ts";
import { isAngularTemplate, isModuleConfigFile, isPackageManifest, isTypeScriptSource } from "../languages/typescript.ts";
import {
  composeSections,
  type CompleteFact,
  type Cut,
  type DeclaredScope,
  type Fact,
  type FactBase,
  type Finding,
  type PartialFact,
} from "../shared/fact.ts";
import { sortedGlobs, type ScopeRequest } from "../shared/scope.ts";

export type EntrypointMap = { entrypoints: Fact<readonly Fact<Entrypoint>[]> };

export type EntrypointMapFact = CompleteFact<EntrypointMap> | PartialFact<EntrypointMap>;

export type MapBase = Omit<FactBase, "evidence">;

const MAP_SCOPE = { languages: ["java", "typescript"], frameworks: ["angular", "spring"] } as const;

const SUBMODULE = "submodule";

/**
 * What the export writes and digests: the Java sources the extractor parses, the build files it reads for a declared
 * source generator, the Spring config files it reads for the base path, and for Angular the TypeScript sources outside
 * tests, the `package.json` files that name the framework of a project, the `tsconfig` files that resolve a module specifier and
 * the `.html` templates a component names, which the relation reader parses and a change to which must invalidate the
 * fact.
 */
export function isInMapScope(path: string): boolean {
  return isJavaSource(path) || isJvmBuildFile(path) || isSpringConfigFile(path) || isTypeScriptSource(path) || isPackageManifest(path) || isModuleConfigFile(path) || isAngularTemplate(path);
}

export function declaredScope(request: ScopeRequest = {}): DeclaredScope {
  return { ...MAP_SCOPE, include: sortedGlobs(request.include), exclude: sortedGlobs(request.exclude) };
}

export interface MapExport {
  /** Every regular file the export accepted, written or not. */
  files: readonly { path: string; blob: string; written: boolean }[];
  /** Every entry the export left out, with its reason. */
  skipped: readonly { path: string; reason: string }[];
  /** Where a budget stopped the export; nothing at or after that path was exported. */
  stopped?: { at: string; limit: number };
}

/**
 * Everything of the export that decides the fact, unambiguously encoded and sorted so the order of the lists does not
 * matter (RFC-0002 rule 5): the blob of every in-scope file (the blob ids stand for the content), the path and blob of
 * every uncovered source that produces a cut, every skipped entry with its reason, and where a budget stopped
 * the export.
 */
export function contentFingerprint({ files, skipped, stopped }: MapExport): string {
  const parts: [string, ...string[]][] = [
    ...files
      .filter((file) => isInMapScope(file.path) || isUncoveredSource(file.path))
      .map((file): [string, ...string[]] => [isInMapScope(file.path) ? "source" : "unsupported", file.path, file.blob]),
    ...skipped.map((entry): [string, ...string[]] => ["skipped", entry.path, entry.reason]),
    ...(stopped === undefined ? [] : [["stopped", stopped.at] satisfies [string, ...string[]]]),
  ];
  return JSON.stringify(parts.map((part) => JSON.stringify(part)).toSorted());
}

/** The section is cut, so the entrypoint table never looks complete, by every cause `exportCuts` names. */
export function buildEntrypointMap(base: MapBase, findings: readonly Finding<Entrypoint>[], exported: MapExport): EntrypointMapFact {
  const items = findings.map((finding): Fact<Entrypoint> => itemFact(base, finding));
  const [first, ...rest] = exportCuts(exported);
  const section: Fact<readonly Fact<Entrypoint>[]> =
    first === undefined
      ? { ...base, evidence: [], status: "complete", value: items }
      : { ...base, evidence: [], status: "partial", value: items, cuts: [first, ...rest] };
  return composeSections({ ...base, evidence: [] }, { entrypoints: section });
}

/**
 * What the export leaves unread: a budget that stopped it (`caller-budget`), every in-scope path or submodule it left
 * out (`not-exported`) and every listed source file whose language has no extractor (`no-extractor`).
 */
export function exportCuts(exported: MapExport): Cut[] {
  return [
    ...(exported.stopped === undefined ? [] : [{ kind: "caller-budget", at: [exported.stopped.at], limit: exported.stopped.limit } satisfies Cut]),
    ...cutsAt(
      "not-exported",
      exported.skipped.filter((entry) => entry.reason === SUBMODULE || isInMapScope(entry.path)).map((entry) => entry.path),
    ),
    ...cutsAt(
      "no-extractor",
      exported.files.map((file) => file.path).filter(isUncoveredSource),
    ),
  ];
}

function cutsAt(kind: Cut["kind"], paths: readonly string[]): Cut[] {
  return paths.toSorted().map((path) => ({ kind, at: [path] }));
}

function itemFact(base: MapBase, finding: Finding<Entrypoint>): Fact<Entrypoint> {
  return finding.status === "complete"
    ? { ...base, evidence: finding.evidence, status: "complete", value: finding.value }
    : { ...base, evidence: finding.evidence, status: "unknown", reason: finding.reason };
}
