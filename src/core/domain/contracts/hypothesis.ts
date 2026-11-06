import type { HttpMethod } from "../entrypoints/http-route.ts";
import type { Result } from "../shared/result.ts";
import { ELEMENT, formatAccessPath, parseAccessPath, type AccessPath } from "./access-path.ts";
import { formatChange, parseChange, type Change, type ChangeInput, type ChangeRefusal } from "./change.ts";

const HTTP_METHODS: readonly HttpMethod[] = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE", "ANY"];

/** What an operation exchanges that the hypothesis changes; only the response is followed. */
export const TARGETS = ["response"] as const;

/** The hypothesis as a caller writes it, before it is checked. */
export interface HypothesisInput {
  method: string;
  path: string;
  target: string;
  property: string;
  change: ChangeInput;
}

/** One property of one operation's response changing, under the old guarantee that it was present and non-null. */
export interface Hypothesis {
  method: HttpMethod;
  path: string;
  target: (typeof TARGETS)[number];
  property: AccessPath;
  change: Change;
}

export interface HypothesisRefusal {
  kind: "invalid-method" | "invalid-path" | "unsupported-target" | "invalid-property" | "element-is-not-a-property" | ChangeRefusal["kind"];
  detail: string;
}

export function parseHypothesis(input: HypothesisInput): Result<Hypothesis, HypothesisRefusal> {
  const method = HTTP_METHODS.find((verb) => verb === input.method.toUpperCase());
  if (method === undefined) return refuse("invalid-method", input.method);
  if (!input.path.startsWith("/")) return refuse("invalid-path", input.path);
  const target = TARGETS.find((candidate) => candidate === input.target);
  if (target === undefined) return refuse("unsupported-target", input.target);
  const property = parseAccessPath(input.property);
  if (property === undefined || property.length === 0) return refuse("invalid-property", input.property);
  if (property[property.length - 1] === ELEMENT) return refuse("element-is-not-a-property", input.property);
  const change = parseChange(input.change, property);
  if (!change.ok) return change;
  return { ok: true, value: { method, path: input.path, target, property, change: change.value } };
}

export function formatHypothesis(hypothesis: Hypothesis): string {
  return `${hypothesis.method} ${hypothesis.path} ${hypothesis.target} ${formatAccessPath(hypothesis.property)} ${formatChange(hypothesis.change)}`;
}

function refuse(kind: HypothesisRefusal["kind"], detail: string): Result<never, HypothesisRefusal> {
  return { ok: false, fault: { kind, detail } };
}
