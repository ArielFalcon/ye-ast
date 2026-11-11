import { readFile } from "node:fs/promises";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createJavaParser } from "../tree-sitter/java-parser.adapter.ts";
import { createSpringRoutesExtractor } from "./spring-routes.adapter.ts";

for (const name of ["security/bean-implements", "security/no-stereotype", "security/inherited-body", "security/wildcard-import", "security/same-simple-name", "validation/jakarta", "validation/javax", "validation/overloads", "graphql"]) {
  test(`callback conformance: ${name}`, async () => {
    const dir = new URL(`./fixtures/callbacks/${name}/`, import.meta.url);
    const source = await readFile(new URL("Example.java", dir), "utf8");
    const expected = JSON.parse(await readFile(new URL("expected.json", dir), "utf8")) as unknown[];
    const parser = await createJavaParser();
    const findings = (await createSpringRoutesExtractor(parser).extract([{ path: "src/main/java/app/Example.java", content: source }])).findings;
    const actual = findings.map((f) => f.status === "unknown" ? { status: f.status, reason: f.reason } : f.value.kind === "callback" ? { status: f.status, kind: f.value.kind, name: f.value.name, symbol: f.value.handler.symbol, path: f.value.handler.path, line: f.value.handler.line } : f);
    if (name === "graphql") {
      assert.deepEqual(findings.filter((f) => f.status === "unknown").map((f) => f.evidence[0]?.line), [8, 10, 12, 14, 16]);
    }
    assert.deepEqual(actual, expected);
    if (name === "security/inherited-body") assert.deepEqual(findings[0]?.evidence.map((e) => e.line), [5, 6]);
    if (name === "validation/overloads") assert.deepEqual(findings[0]?.evidence.map((e) => e.line), [3, 4, 5]);
    if (name === "security/wildcard-import") assert.ok(findings[0]?.evidence.some((e) => e.via === "org.springframework.security.core.userdetails.UserDetailsService"));
  });
}

test("a diamond of repository interfaces visits an inherited body once", async () => {
  const parser = await createJavaParser();
  const findings = (await createSpringRoutesExtractor(parser).extract([{ path: "src/main/java/app/Diamond.java", content: `package app;
import jakarta.validation.ConstraintValidator;
interface Base extends ConstraintValidator<Object,Object> { default boolean isValid(Object v, Object c) { return true; } }
interface Left extends Base {}
interface Right extends Base {}
class Validator implements Left, Right {}` }])).findings;
  assert.deepEqual(findings.flatMap((f) => f.status === "complete" && f.value.kind === "callback" ? [f.value.handler.symbol] : []), ["Base.isValid"]);
});

test("a missing external body is unknown and unrelated repository interfaces are not evidence", async () => {
  const parser = await createJavaParser();
  const findings = (await createSpringRoutesExtractor(parser).extract([{ path: "src/main/java/app/More.java", content: `package app;
import org.springframework.stereotype.Service;
import org.springframework.security.core.userdetails.UserDetailsService;
interface Other {}
@Service class Missing implements UserDetailsService {}
@Service class Users implements UserDetailsService,
    Other { public Object loadUserByUsername(String s) { return null; } }` }])).findings;
  const missing = findings.find((f) => f.status === "unknown");
  assert.equal(missing?.status === "unknown" && missing.reason, "no-extractor");
  const callback = findings.find((f) => f.status === "complete" && f.value.kind === "callback");
  assert.deepEqual(callback?.evidence.map((e) => e.line), [6]);
});

test("an unread superclass may override a local interface default, but a direct class body wins", async () => {
  const parser = await createJavaParser();
  const findings = (await createSpringRoutesExtractor(parser).extract([{ path: "src/main/java/app/External.java", content: `package app;
import jakarta.validation.ConstraintValidator;
interface Local extends ConstraintValidator<Object,Object> { default boolean isValid(Object v, Object c) { return true; } }
class Test extends external.Base implements Local {}
class Middle extends external.Base {}
class Deep extends Middle implements Local {}
class Own extends external.Base implements Local { public boolean isValid(Object v, Object c) { return true; } }` }])).findings;
  const unknown = findings.filter((f) => f.status === "unknown");
  assert.deepEqual(unknown.map((f) => [f.reason, f.evidence]), [
    ["no-extractor", [{ path: "src/main/java/app/External.java", line: 4, endLine: 4, via: "jakarta.validation.ConstraintValidator" }]],
    ["no-extractor", [{ path: "src/main/java/app/External.java", line: 6, endLine: 6, via: "jakarta.validation.ConstraintValidator" }]],
  ]);
  const complete = findings.filter((f) => f.status === "complete" && f.value.kind === "callback");
  assert.deepEqual(complete.map((f) => f.status === "complete" && f.value.kind === "callback" && [f.value.handler.path, f.value.handler.symbol, f.value.handler.line, f.evidence[0]?.line]), [["src/main/java/app/External.java", "Own.isValid", 7, 7]]);
});

test("a superclass body takes precedence over a nearer interface default", async () => {
  const parser = await createJavaParser();
  const findings = (await createSpringRoutesExtractor(parser).extract([{ path: "src/main/java/app/Precedence.java", content: `package app;
import jakarta.validation.ConstraintValidator;
interface Local extends ConstraintValidator<Object,Object> { default boolean isValid(Object v, Object c) { return true; } }
class Base { public boolean isValid(Object v, Object c) { return true; } }
class Middle extends Base {}
class Test extends Middle implements Local {}` }])).findings;
  assert.deepEqual(findings.flatMap((f) => f.status === "complete" && f.value.kind === "callback" ? [[f.value.handler.symbol, f.value.handler.line, f.evidence[0]?.line]] : []), [["Base.isValid", 4, 6]]);
});

test("competing interface bodies at the same level remain unresolved", async () => {
  const parser = await createJavaParser();
  const findings = (await createSpringRoutesExtractor(parser).extract([{ path: "src/main/java/app/Ambiguous.java", content: `package app;
import jakarta.validation.ConstraintValidator;
interface A extends ConstraintValidator<Object,Object> { default boolean isValid(Object v, Object c) { return true; } }
interface B extends ConstraintValidator<Object,Object> { default boolean isValid(Object v, Object c) { return false; } }
class Test implements A, B {}` }])).findings;
  assert.deepEqual(findings.map((f) => f.status === "unknown" ? [f.reason, ...f.evidence.map((e) => e.line)] : f.status), [["unresolved", 5, 3, 4]]);
});
