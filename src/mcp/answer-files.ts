import type { Fact } from "../core/domain/shared/fact.ts";
import type { AnswerFiles } from "../core/ports/answer-files.port.ts";
import type { QueryFamily } from "../core/ports/evidence-composition.port.ts";
import { isRecord, type Json } from "./full-projection.ts";
import type { SemanticQuery } from "./query-schema.ts";
import { hasDeadline, hasUnavailableIndex } from "./recovery.ts";

/** The key of the result's `_meta` that carries the folder of the answer's files, a response-level sibling of the fact. */
export const ANSWER_FILES_META = "ye-ast/answer-files";

export interface AnswerContent {
  guide: string;
  fields: Json;
  summary: string;
  details: string;
}

/** Why an answer is outside the determinism promise and is never written (RFC-0002 rule 3): a wall-clock deadline cut it, or it could not read its index. */
export function unwrittenReason(fact: Fact<unknown>): string | undefined {
  if (hasDeadline(fact)) return "the answer was cut by a deadline";
  return hasUnavailableIndex(fact) ? "the index was unavailable" : undefined;
}

/** Why a reply names no folder besides the answer being outside the determinism promise. */
export const WITHHELD = {
  noCacheDirectory: "this server has no cache directory",
  notValid: "the full answer does not match its output schema",
  notWritten: "the folder could not be written",
} as const;

/** What closes a reply: the line naming its folder, or the line saying why none was written. */
export type Delivery = { folder?: string; line: string };

/** The delivery of a reply no folder was written for: the reply is `details` at most, and says why. */
export function withheld(reason: string): Delivery {
  return { line: `no answer file written: ${reason}` };
}

/** What decides the bytes of an answer's files: the question, the snapshot and the digests of every input of the fact. */
export function answerInputs(query: SemanticQuery, fact: Fact<unknown>): object {
  const { trust, scope, content, config, engines, buildOutputs } = fact.inputs;
  return { query, schema: fact.schema, producer: fact.producer, snapshot: fact.snapshot, inputs: { trust, scope, content, config, engines, buildOutputs } };
}

export function keepAnswer(files: AnswerFiles, tool: QueryFamily | "compose", inputs: object, { guide, fields, summary, details }: AnswerContent): Promise<string | null> {
  return files.keep({ tool, inputs, files: { "answer.json": JSON.stringify({ guide, ...fields }), "summary.txt": summary, "details.txt": details } });
}

/** The non-empty lists of an answer, by their path in `answer.json`: the members of `value`, those of a nested fact, and the cuts. */
function sections(fields: Json): string[] {
  const counted: string[] = [];
  const count = (path: string, member: unknown): void => {
    if (Array.isArray(member) && member.length > 0) counted.push(`${path} ${member.length}`);
  };
  for (const [name, member] of Object.entries(isRecord(fields["value"]) ? fields["value"] : {})) {
    count(`value.${name}`, member);
    if (isRecord(member)) count(`value.${name}.value`, member["value"]);
  }
  count("cuts", fields["cuts"]);
  return counted;
}

/** The last line of a summary or details reply: where the files are, that `answer.json` is the full result, and which lists it holds. */
export function answerFilesLine(folder: string, fields: Json): string {
  const lists = sections(fields);
  return `answer files: ${folder} — answer.json (the full result, queryable with jq)${lists.length === 0 ? "" : `: ${lists.join(", ")}`}; summary.txt, details.txt`;
}
