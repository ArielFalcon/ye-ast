import { test } from "node:test";
import assert from "node:assert/strict";
import { memoizeTypeResolution } from "./type-resolution-cache.ts";
import type { ReferenceSite, ResolvedTarget } from "../../domain/relations/resolved-reference.ts";
import type { Finding } from "../../domain/shared/fact.ts";
import type { TypeResolution } from "../../ports/type-resolution.port.ts";

const SITE: ReferenceSite = { file: "src/a.ts", line: 3, column: 5, symbol: "load" };
const TARGET: ResolvedTarget = { kind: "repository", file: "src/b.ts", symbol: "load", line: 7, endLine: 9 };

/** A resolution that counts how many sites it was asked about, and answers the same declaration to each. */
function counting(): { port: TypeResolution; asked: number } {
  const counter = {
    asked: 0,
    port: {
      resolve(sites: readonly ReferenceSite[]): readonly Finding<ResolvedTarget>[] {
        counter.asked += sites.length;
        return sites.map(() => ({ status: "complete", value: TARGET, evidence: [] }));
      },
    },
  };
  return counter;
}

test("a site asked again is answered from the cache, so the frontier is settled once", () => {
  const counter = counting();
  const resolution = memoizeTypeResolution(counter.port);

  assert.deepEqual(resolution.resolve([SITE]), resolution.resolve([SITE]));
  assert.equal(counter.asked, 1);
});

test("a site repeated inside one request is asked once and answered for every place", () => {
  const counter = counting();
  const resolution = memoizeTypeResolution(counter.port);

  const answers = resolution.resolve([SITE, SITE]);

  assert.equal(counter.asked, 1);
  assert.equal(answers.length, 2);
  assert.deepEqual(answers[0], answers[1]);
});

test("a different place is not answered from another one's cache", () => {
  const counter = counting();
  const resolution = memoizeTypeResolution(counter.port);

  resolution.resolve([SITE]);
  resolution.resolve([{ ...SITE, line: 4 }]);

  assert.equal(counter.asked, 2);
});

test("an answer the inner resolution did not return is unknown, never omitted", () => {
  const resolution = memoizeTypeResolution({ resolve: () => [] });

  assert.deepEqual(resolution.resolve([SITE]), [{ status: "unknown", reason: "unresolved", evidence: [{ path: "src/a.ts", line: 3 }] }]);
});

test("same-point references with distinct spelling or role never share a cached proof", () => {
  const counter = counting();
  const resolution = memoizeTypeResolution(counter.port);
  resolution.resolve([{ ...SITE, fullName: "factory().load", kind: "calls" }]);
  resolution.resolve([{ ...SITE, fullName: "other().load", kind: "calls" }]);
  resolution.resolve([{ ...SITE, fullName: "factory().load", kind: "references" }]);
  assert.equal(counter.asked, 3);
});
