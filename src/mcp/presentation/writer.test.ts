import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Cut } from "../../core/domain/shared/fact.ts";
import type { Place, Presentation, Row, Section } from "./model.ts";
import { cutSection } from "./rows.ts";
import { write } from "./writer.ts";

const sha = "6b000b5d23a36c45e01472471b84a44fa2464044";
const base = (sections: readonly Section[]): Presentation => ({ status: ["status: complete"], snapshots: [{ repo: "app", kind: "sha", sha }], sections });
const answer = (rows: readonly Row[], layout: Section["layout"] = "by-file"): Section => ({ id: "symbols", title: "symbols", role: "answer", layout, rows });
const row = (key: string, place?: Place, extra: Partial<Row> = {}): Row => ({ key, label: `label-${key}`, ...(place === undefined ? {} : { place }), ...extra });
const occurrences = (text: string, part: string) => text.split(part).length - 1;

function generator(seed: number) {
  let state = seed;
  const next = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return (below: number) => Math.floor(next() * below);
}

function generated(seed: number): Presentation {
  const pick = generator(seed);
  const place = (): Place => ({ path: `src/f${pick(4)}.ts`, line: 1 + pick(40), ...(pick(2) === 0 ? {} : { endLine: 50 + pick(10) }) });
  const sections = (["answer", "completeness", "context", "answer"] as const).map((role, index): Section => {
    let count = 0;
    const rows = (depth: number): Row[] => Array.from({ length: pick(depth === 0 ? 40 : 3) }, () => ({
      key: `k${count++}`,
      label: `l${pick(5)}`,
      ...(pick(4) === 0 ? {} : { place: place() }),
      tier: pick(3),
      ...(pick(2) === 0 ? {} : { evidence: Array.from({ length: 1 + pick(3) }, place) }),
      ...(depth > 0 || pick(3) !== 0 ? {} : { children: rows(1), ...(pick(2) === 0 ? {} : { childrenAreAnswer: true as const }) }),
    }));
    return { id: `s${index}`, title: `t${index}`, role, layout: (["by-file", "list", "tree"] as const)[pick(3)]!, rows: rows(0) };
  });
  return base(sections);
}

test("the same presentation written twice gives the same bytes and is not mutated", () => {
  const presentation = generated(7);
  const before = structuredClone(presentation);
  for (const mode of ["summary", "details"] as const) assert.equal(write(presentation, mode).text, write(structuredClone(presentation), mode).text);
  assert.deepEqual(presentation, before);
});

test("sections are written answer, completeness, context in mapper order within a role", () => {
  const cut = cutSection([{ kind: "depth", at: ["x"], reason: "depth", reach: { kind: "anything" } } as Cut]);
  const sections: Section[] = [
    { id: "ctx", title: "context-title", role: "context", layout: "list", rows: [row("c")] },
    cut,
    { ...answer([row("a")]), id: "a1", title: "first" },
    { ...answer([row("b")]), id: "a2", title: "second" },
  ];
  const { text } = write(base(sections), "details");
  const at = ["first:", "second:", "cuts:", "context-title:"].map((title) => text.indexOf(title));
  assert.deepEqual(at, at.toSorted((a, b) => a - b));
  assert.ok(at.every((index) => index >= 0));
  assert.ok(text.indexOf("status: complete") < at[0]! && text.indexOf(`snapshot: app @ ${sha}`) < at[0]!);
});

test("a path is stated once per group however its rows interleave, and once per section in a list", () => {
  const rows = [row("1", { path: "src/a.ts", line: 3 }), row("2", { path: "src/b.ts", line: 4 }), row("3", { path: "src/a.ts", line: 9, endLine: 12 }), row("4", { repo: "other", path: "src/a.ts", line: 1 })];
  const grouped = write(base([answer(rows)]), "summary");
  assert.equal(occurrences(grouped.text, "src/a.ts"), 2);
  assert.equal(occurrences(grouped.text, "other:src/a.ts"), 1);
  assert.deepEqual(grouped.printed.map((printed) => printed.key), ["1", "3", "2", "4"]);
  const list = write(base([answer(rows, "list")]), "summary").text;
  assert.equal(occurrences(list, "src/a.ts"), 2);
  assert.match(list, /\n {2}:9-12 label-3/);
});

test("evidence that repeats the row's place is not printed and its own file prints as lines", () => {
  const own: Place = { path: "src/a.ts", line: 10 };
  const rows = [row("1", own, { evidence: [own, { path: "src/a.ts", line: 40 }, { path: "src/b.ts", line: 3 }, { path: "src/b.ts", line: 8 }] })];
  const text = write(base([answer(rows)]), "details").text;
  assert.match(text, /\n {6}evidence: :40, src\/b\.ts:3,8$/);
  assert.equal(occurrences(text, "10"), 1);
  assert.match(write(base([answer(rows)]), "summary").text, /label-1 \(3 places\)/);
});

test("consecutive rows with equal evidence state it once, and a row owning one of the places keeps its own list", () => {
  const evidence: Place[] = [{ path: "src/proof.ts", line: 5 }, { path: "src/proof.ts", line: 6 }];
  const shared = [row("1", { path: "src/a.ts", line: 1 }, { evidence }), row("2", { path: "src/a.ts", line: 2 }, { evidence }), row("3", { path: "src/a.ts", line: 3 }, { evidence })];
  assert.equal(occurrences(write(base([answer(shared)]), "details").text, "src/proof.ts"), 1);
  const owned = [row("1", { path: "src/proof.ts", line: 5 }, { evidence }), row("2", { path: "src/a.ts", line: 2 }, { evidence })];
  const text = write(base([answer(owned)]), "details").text;
  assert.equal(occurrences(text, "evidence:"), 2);
  assert.match(text, /evidence: :6\n/);
});

