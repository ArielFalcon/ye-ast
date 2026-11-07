import { before, test } from "node:test";
import assert from "node:assert/strict";
import type { KnownShape, OperationShape, Shape } from "../../domain/contracts/payload-shape.ts";
import type { Finding } from "../../domain/shared/fact.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import { createJavaParser, type JavaParser } from "../tree-sitter/java-parser.adapter.ts";
import { createSpringPayloadShapes } from "./spring-payload-shapes.adapter.ts";
import { createSpringRoutesExtractor } from "./spring-routes.adapter.ts";

const HEADER = [
  "package app;",
  "import org.springframework.web.bind.annotation.*;",
  "import org.springframework.http.ResponseEntity;",
  "import org.springframework.stereotype.Controller;",
  "import com.fasterxml.jackson.annotation.*;",
  "import java.util.*;",
  "import lombok.*;",
].join("\n");

let parser: JavaParser;

before(async () => {
  parser = await createJavaParser();
});

function source(name: string, body: string): SourceFile {
  return { path: `src/main/java/app/${name}.java`, content: `${HEADER}\n${body}` };
}

/** A controller whose one `GET /items` handler returns `returns`. */
function controller(returns: string, annotation = "@RestController"): SourceFile {
  return source("ItemController", `${annotation}\nclass ItemController {\n  @GetMapping("/items")\n  ${returns} items() { return null; }\n}`);
}

async function responses(...files: SourceFile[]): Promise<readonly Finding<OperationShape>[]> {
  const routes = await createSpringRoutesExtractor(parser).extract(files);
  return createSpringPayloadShapes(parser, () => routes).responses(files);
}

async function shapeOf(...files: SourceFile[]): Promise<Shape> {
  const [only, ...rest] = await responses(...files);
  assert.ok(only?.status === "complete" && rest.length === 0);
  return only.value.shape;
}

function known(shape: Shape): KnownShape {
  assert.equal(shape.kind, "known");
  return shape as KnownShape;
}

function properties(shape: Shape): Record<string, { required: boolean; shape: Shape }> {
  const object = known(shape).object;
  assert.ok(object);
  return Object.fromEntries(object.properties.map(({ name, required, shape: own }) => [name, { required, shape: own }]));
}

function propertyShapes(shape: Shape): Record<string, string> {
  return Object.fromEntries(Object.entries(properties(shape)).map(([name, { required, shape: own }]) => [name, `${required ? "" : "?"}${describe(own)}`]));
}

function describe(shape: Shape): string {
  if (shape.kind === "unknown") return `unknown(${shape.reason})`;
  const { literals, array, object, null: nullable } = shape.values;
  const classes = (["boolean", "number", "string"] as const).flatMap((name) => (literals[name] === "every" ? [name] : literals[name].length > 0 ? [`${name}[${literals[name].join("|")}]`] : []));
  const kinds = [...classes, ...(array ? [`array<${describe(shape.elements!)}>`] : []), ...(object ? ["object"] : [])];
  return `${kinds.join("|")}${nullable ? "|null" : ""}`;
}

test("a handler returns the object of its class: public getters and fields by Jackson's names, a primitive never null and every other reference nullable", async () => {
  const dto = source(
    "Item",
    [
      "class Item {",
      "  public String label;",
      "  private int count;",
      "  private Boolean active;",
      "  private boolean flag;",
      "  private String hidden;",
      "  private List<String> tags;",
      "  public int getCount() { return count; }",
      "  public Boolean getActive() { return active; }",
      "  public boolean isFlag() { return flag; }",
      "  public List<String> getTags() { return tags; }",
      "  public String getURL() { return null; }",
      "  public static String getUtility() { return null; }",
      "}",
    ].join("\n"),
  );
  const shape = await shapeOf(controller("Item"), dto);
  assert.deepEqual(propertyShapes(shape), {
    active: "boolean|null",
    count: "number",
    flag: "boolean",
    label: "string|null",
    tags: "array<string|null>|null",
    url: "string|null",
  });
  assert.equal(known(shape).object?.open, false);
});

test("the operation carries the verb and path the code maps and the files its shape was read from", async () => {
  const [found] = await responses(controller("Item"), source("Item", "class Item { public String name; }"));
  assert.ok(found?.status === "complete");
  assert.deepEqual(
    [found.value.operationId, found.value.method, found.value.path, found.value.basePath, found.value.files],
    [undefined, "GET", "/items", "", ["src/main/java/app/Item.java", "src/main/java/app/ItemController.java"]],
  );
});

