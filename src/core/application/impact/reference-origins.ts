import { kindOfChangedFile } from "../../domain/change/changed-file.ts";
import type { MemberProofContext } from "../../domain/relations/member-use.ts";
import { isTypeScriptSource } from "../../domain/languages/typescript.ts";
import type { DeclaredScope } from "../../domain/shared/fact.ts";
import { referenceKey, rootedName, uniqueReferenceKeys } from "../../domain/impact/impact-cuts.ts";
import type { CodeGraphReader, GraphUnresolvedReference } from "../../ports/code-graph.port.ts";
import type { ImportOriginSite, ImportOrigins } from "../../ports/import-origins.port.ts";
import type { CommitExtraction } from "../snapshot/read-snapshot.ts";

/** The head's sources the walk reads: written, in scope, and of a kind an extractor covers. */
export function sourceFilesOf(headTree: Pick<CommitExtraction, "export">): string[] {
  return headTree.export.files.filter((file) => file.written && kindOfChangedFile(file.path) === "source").map((file) => file.path);
}

/** The references the index could not settle in the head's sources. */
export function unresolvedOf(store: CodeGraphReader, headTree: Pick<CommitExtraction, "export">): readonly GraphUnresolvedReference[] {
  return store.unresolvedReferences(sourceFilesOf(headTree));
}

/**
 * The two proofs a file's own imports make about the references the index could not settle: the places whose root the
 * proof places outside the repository, and the file a bare name imported from the repository resolves to. The first
 * retires a cut (`ADR-0019`); the second is what lets a bare reference be attributed to the declaration it actually
 * names instead of to a homonym (`RFC-0016` S12). A file the reader does not know proves nothing.
 */
export async function referenceProofsOf(reader: ImportOrigins | undefined, store: CodeGraphReader, headTree: Pick<CommitExtraction, "export" | "sources">, signal?: AbortSignal, read: readonly GraphUnresolvedReference[] = unresolvedOf(store, headTree)): Promise<ReferenceProofs> {
  const external = new Set<string>();
  const bound = new Map<string, string>();
  const localParameters = new Set<string>();
  const validOccurrences = new Set<string>();
  const thisMemberCalls = new Set<string>();
  if (reader === undefined) return { external, bound, localParameters, validOccurrences, thisMemberCalls };
  const unique = uniqueReferenceKeys(read);
  const asked = read.flatMap((reference) => {
    const key = referenceKey(reference);
    const name = rootedName(reference.name);
    if (key === undefined || !unique.has(key) || reference.kind === "imports" || !name) return [];
    const site: ImportOriginSite = { file: reference.file, line: reference.line, column: reference.column + 1, name, fullName: reference.name, kind: reference.kind };
    return [{ key, reference, site }];
  });
  const findings = await reader.origins(asked.map(({ site }) => site), signal);
  for (const [index, { key, reference }] of asked.entries()) {
    const finding = findings[index];
    if (finding?.occurrence === true) validOccurrences.add(key);
    if (finding?.status !== "complete" || finding.occurrence !== true) continue;
    if (finding.value.kind === "external" || finding.value.kind === "ambient") external.add(key);
    if (finding.value.kind === "repository") bound.set(key, finding.value.file);
    if (finding.value.kind === "local-parameter" && reference.name === finding.value.name && reference.kind === "calls") localParameters.add(key);
    if (finding.value.kind === "this-member" && reference.name === finding.value.name && reference.kind === "calls") thisMemberCalls.add(key);
  }
  return { external, bound, localParameters, validOccurrences, thisMemberCalls };
}

/** What a file's own imports prove about the references the index could not settle. */
export interface ReferenceProofs {
  /** Places whose root a proof puts outside the repository: an import binding, or an ambient library name. */
  external: ReadonlySet<string>;
  /** The file a bare name imported from the repository resolves to, keyed by the complete occurrence. */
  bound: ReadonlyMap<string, string>;
  localParameters: ReadonlySet<string>;
  validOccurrences: ReadonlySet<string>;
  /** Bare graph calls the syntax writes on `this` inside a class member, keyed by the complete occurrence. */
  thisMemberCalls: ReadonlySet<string>;
}

export function memberProofContextOf(tree: Pick<CommitExtraction, "export" | "sources">, scope: DeclaredScope): MemberProofContext {
  if (scope.include.length > 0 || scope.exclude.length > 0 || tree.export.stopped !== undefined || tree.export.skipped.length > 0) return { completeSource: false };
  const sources = new Set(tree.sources.map(({ path }) => path));
  return { completeSource: tree.export.files.every(({ path, written }) => !isTypeScriptSource(path) || (written && sources.has(path))) };
}
