import { test } from "node:test";
import assert from "node:assert/strict";
import type { Finding } from "../shared/fact.ts";
import { sortFindings } from "./finding-order.ts";

type Named = { kind: string; name: string };

function found(path: string, line: number, kind: string, name: string): Finding<Named> {
  return { status: "complete", value: { kind, name }, evidence: [{ path, line }] };
}

function gap(path: string, line: number): Finding<Named> {
  return { status: "unknown", reason: "unresolved", evidence: [{ path, line }] };
}

function labels(findings: readonly Finding<Named>[]): string[] {
  return findings.map((finding) => (finding.status === "complete" ? `${finding.evidence[0]?.path}:${finding.evidence[0]?.line} ${finding.value.kind} ${finding.value.name}` : `${finding.evidence[0]?.path}:${finding.evidence[0]?.line} unknown`));
}

test("findings are ordered by evidence path, then line numerically, then kind, then name, with an unknown item after the entrypoints at its location", () => {
  const sorted = sortFindings([
    found("b.ts", 2, "ui-route", "/a"),
    gap("a.ts", 10),
    found("a.ts", 10, "ui-route", "/z"),
    found("a.ts", 9, "ui-route", "/q"),
    found("a.ts", 10, "http-route", "GET /m"),
    found("a.ts", 10, "ui-route", "/b"),
    found("B.ts", 1, "ui-route", "/upper"),
  ]);

  assert.deepEqual(labels(sorted), [
    "B.ts:1 ui-route /upper",
    "a.ts:9 ui-route /q",
    "a.ts:10 http-route GET /m",
    "a.ts:10 ui-route /b",
    "a.ts:10 ui-route /z",
    "a.ts:10 unknown",
    "b.ts:2 ui-route /a",
  ]);
});

test("a finding that repeats another one is kept once", () => {
  const sorted = sortFindings([found("a.ts", 1, "ui-route", "/x"), found("a.ts", 1, "ui-route", "/x"), gap("a.ts", 1), gap("a.ts", 1)]);

  assert.deepEqual(labels(sorted), ["a.ts:1 ui-route /x", "a.ts:1 unknown"]);
});