test("ResponseEntity and Optional are unwrapped, and a collection or array is an array of its element", async () => {
  const dto = source("Item", "class Item { public String name; }");
  assert.equal(describe(known(await shapeOf(controller("ResponseEntity<List<Item>>"), dto))), "array<object|null>|null");
  assert.equal(describe(known(await shapeOf(controller("Optional<Item>"), dto))), "object|null");
  assert.equal(describe(known(await shapeOf(controller("Item[]"), dto))), "array<object|null>|null");
});

test("a record is its components", async () => {
  const shape = await shapeOf(controller("Item"), source("Item", "record Item(String name, long size) {}"));
  assert.deepEqual(propertyShapes(shape), { name: "string|null", size: "number" });
  assert.equal(known(shape).object?.open, false);
});

test("Lombok's @Data, @Value and @Getter generate the getters Jackson reads, and an access level other than public generates none", async () => {
  const data = source("Item", "@Data class Item { private String name; private boolean done; private static String skipped; @Getter(AccessLevel.NONE) private String secret; @Getter(AccessLevel.PRIVATE) private String own; }");
  assert.deepEqual(propertyShapes(await shapeOf(controller("Item"), data)), { done: "boolean", name: "string|null" });
  const fieldLevel = source("Item", "class Item { @Getter private Long id; private String unread; }");
  assert.deepEqual(propertyShapes(await shapeOf(controller("Item"), fieldLevel)), { id: "number|null" });
});

test("a Lombok boolean field named isX is the property x, and a wrapper Boolean named isX keeps its name", async () => {
  const shape = await shapeOf(controller("Item"), source("Item", "@Getter class Item { private boolean isDone; private Boolean isOpen; }"));
  assert.deepEqual(Object.keys(properties(shape)), ["done", "isOpen"]);
});

test("@Accessors changes the accessors Lombok writes: the class is unknown", async () => {
  const shape = await shapeOf(controller("Item"), source("Item", "@Data @lombok.experimental.Accessors(fluent = true) class Item { private String name; }"));
  assert.equal(shape.kind, "unknown");
});

test("@JsonProperty names a property whatever the field is called, so a renamed field with its wire name pinned keeps the same shape", async () => {
  const before = source("Item", '@Data class Item { @JsonProperty("display_name") private String name; }');
  const after = source("Item", '@Data class Item { @JsonProperty("display_name") private String title; }');
  const pinned = await shapeOf(controller("Item"), before);
  assert.deepEqual(pinned, await shapeOf(controller("Item"), after));
  assert.deepEqual(Object.keys(properties(pinned)), ["display_name"]);
});

test("a field renamed to the wire name its getter already has is one property with that name", async () => {
  const before = source("Item", "@Data class Item { private boolean monolith; }");
  const after = source("Item", '@Data class Item { @JsonProperty("monolith") private boolean isMonolith; }');
  const base = await shapeOf(controller("Item"), before);
  assert.deepEqual(propertyShapes(base), { monolith: "boolean" });
  assert.deepEqual(await shapeOf(controller("Item"), after), base);
});

test("two properties of one wire name that disagree on their type leave the class unknown", async () => {
  const dto = source("Item", '@Data class Item { @JsonProperty("size") private String label; private int size; }');
  assert.equal((await shapeOf(controller("Item"), dto)).kind, "unknown");
});

test("@JsonGetter names a property through its getter, and a field annotation renames the property its getter belongs to", async () => {
  const shape = await shapeOf(controller("Item"), source("Item", '@Data class Item { @JsonProperty("a") private String first; private String second; @JsonGetter("b") public String getSecond() { return second; } }'));
  assert.deepEqual(Object.keys(properties(shape)), ["a", "b"]);
});

test("@JsonIgnore on any accessor and write-only access drop a property", async () => {
  const dto = source("Item", "@Data class Item { @JsonIgnore private String ignored; @JsonProperty(access = JsonProperty.Access.WRITE_ONLY) private String password; private String kept; public String getSecret() { return null; } @JsonIgnore public void setSecret(String value) {} }");
  assert.deepEqual(Object.keys(properties(await shapeOf(controller("Item"), dto))), ["kept"]);
});

