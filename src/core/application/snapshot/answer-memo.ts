import { canonicalJson } from "../../domain/shared/canonical-json.ts";
import { SCHEMA, type Fact, type Producer } from "../../domain/shared/fact.ts";
import type { Result } from "../../domain/shared/result.ts";
import { WORKSPACE_SCOPE } from "../../domain/shared/scope.ts";
import { isKeptAnswer } from "../../domain/snapshot/answer-memo.ts";
import type { ImpactCallersRequest, ImpactImportersRequest } from "../../ports/impact-queries.port.ts";
import type { OutlineRequest } from "../../ports/outline-queries.port.ts";
import type { TraceRequest } from "../../ports/trace-queries.port.ts";
import type { PreparedCommit } from "./read-snapshot.ts";

/**
 * What a request field is to the answer memo (ADR-0151 decision 3): part of the key; left out because the memo sits
 * inside the call it serves (the signal, the staleness callback); or an input the key cannot name, whose presence keeps
 * the answer from being kept.
 */
type FieldRole = "key" | "excluded" | "refuses";

type FieldsOf<Request> = Request extends unknown ? keyof Request : never;

/** One role per field of every variant of `Request`: a field added to the request without a role fails to compile. */
type FieldTable<Request> = { readonly [Field in FieldsOf<Request>]-?: FieldRole };

const CALLERS_FIELDS: FieldTable<ImpactCallersRequest> = {
  [WORKSPACE_SCOPE]: "key",
  repo: "key",
  source: "key",
  repoId: "key",
  targets: "key",
  scope: "key",
  budget: "key",
  buildOutputs: "refuses",
  signal: "excluded",
  revision: "key",
  live: "key",
  onStale: "excluded",
};

const IMPORTERS_FIELDS: FieldTable<ImpactImportersRequest & { synthesized?: true }> = {
  repo: "key",
  repoId: "key",
  files: "key",
  scope: "key",
  signal: "excluded",
  revision: "key",
  live: "key",
  onStale: "excluded",
  synthesized: "key",
};

const OUTLINE_FIELDS: FieldTable<OutlineRequest> = {
  repo: "key",
  repoId: "key",
  scope: "key",
  signal: "excluded",
  files: "key",
  focus: "key",
  revision: "key",
  live: "key",
  onStale: "excluded",
};

/** A workspace-scoped trace reads library sources its workspace operation hands it, which the request does not name. */
const TRACE_FIELDS: FieldTable<TraceRequest> = {
  [WORKSPACE_SCOPE]: "refuses",
  workspace: "refuses",
  offline: "key",
  source: "key",
  repo: "key",
  repoId: "key",
  targets: "key",
  buildOutputs: "refuses",
  budget: "key",
  scope: "key",
  signal: "excluded",
  revision: "key",
  live: "key",
  onStale: "excluded",
};

export const ANSWER_FIELDS = { callers: CALLERS_FIELDS, importers: IMPORTERS_FIELDS, outline: OUTLINE_FIELDS, trace: TRACE_FIELDS } as const;

export type AnswerFamily = keyof typeof ANSWER_FIELDS;

/** What names the snapshot an answer was derived from: for the live tree its content, the pinned store generation and HEAD; for a sha the commit and the digest of its export. */
export type AnswerSnapshot = { kind: "live"; stateId: string; generation: string | undefined; head: string } | { kind: "sha"; sha: string; content: string };

export type AnswerMemoOutcome = "hit" | "admitted" | "not-kept";

/**
 * The request as the key names it: every field the family's table keys, by name, or nothing when a field the table
 * does not list, or one that refuses, is present.
 */
export function canonicalRequest(family: AnswerFamily, request: object): Record<string, unknown> | undefined {
  const table: Readonly<Record<PropertyKey, FieldRole | undefined>> = ANSWER_FIELDS[family];
  const keyed: Record<string, unknown> = {};
  for (const field of Reflect.ownKeys(request)) {
    const value = (request as Record<PropertyKey, unknown>)[field];
    if (value === undefined) continue;
    const role = table[field];
    if (role === undefined || role === "refuses") return undefined;
    if (role === "key") keyed[typeof field === "symbol" ? `symbol:${field.description ?? ""}` : field] = value;
  }
  return keyed;
}

export interface AnswerSlot {
  family: AnswerFamily;
  request: object;
  snapshot: AnswerSnapshot;
  engines: Readonly<Record<string, string>>;
  declaredConfig: object;
  producer: Producer;
}

/** The slot of an answer under its snapshot's entry, or nothing when the answer must not be kept. */
export function answerSlot(slot: AnswerSlot): string | undefined {
  const request = canonicalRequest(slot.family, slot.request);
  if (request === undefined || (slot.snapshot.kind === "live" && slot.snapshot.generation === undefined)) return undefined;
  return canonicalJson({ answer: slot.family, request, snapshot: slot.snapshot, engines: slot.engines, declaredConfig: slot.declaredConfig, producer: slot.producer, schema: SCHEMA });
}

/**
 * The fact `run` answers, kept under `slot` in the snapshot's retained outputs when it may be (ADR-0151): a kept fact is
 * answered without running; a failed result, an aborted call or a fact `isKeptAnswer` refuses is answered and not kept.
 */
export async function rememberedAnswer<V, E>(
  retained: PreparedCommit["retained"],
  slot: string | undefined,
  signal: AbortSignal | undefined,
  run: () => Promise<Result<Fact<V>, E>>,
  observe?: (outcome: AnswerMemoOutcome) => void,
): Promise<Result<Fact<V>, E>> {
  if (retained === undefined || slot === undefined) {
    observe?.("not-kept");
    return run();
  }
  const call: { ran?: Result<Fact<V>, E>; kept: boolean } = { kept: false };
  const fact = await retained<Fact<V> | undefined>(slot, async () => {
    const ran = (call.ran = await run());
    return ran.ok ? ran.value : undefined;
  }, signal, (answer) => (call.kept = answer !== undefined && isKeptAnswer(answer)));
  observe?.(call.ran === undefined ? "hit" : call.kept ? "admitted" : "not-kept");
  if (call.ran !== undefined && !call.ran.ok) return call.ran;
  return { ok: true, value: fact! };
}
