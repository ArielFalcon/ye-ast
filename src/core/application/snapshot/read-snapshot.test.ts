import { test } from "node:test";
import assert from "node:assert/strict";
import { factBaseOf, type FactBaseRequest } from "./read-snapshot.ts";
import type { Digest } from "../../ports/digest.port.ts";

const digest: Digest = { of: (text) => `digest(${text})` };

const REQUEST: FactBaseRequest = {
  repoId: "repo",
  sha: "abc",
  trust: "untrusted",
  scope: { languages: [], frameworks: [], include: [], exclude: [] },
  content: "c",
  declaredConfig: {},
  engines: {},
};

function inputsOf(request: FactBaseRequest): Record<string, unknown> {
  return factBaseOf({ digest, producer: { name: "p", version: "1" } }, request).inputs as unknown as Record<string, unknown>;
}

test("a type root that answered is part of the fact's inputs, so a different one invalidates the stored fact", () => {
  assert.deepEqual(inputsOf({ ...REQUEST, typeRoot: { identity: "root-a" } }).typeRoot, { identity: "root-a" });
  assert.deepEqual(inputsOf({ ...REQUEST, typeRoot: { identity: "root-b" } }).typeRoot, { identity: "root-b" });
});

test("a fact no type root answered carries no such field, which is not the same as one that settled nothing", () => {
  assert.equal("typeRoot" in inputsOf(REQUEST), false);
});
