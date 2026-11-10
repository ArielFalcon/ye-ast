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
  const routes = (await createSpringRoutesExtractor(parser).extract(files)).findings;
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

test("@JsonGetter and @JsonProperty on a method make it a property whatever the method is called", async () => {
  const shape = await shapeOf(controller("Item"), source("Item", 'class Item { @JsonGetter("a") public String value() { return null; } @JsonProperty("b") String other() { return null; } public String plain() { return null; } }'));
  assert.deepEqual(propertyShapes(shape), { a: "string|null", b: "string|null" });
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

const OBJECT_MAPPER = "import com.fasterxml.jackson.databind.ObjectMapper;";
const CONFIGURATION = "@org.springframework.context.annotation.Configuration";
const BEAN = "@org.springframework.context.annotation.Bean";
const WEB_IMPORTS = [
  "import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;",
  "import org.springframework.http.converter.HttpMessageConverter;",
  "import org.springframework.http.converter.json.MappingJackson2HttpMessageConverter;",
].join(" ");

test("code that configures the mapper makes every Java shape unknown, with the places that configure it", async () => {
  const dto = source("Item", "class Item { public String name; }");
  const config = source("MapperConfig", `${OBJECT_MAPPER} @org.springframework.context.annotation.Configuration class MapperConfig { @org.springframework.context.annotation.Bean ObjectMapper mapper() { return null; } }`);
  const shape = await shapeOf(controller("Item"), dto, config);
  assert.ok(shape.kind === "unknown");
  assert.deepEqual(
    shape.evidence.map(({ path, line }) => `${path}:${line}`),
    ["src/main/java/app/MapperConfig.java:8"],
  );
  const yaml: SourceFile = { path: "src/main/resources/application.yml", content: "spring:\n  jackson:\n    default-property-inclusion: non_null\n" };
  assert.equal((await shapeOf(controller("Item"), dto, yaml)).kind, "unknown");
});

const yamlAt = (content: string, path = "src/main/resources/application.yml"): SourceFile => ({ path, content });

test("a mapper setting that changes what a body holds makes the shapes unknown at that key, and one that only presents it does not", async () => {
  const files = [controller("Item"), source("Item", "class Item { public String name; }")];
  for (const harmless of ["serialization:\n      indent-output: false", "time-zone: UTC", "locale: en", "deserialization:\n      fail-on-unknown-properties: false", "serialization:\n      INDENT_OUTPUT: true"]) {
    assert.equal((await shapeOf(...files, yamlAt(`spring:\n  jackson:\n    ${harmless}\n`))).kind, "known", harmless);
  }
  for (const changing of ["default-property-inclusion: non_null", "property-naming-strategy: SNAKE_CASE", "serialization:\n      write-enums-using-to-string: true", "mapper:\n      use-annotations: false"]) {
    assert.equal((await shapeOf(...files, yamlAt(`spring:\n  jackson:\n    ${changing}\n`))).kind, "unknown", changing);
  }
  const shape = await shapeOf(...files, yamlAt("# jackson\nspring:\n  jackson:\n    time-zone: UTC\n    default-property-inclusion: non_null\n"));
  assert.ok(shape.kind === "unknown");
  assert.deepEqual(shape.evidence, [{ path: "src/main/resources/application.yml", line: 5 }]);
});

test("a mapper setting of another module, or text that only mentions jackson, does not change a module's shapes", async () => {
  const dto = source("Item", "class Item { public String name; }");
  const other = yamlAt("spring:\n  jackson:\n    default-property-inclusion: non_null\n", "other/src/main/resources/application.yml");
  assert.equal((await shapeOf(controller("Item"), dto, other, yamlAt("app:\n  note: jackson\n"))).kind, "known");
});

test("a converter hook that only registers the default Jackson converter changes nothing; any other statement in it may", async () => {
  const dto = source("Item", "class Item { public String name; }");
  const hook = (body: string) => source("WebConfig", `${WEB_IMPORTS} class WebConfig implements WebMvcConfigurer { public void configureMessageConverters(List<HttpMessageConverter<?>> converters) { ${body} } }`);
  assert.equal((await shapeOf(controller("Item"), dto, hook("converters.add(new MappingJackson2HttpMessageConverter());"))).kind, "known");
  assert.equal((await shapeOf(controller("Item"), dto, hook("converters.add(new MappingJackson2HttpMessageConverter(custom));"))).kind, "unknown");
  assert.equal((await shapeOf(controller("Item"), dto, hook("converters.add(build());"))).kind, "unknown");
  assert.equal((await shapeOf(controller("Item"), dto, hook("converters.clear();"))).kind, "unknown");
  const own = source("MappingJackson2HttpMessageConverter", "class MappingJackson2HttpMessageConverter { }");
  const withoutImport = (body: string) => source("WebConfig", `import org.springframework.web.servlet.config.annotation.WebMvcConfigurer; class WebConfig implements WebMvcConfigurer { public void configureMessageConverters(List<Object> converters) { ${body} } }`);
  assert.equal((await shapeOf(controller("Item"), dto, own, withoutImport("converters.add(new MappingJackson2HttpMessageConverter());"))).kind, "unknown");
});

test("the files a shape depends on include every file that declares a mapper setting, harmless or not, and the places of code that configure it", async () => {
  const files = [controller("Item"), source("Item", "class Item { public String name; }")];
  const filesOf = async (...more: SourceFile[]) => {
    const [only] = await responses(...files, ...more);
    assert.ok(only?.status === "complete");
    return only.value.files;
  };
  const item = "src/main/java/app/Item.java";
  const handler = "src/main/java/app/ItemController.java";
  const settings = "src/main/resources/application.yml";
  assert.deepEqual(await filesOf(), [item, handler]);
  assert.deepEqual(await filesOf(yamlAt("spring:\n  jackson:\n    time-zone: UTC\n")), [item, handler, settings]);
  const mapper = `${OBJECT_MAPPER} ${CONFIGURATION} class Mapper { ${BEAN} ObjectMapper mapper() { return null; } }`;
  assert.deepEqual(await filesOf(source("Mapper", mapper)), [item, handler, "src/main/java/app/Mapper.java"]);
});

test("the files of a shape the reader cannot answer under the configured mapper still include the types it would have read, and an unrelated file stays out", async () => {
  const handler = "src/main/java/app/ItemController.java";
  const item = "src/main/java/app/Item.java";
  const unrelated = source("Unrelated", "class Unrelated { public int z; }");
  const mapper = source("Mapper", `${OBJECT_MAPPER} ${CONFIGURATION} class Mapper { ${BEAN} ObjectMapper mapper() { return null; } }`);
  const inclusion = yamlAt("spring:\n  jackson:\n    default-property-inclusion: non_null\n");
  for (const configured of [inclusion, mapper]) {
    const [only] = await responses(controller("Item"), source("Item", "class Item { public String x; }"), unrelated, configured);
    assert.ok(only?.status === "complete" && only.value.shape.kind === "unknown");
    assert.deepEqual(only.value.files, [item, handler, configured.path].toSorted());
  }
});

test("a method named like a converter hook is code configuration only in a class that is a Spring MVC configurer", async () => {
  const dto = source("Item", "class Item { public String name; }");
  const hook = "public void configureMessageConverters(List<HttpMessageConverter<?>> converters) { converters.clear(); }";
  const support = "import org.springframework.web.servlet.config.annotation.WebMvcConfigurationSupport; import org.springframework.http.converter.HttpMessageConverter;";
  const configure = (name: string, head: string, supertype: string, imports = WEB_IMPORTS) => source(name, `${imports} ${head} class ${name} ${supertype} { ${hook} }`);
  assert.equal((await shapeOf(controller("Item"), dto, configure("Helper", "", ""))).kind, "known");
  assert.equal((await shapeOf(controller("Item"), dto, configure("Helper", "", "implements Runnable"))).kind, "known");
  assert.equal((await shapeOf(controller("Item"), dto, configure("WebConfig", "", "implements WebMvcConfigurer"))).kind, "unknown");
  assert.equal((await shapeOf(controller("Item"), dto, configure("WebConfig", "", "extends WebMvcConfigurationSupport", support))).kind, "unknown");
  const intermediate = source("Base", `${WEB_IMPORTS} interface Base extends WebMvcConfigurer { }`);
  assert.equal((await shapeOf(controller("Item"), dto, intermediate, configure("WebConfig", "", "implements Base"))).kind, "unknown");
  const homonym = configure("WebConfig", "", "implements WebMvcConfigurer", "import example.WebMvcConfigurer; import org.springframework.http.converter.HttpMessageConverter;");
  assert.equal((await shapeOf(controller("Item"), dto, homonym)).kind, "known");
});

test("a bean configures the mapper by the identity of its declared type, whatever its simple name", async () => {
  const dto = source("Item", "class Item { public String name; }");
  const bean = (name: string, imports: string, type: string) => source(name, `${imports} ${CONFIGURATION} class ${name} { ${BEAN} ${type} bean() { return null; } }`);
  assert.equal((await shapeOf(controller("Item"), dto, bean("Config", OBJECT_MAPPER, "ObjectMapper"))).kind, "unknown");
  assert.equal((await shapeOf(controller("Item"), dto, bean("Config", "import com.fasterxml.jackson.databind.*;", "ObjectMapper"))).kind, "unknown");
  assert.equal((await shapeOf(controller("Item"), dto, bean("Config", "", "com.fasterxml.jackson.databind.ObjectMapper"))).kind, "unknown");
  const own = source("OwnMapper", `${OBJECT_MAPPER} class OwnMapper extends ObjectMapper { }`);
  assert.equal((await shapeOf(controller("Item"), dto, own, bean("Config", "", "OwnMapper"))).kind, "unknown");
  assert.equal((await shapeOf(controller("Item"), dto, bean("Config", "import example.ObjectMapper;", "ObjectMapper"))).kind, "known");
  assert.equal((await shapeOf(controller("Item"), dto, bean("Config", "import java.lang.Module;", "Module"))).kind, "known");
  assert.equal((await shapeOf(controller("Item"), dto, bean("Config", "", "String"))).kind, "known");
});

test("code configuration decides the shapes of its own module, and another module's makes them unresolved at its places", async () => {
  const dto = source("Item", "class Item { public String name; }");
  const mapper = `${OBJECT_MAPPER} ${CONFIGURATION} class Mapper { ${BEAN} ObjectMapper mapper() { return null; } }`;
  const own = source("Mapper", mapper);
  const other: SourceFile = { path: "other/src/main/java/app/Mapper.java", content: `${HEADER}\n${mapper}` };
  const sameModule = await shapeOf(controller("Item"), dto, own);
  assert.ok(sameModule.kind === "unknown");
  assert.equal(sameModule.reason, "no-extractor");
  const elsewhere = await shapeOf(controller("Item"), dto, other);
  assert.ok(elsewhere.kind === "unknown");
  assert.equal(elsewhere.reason, "unresolved");
  assert.deepEqual(elsewhere.evidence.map(({ path, line }) => `${path}:${line}`), [`${other.path}:8`]);
  const [only] = await responses(controller("Item"), dto, other);
  assert.ok(only?.status === "complete");
  assert.ok(only.value.files.includes(other.path) && only.value.files.includes("src/main/java/app/Item.java"));
});

test("a mapper setting an alias or a merge key may hold leaves the shapes unknown at that place", async () => {
  const files = [controller("Item"), source("Item", "class Item { public String name; }")];
  const alias = "defaults: &settings\n  jackson:\n    default-property-inclusion: non_null\nspring: *settings\n";
  const merge = "defaults: &defaults\n  jackson:\n    default-property-inclusion: non_null\nspring:\n  <<: *defaults\n";
  for (const content of [alias, merge]) {
    const shape = await shapeOf(...files, yamlAt(content));
    assert.ok(shape.kind === "unknown", content);
    assert.equal(shape.evidence[0]?.path, "src/main/resources/application.yml");
  }
  assert.equal((await shapeOf(...files, yamlAt("shared: &shared\n  a: 1\nother: *shared\nspring:\n  jackson:\n    locale: en\n"))).kind, "known");
});

test("only a plain registration of the framework's own converter on the hook's list keeps the default mapper", async () => {
  const dto = source("Item", "class Item { public String name; }");
  const hook = (body: string, imports = WEB_IMPORTS) => source("WebConfig", `${imports} class WebConfig implements WebMvcConfigurer { public void configureMessageConverters(List<HttpMessageConverter<?>> converters, List<Object> others) { ${body} } }`);
  const subclass = "converters.add(new MappingJackson2HttpMessageConverter() { @Override protected void writeInternal(Object object, java.lang.reflect.Type type, org.springframework.http.HttpOutputMessage out) { } });";
  assert.equal((await shapeOf(controller("Item"), dto, hook(subclass))).kind, "unknown");
  assert.equal((await shapeOf(controller("Item"), dto, hook("converters.add(new example.MappingJackson2HttpMessageConverter());"))).kind, "unknown");
  assert.equal((await shapeOf(controller("Item"), dto, hook("converters.add(new MappingJackson2HttpMessageConverter());", WEB_IMPORTS.replace("org.springframework.http.converter.json", "example")))).kind, "unknown");
  assert.equal((await shapeOf(controller("Item"), dto, hook("others.add(new MappingJackson2HttpMessageConverter());"))).kind, "unknown");
  assert.equal((await shapeOf(controller("Item"), dto, hook("converters.add(new org.springframework.http.converter.json.MappingJackson2HttpMessageConverter());", ""))).kind, "known");
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
