import type { ParseHold } from "../../ports/parse-holds.port.ts";
import { heldPaths } from "../navigation/snapshot-files.ts";
import { declaredScope } from "../../domain/map/entrypoint-map.ts";
import type { MemberProofContext } from "../../domain/relations/member-use.ts";
import type { DeclaredScope } from "../../domain/shared/fact.ts";
import { canonicalJson } from "../../domain/shared/canonical-json.ts";
import type { ScopeRequest } from "../../domain/shared/scope.ts";
import type { RelationExtraction, RelationExtractor } from "./relation-extractor.ts";
import type { CommitExtraction, PreparedCommit } from "../snapshot/read-snapshot.ts";

/**
 * The relations of one snapshot's sources, under the one retained key every query family reads them by, so impact and
 * trace at the same snapshot and scope share one extraction (ADR-0026).
 */
export function retainedRelations(
  extractor: RelationExtractor,
  prepared: PreparedCommit | undefined,
  tree: Pick<CommitExtraction, "export" | "sources">,
  request: { scope?: ScopeRequest; signal?: AbortSignal },
  hold?: ParseHold,
): Promise<RelationExtraction> {
  const memberProofs = memberProofContextOf(extractor, tree, declaredScope(request.scope));
  const completeSource = tree.export.stopped === undefined && (request.scope?.include?.length ?? 0) === 0 && (request.scope?.exclude?.length ?? 0) === 0;
  const produce = () => extractor.extract(tree.sources, {
    memberProofs, completeSource,
    paths: heldPaths(tree.export) ?? tree.export.files.map(({ path }) => path),
    ...(hold === undefined ? {} : { hold }),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  });
  return prepared?.retained === undefined ? produce() : prepared.retained(canonicalJson({ output: "relations", memberProofs }), produce, request.signal);
}

export function memberProofContextOf(extractor: Pick<RelationExtractor, "language">, tree: Pick<CommitExtraction, "export" | "sources">, scope: DeclaredScope): MemberProofContext {
  if (scope.include.length > 0 || scope.exclude.length > 0 || tree.export.stopped !== undefined || tree.export.skipped.length > 0) return { completeSource: false };
  const sources = new Set(tree.sources.map(({ path }) => path));
  return { completeSource: tree.export.files.every(({ path, written }) => !extractor.language.reads(path) || (written && sources.has(path))) };
}
