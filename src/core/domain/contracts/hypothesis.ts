import type { HttpMethod } from "../entrypoints/http-route.ts";
import type { Result } from "../shared/result.ts";
import { ELEMENT, formatAccessPath, parseAccessPath, type AccessPath } from "./access-path.ts";

const HTTP_METHODS: readonly HttpMethod[] = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE", "ANY"];

export const CHANGE_KINDS = ["nullable", "removed"] as const;

export type ChangeKind = (typeof CHANGE_KINDS)[number];

/** What an operation exchanges that the hypothesis changes; only the response is followed. */
export const TARGETS = ["response"] as const;

/** The hypothesis as a caller writes it, before it is checked. */
export interface HypothesisInput {
  method: string;
  path: string;
  target: string;
  property: string;
  change: string;
}

/** One property of one operation's response changing, under the old guarantee that it was present and non-null. */
export interface Hypothesis {
  method: HttpMethod;
  path: string;
  target: (typeof TARGETS)[number];
  property: AccessPath;
  change: ChangeKind;
}

export interface HypothesisRefusal {
  kind: "invalid-method" | "invalid-path" | "unsupported-target" | "unsupported-change" | "invalid-property" | "element-is-not-a-property";
  detail: string;
}

export function parseHypothesis(input: HypothesisInput): Result<Hypothesis, HypothesisRefusal> {
  const method = HTTP_METHODS.find((verb) => verb === input.method.toUpperCase());
  if (method === undefined) return refuse("invalid-method", input.method);
  if (!input.path.startsWith("/")) return refuse("invalid-path", input.path);
  const target = TARGETS.find((candidate) => candidate === input.target);
  if (target === undefined) return refuse("unsupported-target", input.target);
  const change = CHANGE_KINDS.find((candidate) => candidate === input.change);
  if (change === undefined) return refuse("unsupported-change", input.change);
  const property = parseAccessPath(input.property);
  if (property === undefined || property.length === 0) return refuse("invalid-property", input.property);
  if (property[property.length - 1] === ELEMENT) return refuse("element-is-not-a-property", input.property);
  return { ok: true, value: { method, path: input.path, target, property, change } };
}

export function formatHypothesis(hypothesis: Hypothesis): string {
  return `${hypothesis.method} ${hypothesis.path} ${hypothesis.target} ${formatAccessPath(hypothesis.property)} ${hypothesis.change}`;
}

function refuse(kind: HypothesisRefusal["kind"], detail: string): Result<never, HypothesisRefusal> {
  return { ok: false, fault: { kind, detail } };
}
