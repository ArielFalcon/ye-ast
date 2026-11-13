import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import type { ReceiverMethod } from "../../ports/import-origins.port.ts";
import { createJavaParser } from "../tree-sitter/java-parser.adapter.ts";
import { createJavaNameBindings } from "./java-name-bindings.adapter.ts";

const DIRECTORY = new URL("./fixtures/lombok/", import.meta.url);
const GENERATED: ReceiverMethod = { kind: "generated" };
const UNPROVEN: ReceiverMethod = { kind: "unproven" };

function sources(replace: (name: string, content: string) => string = (_, content) => content) {
  return readdirSync(DIRECTORY).map((name) => ({ path: `src/main/java/app/${name}`, content: replace(name, readFileSync(new URL(name, DIRECTORY), "utf8")) }));
}

/** What the call that the statement starting with `statement` makes of `member` is resolved to. */
async function callOf(statement: string, member: string, files = sources(), paths?: readonly string[]): Promise<ReceiverMethod | undefined> {
  const use = files.find(({ path }) => path.endsWith("/Use.java"))!;
  const lines = use.content.split("\n");
  const index = lines.findIndex((line) => line.trim().startsWith(statement));
  assert.notEqual(index, -1, statement);
  const column = lines[index]!.indexOf(statement) + 1;
  const [found] = await createJavaNameBindings(createJavaParser, files, paths).receiverMethods([{ file: use.path, line: index + 1, column, member }]);
  return found;
}

test("a Lombok class annotation generates the accessors of its non-static fields: getters for @Data, setters only for non-final fields, is/set for a primitive boolean", async () => {
  assert.deepEqual(await callOf("person.getName", "getName"), GENERATED);
  assert.deepEqual(await callOf("person.setName", "setName"), GENERATED);
  assert.deepEqual(await callOf("person.isActive", "isActive"), GENERATED);
  assert.deepEqual(await callOf("person.isAdmin", "isAdmin"), GENERATED);
  assert.deepEqual(await callOf("person.setAdmin", "setAdmin"), GENERATED);
  assert.deepEqual(await callOf("person.getBoxed", "getBoxed"), GENERATED);
  assert.deepEqual(await callOf("person.getId", "getId"), GENERATED);
  assert.deepEqual(await callOf("person.setId", "setId"), UNPROVEN);
  assert.deepEqual(await callOf("person.getCount", "getCount"), UNPROVEN);
  assert.deepEqual(await callOf("person.getMissing", "getMissing"), UNPROVEN);
});

test("@Value generates getters and no setters", async () => {
  assert.deepEqual(await callOf("value.getId", "getId"), GENERATED);
  assert.deepEqual(await callOf("value.setId", "setId"), UNPROVEN);
});

test("a method the class declares wins over the generated one, and its neighbours stay generated", async () => {
  assert.deepEqual(await callOf("declared.getLabel", "getLabel"), { kind: "method", file: "src/main/java/app/Declared.java", start: 7, nameLine: 7 });
  assert.deepEqual(await callOf("declared.getOther", "getOther"), GENERATED);
});

test("a field annotation covers only its field, and only the accessor it asks for", async () => {
  assert.deepEqual(await callOf("only.getShown", "getShown"), GENERATED);
  assert.deepEqual(await callOf("only.setWritten", "setWritten"), GENERATED);
  assert.deepEqual(await callOf("only.getHidden", "getHidden"), UNPROVEN);
  assert.deepEqual(await callOf("only.setShown", "setShown"), UNPROVEN);
});

test("an annotation that is not Lombok's, or that changes the access, settles nothing", async () => {
  assert.deepEqual(await callOf("not.getName", "getName"), UNPROVEN);
  assert.deepEqual(await callOf("restricted.getName", "getName"), UNPROVEN);
});

test("a lombok.config in the snapshot leaves every generated member unsettled", async () => {
  const files = sources();
  assert.deepEqual(await callOf("person.getName", "getName", files, [...files.map(({ path }) => path), "lombok.config"]), UNPROVEN);
  assert.deepEqual(await callOf("person.getName", "getName", files, [...files.map(({ path }) => path), "src/main/lombok.config.md"]), GENERATED);
});

test("@Builder generates builder(), a setter per settable field and build(), whose result is the built type", async () => {
  assert.deepEqual(await callOf("Order.builder().id", "builder"), GENERATED);
  assert.deepEqual(await callOf("Order.builder().id", "id"), GENERATED);
  assert.deepEqual(await callOf("Order.builder().id(\"a\").owner", "owner"), GENERATED);
  assert.deepEqual(await callOf("Order.builder().id(\"a\").owner(null).build()", "build"), GENERATED);
  assert.deepEqual(await callOf("Order.builder().id(\"a\").owner(null).build().getOwner", "getOwner"), GENERATED);
  assert.deepEqual(await callOf("Order.builder().version", "version"), UNPROVEN);
  assert.deepEqual(await callOf("Order.builder().missing", "missing"), UNPROVEN);
  assert.deepEqual(await callOf("Plain.builder().name", "name"), UNPROVEN);
});

test("a record generates the accessor of each component it does not declare, typed as the component", async () => {
  assert.deepEqual(await callOf("pair.owner().getName", "getName"), GENERATED);
  assert.deepEqual(await callOf("pair.owner", "owner"), GENERATED);
  assert.deepEqual(await callOf("pair.left", "left"), { kind: "method", file: "src/main/java/app/Pair.java", start: 3, nameLine: 3 });
  assert.deepEqual(await callOf("pair.right", "right"), UNPROVEN);
});
