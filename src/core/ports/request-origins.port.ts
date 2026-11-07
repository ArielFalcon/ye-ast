import type { AccessPath } from "../domain/contracts/access-path.ts";
import type { Origin } from "../domain/contracts/request-origin.ts";

/** What a caller passes at one parameter: nothing (or `undefined`), which leaves the parameter to its default, or the origins of the argument. */
export type ArgumentOrigins = { kind: "omitted" } | { kind: "passed"; origins: readonly Origin[] };

/**
 * Follows a request body backward, syntax only, from the HTTP call that sends it to what builds the value at a path of
 * it. Reading stops at a function's parameter, which it hands back as a continuation the use case resolves at the
 * callers; whatever it cannot follow is a frontier with its reason, never an empty answer.
 */
export interface RequestOriginReader {
  /** The origins of the value at `path` of the body of the HTTP request made at the call site, in source order. */
  ofBody(site: { file: string; line: number; symbol: string }, path: AccessPath): Promise<readonly Origin[]>;
  /**
   * The origins of the value at `path` of the argument at `index` of the call of `callee` at `line` of `file`. `body`
   * says the argument is the whole request body, which a `JSON.stringify` of a value then serializes without changing.
   */
  ofArgument(call: { file: string; line: number; callee: string }, index: number, path: AccessPath, body: boolean): Promise<ArgumentOrigins>;
}
