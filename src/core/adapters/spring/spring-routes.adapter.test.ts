import { before, test } from "node:test";
import assert from "node:assert/strict";
import type { Entrypoint } from "../../domain/entrypoints/entrypoint.ts";
import type { BasePath, HttpMethod, HttpRoute } from "../../domain/entrypoints/http-route.ts";
import type { Finding } from "../../domain/shared/fact.ts";
import type { ContractOperation } from "../../ports/contract-routes.port.ts";
import type { EntrypointExtractor, SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { Node } from "web-tree-sitter";
import { createJavaParser, type JavaParser } from "../tree-sitter/java-parser.adapter.ts";
import { createSpringRoutesExtractor } from "./spring-routes.adapter.ts";

const WEB = "import org.springframework.web.bind.annotation.*;";
const BOOT = "package app;\nimport org.springframework.boot.autoconfigure.SpringBootApplication;\n@SpringBootApplication\npublic class Main {}";
const MAIN = { path: "src/main/java/app/Main.java", content: BOOT };
const ALIAS = "import org.springframework.core.annotation.AliasFor;";

let extractor: EntrypointExtractor;
let parser: JavaParser;

before(async () => {
  parser = await createJavaParser();
  extractor = createSpringRoutesExtractor(parser);
});

function file(path: string, content: string): SourceFile {
  return { path, content };
}

/** A Java source in package `app` with the Spring web annotations imported; the body starts at line 4. */
function app(name: string, body: string, imports = ""): SourceFile {
  return file(`src/main/java/app/${name}.java`, `package app;\n${WEB}\n${imports}\n${body}`);
}

function routeLabel(route: HttpRoute): string {
  return `${route.method} ${route.path}${route.version === undefined ? "" : ` v${route.version}`}`;
}

function routes(findings: readonly Finding<Entrypoint>[]): string[] {
  return findings.flatMap((finding) => (finding.status === "complete" && finding.value.kind === "http-route" ? [routeLabel(finding.value)] : [])).sort();
}

function unknowns(findings: readonly Finding<Entrypoint>[]) {
  return findings.flatMap((finding) => (finding.status === "unknown" ? [finding] : []));
}

function gaps(findings: readonly Finding<Entrypoint>[]): string[] {
  return unknowns(findings)
    .map((finding) => `${finding.reason}@${finding.evidence[0]?.line}`)
    .sort();
}

function handlers(findings: readonly Finding<Entrypoint>[]): string[] {
  return findings
    .flatMap((finding) => (finding.status === "complete" && finding.value.kind !== "ui-route" ? [`${finding.value.handler.symbol}@${finding.value.handler.line}`] : []))
    .sort();
}

test("a route carries the exact span of its handler: the annotations through the closing brace", async () => {
  const source = file(
    "src/main/java/app/OrderController.java",
    [
      "package app;",
      WEB,
      "@RestController",
      "public class OrderController {",
      '  @GetMapping("/orders")',
      "  @ResponseBody",
      "  public List<String> list(",
      "      int page) {",
      "    return null;",
      "  }",
      "}",
    ].join("\n"),
  );

  const findings = await extractor.extract([source, MAIN]);

  assert.deepEqual(findings, [
    {
      status: "complete",
      value: {
        kind: "http-route",
        name: "GET /orders",
        method: "GET",
        path: "/orders",
        handler: { path: source.path, symbol: "OrderController.list", line: 5, endLine: 10 },
        basePath: { status: "complete", value: { default: {}, profiles: {} }, evidence: [] },
      },
      evidence: [{ path: source.path, line: 5, endLine: 10 }],
    },
  ]);
});

test("every verb shortcut maps to its method and both controller stereotypes are controllers", async () => {
  const findings = await extractor.extract([
    app(
      "Verbs",
      `@Controller class Verbs {
  @GetMapping("/g") void g() {}
  @PostMapping("/p") void p() {}
  @PutMapping("/u") void u() {}
  @DeleteMapping("/d") void d() {}
  @PatchMapping("/a") void a() {}
}
@RestController class Rest { @GetMapping("/r") void r() {} }`,
      "import org.springframework.stereotype.Controller;",
    ),
  ]);

  assert.deepEqual(routes(findings), ["DELETE /d", "GET /g", "GET /r", "PATCH /a", "POST /p", "PUT /u"]);
});

test("a class that is not annotated as a controller gives no routes", async () => {
  const findings = await extractor.extract([app("Plain", `class Plain { @GetMapping("/x") void x() {} }`)]);

  assert.deepEqual(findings, []);
});

test("the class prefix is prepended to the method path", async () => {
  const findings = await extractor.extract([
    app("Orders", `@RestController @RequestMapping("/orders") class Orders { @GetMapping("/{id}") void one() {} }`),
  ]);

  assert.deepEqual(routes(findings), ["GET /orders/{id}"]);
});

test("prefix and path are joined with exactly one slash, a missing path keeps the prefix and an empty route is the root", async () => {
  const findings = await extractor.extract([
    app(
      "Joins",
      `@RestController @RequestMapping("/api/") class Joins {
  @GetMapping("/a") void a() {}
  @GetMapping("b") void b() {}
  @GetMapping void c() {}
}
@RestController class Root { @GetMapping void root() {} }
@RestController class Bare { @GetMapping("health") void health() {} }`,
    ),
  ]);

  assert.deepEqual(routes(findings), ["GET /", "GET /api/", "GET /api/a", "GET /api/b", "GET /health"]);
});

test("the prefix comes from an interface the controller implements, directly or through another interface", async () => {
  const findings = await extractor.extract([
    app("BaseApi", `@RequestMapping("/api") interface BaseApi {}`),
    app("OrderApi", `interface OrderApi extends BaseApi {}`),
    app("OrderController", `@RestController class OrderController implements OrderApi { @GetMapping("/orders") void list() {} }`),
  ]);

  assert.deepEqual(routes(findings), ["GET /api/orders"]);
});

test("the prefix comes from a superclass and the controller's own mapping wins over it", async () => {
  const findings = await extractor.extract([
    app("Base", `@RequestMapping("/base") abstract class Base {}`),
    app("Inherits", `@RestController class Inherits extends Base { @GetMapping("/x") void x() {} }`),
    app("Own", `@RestController @RequestMapping("/own") class Own extends Base { @GetMapping("/y") void y() {} }`),
  ]);

  assert.deepEqual(routes(findings), ["GET /base/x", "GET /own/y"]);
});

test("a mapping on a hand-written interface method is served by the controller method that implements it", async () => {
  const api = app("OrderApi", `interface OrderApi {\n  @GetMapping("/orders") List<String> list(int page);\n}`);
  const controller = app(
    "OrderController",
    `@RestController class OrderController implements OrderApi {\n  @Override public List<String> list(int page) { return null; }\n}`,
  );

  const findings = await extractor.extract([api, controller]);

  assert.deepEqual(routes(findings), ["GET /orders"]);
  assert.deepEqual(handlers(findings), ["OrderController.list@5"]);
});

test("the mapping of the overriding method wins over the one it overrides", async () => {
  const findings = await extractor.extract([
    app("OrderApi", `interface OrderApi { @GetMapping("/declared") void list(); }`),
    app("OrderController", `@RestController class OrderController implements OrderApi { @GetMapping("/own") public void list() {} }`),
  ]);

  assert.deepEqual(routes(findings), ["GET /own"]);
});

test("a handler inherited from a superclass is a route of the subclass, linked to the superclass method", async () => {
  const base = app("CrudController", `abstract class CrudController {\n  @GetMapping("/{id}") Object one() { return null; }\n}`);
  const users = app("UserController", `@RestController @RequestMapping("/users") class UserController extends CrudController {}`);

  const findings = await extractor.extract([base, users]);

  assert.deepEqual(routes(findings), ["GET /users/{id}"]);
  assert.deepEqual(handlers(findings), ["CrudController.one@5"]);
});

test("an inherited handler that the subclass overrides is served once, by the override", async () => {
  const findings = await extractor.extract([
    app("CrudController", `abstract class CrudController { @GetMapping("/{id}") Object one() { return null; } }`),
    app("UserController", `@RestController @RequestMapping("/users") class UserController extends CrudController {\n  @Override Object one() { return null; }\n}`),
  ]);

  assert.deepEqual(routes(findings), ["GET /users/{id}"]);
  assert.deepEqual(handlers(findings), ["UserController.one@5"]);
});

test("a constant of the same class and a concatenation resolve", async () => {
  const findings = await extractor.extract([
    app(
      "Orders",
      `@RestController class Orders {
  static final String BASE = "/api";
  private static final String ORDERS = BASE + "/orders";
  @GetMapping((ORDERS) + "/{id}") void one() {}
}`,
    ),
  ]);

  assert.deepEqual(routes(findings), ["GET /api/orders/{id}"]);
});

test("a constant of another file resolves through an import and a qualified name", async () => {
  const paths = file(
    "src/main/java/app/paths/Paths.java",
    `package app.paths;\npublic final class Paths {\n  public static final String API = "/api";\n  public static final String ORDERS = API + "/orders";\n}`,
  );
  const findings = await extractor.extract([
    paths,
    app("Orders", `@RestController @RequestMapping(Paths.ORDERS) class Orders { @GetMapping("/{id}") void one() {} }`, "import app.paths.Paths;"),
  ]);

  assert.deepEqual(routes(findings), ["GET /api/orders/{id}"]);
});

test("a constant named by its fully qualified type resolves without an import", async () => {
  const paths = file("src/main/java/app/paths/Paths.java", `package app.paths;\npublic final class Paths { public static final String API = "/api"; }`);
  const findings = await extractor.extract([paths, app("Orders", `@RestController @RequestMapping(app.paths.Paths.API) class Orders { @GetMapping("/x") void x() {} }`)]);

  assert.deepEqual(routes(findings), ["GET /api/x"]);
});

test("a type that two files declare is not resolved, whatever the order of the files", async () => {
  const paths = (module: string, api: string) =>
    file(`${module}/src/main/java/app/paths/Paths.java`, `package app.paths;\npublic final class Paths { public static final String API = "${api}"; }`);
  const controller = app("Orders", `@RestController @RequestMapping(Paths.API) class Orders { @GetMapping("/x") void x() {} }`, "import app.paths.Paths;");

  for (const files of [[paths("a", "/one"), paths("b", "/two"), controller], [paths("b", "/two"), paths("a", "/one"), controller]]) {
    const findings = await extractor.extract(files);

    assert.deepEqual(routes(findings), []);
    assert.equal(unknowns(findings).length, 1);
  }
});

test("a constant resolves through a single static import and through an on-demand static import", async () => {
  const paths = file("src/main/java/app/paths/Paths.java", `package app.paths;\npublic final class Paths { public static final String API = "/api"; }`);
  const findings = await extractor.extract([
    paths,
    app("Single", `@RestController @RequestMapping(API) class Single { @GetMapping("/s") void s() {} }`, "import static app.paths.Paths.API;"),
    app("Wild", `@RestController @RequestMapping(API) class Wild { @GetMapping("/w") void w() {} }`, "import static app.paths.Paths.*;"),
  ]);

  assert.deepEqual(routes(findings), ["GET /api/s", "GET /api/w"]);
});

test("a constant inherited from an interface resolves, and an interface field needs no modifiers", async () => {
  const findings = await extractor.extract([
    app("Constants", `interface Constants { String API = "/api"; }`),
    app("Orders", `@RestController class Orders implements Constants { @GetMapping(API + "/orders") void list() {} }`),
  ]);

  assert.deepEqual(routes(findings), ["GET /api/orders"]);
});

test("a nested controller resolves a constant of its enclosing class", async () => {
  const findings = await extractor.extract([
    app(
      "Holder",
      `class Holder {
  static final String API = "/api";
  @RestController static class Inner { @GetMapping(API) void x() {} }
}`,
    ),
  ]);

  assert.deepEqual(routes(findings), ["GET /api"]);
});

test("a path that is not a constant expression is an unknown item at the expression and the handler", async () => {
  const source = app("Dynamic", `@RestController class Dynamic {\n  @GetMapping(\n      prefix() + "/x")\n  void x() {}\n}`);

  const findings = await extractor.extract([source]);

  assert.deepEqual(findings, [
    {
      status: "unknown",
      reason: "unresolved",
      evidence: [
        { path: source.path, line: 5, endLine: 7 },
        { path: source.path, line: 6, endLine: 6 },
      ],
    },
  ]);
});

test("an unknown item never repeats a line: a cause that starts on the line of the span before it adds nothing", async () => {
  const source = app("Dynamic", `@RestController class Dynamic {\n  @GetMapping(prefix() + "/x")\n  void x() {}\n}`);

  const findings = await extractor.extract([source]);

  assert.deepEqual(findings, [{ status: "unknown", reason: "unresolved", evidence: [{ path: source.path, line: 5, endLine: 6 }] }]);
});

test("a cause that starts on the line of the span before it but runs further is kept", async () => {
  const findings = await extractor.extract([
    app("Crud", `@RestController abstract class Crud {}`),
    app("Audit", `@RequestMapping("/audit") class Audit extends Crud { @GetMapping("/x") void x() {}\n  void y() {}\n}`),
  ]);

  assert.deepEqual(
    unknowns(findings).map((finding) => finding.evidence.map((span) => `${span.line}-${span.endLine}`)),
    [["4-4", "4-6"]],
  );
});

test("a constant that is not in the repository is unresolved", async () => {
  const findings = await extractor.extract([
    app("External", `@RestController class External { @GetMapping(Lib.PATH) void x() {} }`, "import com.lib.Lib;"),
  ]);

  assert.deepEqual(routes(findings), []);
  assert.deepEqual(unknowns(findings).map((finding) => finding.reason), ["unresolved"]);
});

test("a field that is not final is not a constant", async () => {
  const findings = await extractor.extract([
    app("Mutable", `@RestController class Mutable { static String P = "/x"; @GetMapping(P) void x() {} }`),
  ]);

  assert.deepEqual(routes(findings), []);
  assert.equal(unknowns(findings).length, 1);
});

test("a field that is not static is not a constant", async () => {
  const findings = await extractor.extract([
    app("Instance", `@RestController class Instance { final String P = "/x"; @GetMapping(P) void x() {} }`),
  ]);

  assert.deepEqual(routes(findings), []);
  assert.equal(unknowns(findings).length, 1);
});

test("constants that refer to each other are unresolved, never a hang", async () => {
  const findings = await extractor.extract([
    app("Loop", `@RestController class Loop { static final String A = B; static final String B = A; @GetMapping(A) void x() {} }`),
  ]);

  assert.deepEqual(routes(findings), []);
  assert.equal(unknowns(findings).length, 1);
});

test("a path holding bytes that were not UTF-8 is unresolved, while the rest of the file still gives its routes", async () => {
  const findings = await extractor.extract([
    app(
      "Legacy",
      `// Caf\uFFFD menu
@RestController class Legacy {
  @GetMapping("/caf\uFFFD") void garbled() {}
  @GetMapping("/menu") void menu() {}
}`,
    ),
  ]);

  assert.deepEqual(routes(findings), ["GET /menu"]);
  assert.deepEqual(gaps(findings), ["unresolved@6"]);
});

test("a ${...} placeholder is unresolved, never raw text, whether written or reached through a constant", async () => {
  const findings = await extractor.extract([
    app(
      "Configured",
      `@RestController class Configured {
  static final String KEY = "\${api.base}";
  @GetMapping("\${api.base}/x") void literal() {}
  @GetMapping(KEY + "/y") void viaConstant() {}
  @GetMapping("#{spel}") void spel() {}
}`,
    ),
  ]);

  assert.deepEqual(routes(findings), []);
  assert.equal(unknowns(findings).length, 3);
});

test("an unresolved class prefix is one unknown item per handler and gives those handlers no route", async () => {
  const findings = await extractor.extract([
    app("Prefixed", `@RestController @RequestMapping(Lib.BASE) class Prefixed {\n  @GetMapping("/a") void a() {}\n  @GetMapping("/b") void b() {}\n}`, "import com.lib.Lib;"),
  ]);

  assert.deepEqual(routes(findings), []);
  assert.deepEqual(
    unknowns(findings).map((finding) => finding.evidence.map((where) => where.line)),
    [
      [5, 4],
      [6, 4],
    ],
  );
});

test("an unresolved path beside a resolved one keeps the route and adds the unknown item", async () => {
  const findings = await extractor.extract([
    app("Mixed", `@RestController class Mixed { @GetMapping({"/a", Lib.B}) void x() {} }`, "import com.lib.Lib;"),
  ]);

  assert.deepEqual(routes(findings), ["GET /a"]);
  assert.equal(unknowns(findings).length, 1);
});

test("a composed annotation in the repository maps its aliased attribute to the mapping's path", async () => {
  const findings = await extractor.extract([
    app("ApiGet", `@GetMapping @interface ApiGet {\n  @AliasFor(annotation = GetMapping.class, attribute = "path") String[] value() default {};\n}`, ALIAS),
    app("Composed", `@RestController class Composed { @ApiGet("/c") void c() {} }`),
  ]);

  assert.deepEqual(routes(findings), ["GET /c"]);
});

test("an alias without an attribute name targets the attribute of the same name", async () => {
  const findings = await extractor.extract([
    app("ApiPost", `@PostMapping @interface ApiPost {\n  @AliasFor(annotation = PostMapping.class) String[] path() default {};\n}`, ALIAS),
    app("Composed", `@RestController class Composed { @ApiPost(path = "/p") void p() {} }`),
  ]);

  assert.deepEqual(routes(findings), ["POST /p"]);
});

test("a composed annotation that composes another composed annotation resolves transitively", async () => {
  const findings = await extractor.extract([
    app("ApiGet", `@GetMapping @interface ApiGet {\n  @AliasFor(annotation = GetMapping.class, attribute = "path") String[] value() default {};\n}`, ALIAS),
    app("Listing", `@ApiGet @interface Listing {\n  @AliasFor(annotation = ApiGet.class, attribute = "value") String[] value() default {};\n}`, ALIAS),
    app("Composed", `@RestController class Composed { @Listing("/t") void t() {} }`),
  ]);

  assert.deepEqual(routes(findings), ["GET /t"]);
});

test("a composed annotation with a fixed path maps it", async () => {
  const findings = await extractor.extract([
    app("Health", `@GetMapping("/health") @interface Health {}`),
    app("Composed", `@RestController class Composed { @Health void h() {} }`),
  ]);

  assert.deepEqual(routes(findings), ["GET /health"]);
});

test("an attribute of a composed annotation without an alias does not change the mapping", async () => {
  const findings = await extractor.extract([
    app("Plain", `@GetMapping("/fixed") @interface Plain { String value() default ""; }`),
    app("Composed", `@RestController class Composed { @Plain("/other") void p() {} }`),
  ]);

  assert.deepEqual(routes(findings), ["GET /fixed"]);
});

test("a composed controller stereotype makes its class a controller", async () => {
  const findings = await extractor.extract([
    app("ApiController", `@RestController @interface ApiController {}`),
    app("Composed", `@ApiController @RequestMapping("/c") class Composed { @GetMapping("/x") void x() {} }`),
  ]);

  assert.deepEqual(routes(findings), ["GET /c/x"]);
});

test("annotations that compose each other in a cycle give no route and do not hang", async () => {
  const findings = await extractor.extract([
    app("First", `@Second @interface First {}`),
    app("Second", `@First @interface Second {}`),
    app("Looped", `@RestController class Looped { @First void x() {} }`),
  ]);

  assert.deepEqual(findings, []);
});

test("only Spring's annotations are mappings: a repository annotation of the same name is not, and a name no import reaches may be a library type", async () => {
  const findings = await extractor.extract([
    file("src/main/java/other/GetMapping.java", `package other;\npublic @interface GetMapping { String value(); }`),
    file(
      "src/main/java/app/Unimported.java",
      `package app;\nimport org.springframework.web.bind.annotation.RestController;\n@RestController class Unimported { @GetMapping("/x") void x() {} }`,
    ),
    file(
      "src/main/java/app/Shadowed.java",
      `package app;\nimport org.springframework.web.bind.annotation.RestController;\nimport other.GetMapping;\n@RestController class Shadowed { @GetMapping("/y") void y() {} }`,
    ),
  ]);

  assert.deepEqual(routes(findings), []);
  assert.deepEqual(
    unknowns(findings).map((finding) => finding.evidence[0]?.path),
    ["src/main/java/app/Unimported.java"],
  );
});

test("single imports and fully qualified annotation names resolve to Spring's annotations", async () => {
  const findings = await extractor.extract([
    file(
      "src/main/java/app/Imported.java",
      `package app;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;
@RestController class Imported { @GetMapping("/i") void i() {} }`,
    ),
    file(
      "src/main/java/app/Qualified.java",
      `package app;
@org.springframework.web.bind.annotation.RestController class Qualified {
  @org.springframework.web.bind.annotation.GetMapping("/q") void q() {}
}`,
    ),
  ]);

  assert.deepEqual(routes(findings), ["GET /i", "GET /q"]);
});

test("paths, prefixes and verbs multiply and a repeated route is reported once", async () => {
  const findings = await extractor.extract([
    app(
      "Product",
      `@RestController @RequestMapping({"/x", "/y"}) class Product {
  @RequestMapping(path = {"/a", "/b"}, method = {RequestMethod.GET, RequestMethod.POST}) void both() {}
  @GetMapping({"/d", "/d"}) void twice() {}
}`,
    ),
  ]);

  assert.deepEqual(routes(findings), [
    "GET /x/a",
    "GET /x/b",
    "GET /x/d",
    "GET /y/a",
    "GET /y/b",
    "GET /y/d",
    "POST /x/a",
    "POST /x/b",
    "POST /y/a",
    "POST /y/b",
  ]);
});

test("a request mapping that names no method serves any method", async () => {
  const findings = await extractor.extract([app("Any", `@RestController class Any { @RequestMapping("/any") void any() {} }`)]);

  assert.deepEqual(routes(findings), ["ANY /any"]);
});

test("the methods of the class mapping and of the handler are combined", async () => {
  const findings = await extractor.extract([
    app("Combined", `@RestController @RequestMapping(path = "/c", method = RequestMethod.POST) class Combined { @GetMapping("/x") void x() {} }`),
  ]);

  assert.deepEqual(routes(findings), ["GET /c/x", "POST /c/x"]);
});

test("a method that is not a literal verb is an unknown item and gives no route", async () => {
  const findings = await extractor.extract([
    app("Verbs", `@RestController class Verbs { static final RequestMethod[] ALL = {}; @RequestMapping(path = "/v", method = ALL) void v() {} }`),
  ]);

  assert.deepEqual(routes(findings), []);
  assert.equal(unknowns(findings).length, 1);
});

test("every request method constant is recognised, qualified or not", async () => {
  const findings = await extractor.extract([
    app(
      "Methods",
      `@RestController class Methods {
  @RequestMapping(path = "/m", method = {RequestMethod.HEAD, OPTIONS, TRACE, PUT, PATCH, DELETE, org.springframework.web.bind.annotation.RequestMethod.GET, POST}) void m() {}
}`,
    ),
  ]);

  assert.deepEqual(routes(findings), ["DELETE /m", "GET /m", "HEAD /m", "OPTIONS /m", "PATCH /m", "POST /m", "PUT /m", "TRACE /m"]);
});

test("the version is part of the route: one path with two versions is two routes", async () => {
  const findings = await extractor.extract([
    app(
      "Versioned",
      `@RestController class Versioned {
  @GetMapping(path = "/orders", version = "1.1") void old() {}
  @GetMapping(path = "/orders", version = "1.2+") void current() {}
  @GetMapping("/orders") void unversioned() {}
}`,
    ),
  ]);

  assert.deepEqual(routes(findings), ["GET /orders", "GET /orders v1.1", "GET /orders v1.2+"]);
});

test("a route is named by its method and the path the code maps, with the version it declares, never with the base path", async () => {
  const findings = await extractor.extract([
    app("Orders", `@RestController class Orders {\n  @GetMapping(path = "/orders", version = "2") void current() {}\n  @PostMapping("/orders") void create() {}\n}`),
    MAIN,
    file("src/main/resources/application.yml", "server.servlet.context-path: /shop\n"),
  ]);

  assert.deepEqual(findings.map((finding) => finding.status === "complete" && finding.value.name), ["GET /orders v2", "POST /orders"]);
});

test("a class version applies to its handlers and a handler version replaces it", async () => {
  const findings = await extractor.extract([
    app(
      "Classed",
      `@RestController @RequestMapping(path = "/c", version = "2") class Classed {
  @GetMapping("/inherits") void inherits() {}
  @GetMapping(path = "/own", version = "3") void own() {}
}`,
    ),
  ]);

  assert.deepEqual(routes(findings), ["GET /c/inherits v2", "GET /c/own v3"]);
});

test("a @FeignClient interface is a client and gives no route", async () => {
  const findings = await extractor.extract([
    app(
      "OrderClient",
      `@FeignClient(name = "orders") @RequestMapping("/api") interface OrderClient { @GetMapping("/orders") List<String> list(); }`,
      "import org.springframework.cloud.openfeign.FeignClient;",
    ),
  ]);

  assert.deepEqual(findings, []);
});

test("each class of a file has its own prefix", async () => {
  const findings = await extractor.extract([
    app(
      "Two",
      `@RestController @RequestMapping("/first") class First { @GetMapping("/a") void a() {} }
@RestController @RequestMapping("/second") class Second { @GetMapping("/a") void a() {} }
@RestController class Third { @GetMapping("/a") void a() {} }`,
    ),
  ]);

  assert.deepEqual(routes(findings), ["GET /a", "GET /first/a", "GET /second/a"]);
});

test("a nested class that is not a controller gives no routes and a nested controller has only its own prefix", async () => {
  const findings = await extractor.extract([
    app(
      "Outer",
      `@RestController @RequestMapping("/outer") class Outer {
  @GetMapping("/own") void own() {}
  static class Dto { @GetMapping("/dto") void dto() {} }
  @RestController @RequestMapping("/inner") static class Inner { @GetMapping("/x") void x() {} }
}`,
    ),
  ]);

  assert.deepEqual(routes(findings), ["GET /inner/x", "GET /outer/own"]);
});

test("a package-private handler is linked to itself", async () => {
  const findings = await extractor.extract([app("Quiet", `@RestController class Quiet {\n  @GetMapping("/q") String q() { return ""; }\n}`)]);

  assert.deepEqual(handlers(findings), ["Quiet.q@5"]);
});

test("overloaded handlers keep their own lines", async () => {
  const findings = await extractor.extract([
    app(
      "Overloaded",
      `@RestController class Overloaded {
  @GetMapping("/a") void find() {}
  @GetMapping("/b") void find(int id) {}
}`,
    ),
  ]);

  assert.deepEqual(handlers(findings), ["Overloaded.find@5", "Overloaded.find@6"]);
});

test("an overload is matched to the declaration it implements by its parameter types", async () => {
  const findings = await extractor.extract([
    app("Api", `interface Api<T> {\n  @GetMapping("/by-id") void find(List<T> id);\n  @GetMapping("/by-name") void find(Map<String, List<T>> name);\n}`),
    app("Impl", `@RestController class Impl implements Api<User> {\n  public void find(final java.util.Map<String, List<User>> name) {}\n  public void find(List<User> id) {}\n}`),
  ]);

  assert.deepEqual(
    findings.flatMap((finding) => (finding.status === "complete" && finding.value.kind === "http-route" ? [`${routeLabel(finding.value)}=${finding.value.handler.line}`] : [])).sort(),
    ["GET /by-id=6", "GET /by-name=5"],
  );
});

test("test files are skipped and so are files that are not Java", async () => {
  const body = `@RestController class Skipped { @GetMapping("/skipped") void x() {} }`;
  const findings = await extractor.extract([
    file("src/test/java/app/Skipped.java", `package app;\n${WEB}\n${body}`),
    file("src/integrationTest/java/app/Skipped.java", `package app;\n${WEB}\n${body}`),
    file("app/SkippedTest.java", `package app;\n${WEB}\n${body}`),
    file("src/main/resources/Skipped.kt", body),
  ]);

  assert.deepEqual(findings, []);
});

test("a file with a syntax error is an unknown item at its error and the other files are still read", async () => {
  const broken = file("src/main/java/app/Broken.java", `package app;\n\nclass Broken {\n  void run( {\n}\n`);

  const findings = await extractor.extract([broken, app("Fine", `@RestController class Fine { @GetMapping("/fine") void f() {} }`)]);

  assert.deepEqual(routes(findings), ["GET /fine"]);
  assert.deepEqual(unknowns(findings), [{ status: "unknown", reason: "source-unreadable", evidence: [{ path: broken.path, line: 4 }] }]);
});

test("the same sources give the same findings in the same order, whatever the order they are given in", async () => {
  const sources = [
    app("Zeta", `@RestController @RequestMapping("/z") class Zeta {\n  @PostMapping("/b") void b() {}\n  @GetMapping("/a") void a() {}\n}`),
    app("Alpha", `@RestController class Alpha { @GetMapping({"/b", "/a"}) void x() {} @GetMapping(Lib.X) void y() {} }`, "import com.lib.Lib;"),
    file("src/main/java/app/Broken.java", `class {`),
  ];

  const first = await extractor.extract(sources);
  const second = await extractor.extract([...sources].reverse());

  assert.deepEqual(first, second);
  assert.deepEqual(
    first.map((finding) => (finding.status === "unknown" ? `${finding.evidence[0]?.path}:${finding.reason}` : finding.value.kind === "http-route" ? `${finding.value.handler.path}:${routeLabel(finding.value)}` : "")),
    [
      "src/main/java/app/Alpha.java:GET /a",
      "src/main/java/app/Alpha.java:GET /b",
      "src/main/java/app/Alpha.java:unresolved",
      "src/main/java/app/Broken.java:source-unreadable",
      "src/main/java/app/Zeta.java:POST /z/b",
      "src/main/java/app/Zeta.java:GET /z/a",
    ],
  );
});

function duplicate(module: string, name: string, body: string): SourceFile {
  return file(`${module}/src/main/java/app/${name}.java`, `package app;\n${WEB}\n${body}`);
}

function inEitherOrder(first: SourceFile, second: SourceFile, rest: readonly SourceFile[]): SourceFile[][] {
  return [[first, second, ...rest], [...rest, second, first]];
}

test("a superclass that two files declare makes the handlers it affects unknown items, whatever the order of the files", async () => {
  const base = (module: string, prefix: string) => duplicate(module, "BaseController", `@RequestMapping("${prefix}") abstract class BaseController {}`);
  const orders = app("OrdersController", `@RestController class OrdersController extends BaseController {\n  @GetMapping("/orders") void list() {}\n}`);

  for (const files of inEitherOrder(base("a", "/orders-api"), base("b", "/billing-api"), [orders])) {
    const findings = await extractor.extract(files);

    assert.deepEqual(routes(findings), []);
    assert.deepEqual(gaps(findings), ["unresolved@5"]);
  }
});

test("an interface that two files declare makes the overriding methods unknown items", async () => {
  const api = (module: string) => duplicate(module, "OrderApi", `interface OrderApi { @GetMapping("/orders") void list(); }`);
  const controller = app("OrderController", `@RestController class OrderController implements OrderApi {\n  @Override public void list() {}\n}`);

  for (const files of inEitherOrder(api("a"), api("b"), [controller])) {
    const findings = await extractor.extract(files);

    assert.deepEqual(routes(findings), []);
    assert.deepEqual(gaps(findings), ["unresolved@5"]);
  }
});

test("a controller stereotype that two files declare makes the mapped handlers unknown items instead of dropping the class", async () => {
  const stereotype = (module: string) => duplicate(module, "ApiController", `@RestController @interface ApiController {}`);
  const controller = app("Orders", `@ApiController class Orders {\n  @GetMapping("/orders") void list() {}\n}`);

  for (const files of inEitherOrder(stereotype("a"), stereotype("b"), [controller])) {
    const findings = await extractor.extract(files);

    assert.deepEqual(routes(findings), []);
    assert.deepEqual(gaps(findings), ["unresolved@5"]);
  }
});

test("a mapping annotation that two files declare makes the handler an unknown item", async () => {
  const annotation = (module: string) => duplicate(module, "ApiGet", `@GetMapping("/a") @interface ApiGet {}`);
  const controller = app("Orders", `@RestController class Orders {\n  @ApiGet void list() {}\n}`);

  for (const files of inEitherOrder(annotation("a"), annotation("b"), [controller])) {
    const findings = await extractor.extract(files);

    assert.deepEqual(routes(findings), []);
    assert.deepEqual(gaps(findings), ["unresolved@5"]);
  }
});

test("an interface default method that nothing overrides is a handler of the controller that implements it", async () => {
  const findings = await extractor.extract([
    app("PetApi", `interface PetApi {\n  @GetMapping("/pet/{petId}")\n  default String getPet() { return null; }\n}`),
    app("PetApiController", `@Controller @RequestMapping("/v2") class PetApiController implements PetApi {}`, "import org.springframework.stereotype.Controller;"),
  ]);

  assert.deepEqual(routes(findings), ["GET /v2/pet/{petId}"]);
  assert.deepEqual(handlers(findings), ["PetApi.getPet@5"]);
});

test("a default method that the class overrides is served once, by the override", async () => {
  const findings = await extractor.extract([
    app("PetApi", `interface PetApi { @GetMapping("/pet") default String getPet() { return null; } }`),
    app("PetController", `@RestController class PetController implements PetApi {\n  @Override public String getPet() { return ""; }\n}`),
  ]);

  assert.deepEqual(routes(findings), ["GET /pet"]);
  assert.deepEqual(handlers(findings), ["PetController.getPet@5"]);
});

test("a default method that a sub-interface overrides is served once, by the sub-interface", async () => {
  const findings = await extractor.extract([
    app("PetApi", `interface PetApi { @GetMapping("/pet") default String getPet() { return null; } }`),
    app("CatApi", `interface CatApi extends PetApi {\n  @Override default String getPet() { return ""; }\n}`),
    app("CatController", `@RestController class CatController implements CatApi {}`),
  ]);

  assert.deepEqual(routes(findings), ["GET /pet"]);
  assert.deepEqual(handlers(findings), ["CatApi.getPet@5"]);
});

test("an @Override method of a controller whose interface is absent from the sources is an unknown item at the method", async () => {
  const findings = await extractor.extract([
    app(
      "Generated",
      `@RestController @RequestMapping("/own") class Generated implements OrdersApi {
  @Override public List<String> list() { return null; }
  @GetMapping("/own") void own() {}
  @Override @GetMapping("/mapped") public void mapped() {}
  void helper() {}
}`,
      "import com.generated.OrdersApi;",
    ),
  ]);

  assert.deepEqual(routes(findings), ["GET /own/mapped", "GET /own/own"]);
  assert.deepEqual(gaps(findings), ["no-extractor@4", "no-extractor@5"]);
});

test("an interface in the same package that no source declares is absent too", async () => {
  const findings = await extractor.extract([
    app("Generated", `@RestController @RequestMapping("/g") class Generated implements OrdersApi {\n  @Override public void list() {}\n}`),
  ]);

  assert.deepEqual(gaps(findings), ["no-extractor@4", "no-extractor@5"]);
});

test("only a default method of an interface can be a handler", async () => {
  const findings = await extractor.extract([
    app("PetApi", `interface PetApi {\n  @GetMapping("/static") static String staticMethod() { return null; }\n  @GetMapping("/private") private String privateMethod() { return null; }\n}`),
    app("PetController", `@RestController class PetController implements PetApi {}`),
  ]);

  assert.deepEqual(findings, []);
});

test("interfaces of the platform packages are not gaps", async () => {
  const findings = await extractor.extract([
    app(
      "Plain",
      `@RestController class Plain implements Serializable, Runnable, InitializingBean {
  @Override public void run() {}
  @Override public void afterPropertiesSet() {}
}`,
      "import java.io.Serializable; import org.springframework.beans.factory.InitializingBean;",
    ),
  ]);

  assert.deepEqual(findings, []);
});

test("a repository under a platform package owns its own packages, not the platform's", async () => {
  const findings = await extractor.extract([
    file(
      "src/main/java/org/springframework/samples/shop/rest/OrderController.java",
      `package org.springframework.samples.shop.rest;
${WEB}
import org.springframework.samples.shop.rest.api.OrdersApi; import org.springframework.beans.factory.InitializingBean;
@RestController class OrderController implements OrdersApi, InitializingBean {
  @Override public void list() {}
  @Override public void afterPropertiesSet() {}
}`,
    ),
  ]);

  assert.deepEqual(gaps(findings), ["no-extractor@4", "no-extractor@5", "no-extractor@6"]);
});

test("a repository under a platform package does not claim the platform's other packages", async () => {
  const findings = await extractor.extract([
    file(
      "src/main/java/org/springframework/samples/shop/rest/Plain.java",
      `package org.springframework.samples.shop.rest;
${WEB}
import org.springframework.beans.factory.InitializingBean;
@RestController class Plain implements InitializingBean {
  @Override public void afterPropertiesSet() {}
}`,
    ),
  ]);

  assert.deepEqual(findings, []);
});

test("a method returning Spring's RouterFunction is an unknown item, imported or fully qualified", async () => {
  const findings = await extractor.extract([
    app(
      "Routes",
      `@Configuration class Routes {
  @Bean RouterFunction<ServerResponse> reactive() { return null; }
  @Bean org.springframework.web.servlet.function.RouterFunction<?> servlet() { return null; }
}`,
      "import org.springframework.web.reactive.function.server.RouterFunction; import org.springframework.context.annotation.*;",
    ),
  ]);

  assert.deepEqual(routes(findings), []);
  assert.deepEqual(gaps(findings), ["no-extractor@5", "no-extractor@6"]);
});

test("a RouterFunction reached through an on-demand import is detected", async () => {
  const findings = await extractor.extract([
    app("Routes", `class Routes {\n  RouterFunction<ServerResponse> routes() { return null; }\n}`, "import org.springframework.web.servlet.function.*;"),
  ]);

  assert.deepEqual(gaps(findings), ["no-extractor@5"]);
});

test("a RouterFunction type that the repository declares is not Spring's", async () => {
  const findings = await extractor.extract([
    app("RouterFunction", `interface RouterFunction {}`),
    app("Routes", `class Routes { RouterFunction routes() { return null; } }`),
  ]);

  assert.deepEqual(findings, []);
});

test("escape sequences of a literal are decoded: the regular expression of a path variable is a route", async () => {
  const findings = await extractor.extract([
    app(
      "Patterns",
      String.raw`@RestController class Patterns {
  @GetMapping("/{id:\\d+}") void id() {}
  @GetMapping("/{year:\\d{4}}/summary") void year() {}
}`,
    ),
  ]);

  assert.deepEqual(routes(findings), ["GET /{id:\\d+}", "GET /{year:\\d{4}}/summary"]);
});

test("every escape of JLS 3.10.7 is decoded, octal and \\s included", async () => {
  const findings = await extractor.extract([
    app(
      "Escapes",
      String.raw`@RestController class Escapes {
  @GetMapping("/\b\s\t\n\f\r\"\'\\") void named() {}
  @GetMapping("/\101\60\7\1011\377") void octal() {}
}`,
    ),
  ]);

  assert.deepEqual(routes(findings), ["GET /\b \t\n\f\r\"'\\", "GET /A0\x07A1\xff"]);
});

test("Unicode escapes are decoded before the literal is read, unless the backslash is itself escaped", async () => {
  const slash = "\\";
  const findings = await extractor.extract([
    app(
      "Unicode",
      `@RestController class Unicode {
  @GetMapping("/${slash}u0061${slash}u0062") void decoded() {}
  @GetMapping("/${slash}${slash}u0063") void escaped() {}
  @GetMapping("/${slash}u005cn") void backslash() {}
}`,
    ),
  ]);

  assert.deepEqual(routes(findings), ["GET /\n", "GET /\\u0063", "GET /ab"]);
});

test("a character literal is decoded with the same escapes as a string", async () => {
  const slash = "\\";
  const findings = await extractor.extract([
    app("Chars", `@RestController class Chars { @GetMapping("/c" + '${slash}u0042' + '${slash}101' + '${slash}'') void chars() {} }`),
  ]);

  assert.deepEqual(routes(findings), ["GET /cBA'"]);
});

test("a value that is not a string is unresolved", async () => {
  const findings = await extractor.extract([app("Number", `@RestController class Number { @GetMapping(5) void five() {} }`)]);

  assert.deepEqual(routes(findings), []);
  assert.deepEqual(gaps(findings), ["unresolved@4"]);
});

test("a malformed escape is unresolved", async () => {
  const findings = await extractor.extract([app("Bad", String.raw`@RestController class Bad { @GetMapping("/\q") void bad() {} }`)]);

  assert.deepEqual(routes(findings), []);
  assert.deepEqual(gaps(findings), ["unresolved@4"]);
});

test("a text block is evaluated: incidental indentation and trailing spaces are stripped and a line continuation joins lines", async () => {
  const findings = await extractor.extract([
    app(
      "Blocks",
      ['@RestController class Blocks {', '  @GetMapping("""', '        /orders\\', '        /{id}  ', '          """) void one() {}', '  @GetMapping("""', '      /inline""") void two() {}', "}"].join("\n"),
    ),
  ]);

  assert.deepEqual(routes(findings), ["GET /inline", "GET /orders/{id}\n"]);
});

test("a text block keeps the indentation the closing delimiter leaves and ignores blank lines when it measures it", async () => {
  const findings = await extractor.extract([
    app(
      "Blocks",
      ['@RestController class Blocks {', '  @GetMapping("""', '          /kept', '', '      """) void less() {}', '  @GetMapping("""', '    /a', '      ', '    /b""") void blank() {}', "}"].join("\n"),
    ),
  ]);

  assert.deepEqual(routes(findings), ["GET /    /kept\n\n", "GET /a\n\n/b"]);
});

test("a text block written with CRLF line terminators has the same value", async () => {
  const findings = await extractor.extract([
    app("Blocks", ['@RestController class Blocks {', '  @GetMapping("""', '        /a', '        /b""") void crlf() {}', "}"].join("\r\n")),
  ]);

  assert.deepEqual(routes(findings), ["GET /a\n/b"]);
});

test("a string concatenated with integer and character literals is converted as Java does", async () => {
  const findings = await extractor.extract([
    app(
      "Versions",
      `@RestController class Versions {
  @GetMapping("/v" + 2 + 'x' + 0x10 + 1_0L + 0xFFFFFFFF + 0b11 + 017) void literals() {}
}`,
    ),
  ]);

  assert.deepEqual(routes(findings), ["GET /v2x1610-1315"]);
});

test("integers added before the first string are summed, not concatenated", async () => {
  const findings = await extractor.extract([
    app("Sums", `@RestController class Sums {\n  @GetMapping('a' + 1 + "/a" + (3 + 4)) void sum() {}\n}`),
  ]);

  assert.deepEqual(routes(findings), ["GET /98/a7"]);
});

test("integer sums wrap at 32 bits and long sums at 64", async () => {
  const findings = await extractor.extract([
    app("Wraps", `@RestController class Wraps {\n  @GetMapping(2147483647 + 1 + "/a" + (9223372036854775807L + 1)) void wrap() {}\n  @GetMapping(2147483647L + 1 + "/b") void widen() {}\n  static final long TOP = 9223372036854775807L;\n  @GetMapping(TOP + 1 + "/c") void constant() {}\n}`),
  ]);

  assert.deepEqual(routes(findings), ["GET /-2147483648/a-9223372036854775808", "GET /-9223372036854775808/c", "GET /2147483648/b"]);
});

test("an integer constant, a character constant and a long constant are converted by their declared type", async () => {
  const findings = await extractor.extract([
    app(
      "Constants",
      `@RestController class Constants {
  static final int VERSION = 3;
  static final long BIG = 4294967296L;
  static final char LETTER = 65;
  @GetMapping("/v" + VERSION + "/" + BIG + "/" + LETTER) void constants() {}
}`,
    ),
  ]);

  assert.deepEqual(routes(findings), ["GET /v3/4294967296/A"]);
});

test("a constant expression the extractor does not evaluate is no-extractor, never unresolved", async () => {
  const findings = await extractor.extract([
    app(
      "Unsupported",
      `@RestController class Unsupported {
  static final double RATIO = 1.5;
  @GetMapping("/a" + 1.5) void literal() {}
  @GetMapping("/b" + RATIO) void constant() {}
  @GetMapping("/c" + (1 - 1)) void arithmetic() {}
  @GetMapping("/d" + true) void flag() {}
  @GetMapping((String) "/e") void cast() {}
}`,
    ),
  ]);

  assert.deepEqual(routes(findings), []);
  assert.deepEqual(gaps(findings), ["no-extractor@10", "no-extractor@6", "no-extractor@7", "no-extractor@8", "no-extractor@9"]);
});

test("a ternary expression or a cast is unresolved when its operands are not constants", async () => {
  const findings = await extractor.extract([
    app("Dynamic", `@RestController class Dynamic {\n  @GetMapping(enabled() ? "/a" : "/b") void ternary() {}\n  @GetMapping((String) lookup()) void cast() {}\n}`),
  ]);

  assert.deepEqual(routes(findings), []);
  assert.deepEqual(gaps(findings), ["unresolved@5", "unresolved@6"]);
});

test("a method that several declarations of one type match equally is an unknown item", async () => {
  const findings = await extractor.extract([
    app("PairApi", `interface PairApi<T> {\n  @GetMapping("/a") void f(T first, String second);\n  @GetMapping("/b") void f(String first, T second);\n}`),
    app("PairController", `@RestController class PairController implements PairApi<String> {\n  public void f(String first, String second) {}\n}`),
  ]);

  assert.deepEqual(routes(findings), []);
  assert.deepEqual(gaps(findings), ["unresolved@5"]);
});

test("an inherited handler that several overloads may override is an unknown item", async () => {
  const findings = await extractor.extract([
    app("CrudBase", `abstract class CrudBase<T> {\n  @GetMapping("/items") void save(T entity) {}\n}`),
    app("ItemsController", `@RestController class ItemsController extends CrudBase<Long> {\n  void save(Long entity) {}\n  void save(Integer entity) {}\n}`),
  ]);

  assert.deepEqual(routes(findings), []);
  assert.deepEqual(
    unknowns(findings).map((finding) => `${finding.evidence[0]?.path.split("/").pop()}:${finding.evidence[0]?.line}`),
    ["CrudBase.java:5", "ItemsController.java:5", "ItemsController.java:6"],
  );
});

test("a mapped method of the interface is not served by an unrelated overload of the controller", async () => {
  const findings = await extractor.extract([
    app("ItemsApi", `interface ItemsApi { @GetMapping("/items/{code}") void get(String code); }`),
    app(
      "ItemsController",
      `@RestController class ItemsController implements ItemsApi {
  @Override public void get(String code) {}
  public void get(Long id) {}
}`,
    ),
  ]);

  assert.deepEqual(routes(findings), ["GET /items/{code}"]);
  assert.deepEqual(handlers(findings), ["ItemsController.get@5"]);
});

test("an inherited handler is not overridden by an overload with other parameter types", async () => {
  const findings = await extractor.extract([
    app("Base", `abstract class Base { @GetMapping("/export") void export(String format) {} }`),
    app("ExportController", `@RestController class ExportController extends Base {\n  protected void export(Integer level) {}\n}`),
  ]);

  assert.deepEqual(routes(findings), ["GET /export"]);
  assert.deepEqual(handlers(findings), ["Base.export@4"]);
});

test("a type variable of the declaration matches any parameter type", async () => {
  const findings = await extractor.extract([
    app("CrudApi", `interface CrudApi<T> { @GetMapping("/items") void save(T entity); }`),
    app("ItemsController", `@RestController class ItemsController implements CrudApi<Long> {\n  public void save(Long entity) {}\n}`),
  ]);

  assert.deepEqual(routes(findings), ["GET /items"]);
  assert.deepEqual(handlers(findings), ["ItemsController.save@5"]);
});

test("a type variable claims its declaration before an overload with a concrete type", async () => {
  const findings = await extractor.extract([
    app("CrudApi", `interface CrudApi<T> { @GetMapping("/items") void save(T entity); }`),
    app("ItemsController", `@RestController class ItemsController<T> implements CrudApi<T> {\n  public void save(T entity) {}\n  public void save(Long entity) {}\n}`),
  ]);

  assert.deepEqual(handlers(findings), ["ItemsController.save@5"]);
  assert.deepEqual(gaps(findings), []);
});

test("an inherited handler with a type variable is overridden by the method that binds it", async () => {
  const findings = await extractor.extract([
    app("CrudBase", `abstract class CrudBase<T> { @GetMapping("/items") void save(T entity) {} }`),
    app("ItemsController", `@RestController class ItemsController extends CrudBase<Long> {\n  @Override void save(Long entity) {}\n}`),
  ]);

  assert.deepEqual(routes(findings), ["GET /items"]);
  assert.deepEqual(handlers(findings), ["ItemsController.save@5"]);
});

test("a declaration keeps the method that matches it exactly and gives the type-variable match to the other", async () => {
  const findings = await extractor.extract([
    app("Api", `interface Api<T> {\n  @GetMapping("/by-id") void get(T id);\n  @GetMapping("/by-name") void get(String name);\n}`),
    app("Impl", `@RestController class Impl implements Api<Long> {\n  public void get(Long id) {}\n  public void get(String name) {}\n}`),
  ]);

  assert.deepEqual(
    findings.flatMap((finding) => (finding.status === "complete" && finding.value.kind === "http-route" ? [`${routeLabel(finding.value)}=${finding.value.handler.line}`] : [])).sort(),
    ["GET /by-id=5", "GET /by-name=6"],
  );
});

test("an array of a type variable matches arrays of any element and nothing else", async () => {
  const findings = await extractor.extract([
    app("BatchApi", `interface BatchApi<T> { @GetMapping("/batch") void save(T[] items); }`),
    app("BatchController", `@RestController class BatchController implements BatchApi<String> {\n  public void save(String[] items) {}\n  public void save(String item) {}\n}`),
  ]);

  assert.deepEqual(handlers(findings), ["BatchController.save@5"]);
});

test("array and varargs parameters are told apart from their element type", async () => {
  const findings = await extractor.extract([
    app("BatchApi", `interface BatchApi { @GetMapping("/batch") void run(String... ids); }`),
    app("BatchController", `@RestController class BatchController implements BatchApi {\n  public void run(String[] ids) {}\n  public void run(String ids) {}\n}`),
  ]);

  assert.deepEqual(handlers(findings), ["BatchController.run@5"]);
});

test("overloads that match one declaration equally are unknown items, not a guess", async () => {
  const findings = await extractor.extract([
    app("CrudApi", `interface CrudApi<T> { @GetMapping("/items") void save(T entity); }`),
    app("ItemsController", `@RestController class ItemsController implements CrudApi<Long> {\n  public void save(Long entity) {}\n  public void save(Integer entity) {}\n}`),
  ]);

  assert.deepEqual(routes(findings), []);
  assert.deepEqual(gaps(findings), ["unresolved@5", "unresolved@6"]);
  assert.deepEqual(unknowns(findings).map((finding) => finding.evidence.length), [1, 1]);
});

test("an abstract controller yields no route of its own and its handlers reach the concrete subclass", async () => {
  const findings = await extractor.extract([
    app("AbstractCrud", `@RestController abstract class AbstractCrud { @GetMapping("/{id}") Object one() { return null; } }`),
    app("UserController", `@RestController @RequestMapping("/users") class UserController extends AbstractCrud {}`),
  ]);

  assert.deepEqual(routes(findings), ["GET /users/{id}"]);
});

test("an interface annotated as a controller is not a controller", async () => {
  const findings = await extractor.extract([
    app("Api", `@RestController interface Api { @GetMapping("/x") default void x() {} }`),
  ]);

  assert.deepEqual(findings, []);
});

test("an HTTP interface method implemented by a controller is an unknown item no-extractor", async () => {
  const findings = await extractor.extract([
    app(
      "OrdersExchange",
      `@HttpExchange("/orders") interface OrdersExchange {\n  @GetExchange("/{id}") String one(String id);\n}`,
      "import org.springframework.web.service.annotation.*;",
    ),
    app("OrdersController", `@RestController class OrdersController implements OrdersExchange {\n  @Override public String one(String id) { return id; }\n}`),
  ]);

  assert.deepEqual(routes(findings), []);
  assert.deepEqual(gaps(findings), ["no-extractor@5"]);
});

test("a method carrying an annotation from a library and no mapping is an unknown item no-extractor", async () => {
  const findings = await extractor.extract([
    app("Orders", `@RestController class Orders {\n  @LibGet("/x") void x() {}\n}`, "import com.lib.LibGet;"),
  ]);

  assert.deepEqual(routes(findings), []);
  assert.deepEqual(gaps(findings), ["no-extractor@5"]);
});

test("annotations of the platform and of the repository are not library annotations", async () => {
  const findings = await extractor.extract([
    app("Audited", `@interface Audited {}`),
    app(
      "Orders",
      `@RestController class Orders {
  @Override public String toString() { return ""; }
  @PostConstruct void start() {}
  @Transactional void save() {}
  @SneakyThrows void sneaky() {}
  @Audited void audited() {}
  @jakarta.annotation.PreDestroy void stop() {}
  @ExceptionHandler void handle() {}
}`,
      "import jakarta.annotation.PostConstruct; import lombok.SneakyThrows; import org.springframework.transaction.annotation.Transactional;",
    ),
  ]);

  assert.deepEqual(findings, []);
});

test("annotations of java.lang need no import", async () => {
  const findings = await extractor.extract([
    file(
      "src/main/java/app/Plain.java",
      `package app;\nimport org.springframework.web.bind.annotation.RestController;\n@RestController class Plain {\n  @Override public String toString() { return ""; }\n}`,
    ),
  ]);

  assert.deepEqual(findings, []);
});

test("a library annotation beside a mapping does not hide the route", async () => {
  const findings = await extractor.extract([
    app("Orders", `@RestController class Orders {\n  @Operation("list") @GetMapping("/x") void x() {}\n}`, "import io.swagger.v3.oas.annotations.Operation;"),
  ]);

  assert.deepEqual(routes(findings), ["GET /x"]);
  assert.deepEqual(gaps(findings), []);
});

test("a name that a library wildcard import may supply is a library annotation although a Spring wildcard is imported too", async () => {
  const findings = await extractor.extract([
    app("Orders", `@RestController class Orders {\n  @Operation void x() {}\n}`, "import io.swagger.v3.oas.annotations.*;"),
  ]);

  assert.deepEqual(gaps(findings), ["no-extractor@5"]);
});

test("an HTTP interface annotation on the class of a controller leaves its mapped handlers unknown items", async () => {
  const findings = await extractor.extract([
    app("Exchange", `@HttpExchange("/orders") interface Exchange {}`, "import org.springframework.web.service.annotation.HttpExchange;"),
    app("Orders", `@RestController class Orders implements Exchange {\n  @GetMapping("/x") void x() {}\n}`),
  ]);

  assert.deepEqual(routes(findings), []);
  assert.deepEqual(gaps(findings), ["no-extractor@5"]);
});

test("a controller carrying a library annotation and no class mapping adds one unknown item at the annotation and keeps its routes", async () => {
  const findings = await extractor.extract([
    app("Orders", `@RestController\n@LibMapping("/orders")\nclass Orders {\n  @GetMapping("/x") void x() {}\n}`, "import com.lib.LibMapping;"),
  ]);

  assert.deepEqual(routes(findings), ["GET /x"]);
  assert.deepEqual(gaps(findings), ["no-extractor@5"]);
});

test("a library annotation on a controller that has a class mapping adds nothing", async () => {
  const findings = await extractor.extract([
    app("Orders", `@RestController @RequestMapping("/orders") @Tag("orders") class Orders { @GetMapping("/x") void x() {} }`, "import io.swagger.v3.oas.annotations.tags.Tag;"),
  ]);

  assert.deepEqual(routes(findings), ["GET /orders/x"]);
  assert.deepEqual(gaps(findings), []);
});

test("a composed annotation whose attribute Spring 6.2 and Spring 7 pass on differently is an unresolved handler", async () => {
  const findings = await extractor.extract([
    app("Fixed", `@GetMapping("/fixed") @interface Fixed { String[] path() default {}; }`),
    app("Orders", `@RestController class Orders {\n  @Fixed(path = "/other") void x() {}\n}`),
  ]);

  assert.deepEqual(routes(findings), []);
  assert.deepEqual(gaps(findings), ["unresolved@5"]);
});

test("a composed annotation whose method attribute is not aliased is an unresolved handler", async () => {
  const findings = await extractor.extract([
    app("Verb", `@RequestMapping("/v") @interface Verb { RequestMethod[] method() default {}; }`),
    app("Orders", `@RestController class Orders {\n  @Verb(method = RequestMethod.POST) void x() {}\n}`),
  ]);

  assert.deepEqual(routes(findings), []);
  assert.deepEqual(gaps(findings), ["unresolved@5"]);
});

test("a composed annotation that overrides an attribute of another composed annotation by name is an unresolved handler", async () => {
  const findings = await extractor.extract([
    app("ApiGet", `@GetMapping("/g") @interface ApiGet { @AliasFor(annotation = GetMapping.class) String[] path() default {}; }`, ALIAS),
    app("Listing", `@ApiGet @interface Listing { String[] path() default {}; }`),
    app("Orders", `@RestController class Orders {\n  @Listing(path = "/x") void x() {}\n}`),
  ]);

  assert.deepEqual(routes(findings), []);
  assert.deepEqual(gaps(findings), ["unresolved@5"]);
});

test("a shortcut mapping has no method attribute for a composed annotation to override", async () => {
  const findings = await extractor.extract([
    app("Plain", `@GetMapping("/m") @interface Plain { RequestMethod[] method() default {}; }`),
    app("Orders", `@RestController class Orders { @Plain void x() {} }`),
  ]);

  assert.deepEqual(routes(findings), ["GET /m"]);
});

test("a same-name attribute that is not a path or a method does not make a composed annotation's handler unresolved", async () => {
  const findings = await extractor.extract([
    app("Base", `@GetMapping("/g") @interface Base { String name() default ""; }`),
    app("Derived", `@Base @interface Derived { String name() default ""; }`),
    app("Orders", `@RestController class Orders { @Derived void x() {} }`),
  ]);

  assert.deepEqual(routes(findings), ["GET /g"]);
});

test("a same-name attribute that cannot change the route does not make the handler unresolved", async () => {
  const findings = await extractor.extract([
    app("Named", `@GetMapping("/named") @interface Named { String name() default ""; String[] produces() default {}; }`),
    app("Orders", `@RestController class Orders { @Named(name = "n") void x() {} }`),
  ]);

  assert.deepEqual(routes(findings), ["GET /named"]);
});

test("a file using syntax newer than the grammar is unreadable, failing loud", async () => {
  const findings = await extractor.extract([
    file("src/main/java/app/Modules.java", `package app;\nimport module java.base;\nclass Modules {}`),
    file("src/main/java/app/Early.java", `package app;\nclass Early extends Base {\n  Early(int x) { int y = x + 1; super(y); }\n}`),
  ]);

  assert.deepEqual(
    unknowns(findings).map((finding) => `${finding.reason}:${finding.evidence[0]?.path}`),
    ["source-unreadable:src/main/java/app/Early.java", "source-unreadable:src/main/java/app/Modules.java"],
  );
});

test("classes that extend each other in a cycle are read, never a hang", async () => {
  const findings = await extractor.extract([
    app("A", `@RestController class A extends B {\n  @GetMapping("/a") void a() {}\n}`),
    app("B", `class B extends A {}`),
  ]);

  assert.deepEqual(routes(findings), ["GET /a"]);
});

test("a constant of a nested class resolves through its qualified name", async () => {
  const findings = await extractor.extract([
    app("Paths", `class Paths {\n  static class Users { static final String ROOT = "/users"; }\n}`),
    app("Users", `@RestController class Users {\n  @GetMapping(Paths.Users.ROOT) void list() {}\n}`),
  ]);

  assert.deepEqual(routes(findings), ["GET /users"]);
});

test("a record annotated as a controller serves its handlers", async () => {
  const findings = await extractor.extract([
    app("HelloController", `@RestController record HelloController(String greeting) {\n  @GetMapping("/hello") String hello() { return greeting; }\n}`),
  ]);

  assert.deepEqual(routes(findings), ["GET /hello"]);
});

test("a superclass absent from the sources is one unknown item at its extends, and a method that overrides it is one at the method", async () => {
  const findings = await extractor.extract([
    app(
      "UserController",
      `@RestController @RequestMapping("/users") class UserController extends BaseCrudController<User, Long> {\n  @Override public User findOne(Long id) { return null; }\n}`,
      "import com.acme.lib.BaseCrudController;",
    ),
  ]);

  assert.deepEqual(routes(findings), []);
  assert.deepEqual(gaps(findings), ["no-extractor@4", "no-extractor@5"]);
});

test("a class mapping that an absent superclass may carry makes the route of the controller an unknown item", async () => {
  const findings = await extractor.extract([
    app("UserController", `@RestController class UserController extends BaseApiController {\n  @GetMapping("/users") void list() {}\n}`, "import com.acme.lib.BaseApiController;"),
  ]);

  assert.deepEqual(routes(findings), []);
  assert.deepEqual(gaps(findings), ["no-extractor@4", "no-extractor@5"]);
});

test("a class mapping found before the absent supertype in Spring's search order keeps the route complete", async () => {
  const findings = await extractor.extract([
    app("Base", `@RequestMapping("/base") abstract class Base {}`),
    app("Own", `@RestController @RequestMapping("/own") class Own extends AbsentBase {\n  @GetMapping("/a") void a() {}\n}`, "import com.acme.lib.AbsentBase;"),
    app("Inherited", `@RestController class Inherited extends Base implements AbsentApi {\n  @GetMapping("/b") void b() {}\n}`, "import com.acme.lib.AbsentApi;"),
    app("Reversed", `@RestController class Reversed extends AbsentBase {\n  @GetMapping("/c") void c() {}\n}`, "import com.acme.lib.AbsentBase;"),
  ]);

  assert.deepEqual(routes(findings), ["GET /own/a"]);
  assert.deepEqual(
    unknowns(findings).map((finding) => `${finding.evidence[0]?.path.split("/").pop()}:${finding.evidence[0]?.line}`),
    ["Inherited.java:4", "Inherited.java:5", "Own.java:4", "Reversed.java:4", "Reversed.java:5"],
  );
});

test("an interface absent from the sources is one unknown item even when the controller overrides nothing", async () => {
  const findings = await extractor.extract([
    app("PetsController", `@RestController class PetsController implements PetsApi {\n  void helper() {}\n}`, "import com.acme.gen.PetsApi;"),
  ]);

  assert.deepEqual(gaps(findings), ["no-extractor@4"]);
});

test("a supertype that java.lang or the platform owns is not absent", async () => {
  const findings = await extractor.extract([
    app(
      "Plain",
      `@RestController class Plain extends Object implements Comparable<Plain> {\n  @GetMapping("/x") void x() {}\n  public int compareTo(Plain other) { return 0; }\n}`,
    ),
  ]);

  assert.deepEqual(routes(findings), ["GET /x"]);
  assert.deepEqual(gaps(findings), []);
});

test("a component that implements an absent interface named Delegate has one unknown item per @Override method", async () => {
  const findings = await extractor.extract([
    app(
      "PetsApiDelegateImpl",
      `@Service class PetsApiDelegateImpl implements PetsApiDelegate {
  @Override public void list() {}
  @Override public void create() {}
  void helper() {}
}
@Component class OwnersDelegateImpl implements com.acme.gen.OwnersApiDelegate {
  @Override public void list() {}
}`,
      "import com.acme.gen.PetsApiDelegate; import org.springframework.stereotype.*;",
    ),
  ]);

  assert.deepEqual(routes(findings), []);
  assert.deepEqual(gaps(findings), ["no-extractor@10", "no-extractor@5", "no-extractor@6"]);
});

test("the Delegate signal needs the interface name, a component stereotype and an interface the sources lack", async () => {
  const findings = await extractor.extract([
    app("Declared", `interface PetsApiDelegate { void list(); }`),
    app(
      "Others",
      `@Service class WithDeclared implements PetsApiDelegate {\n  @Override public void list() {}\n}
@Service class OtherName implements PetsHandler {\n  @Override public void list() {}\n}
@Service class AbsentSuperclass extends AbstractDelegate {\n  @Override public void list() {}\n}
class NotAComponent implements OwnersApiDelegate {\n  @Override public void list() {}\n}`,
      "import com.acme.gen.*; import org.springframework.stereotype.Service;",
    ),
  ]);

  assert.deepEqual(findings, []);
});

function pom(groupId: string, artifactId: string, path = "pom.xml"): SourceFile {
  return file(
    path,
    `<project>\n  <build>\n    <plugins>\n      <plugin>\n        <groupId>${groupId}</groupId>\n        <artifactId>${artifactId}</artifactId>\n      </plugin>\n    </plugins>\n  </build>\n</project>`,
  );
}

const OPENAPI_POM = pom("org.openapitools", "openapi-generator-maven-plugin");

const SERVICE_IMPORTS = "import com.acme.gen.PetsApiService; import org.springframework.stereotype.*;";

test("a build file that declares a source generator makes every public method of a component implementing an absent interface an unknown item, @Override or not", async () => {
  const source = app(
    "PetsServiceImpl",
    `@Service class PetsServiceImpl implements PetsApiService {\n  public void list() {}\n  public void create() {}\n  void helper() {}\n  private void inner() {}\n}`,
    SERVICE_IMPORTS,
  );

  const findings = await extractor.extract([OPENAPI_POM, source]);

  assert.deepEqual(routes(findings), []);
  assert.deepEqual(findings, [
    ["no-extractor", 5],
    ["no-extractor", 6],
  ].map(([reason, line]) => ({
    status: "unknown",
    reason,
    evidence: [
      { path: source.path, line, endLine: line },
      { path: source.path, line: 4, endLine: 4 },
      { path: "pom.xml", line: 6 },
    ],
  })));
});

test("a build file without a source generator leaves the component rule as it was: only Delegate interfaces and @Override methods", async () => {
  const findings = await extractor.extract([
    pom("org.springframework.boot", "spring-boot-maven-plugin"),
    app(
      "PetsServiceImpl",
      `@Service class PetsServiceImpl implements PetsApiService {\n  public void list() {}\n}\n@Service class PetsDelegateImpl implements PetsApiDelegate {\n  public void list() {}\n}`,
      SERVICE_IMPORTS + " import com.acme.gen.PetsApiDelegate;",
    ),
  ]);

  assert.deepEqual(findings, []);
});

test("the signal never removes an item the Delegate rule gives, whatever the modifiers of the overriding method", async () => {
  const findings = await extractor.extract([
    OPENAPI_POM,
    app(
      "PetsDelegateImpl",
      `@Service class PetsDelegateImpl implements PetsApiDelegate {\n  @Override protected void hook() {}\n}`,
      "import com.acme.gen.PetsApiDelegate; import org.springframework.stereotype.*;",
    ),
  ]);

  assert.deepEqual(gaps(findings), ["no-extractor@5"]);
});

test("the signal still needs a component stereotype and an interface the sources lack", async () => {
  const findings = await extractor.extract([
    OPENAPI_POM,
    app("Declared", `interface PetsApiService { void list(); }`),
    app(
      "Others",
      `@Service class WithDeclared implements PetsApiService {\n  public void list() {}\n}
@Service class Platform implements Comparable<Platform>, Runnable {\n  public int compareTo(Platform other) { return 0; }\n  public void run() {}\n}
@Service class AbsentSuperclass extends AbstractService {\n  public void list() {}\n}
class NotAComponent implements OwnersApiService {\n  public void list() {}\n}`,
      "import com.acme.gen.*; import org.springframework.stereotype.Service;",
    ),
  ]);

  assert.deepEqual(findings, []);
});

test("the signal reaches every module: the generated interface arrives in a module through a dependency, which no source shows", async () => {
  const consumer = file(
    "modules/service/src/main/java/app/PetsServiceImpl.java",
    `package app;\nimport com.acme.gen.PetsApiService;\nimport org.springframework.stereotype.Service;\n@Service class PetsServiceImpl implements PetsApiService {\n  public void list() {}\n}`,
  );

  const findings = await extractor.extract([pom("org.openapitools", "openapi-generator-maven-plugin", "modules/api/pom.xml"), consumer]);

  assert.deepEqual(findings, [
    {
      status: "unknown",
      reason: "no-extractor",
      evidence: [
        { path: consumer.path, line: 5, endLine: 5 },
        { path: consumer.path, line: 4, endLine: 4 },
        { path: "modules/api/pom.xml", line: 6 },
      ],
    },
  ]);
});

test("the evidence names the first declaring build file by path, whatever the order of the inputs", async () => {
  const gradle = file("b/build.gradle.kts", `plugins {\n  id("org.openapi.generator")\n}`);
  const service = app("PetsServiceImpl", `@Service class PetsServiceImpl implements PetsApiService {\n  public void list() {}\n}`, SERVICE_IMPORTS);
  const declaring = (findings: readonly Finding<Entrypoint>[]) => findings.map((finding) => finding.evidence.at(-1));

  const declaringPom = pom("org.openapitools", "openapi-generator-maven-plugin", "a/pom.xml");

  const forward = await extractor.extract([declaringPom, gradle, service]);
  const reversed = await extractor.extract([service, gradle, declaringPom]);

  assert.deepEqual(declaring(forward), [{ path: "a/pom.xml", line: 6 }]);
  assert.deepEqual(forward, reversed);
});

test("a build file is never read as Java, and only a build file declares a generator", async () => {
  const mentions = app("Mentions", `@Service class Mentions implements PetsApiService {\n  public static final String ID = "org.openapi.generator";\n  public void list() {}\n}`, SERVICE_IMPORTS);

  const findings = await extractor.extract([file("build.gradle", "plugins { id 'java' }"), mentions]);

  assert.deepEqual(findings, []);
});

test("a JAX-RS endpoint method that starts on its annotation's line holds that span once in its evidence", async () => {
  const source = app("UserResource", `@Path("/users") class UserResource {\n  @GET public String list() {\n    return "";\n  }\n}`, "import jakarta.ws.rs.*;");

  const findings = await extractor.extract([source]);

  assert.deepEqual(findings, [{ status: "unknown", reason: "no-extractor", evidence: [{ path: source.path, line: 5, endLine: 7 }] }]);
});

test("a class whose annotation comes from a library may be a handler: each mapped method is an unknown item", async () => {
  const findings = await extractor.extract([
    app(
      "Scanners",
      `@ApiController class Scanners {\n  @GetMapping("/scanners") void list() {}\n  @PostMapping("/scanners") void create() {}\n  void helper() {}\n}`,
      "import com.acme.starter.web.ApiController;",
    ),
  ]);

  assert.deepEqual(routes(findings), []);
  assert.deepEqual(gaps(findings), ["no-extractor@5", "no-extractor@6"]);
});

test("a Spring Data REST controller is a handler this extractor does not model: each mapped method is an unknown item", async () => {
  const findings = await extractor.extract([
    app(
      "ScannerController",
      `@RepositoryRestController class ScannerController {\n  @GetMapping("/scanners/search/listProducers") void list() {}\n}`,
      "import org.springframework.data.rest.webmvc.RepositoryRestController;",
    ),
  ]);

  assert.deepEqual(routes(findings), []);
  assert.deepEqual(gaps(findings), ["no-extractor@5"]);
});

test("a class that may be a handler through an absent supertype has one unknown item per mapped method", async () => {
  const findings = await extractor.extract([
    app("Scanners", `class Scanners extends LibBase {\n  @GetMapping("/scanners") void list() {}\n  void helper() {}\n}`, "import com.acme.lib.LibBase;"),
  ]);

  assert.deepEqual(routes(findings), []);
  assert.deepEqual(gaps(findings), ["no-extractor@5"]);
});

test("a class that may be a handler through an ambiguous supertype has one unresolved item per mapped method", async () => {
  const base = (module: string) => duplicate(module, "Base", `class Base {}`);
  const scanners = app("Scanners", `class Scanners extends Base {\n  @GetMapping("/scanners") void list() {}\n}`);

  for (const files of inEitherOrder(base("a"), base("b"), [scanners])) {
    const findings = await extractor.extract(files);

    assert.deepEqual(routes(findings), []);
    assert.deepEqual(gaps(findings), ["unresolved@5"]);
  }
});

test("a library annotation on a class with no mapped method adds nothing", async () => {
  const findings = await extractor.extract([
    app("Worker", `@LibJob class Worker {\n  void run() {}\n  @Override public String toString() { return ""; }\n}`, "import com.acme.lib.LibJob;"),
  ]);

  assert.deepEqual(findings, []);
});

test("the controller stereotype of a superclass or an interface makes the subclass a controller", async () => {
  const findings = await extractor.extract([
    app("CrudController", `@RestController abstract class CrudController<T> {\n  @GetMapping("/{id}") T one() { return null; }\n}`),
    app("Api", `@RestController interface Api {}`),
    app("UserController", `@Component class UserController extends CrudController<User> {}`, "import org.springframework.stereotype.Component;"),
    app("PetController", `@Component class PetController implements Api {\n  @GetMapping("/pets") void list() {}\n}`, "import org.springframework.stereotype.Component;"),
  ]);

  assert.deepEqual(routes(findings), ["GET /pets", "GET /{id}"]);
});

test("a class that inherits its controller stereotype but carries no component stereotype of its own is unknown, since scanning does not make it a bean", async () => {
  const findings = await extractor.extract([
    app("CrudController", `@RestController abstract class CrudController<T> {\n  @GetMapping("/{id}") T one() { return null; }\n}`),
    app("AuditController", `@RequestMapping("/audit") public class AuditController extends CrudController<Audit> {}`),
  ]);

  assert.deepEqual(routes(findings), []);
  assert.deepEqual(unknowns(findings).map((finding) => finding.evidence.map((span) => `${span.path}:${span.line}`)), [
    ["src/main/java/app/CrudController.java:5", "src/main/java/app/AuditController.java:4"],
  ]);
});

test("a class with a configuration or repository stereotype of its own that inherits its controller stereotype serves its routes: scanning makes it a bean", async () => {
  const findings = await extractor.extract([
    app("CrudController", `@RestController abstract class CrudController<T> {\n  @GetMapping("/{id}") T one() { return null; }\n}`),
    app("AuditController", `@Configuration @RequestMapping("/audit") public class AuditController extends CrudController<Audit> {}`, "import org.springframework.context.annotation.Configuration;"),
    app("LogController", `@Repository @RequestMapping("/log") public class LogController extends CrudController<Log> {}`, "import org.springframework.stereotype.Repository;"),
  ]);

  assert.deepEqual(routes(findings), ["GET /audit/{id}", "GET /log/{id}"]);
  assert.deepEqual(unknowns(findings), []);
});

test("a class whose only link to a class mapping is an interface is not a handler: Spring requires @Controller", async () => {
  const findings = await extractor.extract([
    app(
      "OrdersClient",
      `@FeignClient(name = "orders") @RequestMapping("/orders") interface OrdersClient {\n  @GetMapping("/{id}") String one(String id);\n}`,
      "import org.springframework.cloud.openfeign.FeignClient;",
    ),
    app("OrdersFallback", `@Component class OrdersFallback implements OrdersClient {\n  @Override public String one(String id) { return id; }\n}`, "import org.springframework.stereotype.Component;"),
    app("Annotated", `@Component @RequestMapping("/annotated") class Annotated {\n  @GetMapping("/{id}") void one() {}\n}`, "import org.springframework.stereotype.Component;"),
  ]);

  assert.deepEqual(findings, []);
});

test("a component that extends a controller serves the routes of its base", async () => {
  const findings = await extractor.extract([
    app("OrdersBase", `@RestController @RequestMapping("/orders") class OrdersBase {\n  @GetMapping("/{id}") String one() { return null; }\n}`),
    app("OrdersFallback", `@Component class OrdersFallback extends OrdersBase {}`, "import org.springframework.stereotype.Component;"),
  ]);

  assert.deepEqual(routes(findings), ["GET /orders/{id}"]);
});

test("a class with a platform annotation, no stereotype and no class mapping is not a handler", async () => {
  const findings = await extractor.extract([
    app("Helper", `@Component class Helper {\n  @GetMapping("/x") void x() {}\n}`, "import org.springframework.stereotype.Component;"),
  ]);

  assert.deepEqual(findings, []);
});

const PATH_PREFIX_CONFIG = (call: string) =>
  app(
    "WebConfig",
    `@Configuration class WebConfig implements WebMvcConfigurer {\n  @Override public void configurePathMatch(PathMatchConfigurer configurer) {\n    ${call}\n  }\n}`,
    "import org.springframework.context.annotation.Configuration; import org.springframework.web.servlet.config.annotation.*;",
  );

test("a path prefix added in configurePathMatch makes every route an unknown item with the call as evidence", async () => {
  const findings = await extractor.extract([
    PATH_PREFIX_CONFIG(`configurer.addPathPrefix("/api", HandlerTypePredicate.forAnnotation(RestController.class));`),
    app("Users", `@RestController class Users {\n  @GetMapping("/users") void list() {}\n  @PostMapping("/users") void create() {}\n}`),
  ]);

  assert.deepEqual(routes(findings), []);
  assert.deepEqual(
    unknowns(findings).map((finding) => [finding.reason, ...finding.evidence.map((evidence) => `${evidence.path.split("/").pop()}:${evidence.line}`)]),
    [
      ["no-extractor", "Users.java:5", "WebConfig.java:6"],
      ["no-extractor", "Users.java:6", "WebConfig.java:6"],
    ],
  );
});

test("an addPathPrefix call that is not Spring's two-argument method changes nothing", async () => {
  const findings = await extractor.extract([
    PATH_PREFIX_CONFIG(`registry.addPathPrefix("/api");`),
    app("Users", `@RestController class Users {\n  @GetMapping("/users") void list() {}\n}`),
  ]);

  assert.deepEqual(routes(findings), ["GET /users"]);
});

test("a class that extends Spring's RequestMappingHandlerMapping, servlet or reactive, makes every route an unknown item", async () => {
  const findings = await extractor.extract([
    app(
      "ServletMapping",
      `class ServletMapping extends RequestMappingHandlerMapping {}`,
      "import org.springframework.web.servlet.mvc.method.annotation.RequestMappingHandlerMapping;",
    ),
    app(
      "ReactiveMapping",
      `class ReactiveMapping extends RequestMappingHandlerMapping {}`,
      "import org.springframework.web.reactive.result.method.annotation.RequestMappingHandlerMapping;",
    ),
    app("Users", `@RestController class Users {\n  @GetMapping("/users") void list() {}\n}`),
  ]);

  assert.deepEqual(routes(findings), []);
  assert.deepEqual(
    unknowns(findings).map((finding) => finding.evidence.map((evidence) => `${evidence.path.split("/").pop()}:${evidence.line}`)),
    [["Users.java:5", "ReactiveMapping.java:4", "ServletMapping.java:4"]],
  );
});

test("a RequestMappingHandlerMapping that the repository declares is not Spring's", async () => {
  const findings = await extractor.extract([
    app("RequestMappingHandlerMapping", `class RequestMappingHandlerMapping {}`),
    app("Own", `class Own extends RequestMappingHandlerMapping {}`, "import org.springframework.web.servlet.mvc.method.annotation.*;"),
    app("Users", `@RestController class Users {\n  @GetMapping("/users") void list() {}\n}`),
  ]);

  assert.deepEqual(routes(findings), ["GET /users"]);
});

test("JAX-RS resources are unknown items per endpoint method, or per type when it has none, under either package", async () => {
  const findings = await extractor.extract([
    app(
      "UserResource",
      `@Path("/users") class UserResource {\n  @GET void list() {}\n  @POST @Path("/{id}") void create() {}\n  void helper() {}\n}\n@Path("/empty") class EmptyResource {}`,
      "import jakarta.ws.rs.*;",
    ),
    app("LegacyResource", `@javax.ws.rs.Path("/legacy") class LegacyResource {\n  @javax.ws.rs.DELETE void remove() {}\n}`),
  ]);

  assert.deepEqual(routes(findings), []);
  assert.deepEqual(
    unknowns(findings).map((finding) => `${finding.reason}:${finding.evidence[0]?.path.split("/").pop()}:${finding.evidence[0]?.line}`),
    ["no-extractor:LegacyResource.java:5", "no-extractor:UserResource.java:5", "no-extractor:UserResource.java:6", "no-extractor:UserResource.java:9"],
  );
});

test("a Micronaut controller is an unknown item per endpoint method, or per type when it has none", async () => {
  const findings = await extractor.extract([
    app(
      "Users",
      `@Controller("/users") class Users {\n  @Get("/") void list() {}\n  @Post void create() {}\n}\n@Controller("/empty") class Empty {}`,
      "import io.micronaut.http.annotation.*;",
    ),
  ]);

  assert.deepEqual(routes(findings), []);
  assert.deepEqual(gaps(findings), ["no-extractor@5", "no-extractor@6", "no-extractor@8"]);
});

test("a servlet and a Quarkus reactive route are unknown items", async () => {
  const findings = await extractor.extract([
    app("UserServlet", `@WebServlet("/users") class UserServlet {}`, "import jakarta.servlet.annotation.WebServlet;"),
    app("UserRoutes", `class UserRoutes {\n  @Route(path = "/users") void list() {}\n}`, "import io.quarkus.vertx.web.Route;"),
  ]);

  assert.deepEqual(routes(findings), []);
  assert.deepEqual(
    unknowns(findings).map((finding) => `${finding.reason}:${finding.evidence[0]?.path.split("/").pop()}:${finding.evidence[0]?.line}`),
    ["no-extractor:UserRoutes.java:5", "no-extractor:UserServlet.java:4"],
  );
});

test("an annotation of the repository named like a foreign server's is not one", async () => {
  const findings = await extractor.extract([
    app("Path", `@interface Path { String value(); }`),
    app("Own", `@Path("/own") class Own {\n  void list() {}\n}`),
  ]);

  assert.deepEqual(findings, []);
});

function longRoute(annotationArgument: string, extra = ""): SourceFile {
  return app("Long", `@RestController class Long {\n  @GetMapping(${annotationArgument}) void long() {}\n${extra}}`);
}

test("a concatenation of 20,000 terms evaluates, never overflows the stack", async () => {
  const terms = ['"/x"', ...Array.from({ length: 19_999 }, () => '"a"')];

  const findings = await extractor.extract([longRoute(terms.join(" + "))]);

  assert.deepEqual(routes(findings), [`GET /x${"a".repeat(19_999)}`]);
});

test("20,000 nested parentheses evaluate, never overflow the stack", async () => {
  const findings = await extractor.extract([longRoute(`${"(".repeat(20_000)}"/p"${")".repeat(20_000)}`)]);

  assert.deepEqual(routes(findings), ["GET /p"]);
});

test("a constant expression nested too deep to evaluate is that handler's unknown item and the rest of the file is still read", async () => {
  const nested = `${'true ? "a" : '.repeat(20_000)}"/deep"`;

  const findings = await extractor.extract([longRoute(nested, `  @GetMapping("/ok") void ok() {}\n`)]);

  assert.deepEqual(routes(findings), ["GET /ok"]);
  assert.deepEqual(gaps(findings), ["unresolved@5"]);
});

test("5,000 nested static classes are declared, never overflow the stack", async () => {
  let nested = "";
  for (let depth = 4_999; depth >= 0; depth--) nested = `static class C${depth} { ${nested} }`;

  const findings = await extractor.extract([app("Deep", `@RestController class Deep {\n  @GetMapping("/deep") void deep() {}\n  ${nested}\n}`)]);

  assert.deepEqual(routes(findings), ["GET /deep"]);
});

test("a file whose parsing throws is that file's source-unreadable item and the other files are still read", async () => {
  const base = await createJavaParser();
  const parser: JavaParser = {
    parse(source) {
      if (source.includes("Explodes")) throw new RangeError("Maximum call stack size exceeded");
      return base.parse(source);
    },
  };

  const findings = await createSpringRoutesExtractor(parser).extract([
    app("Explodes", `@RestController class Explodes {}`),
    app("Fine", `@RestController class Fine {\n  @GetMapping("/fine") void fine() {}\n}`),
  ]);

  assert.deepEqual(routes(findings), ["GET /fine"]);
  assert.deepEqual(
    unknowns(findings).map((finding) => `${finding.reason}:${finding.evidence[0]?.path.split("/").pop()}`),
    ["source-unreadable:Explodes.java"],
  );
});

/** A parser whose nodes throw a stack overflow when `failsAt` says so, for the sources that mention `Poisoned`. */
function poisonedParser(base: JavaParser, failsAt: (node: Node, member: string) => boolean): JavaParser {
  const wrapNullable = (node: Node | null): Node | null => (node === null ? null : wrap(node));
  const wrap = (node: Node): Node =>
    new Proxy(node, {
      get(target, member) {
        if (typeof member === "string" && failsAt(target, member)) throw new RangeError("Maximum call stack size exceeded");
        const value = Reflect.get(target, member, target) as unknown;
        if (member === "namedChildren" || member === "children") return (value as Node[]).map(wrap);
        if (member === "childForFieldName") return (field: string) => wrapNullable(target.childForFieldName(field));
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  return {
    parse(source) {
      const result = base.parse(source);
      return result.ok && source.includes("Poisoned") ? { ok: true, value: { ...result.value, root: wrap(result.value.root) } } : result;
    },
  };
}

test("a file whose declarations throw is that file's source-unreadable item and the other files are still read", async () => {
  const parser = poisonedParser(await createJavaParser(), (node, member) => node.type === "method_declaration" && member === "childForFieldName");

  const findings = await createSpringRoutesExtractor(parser).extract([
    app("Poisoned", `@RestController class Poisoned extends Absent {\n  @GetMapping("/poisoned") void poisoned() {}\n}`),
    app("Fine", `@RestController class Fine {\n  @GetMapping("/fine") void fine() {}\n}`),
  ]);

  assert.deepEqual(routes(findings), ["GET /fine"]);
  assert.deepEqual(
    unknowns(findings).map((finding) => `${finding.reason}:${finding.evidence[0]?.path.split("/").pop()}`),
    ["source-unreadable:Poisoned.java"],
  );
});

test("a type whose annotations throw is that type's unknown item and the other types are still read", async () => {
  const parser = poisonedParser(await createJavaParser(), (node, member) => node.type === "annotation" && member === "childForFieldName");

  const findings = await createSpringRoutesExtractor(parser).extract([
    app("Poisoned", `@RequestMapping("/p") @RestController class Poisoned {}`),
    app("Fine", `@RestController class Fine {\n  @GetMapping("/fine") void fine() {}\n}`),
  ]);

  assert.deepEqual(routes(findings), ["GET /fine"]);
  assert.deepEqual(
    unknowns(findings).map((finding) => `${finding.reason}:${finding.evidence[0]?.path.split("/").pop()}:${finding.evidence[0]?.line}`),
    ["unresolved:Poisoned.java:4"],
  );
});

const ORDERS = '@RestController\npublic class Orders {\n  @GetMapping("/orders")\n  public String list() { return ""; }\n}';

async function basePathOf(...config: SourceFile[]): Promise<Finding<BasePath>> {
  const [route] = await extractor.extract([app("Orders", ORDERS), MAIN, ...config]);
  assert.ok(route?.status === "complete" && route.value.kind === "http-route");
  return route.value.basePath;
}

test("a route's base path is what its module's configuration declares, while its path stays the mapping the code declares", async () => {
  const [route] = await extractor.extract([app("Orders", ORDERS), MAIN, file("src/main/resources/application.yml", "server:\n  servlet:\n    context-path: /shop\n")]);

  assert.equal(route?.status === "complete" && route.value.kind === "http-route" && route.value.path, "/orders");
  assert.deepEqual(route?.status === "complete" && route.value.kind === "http-route" && route.value.basePath, {
    status: "complete",
    value: { default: { contextPath: "/shop" }, profiles: {} },
    evidence: [{ path: "src/main/resources/application.yml", line: 3 }],
  });
});

test("every form Spring binds a key name from gives the key: nested or dotted YAML, kebab, camel or underscore case", async () => {
  const yaml = file("src/main/resources/application.yaml", "spring.mvc:\n  servlet.path: /mvc\nspring:\n  webflux:\n    base_path: /flux\n");
  const properties = file("src/main/resources/config/application.properties", "# comment\nserver.servlet.contextPath = /shop\n");

  assert.deepEqual(await basePathOf(yaml, properties), {
    status: "complete",
    value: { default: { contextPath: "/shop", servletPath: "/mvc", webfluxBasePath: "/flux" }, profiles: {} },
    evidence: [
      { path: "src/main/resources/application.yaml", line: 2 },
      { path: "src/main/resources/application.yaml", line: 5 },
      { path: "src/main/resources/config/application.properties", line: 2 },
    ],
  });
});

test("a configuration that declares no key gives a complete base path with nothing set and no evidence", async () => {
  assert.deepEqual(await basePathOf(file("src/main/resources/application.yml", "spring:\n  application:\n    name: orders\n")), {
    status: "complete",
    value: { default: {}, profiles: {} },
    evidence: [],
  });
  assert.deepEqual(await basePathOf(), { status: "complete", value: { default: {}, profiles: {} }, evidence: [] });
});

test("each profile's documents are reported by the profile they declare, by document condition or by file name, and none is picked", async () => {
  const yaml = file(
    "src/main/resources/application.yml",
    "server.servlet.context-path: /shop\n---\nspring.config.activate.on-profile: prod\nserver.servlet.context-path: /live\n",
  );
  const properties = file("src/main/resources/application-dev.properties", "spring.mvc.servlet.path=/dev\n#---\nspring.config.activate.on-profile=!dev\nspring.mvc.servlet.path=/x\n");

  const basePath = await basePathOf(yaml, properties);

  assert.equal(basePath.status, "unknown", "a profile file's document with its own profile condition is left undecided");
  assert.deepEqual(await basePathOf(file("src/main/resources/application.properties", "spring.mvc.servlet.path=/a\n#---\nspring.config.activate.on-profile=prod\nspring.mvc.servlet.path=/b\n")), {
    status: "complete",
    value: { default: { servletPath: "/a" }, profiles: { prod: { servletPath: "/b" } } },
    evidence: [
      { path: "src/main/resources/application.properties", line: 1 },
      { path: "src/main/resources/application.properties", line: 4 },
    ],
  });
  assert.deepEqual(await basePathOf(yaml, file("src/main/resources/application-dev.properties", "spring.mvc.servlet.path=/dev\n")), {
    status: "complete",
    value: { default: { contextPath: "/shop" }, profiles: { dev: { servletPath: "/dev" }, prod: { contextPath: "/live" } } },
    evidence: [
      { path: "src/main/resources/application-dev.properties", line: 1 },
      { path: "src/main/resources/application.yml", line: 1 },
      { path: "src/main/resources/application.yml", line: 4 },
    ],
  });
});

test("a route reads only the configuration of its own module", async () => {
  const findings = await extractor.extract([
    file("orders/src/main/java/app/Orders.java", `package app;\n${WEB}\n\n${ORDERS}`),
    file("orders/src/main/java/app/Main.java", BOOT),
    file("orders/src/main/resources/application.yml", "server.servlet.context-path: /orders-api\n"),
    file("src/main/resources/application.yml", "server.servlet.context-path: /root\n"),
  ]);

  assert.deepEqual(findings.map((finding) => finding.status === "complete" && finding.value.kind === "http-route" && finding.value.basePath.status === "complete" && finding.value.basePath.value.default), [{ contextPath: "/orders-api" }]);
});

test("a base path the snapshot cannot decide is unknown at the declarations that leave it undecided", async () => {
  const at = async (reason: string, ...config: SourceFile[]) => {
    const basePath = await basePathOf(...config);
    return basePath.status === "unknown" ? `${basePath.reason}@${basePath.evidence.map((span) => `${span.path.replace("src/main/resources/", "")}:${span.line}`).join(",")}` : `complete, expected ${reason}`;
  };

  assert.equal(await at("placeholder", file("src/main/resources/application.yml", "server.servlet.context-path: ${BASE:/shop}\n")), "unresolved@application.yml:1");
  assert.equal(
    await at("two values", file("src/main/resources/application.yml", "server.servlet.context-path: /a\n"), file("src/main/resources/application.properties", "\nserver.servlet.context-path=/b\n")),
    "unresolved@application.properties:2,application.yml:1",
  );
  assert.equal(await at("import", file("src/main/resources/application.yml", "spring.config.import: \"optional:configserver:\"\n")), "unresolved@application.yml:1");
  assert.equal(await at("cloud platform", file("src/main/resources/application.yml", "---\nspring.config.activate.on-cloud-platform: kubernetes\nserver.servlet.context-path: /k\n")), "unresolved@application.yml:3");
  assert.equal(await at("alias", file("src/main/resources/application.yml", "base: &base\n  context-path: /a\nserver:\n  servlet: *base\n")), "unresolved@application.yml:4");
  assert.equal(await at("merge key", file("src/main/resources/application.yml", "base: &base\n  servlet:\n    context-path: /a\nserver:\n  <<: *base\n")), "unresolved@application.yml:5");
  assert.equal(await at("not a string", file("src/main/resources/application.yml", "server.servlet.context-path:\n  - /a\n")), "unresolved@application.yml:1");
  assert.equal(await at("duplicate key", file("src/main/resources/application.yml", "server.port: 8080\nserver.port: 8081\n")), "source-unreadable@application.yml:2");
  assert.equal(await at("escape", file("src/main/resources/application.properties", "server.servlet.context-path=\\u12\n")), "source-unreadable@application.properties:1");
});

test("a value the configuration holds under any other key is never read into the base path", async () => {
  const basePath = await basePathOf(file("src/main/resources/application.yml", "spring.datasource.password: s3cret\nserver.servlet.context-path: /shop\n"));

  assert.equal(JSON.stringify(basePath).includes("s3cret"), false);
});

test("a handler outside a main source set has an unknown base path: no module's configuration is known to apply", async () => {
  const [route] = await extractor.extract([file("src/generated/java/app/Orders.java", `package app;\n${WEB}\n\n${ORDERS}`)]);

  assert.deepEqual(route?.status === "complete" && route.value.kind === "http-route" && route.value.basePath, { status: "unknown", reason: "unresolved", evidence: [{ path: "src/generated/java/app/Orders.java", line: 6, endLine: 7 }] });
});

test("a properties document separator counts only as Spring reads it: at column 0, after no comment of its prefix, and a comment opening the next document reopens the previous one", async () => {
  const at = async (content: string) => (await basePathOf(file("src/main/resources/application.properties", content))).status;
  const profile = "spring.config.activate.on-profile=prod\nserver.servlet.context-path=/prod\n";

  assert.equal(await at(`server.servlet.context-path=/api\n#---\n# production\n${profile}`), "unknown");
  assert.equal(await at(`server.servlet.context-path=/api\n# production\n#---\n${profile}`), "unknown");
  assert.equal(await at(`server.servlet.context-path=/api\n  #---\n${profile}`), "unknown");
  assert.equal(await at(`server.servlet.context-path=/api\n! note\n#--- \n${profile}`), "complete");
});

test("a route of a module that holds no Spring Boot application has an unknown base path: the module that serves it is not known", async () => {
  const [route] = await extractor.extract([
    file("web/src/main/java/app/Orders.java", `package app;\n${WEB}\n\n${ORDERS}`),
    file("app/src/main/java/app/Main.java", BOOT),
    file("app/src/main/resources/application.yml", "server.servlet.context-path: /shop\n"),
  ]);

  assert.deepEqual(route?.status === "complete" && route.value.kind === "http-route" && route.value.basePath, { status: "unknown", reason: "unresolved", evidence: [{ path: "web/src/main/java/app/Orders.java", line: 6, endLine: 7 }] });
});

test("a base path the code may set, anywhere in the commit, is unknown at that code: the extractor does not evaluate it", async () => {
  const at = async (content: string) => {
    const basePath = await basePathOf(file("src/main/java/app/Web.java", content));
    return basePath.status === "unknown" ? `${basePath.reason}@${basePath.evidence.map((span) => span.line).join(",")}` : "complete";
  };

  assert.equal(await at("package app;\nclass Web {\n  void customize(Object factory) {\n    factory.setContextPath(\"/x\");\n  }\n}"), "no-extractor@4");
  assert.equal(await at("package app;\nimport org.springframework.context.annotation.PropertySource;\n@PropertySource(\"classpath:web.properties\")\nclass Web {}"), "no-extractor@3");
  assert.equal(await at("package app;\nclass Web {\n  String key = \"server.servlet.context-path=/x\";\n}"), "no-extractor@3");
  assert.equal(await at("package app;\nclass Web {\n  String key = \"server.port\";\n}"), "complete");
});

test("a config file the reader does not read, or a properties value Spring decodes differently, leaves the base path unknown", async () => {
  const xml = await basePathOf(file("src/main/resources/application.xml", "<properties/>"));
  const latin = await basePathOf(file("src/main/resources/application.properties", "server.servlet.context-path=/caf\\u00e9\nspring.mvc.servlet.path=/café\n"));

  assert.deepEqual(xml, { status: "unknown", reason: "no-extractor", evidence: [{ path: "src/main/resources/application.xml", line: 1 }] });
  assert.deepEqual(latin, { status: "unknown", reason: "unresolved", evidence: [{ path: "src/main/resources/application.properties", line: 2 }] });
});

const KAFKA = "import org.springframework.kafka.annotation.*;";
const RABBIT = "import org.springframework.amqp.rabbit.annotation.*;";
const JMS = "import org.springframework.jms.annotation.*;";
const EVENTS = "import org.springframework.context.event.EventListener; import org.springframework.transaction.event.TransactionalEventListener;";
const SCHEDULING = "import org.springframework.scheduling.annotation.*;";
const COMPONENT = "import org.springframework.stereotype.Component;";

/** The listeners and jobs the findings hold, as `name@handler symbol`. */
function listeners(findings: readonly Finding<Entrypoint>[]): string[] {
  return findings.flatMap((finding) => (finding.status === "complete" && finding.value.kind !== "http-route" && finding.value.kind !== "ui-route" ? [`${finding.value.name}@${finding.value.handler.symbol}`] : [])).sort();
}

test("a Kafka, Rabbit or JMS listener method is one item per destination, named by its protocol and destination, with no base path", async () => {
  const source = app(
    "Consumers",
    `@Component class Consumers {\n  @KafkaListener(topics = {"orders", "refunds"}) void orders(String message) {}\n  @RabbitListener(queues = "payments") void payments(String message) {}\n  @JmsListener(destination = "audit") void audit(String message) {}\n}`,
    `${KAFKA} ${RABBIT} ${JMS} ${COMPONENT}`,
  );
  const item = (protocol: "kafka" | "rabbit" | "jms", destination: string, method: string, line: number) => ({
    status: "complete",
    value: { kind: "listener", name: `${protocol} ${destination}`, protocol, destination, handler: { path: source.path, symbol: `Consumers.${method}`, line } },
    evidence: [{ path: source.path, line, endLine: line }],
  });

  const findings = await extractor.extract([source, MAIN]);

  assert.deepEqual(findings, [item("kafka", "orders", "orders", 5), item("kafka", "refunds", "orders", 5), item("rabbit", "payments", "payments", 6), item("jms", "audit", "audit", 7)]);
});

test("a destination named by a constant of another file resolves", async () => {
  const findings = await extractor.extract([
    app("Topics", `public final class Topics { public static final String ORDERS = "orders" + "-v1"; }`),
    app("Consumer", `@Component class Consumer { @KafkaListener(topics = Topics.ORDERS) void on(String message) {} }`, `${KAFKA} ${COMPONENT}`),
  ]);

  assert.deepEqual(listeners(findings), ["kafka orders-v1@Consumer.on"]);
});

test("a placeholder, a SpEL expression or a constant the sources lack is an unresolved destination, beside the destinations that resolve", async () => {
  const findings = await extractor.extract([
    app(
      "Placeholders",
      `@Component class Placeholders {\n  @KafkaListener(topics = {"\${orders.topic}", "fixed"}) void kafka(String message) {}\n  @RabbitListener(queues = "#{ordersQueue.name}") void rabbit(String message) {}\n  @JmsListener(destination = Lib.QUEUE) void jms(String message) {}\n}`,
      `${KAFKA} ${RABBIT} ${JMS} ${COMPONENT} import com.lib.Lib;`,
    ),
  ]);

  assert.deepEqual(listeners(findings), ["kafka fixed@Placeholders.kafka"]);
  assert.deepEqual(gaps(findings), ["unresolved@5", "unresolved@6", "unresolved@7"]);
});

test("the repeatable containers and a repeated annotation give one item per listener annotation", async () => {
  const findings = await extractor.extract([
    app(
      "Repeated",
      `@Component class Repeated {
  @KafkaListeners({@KafkaListener(topics = "a"), @KafkaListener(topics = "b")}) void kafka(String message) {}
  @RabbitListeners(@RabbitListener(queues = "c")) void rabbit(String message) {}
  @JmsListener(destination = "d") @JmsListener(destination = "e") void jms(String message) {}
  @JmsListeners({@JmsListener(destination = "f")}) void jmsContainer(String message) {}
}`,
      `${KAFKA} ${RABBIT} ${JMS} ${COMPONENT}`,
    ),
  ]);

  assert.deepEqual(listeners(findings), [
    "jms d@Repeated.jms",
    "jms e@Repeated.jms",
    "jms f@Repeated.jmsContainer",
    "kafka a@Repeated.kafka",
    "kafka b@Repeated.kafka",
    "rabbit c@Repeated.rabbit",
  ]);
});

test("a class-level Kafka or Rabbit listener is one item per destination, handled by the class that dispatches to its handler methods", async () => {
  const orders = app("Orders", `@Component @KafkaListener(topics = {"orders", "refunds"}) class Orders {\n  @KafkaHandler void on(String message) {}\n}`, `${KAFKA} ${COMPONENT}`);
  const findings = await extractor.extract([
    orders,
    app("Payments", `@Component @RabbitListener(queues = "payments") class Payments {\n  @RabbitHandler void on(String message) {}\n}`, `${RABBIT} ${COMPONENT}`),
  ]);

  assert.deepEqual(listeners(findings), ["kafka orders@Orders", "kafka refunds@Orders", "rabbit payments@Payments"]);
  assert.deepEqual(findings[0], {
    status: "complete",
    value: { kind: "listener", name: "kafka orders", protocol: "kafka", destination: "orders", handler: { path: orders.path, symbol: "Orders", line: 4, endLine: 6 } },
    evidence: [{ path: orders.path, line: 4, endLine: 6 }],
  });
});

test("a destination given by a pattern, partitions, bindings or queues to declare is no-extractor, and a listener that names none is unresolved", async () => {
  const source = app(
    "Patterns",
    `@Component class Patterns {
  @KafkaListener(topicPattern = "orders-.*") void pattern(String message) {}
  @KafkaListener(topicPartitions = @TopicPartition(topic = "x", partitions = "0")) void partitions(String message) {}
  @RabbitListener(bindings = @QueueBinding(value = @Queue, exchange = @Exchange("x"))) void bound(String message) {}
  @RabbitListener(queuesToDeclare = @Queue("declared")) void declared(String message) {}
  @KafkaListener(id = "none") void none(String message) {}
}`,
    `${KAFKA} ${RABBIT} ${COMPONENT}`,
  );

  const findings = await extractor.extract([source]);

  assert.deepEqual(listeners(findings), []);
  assert.deepEqual(gaps(findings), ["no-extractor@5", "no-extractor@6", "no-extractor@7", "no-extractor@8", "unresolved@9"]);
});

test("a listener annotation of another library is no-extractor, on a method or on a type, bean or not", async () => {
  const findings = await extractor.extract([
    app(
      "Foreign",
      `class Foreign {
  @StreamListener("input") void stream(String message) {}
  @SqsListener("queue") void sqs(String message) {}
  @PulsarListener(topics = "t") void pulsar(String message) {}
}
@SqsListener("typed") class Typed {}`,
      "import org.springframework.cloud.stream.annotation.StreamListener; import io.awspring.cloud.sqs.annotation.SqsListener; import org.springframework.pulsar.annotation.PulsarListener;",
    ),
  ]);

  assert.deepEqual(gaps(findings), ["no-extractor@5", "no-extractor@6", "no-extractor@7", "no-extractor@9"]);
});

test("a listener annotation composed by a repository annotation is no-extractor at the method", async () => {
  const findings = await extractor.extract([
    app("OrdersTopic", `@KafkaListener(topics = "orders") public @interface OrdersTopic {}`, KAFKA),
    app("Consumer", `@Component class Consumer {\n  @OrdersTopic void on(String message) {}\n}`, COMPONENT),
  ]);

  assert.deepEqual(gaps(findings), ["no-extractor@5"]);
});

test("repository annotations that compose each other in a cycle are no listener and do not hang", async () => {
  const findings = await extractor.extract([
    app("First", `@Second public @interface First {}`),
    app("Second", `@First public @interface Second {}`),
    app("Consumer", `@Component class Consumer {\n  @First void on(String message) {}\n}`, COMPONENT),
  ]);

  assert.deepEqual(findings, []);
});

test("a listener in a class that is not a scanned bean of its own is no-extractor with the class as cause, and @Configuration makes a bean", async () => {
  const findings = await extractor.extract([
    app("Plain", `class Plain {\n  @KafkaListener(topics = "orders") void on(String message) {}\n}`, KAFKA),
    app("Config", `@Configuration class Config {\n  @KafkaListener(topics = "config") void on(String message) {}\n}`, `${KAFKA} import org.springframework.context.annotation.Configuration;`),
  ]);

  assert.deepEqual(listeners(findings), ["kafka config@Config.on"]);
  assert.deepEqual(
    unknowns(findings).map((finding) => [finding.reason, ...finding.evidence.map((span) => `${span.path.split("/").pop()}:${span.line}`)]),
    [["no-extractor", "Plain.java:5", "Plain.java:4"]],
  );
});

test("a listener a bean inherits from a supertype is no-extractor at the inherited method and the bean", async () => {
  const findings = await extractor.extract([
    app("Base", `abstract class Base {\n  @KafkaListener(topics = "orders") void on(String message) {}\n}`, KAFKA),
    app("Orders", `@Component class Orders extends Base {}`, COMPONENT),
  ]);

  assert.deepEqual(listeners(findings), []);
  assert.deepEqual(
    unknowns(findings).map((finding) => [finding.reason, ...finding.evidence.map((span) => `${span.path.split("/").pop()}:${span.line}`)]),
    [["no-extractor", "Base.java:5", "Orders.java:4"]],
  );
});

test("an event listener is one item per event type, from its classes or value attribute, else from its single parameter", async () => {
  const findings = await extractor.extract([
    app("OrderCreated", `public class OrderCreated {}`),
    app(
      "Events",
      `@Component class Events {
  @EventListener void created(OrderCreated event) {}
  @EventListener(classes = {OrderCreated.class, OrderPaid.class}) void many() {}
  @TransactionalEventListener(OrderPaid.class) void paid() {}
  @EventListener void any(Object event) {}
  @EventListener void wrapped(Envelope<OrderCreated> event) {}
  @EventListener void qualified(com.shop.events.OrderShipped event) {}
}`,
      `${EVENTS} ${COMPONENT} import com.shop.events.OrderPaid; import com.shop.events.Envelope;`,
    ),
  ]);

  assert.deepEqual(listeners(findings), [
    "event app.OrderCreated@Events.created",
    "event app.OrderCreated@Events.many",
    "event com.shop.events.Envelope@Events.wrapped",
    "event com.shop.events.OrderPaid@Events.many",
    "event com.shop.events.OrderPaid@Events.paid",
    "event com.shop.events.OrderShipped@Events.qualified",
    "event java.lang.Object@Events.any",
  ]);
});

test("an event type that the sources do not decide is unresolved: no import names it, two files declare it, or no single parameter gives it", async () => {
  const findings = await extractor.extract([
    file("a/src/main/java/shared/Twice.java", "package shared;\npublic class Twice {}"),
    file("b/src/main/java/shared/Twice.java", "package shared;\npublic class Twice {}"),
    app(
      "Events",
      `@Component class Events {
  @EventListener void absent(Missing event) {}
  @EventListener void wildcard(Thing event) {}
  @EventListener void twice(Twice event) {}
  @EventListener void none() {}
  @EventListener(Lib.TYPE) void constant() {}
  @EventListener void two(Object first, Object second) {}
}`,
      `${EVENTS} ${COMPONENT} import com.lib.*; import shared.Twice;`,
    ),
  ]);

  assert.deepEqual(listeners(findings), []);
  assert.deepEqual(gaps(findings), ["unresolved@10", "unresolved@5", "unresolved@6", "unresolved@7", "unresolved@8", "unresolved@9"]);
});

test("a scheduled method is one job per annotation, named by the attribute that triggers it and its value", async () => {
  const source = app(
    "Jobs",
    `@Component class Jobs {
  static final long DELAY = 5000;
  @Scheduled(cron = "0 0 * * * *") void hourly() {}
  @Scheduled(fixedDelay = DELAY) void delayed() {}
  @Scheduled(fixedRate = 1000, initialDelay = 10) void rated() {}
  @Scheduled(fixedDelayString = "PT5S") void delayedText() {}
  @Scheduled(fixedRateString = "PT1M") void ratedText() {}
  @Schedules({@Scheduled(cron = "0 0 1 * * *"), @Scheduled(cron = "0 0 2 * * *")}) void twice() {}
}`,
    `${SCHEDULING} ${COMPONENT}`,
  );

  const findings = await extractor.extract([source]);

  assert.deepEqual(listeners(findings), [
    "scheduled cron=0 0 * * * *@Jobs.hourly",
    "scheduled cron=0 0 1 * * *@Jobs.twice",
    "scheduled cron=0 0 2 * * *@Jobs.twice",
    "scheduled fixedDelay=5000@Jobs.delayed",
    "scheduled fixedDelayString=PT5S@Jobs.delayedText",
    "scheduled fixedRate=1000@Jobs.rated",
    "scheduled fixedRateString=PT1M@Jobs.ratedText",
  ]);
  assert.deepEqual(findings[1], {
    status: "complete",
    value: { kind: "job", name: "scheduled fixedDelay=5000", trigger: { attribute: "fixedDelay", value: "5000" }, handler: { path: source.path, symbol: "Jobs.delayed", line: 7 } },
    evidence: [{ path: source.path, line: 7, endLine: 7 }],
  });
});

test("a trigger from a placeholder is unresolved, an expression not evaluated is no-extractor, and so is an annotation without exactly one trigger", async () => {
  const findings = await extractor.extract([
    app(
      "Jobs",
      `@Component class Jobs {
  @Scheduled(cron = "\${jobs.cron}") void placeholder() {}
  @Scheduled(fixedDelay = 5 * 1000) void product() {}
  @Scheduled(initialDelay = 1000) void once() {}
  @Scheduled(fixedDelay = 1000, fixedRate = 2000) void both() {}
}`,
      `${SCHEDULING} ${COMPONENT}`,
    ),
  ]);

  assert.deepEqual(listeners(findings), []);
  assert.deepEqual(gaps(findings), ["no-extractor@6", "no-extractor@7", "no-extractor@8", "unresolved@5"]);
});

test("the entrypoints of one method are ordered by kind and then by name", async () => {
  const sources = [
    app(
      "Mixed",
      `@RestController class Mixed {\n  @GetMapping("/mixed") @Scheduled(fixedRate = 1) @KafkaListener(topics = {"b", "a"}) void all(String message) {}\n}`,
      `${KAFKA} ${SCHEDULING}`,
    ),
  ];

  const findings = await extractor.extract(sources);

  assert.deepEqual(
    findings.map((finding) => finding.status === "complete" && finding.value.name),
    ["GET /mixed", "scheduled fixedRate=1", "kafka a", "kafka b"],
  );
});

test("a path prefix makes the routes unknown items, never a listener", async () => {
  const findings = await extractor.extract([
    PATH_PREFIX_CONFIG(`configurer.addPathPrefix("/api", HandlerTypePredicate.forAnnotation(RestController.class));`),
    app("Consumer", `@Component class Consumer { @KafkaListener(topics = "orders") void on(String message) {} }`, `${KAFKA} ${COMPONENT}`),
  ]);

  assert.deepEqual(listeners(findings), ["kafka orders@Consumer.on"]);
});

test("a Spring Modulith application module listener is an event listener of its single parameter's type", async () => {
  const findings = await extractor.extract([
    app("OrderCreated", "public class OrderCreated {}"),
    app("Inventory", "@Component class Inventory {\n  @ApplicationModuleListener void on(OrderCreated event) {}\n}", `import org.springframework.modulith.events.ApplicationModuleListener; ${COMPONENT}`),
  ]);

  assert.deepEqual(listeners(findings), ["event app.OrderCreated@Inventory.on"]);
});

test("a dotted event type is named only when its first segment is an imported type or a package: a type of the file's package or of a wildcard import is not decided", async () => {
  const findings = await extractor.extract([
    app(
      "Events",
      `@Component class Events {
  @EventListener void local(Holder.Created event) {}
  @EventListener void wildcard(LibEvents.Created event) {}
  @EventListener void imported(Imported.Created event) {}
  @EventListener(classes = Holder.Paid.class) void literal() {}
}`,
      `${EVENTS} ${COMPONENT} import com.lib.events.*; import com.shop.Imported;`,
    ),
  ]);

  assert.deepEqual(listeners(findings), ["event com.shop.Imported.Created@Events.imported"]);
  assert.deepEqual(gaps(findings), ["unresolved@5", "unresolved@6", "unresolved@8"]);
});

test("a job whose cron is Spring's disabled marker is no entrypoint: Spring never schedules it", async () => {
  const findings = await extractor.extract([app("Jobs", `@Component class Jobs {\n  @Scheduled(cron = "-") void off() {}\n}`, `${SCHEDULING} ${COMPONENT}`)]);

  assert.deepEqual(findings, []);
});

const NATS = "import io.nats.client.Connection; import io.nats.client.JetStream; import io.nats.client.Message;";

/** A Java source in package `app` with the NATS client imported; the body starts at line 4. */
function nats(name: string, body: string, imports = ""): SourceFile {
  return file(`src/main/java/app/${name}.java`, ["package app;", NATS, `${COMPONENT} ${imports}`, body].join("\n"));
}

test("a direct NATS subscription is a listener named by its subject, with or without a queue group, and JetStream subscribes the same way", async () => {
  const source = nats(
    "Consumers",
    `@Component class Consumers {
  private final Connection connection;
  private final JetStream jetStream;
  void plain() { connection.subscribe("orders.created", message -> handle(message)); }
  void grouped() { connection.subscribe("orders.paid", "workers", message -> handle(message)); }
  void stream() { jetStream.subscribe("orders.shipped", message -> handle(message)); }
  void handle(Message message) {}
}`,
  );

  const findings = await extractor.extract([source, MAIN]);

  assert.deepEqual(listeners(findings), ["nats orders.created@Consumers.plain", "nats orders.paid@Consumers.grouped", "nats orders.shipped@Consumers.stream"]);
});

test("a NATS subscription whose subject the sources do not state is an unresolved item", async () => {
  const findings = await extractor.extract([
    nats("Consumers", `@Component class Consumers {\n  private final Connection connection;\n  void plain() { connection.subscribe(Subjects.ORDERS, message -> handle(message)); }\n  void handle(Message message) {}\n}`, "import com.lib.Subjects;"),
  ]);

  assert.deepEqual(listeners(findings), []);
  assert.deepEqual(gaps(findings), ["unresolved@6"]);
});

const CONTRACT = "src/main/resources/openapi/api-definition.yaml";

/** The extractor with the operations a contract document of the repository declares, as the port hands them over. */
function contracting(operations: readonly Finding<ContractOperation>[]): EntrypointExtractor {
  return createSpringRoutesExtractor(parser, { operations: () => operations });
}

function operation(operationId: string | undefined, method: HttpMethod, path: string, line = 5, basePath: string | null = ""): Finding<ContractOperation> {
  const data = { request: "", response: "", files: [], unresolved: [] };
  return { status: "complete", value: { operationId, method, path, basePath: basePath ?? undefined, document: CONTRACT, line, data }, evidence: [{ path: CONTRACT, line }] };
}

test("an @Override method that a contract operationId names is a route with the contract's verb and path", async () => {
  const controller = app("OrdersController", `@RestController class OrdersController implements OrdersApi {\n  @Override public List<String> createNewOrder() { return null; }\n}`);
  extractor = contracting([operation("createNewOrder", "POST", "/orders")]);

  const findings = await extractor.extract([controller, MAIN]);

  assert.deepEqual(routes(findings), ["POST /orders"]);
  assert.deepEqual(handlers(findings), ["OrdersController.createNewOrder@5"]);
  assert.deepEqual(
    findings.flatMap((finding) => (finding.status === "complete" ? [finding.evidence.map((evidence) => `${evidence.path}:${evidence.line}`)] : [])),
    [[`${controller.path}:5`, `${CONTRACT}:5`]],
  );
});

test("a contract whose operations no class of the snapshot implements gives no route", async () => {
  extractor = contracting([operation("addPet", "POST", "/pet"), operation("getPet", "GET", "/pet/{petId}")]);

  const findings = await extractor.extract([app("OrdersController", `@RestController class OrdersController implements OrdersApi {\n  @Override public void createNewOrder() {}\n}`), MAIN]);

  assert.deepEqual(routes(findings), []);
  assert.deepEqual(gaps(findings), ["no-extractor@4", "no-extractor@5"]);
});

test("an override that no contract operation names stays an unknown item at the method", async () => {
  extractor = contracting([operation("createNewOrder", "POST", "/orders")]);

  const findings = await extractor.extract([
    app("OrdersController", `@RestController class OrdersController implements OrdersApi {\n  @Override public void createNewOrder() {}\n  @Override public void deleteOrder() {}\n}`),
  ]);

  assert.deepEqual(routes(findings), ["POST /orders"]);
  assert.deepEqual(gaps(findings), ["no-extractor@4", "no-extractor@6"]);
});

test("an operation the contract declares without an operationId is joined to no override", async () => {
  extractor = contracting([operation(undefined, "POST", "/orders"), operation("createNewOrder", "PUT", "/orders/{id}")]);

  const findings = await extractor.extract([app("OrdersController", `@RestController class OrdersController implements OrdersApi {\n  @Override public void createNewOrder() {}\n  @Override public void undefined() {}\n}`)]);

  assert.deepEqual(routes(findings), ["PUT /orders/{id}"]);
  assert.deepEqual(gaps(findings), ["no-extractor@4", "no-extractor@6"]);
});

test("an operationId that two contract documents declare picks neither: the handler is unknown", async () => {
  const other = { ...operation("createNewOrder", "PUT", "/orders"), evidence: [{ path: "swagger/other.yaml", line: 9 }] };
  extractor = contracting([operation("createNewOrder", "POST", "/orders"), other]);

  const findings = await extractor.extract([app("OrdersController", `@RestController class OrdersController implements OrdersApi {\n  @Override public void createNewOrder() {}\n}`)]);

  assert.deepEqual(routes(findings), []);
  assert.deepEqual(gaps(findings), ["no-extractor@4", "unresolved@5"]);
});

test("a handler that declares its own mapping keeps the route the annotation makes, never a second one from the contract", async () => {
  extractor = contracting([operation("own", "POST", "/orders")]);

  const findings = await extractor.extract([app("OrdersController", `@RestController @RequestMapping("/own") class OrdersController implements OrdersApi {\n  @Override @GetMapping("/own") public void own() {}\n}`)]);

  assert.deepEqual(routes(findings), ["GET /own/own"]);
});

test("an override a contract names but that declares a mapping of its own keeps the absent supertype as an item", async () => {
  extractor = contracting([operation("own", "GET", "/own")]);

  const findings = await extractor.extract([app("OrdersController", `@RestController class OrdersController implements OrdersApi {\n  @Override @GetMapping("/own") public void own() {}\n}`)]);

  assert.deepEqual(routes(findings), []);
  assert.deepEqual(gaps(findings), ["no-extractor@4", "no-extractor@5"]);
});

test("a contract's base path leads the path of the route its operation makes", async () => {
  const controller = app("OrdersController", `@RestController class OrdersController implements OrdersApi {\n  @Override public void createNewOrder() {}\n}`);
  extractor = contracting([operation("createNewOrder", "POST", "/orders", 5, "/v2")]);

  assert.deepEqual(routes(await extractor.extract([controller, MAIN])), ["POST /v2/orders"]);
});

test("a contract whose servers disagree on the path makes a route whose base path is unknown, at the contract", async () => {
  const controller = app("OrdersController", `@RestController class OrdersController implements OrdersApi {\n  @Override public void createNewOrder() {}\n}`);
  extractor = contracting([operation("createNewOrder", "POST", "/orders", 5, null)]);

  const [finding] = await extractor.extract([controller, MAIN]);

  assert.equal(finding?.status === "complete" && finding.value.kind === "http-route" && finding.value.path, "/orders");
  assert.deepEqual(finding?.status === "complete" && finding.value.kind === "http-route" && finding.value.basePath, {
    status: "unknown",
    reason: "unresolved",
    evidence: finding?.evidence,
  });
});

test("a source NATS template subscription evaluates the subject override per concrete bean", async () => {
  const source = nats("Consumers", `abstract class BaseConsumer {
    Connection connection;
    abstract String getSubject();
    void listen() { connection.subscribe(getSubject(), message -> {}); }
  }
  @Component class FirstConsumer extends BaseConsumer { String getSubject() { return "catalog.created"; } }
  @Component class SecondConsumer extends BaseConsumer { String getSubject() { return "catalog.updated"; } }`);
  const findings = await extractor.extract([source, MAIN]);
  assert.deepEqual(listeners(findings), ["nats catalog.created@FirstConsumer.listen", "nats catalog.updated@SecondConsumer.listen"]);
});

test("a NATS Dispatcher subscription is a listener, from a constructor a base class runs for each concrete bean and from a dispatcher the connection creates in place", async () => {
  const source = nats("Consumers", `abstract class ListenerDelegate {
    protected final Dispatcher dispatcher;
    protected ListenerDelegate(Connection connection) {
      dispatcher = connection.createDispatcher();
      dispatcher.subscribe(getSubject(), getQueueName(), this::handleMessage);
    }
    public abstract void handleMessage(Message message);
    public abstract String getSubject();
    public abstract String getQueueName();
  }
  @Component class CreatedListener extends ListenerDelegate {
    CreatedListener(Connection connection) { super(connection); }
    public void handleMessage(Message message) {}
    public String getSubject() { return "orders.created"; }
    public String getQueueName() { return "workers"; }
  }
  @Component class PaidListener {
    private final Connection connection;
    void listen() { connection.createDispatcher().subscribe("orders.paid"); }
  }`, "import io.nats.client.Dispatcher;");
  const findings = await extractor.extract([source, MAIN]);
  assert.deepEqual(listeners(findings), ["nats orders.created@CreatedListener", "nats orders.paid@PaidListener.listen"]);
});

const MESSENGER_BASE = file("src/main/java/lib/NatsListener.java", `package lib;
import io.nats.client.Connection; import io.nats.client.Dispatcher; import io.nats.client.Message;
public abstract class NatsListener {
  protected NatsListener(Connection connection) {
    Dispatcher dispatcher = connection.createDispatcher();
    dispatcher.subscribe(subject(), this::handle);
  }
  public abstract void handle(Message message);
  public abstract String subject();
}`);

const INHERITING = nats("CreatedListener", `@Component class CreatedListener extends NatsListener {
  CreatedListener(Connection connection) { super(connection); }
  public void handle(Message message) {}
  public String subject() { return "orders.created"; }
}`, "import lib.NatsListener;");

test("a NATS subscription a base class from the libraries holds is a listener of the concrete class, placed in the repository's own source", async () => {
  const findings = await extractor.extract([INHERITING, MAIN], [{ repo: "lib", ...MESSENGER_BASE }]);

  assert.deepEqual(listeners(findings), ["nats orders.created@CreatedListener"]);
  const [listener] = findings;
  assert.ok(listener?.status === "complete" && listener.value.kind === "listener");
  assert.deepEqual([listener.value.handler.path, listener.value.handler.line, listener.evidence.map(({ path }) => path)], [INHERITING.path, 4, [INHERITING.path]]);
});

test("a NATS subscription a base class holds is not read when no library source is given", async () => {
  assert.deepEqual(listeners(await extractor.extract([INHERITING, MAIN])), []);
});

test("a library class is never reported as an entrypoint, and the routes the repository's sources declare stay as they were", async () => {
  const controller = app("Orders", `@RestController class Orders {\n  @GetMapping("/orders") String list() { return ""; }\n}`, "import org.springframework.web.bind.annotation.RestController;");
  const concrete = file("src/main/java/lib/Own.java", `package lib;\nimport io.nats.client.Connection;\npublic class Own extends NatsListener {\n  Own(Connection connection) { super(connection); }\n  public void handle(io.nats.client.Message message) {}\n  public String subject() { return "lib.own"; }\n}`);
  const bare = await extractor.extract([controller, INHERITING, MAIN]);
  const withLibrary = await extractor.extract([controller, INHERITING, MAIN], [MESSENGER_BASE, concrete].map((source) => ({ repo: "lib", ...source })));

  assert.deepEqual(withLibrary.filter((finding) => finding.evidence.every(({ path }) => path !== INHERITING.path)), bare.filter((finding) => finding.evidence.every(({ path }) => path !== INHERITING.path)));
  assert.ok(withLibrary.every((finding) => finding.evidence.every(({ path }) => !path.startsWith("(library)"))));
});

test("an unmapped inherited declaration with unread external ancestry does not add a speculative route item", async () => {
  const findings = await extractor.extract([
    file("src/main/java/app/Main.java", "package app; import org.springframework.boot.autoconfigure.SpringBootApplication; @SpringBootApplication public class Main {}"),
    file("src/main/java/app/Port.java", "package app; import ext.Event; public interface Port extends ext.Subscriber { void send(Event event); }"),
    file("src/main/java/app/Sender.java", "package app; import ext.Event; import org.springframework.stereotype.Component; @Component public class Sender implements Port { public void send(Event event) {} }"),
  ]);
  assert.deepEqual(findings, []);
});
