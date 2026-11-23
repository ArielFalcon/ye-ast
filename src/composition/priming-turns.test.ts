import { test } from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { queriesFirst } from "./priming-turns.ts";

test("waits for queries leave no abort listener on a long-lived signal once the queries are done", async () => {
  const { counted, turns } = queriesFirst();
  let finish!: () => void;
  const family = counted({ ask: () => new Promise<void>((resolve) => { finish = resolve; }) });
  const lifetime = new AbortController();

  const query = family.ask();
  const waits = [turns.queriesDone(lifetime.signal), turns.queriesDone(lifetime.signal), turns.passTurn(lifetime.signal)];
  await new Promise((resolve) => setImmediate(resolve));
  finish();
  await query;
  await Promise.all(waits);

  assert.equal(getEventListeners(lifetime.signal, "abort").length, 0);
});

test("an abort still releases a wait for queries", { timeout: 5_000 }, async () => {
  const { counted, turns } = queriesFirst();
  const family = counted({ ask: () => new Promise<void>(() => undefined) });
  const lifetime = new AbortController();
  void family.ask();

  const waiting = turns.queriesDone(lifetime.signal);
  lifetime.abort();

  await waiting;
});