test("NON_NULL turns null into absence on the class or the member, and an Optional keeps its null", async () => {
  const dto = source(
    "Item",
    "@Data @JsonInclude(JsonInclude.Include.NON_NULL) class Item { private String name; private int size; private Optional<String> note; @JsonInclude(JsonInclude.Include.ALWAYS) private String forced; }",
  );
  assert.deepEqual(propertyShapes(await shapeOf(controller("Item"), dto)), { forced: "string|null", name: "?string", note: "string|null", size: "number" });
});

test("an inclusion other than NON_NULL leaves its property unknown, on the member or inherited from the class", async () => {
  const member = source("Item", "@Data class Item { @JsonInclude(JsonInclude.Include.NON_EMPTY) private List<String> tags; private String name; }");
  assert.deepEqual(propertyShapes(await shapeOf(controller("Item"), member)), { name: "string|null", tags: "?unknown(no-extractor)" });
  const inherited = source("Item", "@Data @JsonInclude(JsonInclude.Include.NON_DEFAULT) class Item { private int size; }");
  assert.deepEqual(propertyShapes(await shapeOf(controller("Item"), inherited)), { size: "?unknown(no-extractor)" });
});

test("an enumeration is a string of its constants' wire names, and @JsonValue or @JsonFormat leaves it unknown", async () => {
  const plain = source("Kind", 'enum Kind { B, A, @JsonProperty("c-wire") C }');
  const dto = source("Item", "@Data class Item { private Kind kind; }");
  assert.deepEqual(propertyShapes(await shapeOf(controller("Item"), dto, plain)), { kind: "string[A|B|c-wire]|null" });
  const value = source("Kind", "enum Kind { A; @JsonValue public String code() { return null; } }");
  assert.deepEqual(propertyShapes(await shapeOf(controller("Item"), dto, value)), { kind: "unknown(no-extractor)" });
  const format = source("Kind", "@JsonFormat(shape = JsonFormat.Shape.OBJECT) enum Kind { A }");
  assert.deepEqual(propertyShapes(await shapeOf(controller("Item"), dto, format)), { kind: "unknown(no-extractor)" });
});

test("annotations that change which properties a class writes leave the class unknown, and those that change a value leave only the property", async () => {
  const unwrapped = source("Item", "@Data class Item { @JsonUnwrapped private Inner inner; } class Inner { public String x; }");
  assert.equal((await shapeOf(controller("Item"), unwrapped)).kind, "unknown");
  const valueOnly = source("Item", "@Data class Item { @JsonFormat(shape = JsonFormat.Shape.STRING) private Long id; private String name; }");
  assert.deepEqual(propertyShapes(await shapeOf(controller("Item"), valueOnly)), { id: "?unknown(no-extractor)", name: "string|null" });
});

test("an annotation on the class that adds, drops or reshapes properties leaves the class unknown", async () => {
  const dto = source("Item", '@Data @JsonIgnoreProperties({"name"}) class Item { private String name; }');
  assert.equal((await shapeOf(controller("Item"), dto)).kind, "unknown");
});

test("every operation names the files of its shape, including those of a type another handler already read", async () => {
  const twice = source("ItemController", '@RestController class ItemController { @GetMapping("/a") Item a() { return null; } @GetMapping("/b") Item b() { return null; } }');
  const found = await responses(twice, source("Item", "class Item { public String name; }"));
  assert.deepEqual(
    found.map((finding) => finding.status === "complete" && finding.value.files),
    [
      ["src/main/java/app/Item.java", "src/main/java/app/ItemController.java"],
      ["src/main/java/app/Item.java", "src/main/java/app/ItemController.java"],
    ],
  );
});

test("Map, Page, dates, Object and a type no source declares are unknown at their place", async () => {
  const dto = source("Item", "@Data class Item { private Map<String, String> attributes; private java.time.Instant at; private Object any; private Missing gone; private String name; }");
  assert.deepEqual(propertyShapes(await shapeOf(controller("Item"), dto)), {
    any: "unknown(no-extractor)",
    at: "unknown(no-extractor)",
    attributes: "unknown(no-extractor)",
    gone: "unknown(unresolved)",
    name: "string|null",
  });
  assert.equal((await shapeOf(controller("Page<Item>"), dto)).kind, "unknown");
});

