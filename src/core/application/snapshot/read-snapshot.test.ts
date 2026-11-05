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
