import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { DaemonLink } from "../daemon/daemon-link.ts";
import { processHost } from "./process-host.ts";

test("only queries composed for the MCP server go through the daemon; serve's stay in process", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "ye-ast-host-"));
  try {
    const attaches: string[] = [];
    const daemon: DaemonLink = { attach: async (repo) => (attaches.push(repo), { kind: "absent" }), attachStarting: async () => ({ kind: "absent" }), start: () => undefined };
    const host = processHost({ signal: new AbortController().signal, daemon });
    const request = { repo: join(scratch, "missing"), repoId: "missing", revision: "HEAD" };
    const served = await host.queries().entrypoints.map(request);
    assert.equal(served.ok, false);
    assert.deepEqual(attaches, []);
    await host.queries({ trustRecord: true, throughDaemon: true }).entrypoints.map(request);
    assert.deepEqual(attaches, [request.repo]);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
