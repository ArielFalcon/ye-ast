import { test } from "node:test";
import assert from "node:assert/strict";
import { createJavaParser } from "../tree-sitter/java-parser.adapter.ts";
import { createJavaProject, describeFile } from "./java-symbols.ts";
import { fieldBindings } from "./java-members.ts";
import { JavaMethodFlow } from "./java-method-flow.ts";

test("independent dispatch edges retain linear leaf evaluations", async () => {
  const count = 12;
  const source = Array.from({ length: count }, (_, i) => `interface G${i} { void send(String p); }
    class A${i} implements G${i} { public void send(String p) { sink(p); } }
    class B${i} implements G${i} { public void send(String p) { sink(p); } }`).join("\n")
    + `class W { ${Array.from({ length: count }, (_, i) => `G${i} g${i};`).join(" ")}
    void all(String p) { ${Array.from({ length: count }, (_, i) => `g${i}.send(p);`).join(" ")} } }
    class D { W w; void load() { w.all("/x"); } }`;
  const parsed = (await createJavaParser()).parse(source);
  assert.ok(parsed.ok);
  try {
    const project = createJavaProject([describeFile("Probe.java", parsed.value.root)]);
    const flow = new JavaMethodFlow(project, { fieldOf: (owner, name) => { const binding = fieldBindings(owner).get(name); return binding === undefined ? undefined : { binding, owner }; } }, (invocation) => invocation.node.childForFieldName("name")?.text === "sink" ? { invocation } : undefined);
    const root = flow.invocations.find((call) => call.type.name === "D");
    assert.ok(root);
    const groups = flow.expand(root, { type: root.type, locals: root.locals, env: new Map() });
    assert.ok(groups);
    assert.equal(groups.flat().length, count * 2);
  } finally { parsed.value.dispose(); }
});
