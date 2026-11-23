import assert from "node:assert/strict";
import { test } from "node:test";
import { ANYTHING, SCHEMA, type Fact, type FactBase } from "../../domain/shared/fact.ts";
import type { Result } from "../../domain/shared/result.ts";
import { ANSWER_FIELDS, answerSlot, rememberedAnswer, type AnswerFamily, type AnswerMemoOutcome, type AnswerSlot, type AnswerSnapshot } from "./answer-memo.ts";
import { snapshotRetention } from "./prepared-snapshot.ts";
import { createSnapshotDataCache } from "./snapshot-data-cache.ts";

const SHA: AnswerSnapshot = { kind: "sha", sha: "a".repeat(40), content: "export-1" };
const LIVE: AnswerSnapshot = { kind: "live", stateId: "state-1", generation: "generation-1", head: "b".repeat(40) };

const slotOf = (family: AnswerFamily, request: object, snapshot: AnswerSnapshot = SHA): string | undefined =>
  answerSlot({ family, request, snapshot, engines: { codegraph: "1" }, declaredConfig: {}, producer: { name: "ye-ast", version: "0" } } satisfies AnswerSlot);

test("every request field a family's table lists names the slot, an excluded one does not, and a refusing or unlisted one keeps nothing", () => {
  for (const [family, table] of Object.entries(ANSWER_FIELDS) as [AnswerFamily, Readonly<Record<PropertyKey, string>>][]) {
    const base = { repo: "/repos/shop", repoId: "shop" };
    const keyed = slotOf(family, base);
    assert.ok(keyed !== undefined, family);
    for (const field of Reflect.ownKeys(table)) {
      const slot = slotOf(family, { ...base, [field]: field === "repo" ? "/repos/other" : field === "repoId" ? "other" : "value" });
      const role = table[field];
      const name = `${family}.${String(field)}`;
      if (role === "key") assert.ok(slot !== undefined && slot !== keyed, name);
      if (role === "excluded") assert.equal(slot, keyed, name);
      if (role === "refuses") assert.equal(slot, undefined, name);
    }
    assert.equal(slotOf(family, { ...base, unlisted: true }), undefined, `${family} unlisted`);
  }
});

test("every part of the snapshot identity names the slot, and a live capture pinned at no store generation keeps nothing", () => {
  const request = { repo: "/repos/shop", repoId: "shop", live: true };
  const slots = [
    slotOf("callers", request, LIVE),
    slotOf("callers", request, { ...LIVE, stateId: "state-2" }),
    slotOf("callers", request, { ...LIVE, generation: "generation-2" }),
    slotOf("callers", request, { ...LIVE, head: "c".repeat(40) }),
    slotOf("callers", request, SHA),
    slotOf("callers", request, { ...SHA, sha: "d".repeat(40) }),
    slotOf("callers", request, { ...SHA, content: "export-2" }),
  ];
  assert.equal(new Set(slots).size, slots.length);
  assert.equal(slotOf("callers", request, { ...LIVE, generation: undefined }), undefined);
});

const BASE: FactBase = {
  schema: SCHEMA,
  snapshot: { repo: "shop", kind: "sha", sha: "a".repeat(40) },
  producer: { name: "ye-ast", version: "0" },
  inputs: { trust: "untrusted", scope: "s", declaredScope: { languages: [], frameworks: [], include: [], exclude: [] }, content: "c", config: "k", declaredConfig: {}, engines: {} },
  evidence: [],
};
const COMPLETE: Fact<{ files: string[] }> = { ...BASE, status: "complete", value: { files: ["src/a.ts"] } };
const DEADLINE: Fact<{ files: string[] }> = { ...BASE, status: "partial", value: { files: [] }, cuts: [{ kind: "deadline", at: ["walk"], reason: "deadline", reach: ANYTHING }] };

/** One snapshot entry of a real cache, and a call of `rememberedAnswer` under one slot that counts how often it ran. */
function memo() {
  const retention = snapshotRetention({ snapshotCache: createSnapshotDataCache("working-set"), digest: { of: (value) => value } }, { repository: "shop", snapshot: "revision" }, "identity", [], "untrusted")!;
  retention.lookup();
  let runs = 0;
  const outcomes: AnswerMemoOutcome[] = [];
  const ask = <E>(answer: Result<Fact<{ files: string[] }>, E>, signal?: AbortSignal) => rememberedAnswer(retention.output, "slot", signal, async () => (runs++, answer), (outcome) => outcomes.push(outcome));
  return { ask, runs: () => runs, outcomes };
}

test("a kept answer is answered frozen without running, and what is not kept runs again: a refused fact, a failure, an aborted call", async () => {
  const kept = memo();
  await kept.ask({ ok: true, value: COMPLETE });
  const hit = await kept.ask({ ok: true, value: COMPLETE });
  assert.deepEqual([kept.runs(), kept.outcomes], [1, ["admitted", "hit"]]);
  assert.ok(hit.ok && Object.isFrozen(hit.value));

  const refused = memo();
  await refused.ask({ ok: true, value: DEADLINE });
  await refused.ask({ ok: true, value: DEADLINE });
  assert.deepEqual([refused.runs(), refused.outcomes], [2, ["not-kept", "not-kept"]]);

  const failed = memo();
  const fault = { ok: false as const, fault: { kind: "git-failed" } };
  assert.equal(await failed.ask(fault), fault);
  await failed.ask(fault);
  assert.equal(failed.runs(), 2);

  const aborted = memo();
  const stop = new AbortController();
  stop.abort();
  await aborted.ask({ ok: true, value: COMPLETE }, stop.signal);
  await aborted.ask({ ok: true, value: COMPLETE });
  assert.equal(aborted.runs(), 2);
});
