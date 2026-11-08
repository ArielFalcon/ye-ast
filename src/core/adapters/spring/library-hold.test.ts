import { test } from "node:test";
import assert from "node:assert/strict";
import { createJavaParser, createJavaTreeHolds } from "../tree-sitter/java-parser.adapter.ts";
import { createJavaCallSites } from "./java-call-sites.adapter.ts";
import type { LibrarySource } from "../../domain/topology/library-source.ts";

test("public and placed library reads share the held source parse", async () => {
  const holds = createJavaTreeHolds();
  const counts = new Map<string, number>();
  const held = holds.held.bind(holds);
  holds.held = (source, parse) => held(source, () => {
    counts.set(source.content, (counts.get(source.content) ?? 0) + 1);
    return parse();
  });
  const hold = holds.open();
  const roots = hold.keep([{ path: "Caller.java", content: 'import transport.Gateway; class Caller { Gateway gateway; void run() { gateway.get("/orders"); } }' }]);
  const library: LibrarySource = { repo: "lib", path: "Gateway.java", content: 'package transport; import org.springframework.web.client.RestTemplate; public class Gateway { RestTemplate http; public void get(String path) { http.getForObject(path, String.class); } }' };
  const libraries = hold.keep([library]) as LibrarySource[];
  try {
    const reader = createJavaCallSites(await createJavaParser(holds));
    await reader.of(roots, "client", libraries);
    await reader.placed(roots, "client", libraries);
    assert.equal(counts.get(library.content), 1);
    assert.equal(counts.get(roots[0]!.content), 1);
  } finally {
    hold.release();
  }
});
