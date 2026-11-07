import { test } from "node:test";
import assert from "node:assert/strict";
import { createJavaParser } from "../tree-sitter/java-parser.adapter.ts";
import { createJavaNameBindings } from "./java-name-bindings.adapter.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";

const source = (path: string, content: string): SourceFile => ({ path: `${path}.java`, content });
async function dispatch(parameter: string, imports: string, extra: SourceFile[] = [], implementation = parameter, prefix = "", ownerPrefix = "") {
  const port = source("a/Port", `package a; ${ownerPrefix}\npublic interface Port {\n void send(${parameter} value);\n}`);
  const sender = source("b/Sender", `package b; ${imports}\npublic class Sender ${prefix} implements a.Port {\n public void send(${implementation} value) {}\n}`);
  return (await createJavaNameBindings(createJavaParser, [port, sender, ...extra]).dispatchTargets([{ file: port.path, line: 3, name: "send" }]))[0];
}
const BODY = { kind: "bodies", bodies: [{ file: "b/Sender.java", start: 3, nameLine: 3 }] };
const UNKNOWN = { kind: "unknown" };

test("implicit java.lang identities cross packages, while an own-package homonym shadows them", async () => {
  assert.deepEqual(await dispatch("String", ""), BODY);
  assert.deepEqual(await dispatch("String", "", [source("b/String", "package b; public class String {}")]), UNKNOWN);
});

test("a known platform wildcard excludes absent names and resolves its present names alongside repository wildcard packages", async () => {
  const dto = source("dto/Value", "package dto; public class Value {}");
  assert.deepEqual(await dispatch("dto.Value", "import dto.*; import java.util.*;", [dto], "Value"), BODY);
  assert.deepEqual(await dispatch("java.util.List", "import dto.*; import java.util.*;", [dto], "List<String>"), BODY);
  assert.deepEqual(await dispatch("dto.Value", "import dto.*; import missing.*;", [dto], "Value"), UNKNOWN);
});

test("a lexical inherited member type shadows a single-type import, and inherited imports name the declaring member", async () => {
  const base = source("b/Base", "package b; public class Base { public static class Value {} }");
  const other = source("c/Value", "package c; public class Value {}");
  assert.deepEqual(await dispatch("b.Base.Value", "import c.Value;", [base, other], "Value", "extends Base"), BODY);
  assert.deepEqual(await dispatch("c.Value", "import c.Value;", [base, other], "Value", "extends Base"), UNKNOWN);
});

test("single-static imports bind member types, including inherited ones, but unknown owners withhold proof", async () => {
  const base = source("c/Base", "package c; public class Base { public static class Value {} }");
  const child = source("c/Child", "package c; public class Child extends Base {}");
  assert.deepEqual(await dispatch("c.Base.Value", "import static c.Child.Value;", [base, child], "Value"), BODY);
  assert.deepEqual(await dispatch("c.Base.Value", "import static missing.Child.Value;", [base], "Value"), UNKNOWN);
  for (const declaration of ["public enum Value { ONE }", "public record Value(int x) {}", "public @interface Value {}"])
    assert.deepEqual(await dispatch("c.Base.Value", "import static c.Base.Value;", [source("c/Base", `package c; public class Base { ${declaration} }`)], "Value"), BODY);
});

test("static-on-demand imports participate with ordinary demands and java.lang, and collisions stay cuts", async () => {
  const holder = source("c/Holder", "package c; public class Holder { public static class Value {} public static class String {} }");
  assert.deepEqual(await dispatch("c.Holder.Value", "import static c.Holder.*;", [holder], "Value"), BODY);
  assert.deepEqual(await dispatch("String", "import static c.Holder.*;", [holder]), UNKNOWN);
  assert.deepEqual(await dispatch("String", "import static missing.Holder.*;"), UNKNOWN);
});

test("a single-type import shadows own-package types and demands, while a compilation-unit declaration conflicts explicitly", async () => {
  const dto = source("dto/Value", "package dto; public class Value {}");
  const own = source("b/Value", "package b; public class Value {}");
  assert.deepEqual(await dispatch("dto.Value", "import dto.Value; import missing.*;", [dto, own], "Value"), BODY);
  assert.deepEqual(await dispatch("dto.Value", "import dto.Value; class Value {}", [dto], "Value"), UNKNOWN);
  assert.deepEqual(await dispatch("b.Sender", "import other.Sender;", [source("other/Sender", "package other; public class Sender {}")], "Sender"), UNKNOWN);
});

