import { decisionId, type DecisionKind } from "../core/domain/decisions/decision.ts";
import type { QueryFamily } from "../core/ports/evidence-composition.port.ts";
import { handlerPlace, isRecord, nestedFacts, type Json } from "./full-projection.ts";

/** The source answer a full projection stands for: every folded or referenced part put back where it was. */
export function expandFull(tool: QueryFamily, projected: Json): Json {
  const root = structuredClone(projected);
  const value = root["value"];
  if (!isRecord(value)) return root;
  for (const fact of nestedFacts(tool, value)) {
    fact["schema"] ??= root["schema"];
    fact["producer"] ??= root["producer"];
    fact["snapshot"] ??= root["snapshot"];
    const inputs: Json = { ...(root["inputs"] as Json) };
    for (const [key, entry] of Object.entries(isRecord(fact["inputs"]) ? fact["inputs"] : {})) { if (entry === null) delete inputs[key]; else inputs[key] = entry; }
    fact["inputs"] = inputs;
  }
  if (Array.isArray(value["sharedFindings"])) {
    const pool = value["sharedFindings"] as unknown[];
    for (const answer of Array.isArray(value["answers"]) ? value["answers"] : []) {
      if (isRecord(answer) && Array.isArray(answer["findings"])) answer["findings"] = answer["findings"].map((finding) => (isRecord(finding) && typeof finding["sharedFinding"] === "number" ? structuredClone(pool[finding["sharedFinding"]]) : finding));
    }
    delete value["sharedFindings"];
  }
  const entrypoints = value["entrypoints"];
  for (const finding of tool === "entrypoints" && isRecord(entrypoints) && Array.isArray(entrypoints["value"]) ? entrypoints["value"] : []) {
    const place = handlerPlace(finding as Json);
    if (place === undefined) continue;
    const { value: found } = finding as Json;
    for (const owner of [finding as Json, ...(isRecord((found as Json)["basePath"]) ? [(found as Json)["basePath"] as Json] : [])]) {
      if (isRecord(owner["evidence"]) && owner["evidence"]["sameAs"] === "handler") owner["evidence"] = [place];
    }
  }
  for (const decision of tool === "decisions" && Array.isArray(value["decisions"]) ? value["decisions"] : []) {
    if (isRecord(decision) && decision["id"] === undefined) decision["id"] = decisionId(decision["kind"] as DecisionKind, decision["subject"] as string);
  }
  return root;
}
