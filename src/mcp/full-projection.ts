import { canonicalJson } from "../core/domain/shared/canonical-json.ts";
import { decisionId, type DecisionKind } from "../core/domain/decisions/decision.ts";
import type { QueryFamily } from "../core/ports/evidence-composition.port.ts";

export type Json = Record<string, unknown>;
export const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const same = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);
const recordsOf = (value: unknown): Json[] => (Array.isArray(value) ? value.filter(isRecord) : []);

/** The full JSON of an answer with each repeated part stated once (ADR-0109), and the lines that say how to read what was folded. */
export interface FullProjection {
  fields: Json;
  guidance: readonly string[];
}

const NESTED_ENVELOPE_GUIDE = "Nested facts omit schema, snapshot, producer and the inputs keys they share with the answer (an inputs key null: absent there).";
const SHARED_FINDING_GUIDE = "A finding {sharedFinding: n} in value.answers[].findings is value.sharedFindings[n], shared by several answers.";
const SAME_HANDLER_GUIDE = "Evidence {sameAs: \"handler\"} is the place of the finding's value.handler.";
const DECISION_ID_GUIDE = "A decision without id has the id kind:subject.";

/** The facts a family nests under their own envelope inside the value. */
export function nestedFacts(tool: QueryFamily, value: Json): Json[] {
  const found: Json[] = [];
  if (tool === "entrypoints" && isRecord(value["entrypoints"])) found.push(value["entrypoints"]);
  const change = value["change"];
  if (tool === "contract_consequences" && isRecord(change) && isRecord(change["derivation"])) found.push(change["derivation"]);
  for (const section of isRecord(value["sections"]) ? Object.values(value["sections"]) : []) {
    if (!isRecord(section)) continue;
    found.push(section);
    const inner = section["value"];
    for (const read of isRecord(inner) ? recordsOf(inner["reads"]) : []) if (isRecord(read["fact"])) found.push(read["fact"]);
  }
  return found;
}

function foldEnvelope(fact: Json, root: Json): boolean {
  let folded = false;
  for (const key of ["schema", "snapshot", "producer"]) {
    if (key in fact && same(fact[key], root[key])) { delete fact[key]; folded = true; }
  }
  const { inputs } = fact;
  const rootInputs = root["inputs"];
  if (!isRecord(inputs) || !isRecord(rootInputs)) return folded;
  const delta: Json = Object.fromEntries(Object.entries(inputs).filter(([key, entry]) => !same(entry, rootInputs[key])));
  for (const key of Object.keys(rootInputs)) if (!(key in inputs)) delta[key] = null;
  const changed = !same(delta, inputs);
  if (Object.keys(delta).length === 0) delete fact["inputs"]; else fact["inputs"] = delta;
  return folded || changed;
}

function shareFindings(value: Json): boolean {
  const answers = recordsOf(value["answers"]);
  const occurrences = answers.flatMap((answer) => (Array.isArray(answer["findings"]) ? answer["findings"] : []));
  const repeated = new Set([...Map.groupBy(occurrences, (finding) => canonicalJson(finding))].filter(([, group]) => group.length > 1).map(([key]) => key));
  if (repeated.size === 0) return false;
  const pool: unknown[] = [];
  const indexes = new Map<string, number>();
  for (const answer of answers) {
    if (!Array.isArray(answer["findings"])) continue;
    answer["findings"] = answer["findings"].map((finding) => {
      const key = canonicalJson(finding);
      if (!repeated.has(key)) return finding;
      if (!indexes.has(key)) { indexes.set(key, pool.length); pool.push(finding); }
      return { sharedFinding: indexes.get(key) };
    });
  }
  value["sharedFindings"] = pool;
  return true;
}

export function handlerPlace(finding: Json): Json | undefined {
  const { value } = finding;
  const handler = isRecord(value) ? value["handler"] : undefined;
  return isRecord(handler) ? { path: handler["path"], line: handler["line"], ...(handler["endLine"] === undefined ? {} : { endLine: handler["endLine"] }) } : undefined;
}

function foldHandlerPlaces(value: Json): boolean {
  const section = value["entrypoints"];
  let folded = false;
  for (const finding of isRecord(section) ? recordsOf(section["value"]) : []) {
    const place = handlerPlace(finding);
    if (place === undefined) continue;
    const { basePath } = finding["value"] as Json;
    for (const owner of isRecord(basePath) ? [finding, basePath] : [finding]) {
      const { evidence } = owner;
      if (Array.isArray(evidence) && evidence.length === 1 && same(evidence[0], place)) { owner["evidence"] = { sameAs: "handler" }; folded = true; }
    }
  }
  return folded;
}

function foldDecisionIds(value: Json): boolean {
  let folded = false;
  for (const decision of recordsOf(value["decisions"])) {
    if (decision["id"] === decisionId(decision["kind"] as DecisionKind, decision["subject"] as string)) { delete decision["id"]; folded = true; }
  }
  return folded;
}

/**
 * The result JSON of a full answer with every part its places repeat stated once. The source fields are not changed; an
 * answer without a value (unknown) has nothing to fold.
 */
export function projectFull(tool: QueryFamily, source: Json): FullProjection {
  if (!isRecord(source["value"])) return { fields: source, guidance: [] };
  const fields = structuredClone(source);
  const value = fields["value"] as Json;
  const guidance: string[] = [];
  const folded = nestedFacts(tool, value).map((nested) => foldEnvelope(nested, fields));
  if (folded.includes(true)) guidance.push(NESTED_ENVELOPE_GUIDE);
  if (tool === "contract_consequences" && shareFindings(value)) guidance.push(SHARED_FINDING_GUIDE);
  if (tool === "entrypoints" && foldHandlerPlaces(value)) guidance.push(SAME_HANDLER_GUIDE);
  if (tool === "decisions" && foldDecisionIds(value)) guidance.push(DECISION_ID_GUIDE);
  return { fields, guidance };
}
