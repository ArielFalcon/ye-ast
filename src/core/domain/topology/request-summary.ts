import type { Evidence } from "../shared/fact.ts";
import type { HttpMethod } from "../entrypoints/http-route.ts";
import type { SummaryCause } from "./call-site-diagnostic.ts";
export { SUMMARY_CAUSES, type SummaryCause } from "./call-site-diagnostic.ts";
import type { RequestUrlPart } from "./request-url.ts";

/** Which of the function's own parameters supplies the request body. */
export type BodySource = { kind: "parameter"; index: number } | { kind: "none" } | { kind: "unknown"; index: number };

/** A run-time choice inside the path the code writes: a condition on one of the function's own parameters. */
export interface PathCondition {
  parameter: number;
  test: "truthy" | "falsy";
}

/**
 * One request a function can make, stated over its own parameters: `path` is the whole URL the leaf writes — the
 * function's own text, consts and fields folded — with `{}` where one of the function's parameters is read, in source
 * order. A hole is not a cut: it is a value the call supplies.
 */
export interface RequestShape {
  url?: readonly RequestUrlPart[];
  /** Limitations that can invalidate this occurrence; absent when no occurrence-level relevance was established. */
  gaps?: readonly SummaryGap[];
  transport: "http" | "event";
  /** Undefined when the verb is a value an argument fills. */
  method: HttpMethod | undefined;
  path: string;
  /** One entry per `{}` of `path`, in order: the parameter index that hole reads, or undefined for a run-time value that is not a parameter. */
  holes: readonly (number | undefined)[];
  /** A part of the destination that the summary cannot establish, independent of parameter holes. */
  unresolved?: SummaryGap;
  body: BodySource;
  /** Present when the shape holds only under this test of the parameter; several shapes of one leaf split by a conditional. */
  when?: PathCondition;
  /** The request-writing calls this shape passes through inside the function, nearest last. */
  hops: readonly { function: Evidence; call: Evidence; forwarded: Evidence }[];
}

/** How the function's return carries a response body. */
export type ResultShape =
  | { kind: "none" }
  | {
      kind: "body";
      container: "plain" | "observable" | "promise" | "resource";
      /** `response` when the request is observed with `observe: 'response'`, so the body sits under `body`. */
      observed: "body" | "response";
      /** The access path a projection maps the body to, when the function returns one mapped value. */
      projection?: readonly string[];
    }
  | { kind: "unknown"; cause: SummaryCause; evidence: readonly Evidence[] };

export interface SummaryGap {
  cause: SummaryCause;
  /** Where the undecided reading is: the declaration, the call, the argument. */
  evidence: readonly Evidence[];
}

/**
 * One call that hands a value on without being a declaration of its own (a framework function, never a snapshot type):
 * where the carried expression sits, which parameters the callback receives, and what the call returns.
 */
export interface ForwardingRow {
  /** The callee's name: `defer`, `from`, `firstValueFrom`, `asReadonly`, `computed`, `signal`, `resource`, `linkedSignal`. */
  name: string;
  /** Where the declaration's own expression sits in the call: an argument index, or the receiver for a no-argument member. */
  carries: { kind: "argument"; index: number } | { kind: "receiver" };
  /** The parameters a carried callback receives, by index: `carries` names the callback, these name what it is called with. */
  callback?: readonly { index: number; from: { kind: "result" } | { kind: "receiver" } }[];
  /** What the call itself returns: the carried value unchanged, or the carried value in a container. */
  returns: { kind: "same" } | { kind: "container"; container: "observable" | "promise" | "resource" | "signal" };
}

/**
 * What one declaration does with its parameters and its return. `shapes` empty and `gaps` empty is a proof that the
 * body issues no request of the pack's vocabulary; `undefined` from the lookup means "not a snapshot declaration".
 */
export interface RequestSummary {
  shapes: readonly RequestShape[];
  result: ResultShape;
  /** Limits on enumerating the declaration's requests, including gaps independent of an identified occurrence. */
  gaps: readonly SummaryGap[];
}
