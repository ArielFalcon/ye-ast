import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOutputCuts, installVerdict, javaSourcesDeclared, jdkDeclared, mountOf, nodeModulesDeclared } from "./build-outputs.ts";

test("a package read at a version its install path does not lock makes the directory unusable, naming each such package", () => {
  const locked = new Map([["a", "1.0.0"], ["b", "2.0.0"]]);
  assert.deepEqual(installVerdict(locked, [{ path: "a", version: "1.0.0" }]), { usable: true, verified: true });
  assert.deepEqual(installVerdict(locked, [{ path: "c", version: "1.0.0" }, { path: "b", version: "2.1.0" }, { path: "a", version: "1.0.0" }, { path: "d", version: undefined }]), {
    usable: false,
    stale: [{ path: "b", installed: "2.1.0", locked: "2.0.0" }, { path: "c", installed: "1.0.0" }, { path: "d" }],
  });
});

test("without a lockfile the directory is usable and unverified, whatever it holds", () => {
  assert.deepEqual(installVerdict(undefined, [{ path: "a", version: undefined }]), { usable: true, verified: false });
});

test("a java-sources declaration states the directory it stands for and refuses an empty at", () => {
  const generated = "/host/generated-openapi";
  const at = "target/generated-sources/openapi";
  const declared = javaSourcesDeclared(`${at}=${generated}`);
  assert.deepEqual(declared, { kind: "java-sources", at, path: generated });
  assert.ok(declared !== undefined);
  assert.equal(mountOf(declared), at);
  for (const refused of [generated, `=${generated}`, `${at}=`, `../up=${generated}`]) assert.equal(javaSourcesDeclared(refused), undefined, refused);
});

test("a node-modules declaration keeps its parsing and stands for <at>/node_modules", () => {
  assert.deepEqual(nodeModulesDeclared("deps/node_modules"), { kind: "node-modules", at: "", path: "deps/node_modules" });
  assert.deepEqual(nodeModulesDeclared("web=/host/web/node_modules"), { kind: "node-modules", at: "web", path: "/host/web/node_modules" });
  assert.equal(mountOf({ kind: "node-modules", at: "" }), "node_modules");
  assert.equal(mountOf({ kind: "node-modules", at: "web" }), "web/node_modules");
});

test("a jdk declaration parses as a node-modules one does, stands for the directory it compiles and is a cut at it", () => {
  assert.deepEqual(jdkDeclared("/host/jdk"), { kind: "jdk", at: "", path: "/host/jdk" });
  assert.deepEqual(jdkDeclared("svc=/host/jdk"), { kind: "jdk", at: "svc", path: "/host/jdk" });
  assert.deepEqual(jdkDeclared("=/host/a=b"), { kind: "jdk", at: "", path: "/host/a=b" });
  for (const refused of ["", "svc=", "../up=/host/jdk", "/abs=/host/jdk"]) assert.equal(jdkDeclared(refused), undefined, refused);
  assert.equal(mountOf({ kind: "jdk", at: "" }), ".");
  assert.equal(mountOf({ kind: "jdk", at: "svc" }), "svc");
  const parts = [{ used: false as const, outputs: [{ kind: "jdk" as const, at: "svc" }], reason: "jdk-older-than-build" as const }, { used: true as const, refused: ["a/link"] }];
  assert.deepEqual(buildOutputCuts(parts).map(({ at, reason }) => ({ at, reason })), [{ at: ["svc"], reason: "jdk-older-than-build" }, { at: ["a/link"], reason: "link-outside" }]);
});
