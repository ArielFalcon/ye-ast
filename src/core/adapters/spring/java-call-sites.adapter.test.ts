import { test } from "node:test";
import assert from "node:assert/strict";
import type { LibrarySource } from "../../domain/topology/library-source.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import { createJavaParser } from "../tree-sitter/java-parser.adapter.ts";
import { javaCallSitesOf, type JavaSiteReader } from "./java-call-sites.adapter.ts";
import { stagedSelections } from "./java-call-site-owner.ts";
import { invocationsOf } from "./java-invocations.ts";
import { fieldBindings } from "./java-members.ts";

const PORT = { path: "src/main/java/app/Probe.java", content: `package app;
class Controller { private Port port; void run() { port.send(1); } }
interface Port { void send(int s); }
class Sender implements Port { public void send(int s) {} }` };

const fieldLookup = {
  fieldOf: (owner: Parameters<typeof fieldBindings>[0], name: string) => {
    const binding = fieldBindings(owner).get(name);
    return binding === undefined ? undefined : { binding, owner };
  },
};

/** The proofs the pipeline hands its readers, and whether every staged selection stays unproven. */
async function pipeline(files: readonly SourceFile[], libraries: readonly LibrarySource[] = []): Promise<{ proofs: unknown[]; unproven: boolean[] }> {
  const proofs: unknown[] = [];
  const unproven: boolean[] = [];
  const capture: JavaSiteReader = {
    transport: "http",
    read: (project, _configuration, _owned, _repo, _nested, proof) => {
      proofs.push(proof);
      const call = project.types.flatMap(invocationsOf).find((invocation) => invocation.node.childForFieldName("name")?.text === "send");
      assert.ok(call !== undefined);
      unproven.push(stagedSelections(call, project, fieldLookup, call.type, proof).every(({ proven }) => !proven));
      return [];
    },
  };
  javaCallSitesOf(await createJavaParser(), files, libraries, "probe", [capture]);
  return { proofs, unproven };
}

test("a JVM source no extractor reads leaves the staged selection unproven", async () => {
  const kotlin = { path: "src/main/kotlin/app/Other.kt", content: "package app\nclass Other : Port { override fun send(s: Int) {} }" };

  assert.deepEqual(await pipeline([PORT, kotlin]), { proofs: [{ unparsed: [], unreadJvm: true }], unproven: [true] });
});

test("a library the parse left unread leaves the staged selection unproven", async () => {
  const library = (path: string, content: string): LibrarySource => ({ repo: "lib", path, content });

  assert.deepEqual(await pipeline([PORT], [library("Bad.java", "class Bad { void broken( }")]), { proofs: [{ unparsed: [{ path: "(library)/lib/Bad.java", line: 1 }], unreadJvm: false }], unproven: [true] });
});
