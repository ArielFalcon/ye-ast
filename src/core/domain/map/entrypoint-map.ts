import type { Entrypoint } from "../entrypoints/entrypoint.ts";
import { isExtractorConfiguration } from "../languages/configuration.ts";
import { isJavaSource, isJvmTestFile } from "../languages/java.ts";
import { cutsCompleteness } from "../languages/uncovered.ts";
import { isAngularTemplate, isTypeScriptSource } from "../languages/typescript.ts";
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

/**
 * The entrypoints of a snapshot. An item is a `Finding`, not a fact: it carries only what can differ per item (its
 * status, value or reason, and its evidence), while the schema, snapshot, producer and inputs are the collection's
 * ([RFC-0002](../../../docs/architecture/rfc/0002-facts-contract.md) rule 2).
 */
export type EntrypointMap = { entrypoints: Fact<readonly Finding<Entrypoint>[]> };

export type EntrypointMapFact = CompleteFact<EntrypointMap> | PartialFact<EntrypointMap>;

export type MapBase = Omit<FactBase, "evidence">;

const MAP_SCOPE = { languages: ["java", "typescript"], frameworks: ["angular", "spring"] } as const;

const SUBMODULE = "submodule";

/**
 * What the export writes and digests: the Java and TypeScript sources outside tests, the `.html` templates a component
 * names, which the relation reader parses and a change to which must invalidate the fact, and every configuration file
 * an extractor reads to interpret them (`isExtractorConfiguration`).
 */
export function isInMapScope(path: string): boolean {
  return (isJavaSource(path) && !isJvmTestFile(path)) || isTypeScriptSource(path) || isAngularTemplate(path) || isExtractorConfiguration(path);
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
export function contentFingerprint({ files, skipped, stopped }: MapExport, sourceSelection: (path: string) => boolean = isInMapScope): string {
  const declared = holdsDeclaredSource(files);
  const parts: [string, ...string[]][] = [
    ...files
      .filter((file) => sourceSelection(file.path) || cutsCompleteness(file.path, declared))
      .map((file): [string, ...string[]] => [sourceSelection(file.path) ? "source" : "unsupported", file.path, file.blob]),
    ...skipped.map((entry): [string, ...string[]] => ["skipped", entry.path, entry.reason]),
    ...(stopped === undefined ? [] : [["stopped", stopped.at] satisfies [string, ...string[]]]),
  ];
  return JSON.stringify(parts.map((part) => JSON.stringify(part)).toSorted());
}

/** Whether the export holds a source of a declared language, so the repository has something an answer can read. */
export function holdsDeclaredSource(files: MapExport["files"]): boolean {
  return files.some((file) => isJavaSource(file.path) || isTypeScriptSource(file.path));
}

/** The section is cut, so the entrypoint table never looks complete, by every cause `exportCuts` names. */
export function buildEntrypointMap(base: MapBase, findings: readonly Finding<Entrypoint>[], exported: MapExport): EntrypointMapFact {
  const [first, ...rest] = exportCuts(exported);
  const section: Fact<readonly Finding<Entrypoint>[]> =
    first === undefined
      ? { ...base, evidence: [], status: "complete", value: findings }
      : { ...base, evidence: [], status: "partial", value: findings, cuts: [first, ...rest] };
  return composeSections({ ...base, evidence: [] }, { entrypoints: section });
}

/**
 * What the export leaves unread: a budget that stopped it (`caller-budget`), every in-scope path or submodule it left
 * out (`not-exported`) and every listed source an answer could have derived from (`no-extractor`).
 */
export function exportCuts(exported: MapExport): Cut[] {
  const declared = holdsDeclaredSource(exported.files);
  return [
    ...(exported.stopped === undefined ? [] : [{ kind: "caller-budget", at: [exported.stopped.at], limit: exported.stopped.limit } satisfies Cut]),
    ...cutsAt(
      "not-exported",
      exported.skipped.filter((entry) => entry.reason === SUBMODULE || isInMapScope(entry.path)).map((entry) => entry.path),
    ),
    ...cutsAt(
      "no-extractor",
      exported.files.map((file) => file.path).filter((path) => cutsCompleteness(path, declared)),
    ),
  ];
}

function cutsAt(kind: Cut["kind"], paths: readonly string[]): Cut[] {
  return paths.toSorted().map((path) => ({ kind, at: [path] }));
}