test("summary counts rows past the listed bound only when the count is shorter than the rows", () => {
  const tier1 = (count: number, label: string) => Array.from({ length: count }, (_, index) => ({ ...row(`r${index}`), label, tier: 1 }));
  const many = write(base([answer([row("direct"), ...tier1(30, "dependent-with-a-long-name")], "list")]), "summary", { listedItems: 5 });
  assert.deepEqual(many.elided, [{ section: "symbols", rows: 30 }]);
  assert.match(many.text, /\+30 more \(tier 1: 30\): answer\.json symbols/);
  assert.deepEqual(many.printed.map((printed) => printed.key), ["direct"]);
  const one = write(base([answer([row("direct"), ...tier1(5, "x")], "list")]), "summary", { listedItems: 5 });
  assert.deepEqual(one.elided, []);
  assert.equal(one.printed.length, 6);
});

test("a counted line is never longer than the rows it replaces, over generated presentations", () => {
  let counted = 0;
  for (let seed = 1; seed <= 150; seed++) {
    const presentation = generated(seed);
    const summary = write(presentation, "summary", { listedItems: 6 });
    const everything = write(presentation, "summary", { listedItems: Number.MAX_SAFE_INTEGER });
    if (summary.elided.length === 0) continue;
    counted++;
    assert.ok(Buffer.byteLength(summary.text) < Buffer.byteLength(everything.text), `seed ${seed}`);
  }
  assert.ok(counted > 20);
});

test("tier 0 answer rows are never counted away", () => {
  const rows = Array.from({ length: 40 }, (_, index) => row(`r${index}`, undefined, { label: "direct dependent with a long label" }));
  const { elided, printed } = write(base([answer(rows, "list")]), "summary", { listedItems: 3 });
  assert.deepEqual(elided, []);
  assert.equal(printed.length, 40);
});

test("completeness is one line per cause in summary and each cut with its places in details", () => {
  const cut = (reason: Cut["reason"], at: string): Cut => ({ kind: "unresolved-link", at: [at], reason, reach: { kind: "anything" } }) as Cut;
  const cuts = cutSection([cut("callee-unknown" as Cut["reason"], "a.ts:1"), cut("callee-unknown" as Cut["reason"], "b.ts:2"), cut("no-target" as Cut["reason"], "c.ts:3")]);
  const summary = write(base([cuts]), "summary");
  assert.match(summary.text, /\n {2}2 unresolved-link callee-unknown\n {2}unresolved-link no-target$/);
  assert.equal(occurrences(summary.text, "a.ts:1"), 0);
  const details = write(base([cuts]), "details").text;
  for (const place of ["a.ts:1", "b.ts:2", "c.ts:3"]) assert.equal(occurrences(details, place), 1);
});

test("children print in summary only where the family marks them as the answer", () => {
  const children = [row("child")];
  const text = (flag: Partial<Row>) => write(base([answer([row("parent", undefined, { children, ...flag })], "tree")]), "summary").text;
  assert.equal(occurrences(text({}), "label-child"), 0);
  assert.equal(occurrences(text({ childrenAreAnswer: true }), "label-child"), 1);
  assert.equal(occurrences(write(base([answer([row("parent", undefined, { children })], "tree")]), "details").text, "label-child"), 1);
});

test("every row key summary prints is printed by details, over generated presentations", () => {
  for (let seed = 1; seed <= 150; seed++) {
    const presentation = generated(seed);
    const details = new Set(write(presentation, "details").printed.map(({ section, key }) => `${section}\0${key}`));
    for (const { section, key } of write(presentation, "summary", { listedItems: 6 }).printed) assert.ok(details.has(`${section}\0${key}`), `seed ${seed} ${section} ${key}`);
  }
});

test("a numbered section prints each top-level row's position in the section, wherever its file group sits, and nothing for children", () => {
  const rows = [row("a", { path: "src/a.ts", line: 1 }), row("b", { path: "src/b.ts", line: 2 }), row("c", { path: "src/a.ts", line: 3 }, { children: [row("child")] })];
  const text = write(base([{ ...answer(rows), numbered: true }]), "details").text;
  assert.match(text, /^ {2}src\/a\.ts\n {4}0\. 1 label-a\n {4}2\. 3 label-c\n {6}label-child\n {2}src\/b\.ts\n {4}1\. 2 label-b$/m);
  assert.doesNotMatch(write(base([answer(rows)]), "details").text, /\d\. /);
});

test("an evidence place that adds how it was found is printed with it, even when it is the row's own place", () => {
  const own: Place = { path: "src/a.ts", line: 4 };
  const text = write(base([answer([row("a", own, { evidence: [{ ...own, via: "router", confidence: 0.5 }, { path: "src/a.ts", line: 9 }] })])]), "details").text;
  assert.match(text, /evidence: :4 via router confidence 0\.5, :9$/m);
  assert.doesNotMatch(write(base([answer([row("a", own, { evidence: [own] })])]), "details").text, /evidence/);
});