test("type parameters shadow platform and imported types and never prove a concrete override", async () => {
  assert.deepEqual(await dispatch("String", "", [], "String", "", ""), BODY);
  const port = source("a/Port", "package a; public interface Port { void send(String s); }");
  const sender = source("b/Sender", "package b; public class Sender<String> implements a.Port { public void send(String s) {} }");
  assert.deepEqual((await createJavaNameBindings(createJavaParser, [port, sender]).dispatchTargets([{ file: port.path, line: 1, name: "send" }]))[0], UNKNOWN);
});

test("conflicting single-type imports never select the last declaration", async () => {
  const left = source("left/Value", "package left; public class Value {}");
  const right = source("right/Value", "package right; public class Value {}");
  assert.deepEqual(await dispatch("right.Value", "import left.Value; import right.Value;", [left, right], "Value"), UNKNOWN);
});

test("a known on-demand collision stays a cut even when another supplier is unknown and both files share the context", async () => {
  const imports = "package app; import left.*; import right.*; import missing.*;";
  const port = source("app/Port", `${imports}\npublic interface Port { void send(Value value); }`);
  const sender = source("app/Sender", `${imports}\npublic class Sender implements Port { public void send(Value value) {} }`);
  const result = await createJavaNameBindings(createJavaParser, [port, sender,
    source("left/Value", "package left; public class Value {}"), source("right/Value", "package right; public class Value {}"),
  ]).dispatchTargets([{ file: port.path, line: 2, name: "send" }]);
  assert.deepEqual(result[0], UNKNOWN);
});

test("qualified type names resolve the qualifier's binding and each member, never its spelling or capitalization", async () => {
  const common = [source("a/q", "package a; public class q { public static class X { public static class Y {} } }"),
    source("b/q", "package b; public class q { public static class X {} }")];
  const check = async (portType: string, baseType: string, subType: string, imports: [string, string, string], extra: SourceFile[] = [], members = "") => {
    const port = source("p/Port", `package p; ${imports[0]} public interface Port { void send(${portType} v); }`);
    return (await createJavaNameBindings(createJavaParser, [...common, ...extra, port,
      source("p/Base", `package p; ${imports[1]} public class Base implements Port { ${members} public void send(${baseType} v) {} }`),
      source("r/Sub", `package r; ${imports[2]} public class Sub extends p.Base { public void send(${subType} v) {} }`),
    ]).dispatchTargets([{ file: port.path, line: 1, name: "send" }]))[0];
  };
  const bodies = { kind: "bodies", bodies: [{ file: "p/Base.java", start: 1, nameLine: 1 }, { file: "r/Sub.java", start: 1, nameLine: 1 }] };

  assert.deepEqual(await check("q.X", "q.X", "q.X", ["import a.*;", "import a.*;", "import b.*;"]), UNKNOWN);
  assert.deepEqual(await check("a.q.X", "a.q.X", "a.q.X", ["", "", ""]), bodies);
  assert.deepEqual(await check("q.X", "q.X", "q.X", ["import a.*;", "import a.*;", "import a.*;"]), bodies);
  assert.deepEqual(await check("q.X", "q.X", "q.X", ["import a.q;", "import a.q;", "import a.q;"]), bodies);
  assert.deepEqual(await check("a.q.X.Y", "a.Child.X.Y", "a.q.X.Y", ["", "", ""],
    [source("a/Child", "package a; public class Child extends q {}")]), bodies);
  assert.deepEqual(await check("X.Y", "X.Y", "a.q.X.Y", ["import a.q.X;", "import a.q.X;", ""]), bodies);
  assert.deepEqual(await check("X.Y", "X.Y", "a.q.X.Y", ["import static a.q.X;", "import static a.q.X;", ""]), bodies);
  assert.deepEqual(await check("p.Base.q.X", "q.X", "q.X", ["", "", "import b.*;"], [],
    "public static class q { public static class X {} }"), bodies);
  assert.deepEqual(await check("A.q.X", "q.X", "q.X", ["", "import A.q;", "import A.*;"],
    [source("A/q", "package A; public class q { public static class X {} }")]), bodies);
  assert.deepEqual(await check("q.X", "q.X", "q.X", ["", "import missing.*;", "import missing.*;"],
    [source("q/X", "package q; public class X {}")]), UNKNOWN);
});
