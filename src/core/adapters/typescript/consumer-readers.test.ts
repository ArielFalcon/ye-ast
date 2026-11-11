import { test } from "node:test";
import assert from "node:assert/strict";
import { buildProgram } from "./consumer-flow.index.ts";
import { createRequestBodies } from "./http-call-sites.adapter.ts";
import { createConsumerReaders } from "./consumer-readers.ts";

test("each repository reading shares one program and prepares origins only on demand", async () => {
  let builds = 0;
  let bodies = 0;
  const deps = {
    buildProgram: (files: Parameters<typeof buildProgram>[0]) => { builds++; return buildProgram(files); },
    createRequestBodies: (files: Parameters<typeof createRequestBodies>[0]) => { bodies++; return createRequestBodies(files); },
  };
  const files = [{ path: "a.ts", content: "function send() { fetch('/x', { method: 'POST', body: JSON.stringify({ id: 1 }) }); }" }];
  const first = await createConsumerReaders(files, "one", deps);
  first.flow.follow({ site: { kind: "call-site", repo: "one", file: "a.ts", line: 1, symbol: "send" }, path: ["id"] });
  assert.equal(builds, 1);
  assert.equal(bodies, 0);
  await first.origins.ofBody({ file: "a.ts", line: 1, symbol: "send" }, ["id"]);
  await first.origins.ofBody({ file: "a.ts", line: 1, symbol: "send" }, ["id"]);
  assert.equal(builds, 1);
  assert.equal(bodies, 1);
  const second = await createConsumerReaders(files, "two", deps);
  await second.origins.ofBody({ file: "a.ts", line: 1, symbol: "send" }, ["id"]);
  assert.equal(builds, 2);
  assert.equal(bodies, 2);
});
