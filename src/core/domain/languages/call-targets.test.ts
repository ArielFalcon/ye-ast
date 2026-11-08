import assert from "node:assert/strict";
import test from "node:test";
import { mayRunDeclarationOf, sharesRuntime } from "./call-targets.ts";

test("a call runs declarations of its own runtime, templates included, and of files no predicate classifies, never of the other runtime or a configuration file", () => {
  const cases: [string, string, boolean][] = [
    ["src/main/java/a/UserService.java", "src/main/java/a/User.java", true],
    ["src/main/java/a/UserService.java", "src/app/user.service.ts", false],
    ["src/app/user.service.ts", "src/main/java/a/User.java", false],
    ["src/app/user.component.html", "src/app/user.component.ts", true],
    ["src/main/java/a/UserService.java", "src/main/resources/config/application.yml", false],
    ["src/app/user.service.ts", "package.json", false],
    ["src/main/java/a/UserService.java", "scripts/build.py", true],
  ];
  assert.deepEqual(cases.map(([caller, declaration]) => mayRunDeclarationOf(caller, declaration)), cases.map(([, , expected]) => expected));
});

test("a file shares a runtime with files of its own language, templates included, and with files no predicate classifies, configuration among them, never with the other runtime", () => {
  const cases: [string, string, boolean][] = [
    ["src/main/java/a/UserService.java", "src/main/java/a/User.java", true],
    ["src/main/java/a/UserService.java", "src/app/user.service.ts", false],
    ["src/app/user.service.ts", "src/main/java/a/User.java", false],
    ["src/app/user.component.html", "src/app/user.component.ts", true],
    ["src/main/java/a/UserService.java", "src/main/resources/config/application.yml", true],
    ["src/app/user.service.ts", "package.json", true],
  ];
  assert.deepEqual(cases.map(([from, to]) => sharesRuntime(from, to)), cases.map(([, , expected]) => expected));
});
