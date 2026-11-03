import { test } from "node:test";
import assert from "node:assert/strict";
import { retentionDiscards, type LiveRetentionPolicy, type LiveScopeUsage } from "./live-retention.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;
const CURRENT = "current";

/** The values a host supplies by default (RFC-0010 "Retention"); the domain itself keeps none. */
const DEFAULT_POLICY: LiveRetentionPolicy = { keepScopes: 3, unusedForMs: 14 * DAY_MS, maxBytes: 512 * 1024 * 1024 };

function policy(overrides: Partial<LiveRetentionPolicy> = {}): LiveRetentionPolicy {
  return { ...DEFAULT_POLICY, ...overrides };
}

function usage(scope: string, overrides: Partial<LiveScopeUsage> = {}): LiveScopeUsage {
  return { scope, bytes: 0, lastUsedMs: NOW - DAY_MS, locked: false, versionsMatch: true, ...overrides };
}

function discards(scopes: readonly LiveScopeUsage[], options: { debris?: readonly string[]; policy?: Partial<LiveRetentionPolicy>; nowMs?: number; current?: string } = {}) {
  return retentionDiscards({ scopes, debris: options.debris ?? [] }, options.current ?? CURRENT, policy(options.policy), options.nowMs ?? NOW);
}

test("the scope being answered and the most recently used ones stay, and the rest go least recently used first", () => {
  const scopes = [
    usage(CURRENT, { lastUsedMs: NOW }),
    usage("a", { lastUsedMs: NOW - 1_000 }),
    usage("b", { lastUsedMs: NOW - 2_000 }),
    usage("c", { lastUsedMs: NOW - 3_000 }),
    usage("d", { lastUsedMs: NOW - 4_000 }),
  ];

  assert.deepEqual(discards(scopes), { scopes: ["d", "c"], debris: [] });
});

test("the scope being answered is kept even when it is the least recently used", () => {
  const scopes = [
    usage(CURRENT, { lastUsedMs: NOW - 30 * DAY_MS }),
    usage("a", { lastUsedMs: NOW }),
    usage("b", { lastUsedMs: NOW - 1_000 }),
    usage("c", { lastUsedMs: NOW - 2_000 }),
  ];

  assert.deepEqual(discards(scopes).scopes, ["c"]);
});

test("a mirror unused past the policy's time goes even when it is among the most recent, and one exactly at the bound stays", () => {
  const scopes = [
    usage(CURRENT, { lastUsedMs: NOW }),
    usage("stale", { lastUsedMs: NOW - 15 * DAY_MS }),
    usage("fresh", { lastUsedMs: NOW - 1_000 }),
  ];

  assert.deepEqual(discards(scopes).scopes, ["stale"]);
  assert.deepEqual(discards(scopes, { policy: { unusedForMs: 15 * DAY_MS } }).scopes, []);
});

test("a mirror built by other engines goes first, whatever its use", () => {
  const scopes = [
    usage(CURRENT, { lastUsedMs: NOW }),
    usage("other-engine", { lastUsedMs: NOW, versionsMatch: false }),
    usage("fresh", { lastUsedMs: NOW - 1_000 }),
  ];

  assert.deepEqual(discards(scopes).scopes, ["other-engine"]);
});

test("a mirror another live process holds is never discarded and still counts against the policy", () => {
  const scopes = [
    usage(CURRENT, { lastUsedMs: NOW }),
    usage("held", { lastUsedMs: NOW - 20 * DAY_MS, locked: true }),
    usage("a", { lastUsedMs: NOW - 1_000 }),
    usage("b", { lastUsedMs: NOW - 2_000 }),
    usage("c", { lastUsedMs: NOW - 3_000 }),
  ];

  assert.deepEqual(discards(scopes).scopes, ["c", "b"]);
});

test("a directory with no state and an entry that belongs to no scope are debris, sorted", () => {
  const scopes = [usage(CURRENT, { lastUsedMs: NOW }), usage("half-written", { lastUsedMs: null })];

  assert.deepEqual(discards(scopes, { debris: ["b.tmp", "a.state.json"] }), { scopes: ["half-written"], debris: ["a.state.json", "b.tmp"] });
});

test("a tree over the byte cap discards the least recently used mirrors until it fits", () => {
  const hundredMiB = 100 * 1024 * 1024;
  const scopes = [
    usage(CURRENT, { lastUsedMs: NOW, bytes: hundredMiB }),
    usage("a", { lastUsedMs: NOW - 1_000, bytes: hundredMiB }),
    usage("b", { lastUsedMs: NOW - 2_000, bytes: hundredMiB }),
    usage("c", { lastUsedMs: NOW - 3_000, bytes: hundredMiB }),
    usage("d", { lastUsedMs: NOW - 4_000, bytes: hundredMiB }),
    usage("e", { lastUsedMs: NOW - 5_000, bytes: hundredMiB }),
  ];

  assert.deepEqual(discards(scopes, { policy: { keepScopes: 10 } }).scopes, ["e"]);
});

test("a single mirror over the byte cap stays when it is the one being answered", () => {
  assert.deepEqual(discards([usage(CURRENT, { lastUsedMs: NOW, bytes: 2 * 1024 * 1024 * 1024 })]), { scopes: [], debris: [] });
});
