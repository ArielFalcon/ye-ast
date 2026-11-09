import { test } from "node:test";
import assert from "node:assert/strict";
import { createJavaParser } from "../tree-sitter/java-parser.adapter.ts";
import { createJavaProject, describeFile } from "./java-symbols.ts";
import { fieldBindings } from "./java-members.ts";
import { invocationsOf } from "./java-invocations.ts";
import { JavaMethodFlow } from "./java-method-flow.ts";
import { stagedSelections } from "./java-call-site-owner.ts";

/** The staged selections of the call named `member`, as plain data, over one in-memory source. */
async function staged(source: string, member: string): Promise<[string, boolean][]> {
  const parsed = (await createJavaParser()).parse({ path: "src/Controller.java", content: source });
  assert.ok(parsed.ok);
  try {
    const project = createJavaProject([describeFile("src/Controller.java", parsed.value.root)]);
    const call = project.types.flatMap(invocationsOf).find((invocation) => invocation.node.childForFieldName("name")?.text === member);
    assert.ok(call !== undefined, `the source calls ${member}`);
    return stagedSelections(call, project, {
      fieldOf: (owner, name) => {
        const binding = fieldBindings(owner).get(name);
        return binding === undefined ? undefined : { binding, owner };
      },
    }).map(({ method, proven }) => [`${method.owner.name}.${method.name}(${method.parameterTypes.join(",")})`, proven]);
  } finally {
    parsed.value.dispose();
  }
}

const CONTROLLER = (supertype: string) => `package app;
class Controller ${supertype} {
  private ClinicService service;
  void run() { service.findOwnerById(7); }
}
interface ClinicService { Owner findOwnerById(int id); }
class ClinicServiceImpl implements ClinicService { public Owner findOwnerById(int id) { return null; } }
class Owner {}`;

test("a receiver whose type the strict reading leaves unsettled keeps its lenient selection in the staging form", async () => {
  assert.deepEqual(await staged(CONTROLLER("extends OwnersApi"), "findOwnerById"), [["ClinicServiceImpl.findOwnerById(int)", false]], "the undeclared supertype may declare the name, so the strict reading is unsettled");
  assert.deepEqual(await staged(`${CONTROLLER("implements OwnersApi")}\ninterface OwnersApi {}`, "findOwnerById"), [["ClinicServiceImpl.findOwnerById(int)", true]], "a declared supertype settles the name and the closure proves the one body");
});

test("two overloads of one name keep both arity candidates in the staging form, and neither is proven", async () => {
  const source = `package app;
class Controller {
  private Port port;
  void run() { port.find("7"); }
}
interface Port { Owner find(String id); Owner find(Long id); }
class Impl implements Port { public Owner find(String id) { return null; } public Owner find(Long id) { return null; } }
class Owner {}`;

  assert.deepEqual(await staged(source, "find"), [["Impl.find(String)", false], ["Impl.find(Long)", false]]);
});

test("independent dispatch edges retain linear leaf evaluations", async () => {
  const count = 12;
  const source = Array.from({ length: count }, (_, i) => `interface G${i} { void send(String p); }
    class A${i} implements G${i} { public void send(String p) { sink(p); } }
    class B${i} implements G${i} { public void send(String p) { sink(p); } }`).join("\n")
    + `class W { ${Array.from({ length: count }, (_, i) => `G${i} g${i};`).join(" ")}
    void all(String p) { ${Array.from({ length: count }, (_, i) => `g${i}.send(p);`).join(" ")} } }
    class D { W w; void load() { w.all("/x"); } }`;
  const parsed = (await createJavaParser()).parse({ path: "src/D.java", content: source });
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

test("nested dispatch reuses the same forwarded binding context", async () => {
  const source = Array.from({ length: 12 }, (_, i) => `interface G${i} { void send(String p); }
    class A${i} implements G${i} { G${i+1} next; public void send(String p) { next.send(p); } }
    class B${i} implements G${i} { G${i+1} next; public void send(String p) { next.send(p); } }`).join("\n")
    + 'class G12 { void send(String p) { sink(p); } } class D { G0 g; void load() { g.send("/x"); } }';
  const parsed = (await createJavaParser()).parse({ path: "src/D.java", content: source });
  assert.ok(parsed.ok);
  try {
    const project = createJavaProject([describeFile("Probe.java", parsed.value.root)]);
    const flow = new JavaMethodFlow(project, { fieldOf: (owner, name) => { const binding = fieldBindings(owner).get(name); return binding === undefined ? undefined : { binding, owner }; } }, (invocation) => invocation.node.childForFieldName("name")?.text === "sink" ? { invocation } : undefined);
    const root = flow.invocations.find((call) => call.type.name === "D");
    assert.ok(root);
    assert.equal(flow.expand(root, { type: root.type, locals: root.locals, env: new Map() })?.flat().length, 1);
  } finally { parsed.value.dispose(); }
});
