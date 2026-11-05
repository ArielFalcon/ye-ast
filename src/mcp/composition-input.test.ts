import { test } from "node:test";
import assert from "node:assert/strict";
import type { z } from "zod";
import { COMPOSE_INPUT, COMPOSE_LIMITS, COMPOSE_QUERY } from "./composition-input.ts";
import type { ComposeInput } from "./composition-contract.ts";
import type { ComposeQuery } from "./query-schema.ts";

const SHA = "a".repeat(40);
const R1 = `mcp-r1:${"a".repeat(64)}`;
const C1 = `mcp-c1:${"b".repeat(64)}`;
const outline = { name: "ye_ast_outline", arguments: { repo: "shop", revision: SHA, files: ["src/A.java"] } };
const entrypoints = { name: "ye_ast_entrypoints", arguments: { repo: "shop", revision: SHA } };

// The inferred output is the contract type: a schema drifting from ComposeInput/ComposeQuery fails to compile.
const asInput = (value: z.output<typeof COMPOSE_INPUT>): ComposeInput => value;
const asQuery = (value: z.output<typeof COMPOSE_QUERY>): ComposeQuery => value;
void asInput;
void asQuery;

const accepts = (value: unknown) => assert.equal(COMPOSE_INPUT.safeParse(value).success, true, JSON.stringify(value));
const rejects = (value: unknown) => assert.equal(COMPOSE_INPUT.safeParse(value).success, false, JSON.stringify(value));

test("accepts the closed union of the seven families and defaults mode to summary", () => {
  const queries = [
    { ...entrypoints, expect: R1 },
    { name: "ye_ast_impact", arguments: { repo: "shop", base: "main", head: SHA }, expect: R1 },
    { name: "ye_ast_callers", arguments: { targets: [{ file: "src/S.java", symbol: "S.find" }] }, expect: R1 },
    { name: "ye_ast_importers", arguments: { files: ["src/a.ts"] } },
    outline,
    { name: "ye_ast_workspace", arguments: { offline: true } },
    { name: "ye_ast_decisions", arguments: {} },
  ];
  const parsed = COMPOSE_INPUT.parse({ queries });
  assert.equal(parsed.mode, "summary");
  assert.deepEqual(parsed.queries, queries);
  assert.equal(COMPOSE_INPUT.parse({ queries, mode: "full", expect: C1, deadlineMs: 1 }).mode, "full");
});

test("query count is 1..16 before deduplication", () => {
  rejects({ queries: [] });
  accepts({ queries: [outline] });
  accepts({ queries: Array.from({ length: COMPOSE_LIMITS.maxQueries }, () => outline) });
  rejects({ queries: Array.from({ length: COMPOSE_LIMITS.maxQueries + 1 }, () => outline) });
  rejects({});
});

test("rejects unknown families, recursive compose and every nested control", () => {
  rejects({ queries: [{ name: "ye_ast_compose", arguments: { queries: [outline] } }] });
  rejects({ queries: [{ name: "ye_ast_unknown", arguments: {} }] });
  rejects({ queries: [{ name: "ye_ast_outline" }] });
  for (const control of [{ mode: "full" }, { select: { kind: "entrypoint-evidence", findingIndex: 0 } }, { page: { limit: 1 } }, { expect: R1 }]) {
    rejects({ queries: [{ ...entrypoints, arguments: { ...entrypoints.arguments, ...control } }] });
  }
  rejects({ queries: [{ ...entrypoints, mode: "full" }] });
  rejects({ queries: [{ ...entrypoints, select: { kind: "entrypoint-evidence", findingIndex: 0 }, page: { limit: 1 } }] });
  rejects({ queries: [outline], select: { kind: "entrypoint-evidence", findingIndex: 0 } });
  rejects({ queries: [outline], page: { limit: 1 } });
  rejects({ queries: [outline], extra: true });
});

test("source expectations only on the three recoverable families, as mcp-r1", () => {
  for (const name of ["ye_ast_importers", "ye_ast_outline", "ye_ast_workspace", "ye_ast_decisions"]) {
    rejects({ queries: [{ name, arguments: name === "ye_ast_importers" || name === "ye_ast_outline" ? { files: ["a"] } : {}, expect: R1 }] });
  }
  rejects({ queries: [{ ...entrypoints, expect: C1 }] });
  rejects({ queries: [{ ...entrypoints, expect: `mcp-r1:${"A".repeat(64)}` }] });
  rejects({ queries: [{ ...entrypoints, expect: `mcp-r1:${"a".repeat(63)}` }] });
});

test("root expectation is mcp-c1 and deadline is an integer 1..2147483647", () => {
  rejects({ queries: [outline], expect: R1 });
  rejects({ queries: [outline], expect: `mcp-c1:${"b".repeat(64)}x` });
  accepts({ queries: [outline], deadlineMs: 1 });
  accepts({ queries: [outline], deadlineMs: COMPOSE_LIMITS.maxDeadlineMs });
  for (const deadlineMs of [0, -1, 1.5, COMPOSE_LIMITS.maxDeadlineMs + 1, "10", Number.NaN]) rejects({ queries: [outline], deadlineMs });
});

test("the original semantic refinements apply inside compose", () => {
  rejects({ queries: [{ name: "ye_ast_outline", arguments: { files: ["a"], live: true, revision: SHA } }] });
  rejects({ queries: [{ name: "ye_ast_callers", arguments: { targets: [{ file: "a", symbol: "b" }], replay: { version: 1, declaration: `ws-r1:${"c".repeat(64)}`, snapshots: [] } } }] });
  rejects({ queries: [{ name: "ye_ast_callers", arguments: { targets: [{ file: "a", start: 5, end: 2 }] } }] });
  rejects({ queries: [{ name: "ye_ast_outline", arguments: { files: [] } }] });
  rejects({ queries: [{ name: "ye_ast_outline", arguments: { files: ["a"], scope: { include: ["../x"] } } }] });
  rejects({ queries: [{ name: "ye_ast_entrypoints", arguments: { live: true, offline: true } }] });
});
