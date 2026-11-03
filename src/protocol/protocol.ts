export const PROTOCOL = { name: "ye-ast-query", version: 1 } as const;

export const METHOD = {
  hello: "hello",
  declareTrust: "trust.declare",
  cancel: "cancel",
  entrypointsMap: "entrypoints.map",
  impactOfChange: "impact.ofChange",
  impactCallers: "impact.callers",
  impactImporters: "impact.importers",
} as const;

/** The closed set of answers a call can fail with: JSON-RPC's own, one per fault family of the ports, and the protocol's. */
export const ERROR_CODE = {
  "parse-error": -32700,
  "invalid-request": -32600,
  "method-not-found": -32601,
  "invalid-params": -32602,
  "internal-error": -32603,
  "unknown-revision": -32000,
  "git-failed": -32001,
  "not-repository-root": -32002,
  "object-missing": -32003,
  "no-merge-base": -32004,
  "export-write-failed": -32005,
  aborted: -32006,
  "unknown-symbol": -32007,
  deadline: -32008,
  "trust-unsupported": -32009,
  "trust-not-declared": -32010,
  unreadable: -32011,
} as const;

export type ErrorKind = keyof typeof ERROR_CODE;

export type { TrustMode } from "../core/domain/shared/fact.ts";

export type RequestId = string | number;