test("a type variable is the type its use binds, and a raw use leaves it unknown", async () => {
  const envelope = source("Envelope", "@Data class Envelope<T> { private T data; private List<T> all; }");
  const item = source("Item", "class Item { public String name; }");
  assert.deepEqual(propertyShapes(await shapeOf(controller("Envelope<Item>"), envelope, item)), { all: "array<object|null>|null", data: "object|null" });
  assert.deepEqual(propertyShapes(await shapeOf(controller("Envelope"), envelope, item)), { all: "array<unknown(unresolved)>|null", data: "unknown(unresolved)" });
});

test("a type that contains itself stops at the second visit, leaving that place unknown", async () => {
  const tree = source("Node", "@Data class Node { private String name; private List<Node> children; private Node parent; }");
  assert.deepEqual(propertyShapes(await shapeOf(controller("Node"), tree)), { children: "array<unknown(unresolved)>|null", name: "string|null", parent: "unknown(unresolved)" });
});

test("a class a subclass extends is open, and a class nothing extends is not", async () => {
  const base = source("Base", "@Data class Base { private String id; } class Derived extends Base { public String extra; }");
  assert.equal(known(await shapeOf(controller("Base"), base)).object?.open, true);
  assert.equal(known(await shapeOf(controller("Derived"), base)).object?.open, false);
});

test("properties are the class's own and its superclasses'", async () => {
  const base = source("Base", "@Data class Base { private String id; } @Data class Derived extends Base { private String extra; }");
  assert.deepEqual(Object.keys(properties(await shapeOf(controller("Derived"), base))), ["extra", "id"]);
});

test("a supertype the sources do not state, or the platform writes its own way, leaves the class unknown", async () => {
  assert.equal((await shapeOf(controller("Item"), source("Item", "import org.lib.Base; class Item extends Base { public String name; }"))).kind, "unknown");
  assert.equal((await shapeOf(controller("Item"), source("Item", "class Item extends HashMap<String, String> { public String name; }"))).kind, "unknown");
  assert.equal((await shapeOf(controller("Item"), source("Item", "class Item implements java.io.Serializable, Comparable<Item> { public String name; public int compareTo(Item o) { return 0; } }"))).kind, "known");
});

test("a body is written only when the class or method says so or the value is an entity, and plain text is not a JSON value", async () => {
  const dto = source("Item", "class Item { public String name; }");
  assert.equal((await shapeOf(controller("Item", "@Controller"), dto)).kind, "unknown");
  assert.equal((await shapeOf(controller("ResponseEntity<Item>", "@Controller"), dto)).kind, "known");
  const method = source("ItemController", '@Controller class ItemController { @ResponseBody @GetMapping("/items") Item items() { return null; } }');
  assert.equal((await shapeOf(method, dto)).kind, "known");
  assert.equal((await shapeOf(controller("String"))).kind, "unknown");
  assert.equal((await shapeOf(controller("void"))).kind, "unknown");
});

test("code that configures the mapper makes every Java shape unknown, with the places that configure it", async () => {
  const dto = source("Item", "class Item { public String name; }");
  const config = source("MapperConfig", "@org.springframework.context.annotation.Configuration class MapperConfig { @org.springframework.context.annotation.Bean ObjectMapper mapper() { return null; } }");
  const shape = await shapeOf(controller("Item"), dto, config);
  assert.ok(shape.kind === "unknown");
  assert.deepEqual(
    shape.evidence.map(({ path, line }) => `${path}:${line}`),
    ["src/main/java/app/MapperConfig.java:8"],
  );
  const yaml: SourceFile = { path: "src/main/resources/application.yml", content: "spring:\n  jackson:\n    default-property-inclusion: non_null\n" };
  assert.equal((await shapeOf(controller("Item"), dto, yaml)).kind, "unknown");
});

test("one handler mapped to several routes gives each the same shape, and a source with no route gives none", async () => {
  const many = source("ItemController", '@RestController class ItemController { @RequestMapping(path = {"/a", "/b"}, method = RequestMethod.GET) Item items() { return null; } }');
  const found = await responses(many, source("Item", "class Item { public String name; }"));
  assert.deepEqual(found.map((finding) => finding.status === "complete" && `${finding.value.method} ${finding.value.path}`), ["GET /a", "GET /b"]);
  assert.deepEqual(await responses(source("Item", "class Item { public String name; }")), []);
});

test("two runs over the same sources give the same shapes", async () => {
  const files = [controller("Item"), source("Item", "@Data class Item { private String b; private String a; }")];
  assert.deepEqual(await responses(...files), await responses(...files));
});
