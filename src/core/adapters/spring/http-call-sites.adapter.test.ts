import { before, test } from "node:test";
import assert from "node:assert/strict";
import type { LibrarySource } from "../../domain/topology/library-source.ts";
import type { CallSite, CallSiteReader } from "../../domain/topology/call-site.ts";
import { createJavaParser, type JavaParser } from "../tree-sitter/java-parser.adapter.ts";
import { createJavaHttpCallSites } from "./java-call-sites.adapter.ts";

const WEB = ["org.springframework.web.client.RestTemplate", "org.springframework.web.client.RestClient", "org.springframework.http.HttpMethod", "org.springframework.stereotype.Service"];
const RESOURCES = "src/main/resources/application.yml";

let reader: CallSiteReader;

test("Java HTTP sites carry their actual named AST ancestors", async () => {
  const client = java("BillingClient", ["class BillingClient {", "  RestTemplate rt;", "  void send() {", "    rt.getForObject(\"http://billing/orders\", String.class);", "  }", "}"].join("\n"));
  const [site] = await reader.of([client], "orders-svc");
  assert.deepEqual(site?.ancestors, [{ symbol: "send", line: 8, endLine: 10 }, { symbol: "BillingClient", line: 6, endLine: 11 }]);
});

test("declarative HTTP sites carry their actual named AST ancestors", async () => {
  const client = java("CatalogApi", ["@HttpExchange(\"/catalog\")", "interface CatalogApi {", "  @GetExchange(\"/products\") String product();", "}"].join("\n"), ["org.springframework.web.service.annotation.*"]);
  const [site] = await reader.of([client], "orders-svc");
  assert.deepEqual(site?.ancestors, [{ symbol: "product", line: 5, endLine: 5 }, { symbol: "CatalogApi", line: 3, endLine: 6 }]);
});

before(async () => {
  reader = createJavaHttpCallSites(await createJavaParser());
});

function file(path: string, content: string): { path: string; content: string } {
  return { path, content };
}

/** A class of package `app`; the body starts at line 3 + the number of imports. */
function java(name: string, body: string, imports: readonly string[] = WEB): { path: string; content: string } {
  return file(`src/main/java/app/${name}.java`, ["package app;", ...imports.map((entry) => `import ${entry};`), body].join("\n"));
}

function describe(sites: readonly CallSite[]): string[] {
  return sites.map((site) => {
    const where = `${site.symbol}@${site.file.split("/").pop()}:${site.line}`;
    if (site.target.status === "unknown") return `unknown ${where}${site.target.evidence[0]?.via === undefined ? "" : ` via ${site.target.evidence[0].via}`}`;
    const target = site.target.value;
    return "path" in target ? `${target.method} ${target.path}${target.base === undefined ? "" : ` via ${target.base}`} ${where}` : `event ${where}`;
  });
}

function inLibrary(source: { path: string; content: string }): LibrarySource {
  return { repo: "lib", ...source };
}

async function read(files: readonly { path: string; content: string }[], libraries: readonly { path: string; content: string }[] = []): Promise<string[]> {
  return describe(await reader.of(files, "orders-svc", libraries.map(inLibrary)));
}

test("a RestTemplate verb fixes the method by its name, and exchange takes it from its argument", async () => {
  const client = java(
    "BillingClient",
    [
      "@Service class BillingClient {",
      "  private final RestTemplate rt;",
      "  BillingClient(RestTemplate rt) { this.rt = rt; }",
      "  void find(String id) { rt.getForObject(\"http://billing-svc:8080/invoices/\" + id, String.class); }",
      "  void pay() { rt.postForObject(\"http://billing-svc:8080/payments\", null, Void.class); }",
      "  void drop() { rt.exchange(\"http://billing-svc:8080/payments/7\", HttpMethod.DELETE, null, Void.class); }",
      "}",
    ].join("\n"),
  );

  assert.deepEqual(await read([client]), [
    "GET http://billing-svc:8080/invoices/{} BillingClient.find@BillingClient.java:9",
    "POST http://billing-svc:8080/payments BillingClient.pay@BillingClient.java:10",
    "DELETE http://billing-svc:8080/payments/7 BillingClient.drop@BillingClient.java:11",
  ]);
});

test("a method the code does not decide makes the target unknown, never a guess", async () => {
  const client = java(
    "BillingClient",
    ["@Service class BillingClient {", "  private final RestTemplate rt;", "  void send(HttpMethod chosen) { rt.exchange(\"http://billing-svc/payments\", chosen, null, Void.class); }", "}"].join("\n"),
  );

  assert.deepEqual(await read([client]), ["unknown BillingClient.send@BillingClient.java:8"]);
});

test("RestClient and WebClient chains give the method of the verb or of method(), and a base URL set on the client leads the path", async () => {
  const client = java(
    "ShippingClient",
    [
      "@Service class ShippingClient {",
      "  private final RestClient rest;",
      "  private final WebClient web = WebClient.create(\"http://shipping-svc:9000\");",
      "  ShippingClient(RestClient.Builder builder) { this.rest = builder.baseUrl(\"http://shipping-svc:9000/api\").build(); }",
      "  void track() { rest.get().uri(\"/parcels/{id}\", 1).retrieve().body(String.class); }",
      "  void relabel() { rest.method(HttpMethod.PUT).uri(\"/parcels/1\").retrieve(); }",
      "  void cancel() { web.post().uri(\"/cancellations\").retrieve(); }",
      "}",
    ].join("\n"),
    [...WEB, "org.springframework.web.reactive.function.client.WebClient"],
  );

  assert.deepEqual(await read([client]), [
    "GET http://shipping-svc:9000/api/parcels/{id} ShippingClient.track@ShippingClient.java:11",
    "PUT http://shipping-svc:9000/api/parcels/1 ShippingClient.relabel@ShippingClient.java:12",
    "POST http://shipping-svc:9000/cancellations ShippingClient.cancel@ShippingClient.java:13",
  ]);
});

test("a request whose base the snapshot does not decide still states the method and the path the code writes", async () => {
  const client = java(
    "OrdersClient",
    ["@Service class OrdersClient {", "  private final RestClient rest;", "  OrdersClient(RestClient.Builder builder, String base) { this.rest = builder.baseUrl(base).build(); }", "  String load() { return rest.get().uri(\"/orders/{id}\", 7).retrieve().body(String.class); }", "}"].join("\n"),
  );

  const [site] = await reader.of([client], "orders-svc");

  assert.equal(site?.target.status, "unknown");
  assert.deepEqual(site?.stated, { method: "GET", path: "/orders/{id}" });
});

test("a request whose method or path the snapshot does not decide states no request", async () => {
  const client = java(
    "OrdersClient",
    [
      "@Service class OrdersClient {",
      "  private final RestClient rest;",
      "  private HttpMethod chosen;",
      "  private String prefix;",
      "  OrdersClient(RestClient.Builder builder, String base) { this.rest = builder.baseUrl(base).build(); }",
      "  void send() { rest.method(chosen).uri(\"/orders\").retrieve(); }",
      "  void load() { rest.get().uri(String.format(\"%s/orders\", prefix)).retrieve(); }",
      "}",
    ].join("\n"),
  );

  const sites = await reader.of([client], "orders-svc");

  assert.deepEqual(sites.map((site) => [site.symbol, site.target.status, site.stated]), [["OrdersClient.send", "unknown", undefined], ["OrdersClient.load", "unknown", undefined]]);
});

test("a call to a wrapper whose client base the snapshot does not decide states the request its arguments write", async () => {
  const wrapper = java(
    "Gateway",
    ["@Service class Gateway {", "  private final RestClient rest;", "  Gateway(RestClient.Builder builder, String base) { this.rest = builder.baseUrl(base).build(); }", "  String fetch(String path) { return rest.get().uri(path).retrieve().body(String.class); }", "}"].join("\n"),
  );
  const caller = java("Reports", ["@Service class Reports {", "  private final Gateway gateway;", "  void load() { gateway.fetch(\"/reports/daily\"); }", "}"].join("\n"));

  const sites = await reader.of([wrapper, caller], "orders-svc");

  assert.deepEqual(sites.map((site) => [site.symbol, site.target.status, site.stated]), [["Reports.load", "unknown", { method: "GET", path: "/reports/daily" }]]);
});

test("a Feign client whose url the snapshot does not decide states the method and the path of each mapping", async () => {
  const feign = java(
    "StockClient",
    ["@FeignClient(name = \"stock-svc\", url = \"${stock.url}\", path = \"/stock\")", "interface StockClient {", "  @GetMapping(\"/items/{sku}\") String item(String sku);", "}"].join("\n"),
    ["org.springframework.cloud.openfeign.FeignClient", "org.springframework.web.bind.annotation.*"],
  );

  const [site] = await reader.of([feign], "orders-svc");

  assert.equal(site?.target.status, "unknown");
  assert.deepEqual(site?.stated, { method: "GET", path: "/stock/items/{sku}" });
});

test("a Feign client declares one call per mapped method: its url or service name leads, its path prefixes the mapping", async () => {
  const feign = java(
    "StockClient",
    [
      "@FeignClient(name = \"stock-svc\", path = \"/stock\")",
      "interface StockClient {",
      "  @GetMapping(\"/items/{sku}\") String item(String sku);",
      "  @RequestMapping(method = RequestMethod.POST, value = \"/reservations\") void reserve();",
      "}",
    ].join("\n"),
    ["org.springframework.cloud.openfeign.FeignClient", "org.springframework.web.bind.annotation.*"],
  );

  assert.deepEqual(await read([feign]), ["GET /stock/items/{sku} via stock-svc StockClient.item@StockClient.java:6", "POST /stock/reservations via stock-svc StockClient.reserve@StockClient.java:7"]);
});

test("an HttpExchange interface declares its calls with the verb of the annotation and the path of the type and the method", async () => {
  const exchange = java(
    "CatalogApi",
    [
      "@HttpExchange(\"/catalog\")",
      "interface CatalogApi {",
      "  @GetExchange(\"/products/{id}\") String product(String id);",
      "  @HttpExchange(method = \"DELETE\", url = \"/products/{id}\") void drop(String id);",
      "}",
    ].join("\n"),
    ["org.springframework.web.service.annotation.*"],
  );

  assert.deepEqual(await read([exchange]), ["GET /catalog/products/{id} CatalogApi.product@CatalogApi.java:5", "DELETE /catalog/products/{id} CatalogApi.drop@CatalogApi.java:6"]);
});

test("a URL names its host after `scheme://` or a bare `//`, whether a call or an HttpExchange type writes it", async () => {
  const client = java("CatalogClient", ["class CatalogClient {", "  RestTemplate rt;", "  void find() { rt.getForObject(\"//catalog-svc/products\", String.class); }", "}"].join("\n"));
  const exchange = java("CatalogApi", ["@HttpExchange(url = \"http://catalog-svc/catalog\")", "interface CatalogApi {", "  @GetExchange(\"/products\") String product();", "}"].join("\n"), ["org.springframework.web.service.annotation.*"]);

  assert.deepEqual(await read([client, exchange]), ["GET http://catalog-svc/catalog/products CatalogApi.product@CatalogApi.java:5", "GET //catalog-svc/products CatalogClient.find@CatalogClient.java:8"]);
});

test("a @Value placeholder is read from the configuration, its default applies when the key is absent, and a key without value is unknown", async () => {
  const client = java(
    "BillingClient",
    [
      "@Service class BillingClient {",
      "  @Value(\"${billing.url}\") private String url;",
      "  @Value(\"${billing.timeout-url:http://fallback-svc:80}\") private String fallback;",
      "  @Value(\"${billing.missing}\") private String missing;",
      "  private final RestTemplate rt;",
      "  void a() { rt.getForObject(url + \"/invoices\", String.class); }",
      "  void b() { rt.getForObject(fallback + \"/status\", String.class); }",
      "  void c() { rt.getForObject(missing + \"/status\", String.class); }",
      "}",
    ].join("\n"),
    [...WEB, "org.springframework.beans.factory.annotation.Value"],
  );
  const configuration = file(RESOURCES, "billing:\n  url: http://billing-svc:8080/api\n");

  assert.deepEqual(await read([client, configuration]), [
    "GET http://billing-svc:8080/api/invoices BillingClient.a@BillingClient.java:12",
    "GET http://fallback-svc:80/status BillingClient.b@BillingClient.java:13",
    "unknown BillingClient.c@BillingClient.java:14",
  ]);
});

test("a key that two profiles give different values is not decided", async () => {
  const client = java(
    "BillingClient",
    ["@Service class BillingClient {", "  @Value(\"${billing.url}\") private String url;", "  private final RestTemplate rt;", "  void a() { rt.getForObject(url + \"/invoices\", String.class); }", "}"].join("\n"),
    [...WEB, "org.springframework.beans.factory.annotation.Value"],
  );
  const base = file(RESOURCES, "billing.url: http://billing-svc:8080\n");
  const dev = file("src/main/resources/application-dev.yml", "billing.url: http://localhost:8081\n");

  assert.deepEqual(await read([client, base, dev]), ["unknown BillingClient.a@BillingClient.java:10"]);
});

test("an accessor of a @ConfigurationProperties object reads its prefix and property, nested objects included", async () => {
  const properties = java(
    "ClientProperties",
    ["@ConfigurationProperties(prefix = \"clients\")", "class ClientProperties {", "  private Billing billing;", "  Billing getBilling() { return billing; }", "  static class Billing { private String baseUrl; String getBaseUrl() { return baseUrl; } }", "}"].join("\n"),
    ["org.springframework.boot.context.properties.ConfigurationProperties"],
  );
  const client = java(
    "BillingClient",
    ["@Service class BillingClient {", "  private final ClientProperties properties;", "  private final RestTemplate rt;", "  void a() { rt.getForObject(properties.getBilling().getBaseUrl() + \"/invoices\", String.class); }", "}"].join("\n"),
  );
  const configuration = file(RESOURCES, "clients:\n  billing:\n    base-url: http://billing-svc:8080\n");

  assert.deepEqual(await read([properties, client, configuration]), ["GET http://billing-svc:8080/invoices BillingClient.a@BillingClient.java:9"]);
});

test("a part the code fills at run time is a parameter, and a URL that starts with one is unknown", async () => {
  const client = java(
    "BillingClient",
    [
      "@Service class BillingClient {",
      "  private static final String BASE = \"http://billing-svc:8080\";",
      "  private String unset;",
      "  private final RestTemplate rt;",
      "  void a(long id) { rt.getForObject(BASE + \"/invoices/\" + id + \"/lines\", String.class); }",
      "  void b() { rt.getForObject(unset + \"/invoices\", String.class); }",
      "}",
    ].join("\n"),
  );

  assert.deepEqual(await read([client]), ["GET http://billing-svc:8080/invoices/{}/lines BillingClient.a@BillingClient.java:10", "unknown BillingClient.b@BillingClient.java:11"]);
});

test("a method that forwards its parameter into a request is a wrapper: its callers are the call sites, and its own body is not", async () => {
  const wrapper = java(
    "Gateway",
    ["@Service class Gateway {", "  private final RestTemplate rt;", "  String fetch(String path) { return rt.getForObject(\"http://billing-svc:8080\" + path, String.class); }", "}"].join("\n"),
  );
  const caller = java("Reports", ["@Service class Reports {", "  private final Gateway gateway;", "  void load() { gateway.fetch(\"/reports/daily\"); }", "}"].join("\n"));

  assert.deepEqual(await read([wrapper, caller]), ["GET http://billing-svc:8080/reports/daily Reports.load@Reports.java:8"]);
});

test("a wrapper nothing in the snapshot calls stays a cut at its request", async () => {
  const wrapper = java(
    "Gateway",
    ["@Service class Gateway {", "  private final RestTemplate rt;", "  String fetch(String path) { return rt.getForObject(\"http://billing-svc:8080\" + path, String.class); }", "}"].join("\n"),
  );

  assert.deepEqual(await read([wrapper]), ["unknown Gateway.fetch@Gateway.java:8"]);
});

test("a call through a client type from a library whose source is not given is a cut naming the library", async () => {
  const client = java(
    "BillingClient",
    ["@Service class BillingClient {", "  private final AcmeRestClient acme;", "  private final Cache cache;", "  void a() { acme.execute(\"x\"); cache.get(\"x\"); }", "}"].join("\n"),
    [...WEB, "com.acme.http.AcmeRestClient", "com.acme.util.Cache"],
  );

  assert.deepEqual(await read([client]), ["unknown BillingClient.a@BillingClient.java:11 via com.acme.http.AcmeRestClient"]);
});

test("library summaries evaluate source return methods as well as direct parameters", async () => {
  const library = [
    file(
      "src/main/java/com/acme/http/AcmeRestClient.java",
      [
        "package com.acme.http;",
        "import org.springframework.web.client.RestTemplate;",
        "import org.springframework.beans.factory.annotation.Value;",
        "public class AcmeRestClient {",
        "  @Value(\"${acme.base}\") private String base;",
        "  private final RestTemplate rt;",
        "  public String get(String path) { return rt.getForObject(base + path, String.class); }",
        "  public String named(String key) { return rt.getForObject(lookup(key), String.class); }",
        "  private String lookup(String key) { return key; }",
        "}",
      ].join("\n"),
    ),
  ];
  const client = java(
    "BillingClient",
    ["@Service class BillingClient {", "  private final AcmeRestClient acme;", "  void a() { acme.get(\"/invoices\"); acme.named(\"k\"); }", "}"].join("\n"),
    [...WEB, "com.acme.http.AcmeRestClient"],
  );
  const configuration = file(RESOURCES, "acme.base: http://billing-svc:8080\n");

  assert.deepEqual(await read([client, configuration], library), ["GET http://billing-svc:8080/invoices BillingClient.a@BillingClient.java:9", "GET /k BillingClient.a@BillingClient.java:9"]);
});

test("test sources are not call sites", async () => {
  const test = file("src/test/java/app/BillingClientTest.java", "package app;\nimport org.springframework.web.client.RestTemplate;\nclass BillingClientTest { RestTemplate rt; void a() { rt.getForObject(\"http://x/y\", String.class); } }");

  assert.deepEqual(await read([test]), []);
});

test("a Java source the parser rejects is one unknown source-unreadable site at its fault line, and the other files are still read", async () => {
  const broken = java("Broken", ["class Broken {", "  void send( {", "}"].join("\n"));
  const client = java("BillingClient", ["class BillingClient {", "  RestTemplate rt;", "  void send() {", "    rt.getForObject(\"http://billing/orders\", String.class);", "  }", "}"].join("\n"));
  const library = java("Library", "class Library { void broken( }");
  const sites = await reader.of([broken, client], "orders-svc", [inLibrary(library)]);
  assert.deepEqual(sites.filter((site) => site.file === broken.path).map((site) => ({ symbol: site.symbol, transport: site.transport, target: site.target })), [
    { symbol: "Broken", transport: "http", target: { status: "unknown", reason: "source-unreadable", evidence: [{ path: broken.path, line: 7 }] } },
  ]);
  assert.deepEqual(sites.filter((site) => site.file !== broken.path).map((site) => site.file), [client.path]);
});

test("a Java source whose parsing throws is an unknown source-unreadable site at its first line", async () => {
  const base = await createJavaParser();
  const parser: JavaParser = { parse: (source) => { if (source.content.includes("Explodes")) throw new RangeError("Maximum call stack size exceeded"); return base.parse(source); } };
  const explodes = java("Explodes", "class Explodes {}");
  const sites = await createJavaHttpCallSites(parser).of([explodes], "orders-svc");
  assert.deepEqual(sites.map((site) => site.target), [{ status: "unknown", reason: "source-unreadable", evidence: [{ path: explodes.path, line: 1 }] }]);
});

test("source method summaries preserve argument scopes through multiple forwarding methods and cycles", async () => {
  const source = java("Flow", `class Flow {
    RestTemplate rt;
    void leaf(String url) { rt.getForObject(url, String.class); }
    void middle(String path) { leaf("http://catalog" + path); }
    void outer(String key) { middle(key); }
    void load() { String route = "/items"; outer(route); }
    void cycle(String key) { cycle(key); }
  }`);
  const sites = await reader.of([source], "service");
  assert.equal(sites.length, 1);
  assert.equal(sites[0]?.symbol, "Flow.load");
  assert.deepEqual(sites[0]?.target.status === "complete" && sites[0].target.value, { method: "GET", path: "http://catalog/items" });
});

test("interface dispatch evaluates all source implementations without selecting a disagreeing target", async () => {
  const source = java("Dispatch", `interface Gateway { void send(String path); }
    class First implements Gateway { RestTemplate rt; public void send(String path) { rt.getForObject("http://one" + path, String.class); } }
    class Second implements Gateway { RestTemplate rt; public void send(String path) { rt.getForObject("http://two" + path, String.class); } }
    class Dispatch { Gateway gateway; void load() { gateway.send("/items"); } }`);
  const sites = await reader.of([source], "service");
  assert.equal(sites.length, 1);
  assert.equal(sites[0]?.symbol, "Dispatch.load");
  assert.equal(sites[0]?.target.status, "unknown");
  assert.equal(sites[0]?.diagnostic?.cause, "dispatch-disagreement");
  assert.equal(sites[0]?.target.evidence.length, 3);
});

test("source constructors and Lombok builders retain distinct object fields for getters", async () => {
  const source = java("Objects", `@lombok.Builder @lombok.Data class Query { String host; String path; }
    class Explicit { String value; Explicit(String input) { this.value = input; } String getValue() { return value; } }
    class Objects { RestTemplate rt; void load() {
      Query query = Query.builder().host("http://catalog").path("/items").build();
      Explicit suffix = new Explicit("/details");
      rt.getForObject(query.getHost() + query.getPath() + suffix.getValue(), String.class);
    } }`);
  const sites = await reader.of([source], "service");
  assert.deepEqual(sites[0]?.target.status === "complete" && sites[0].target.value, { method: "GET", path: "http://catalog/items/details" });
});

test("Map configuration keys are evaluated through library arguments in the consuming module", async () => {
  const library = java("Gateway", `@org.springframework.boot.context.properties.ConfigurationProperties(prefix="clients")
    class Settings { java.util.Map<String, Endpoint> systems; }
    @lombok.Data class Endpoint { String url; }
    class Gateway { Settings config; RestTemplate rt;
      void send(String key) { Endpoint endpoint = config.getSystems().get(key); rt.getForObject(endpoint.getUrl(), String.class); }
    }`);
  const caller = java("Consumer", `class Consumer { Gateway gateway; void load() { gateway.send("catalog"); } }`);
  const sites = await reader.of([caller, file(RESOURCES, "clients.systems.catalog.url: http://catalog/items\n")], "service", [inLibrary(library)]);
  assert.equal(sites.length, 1);
  assert.deepEqual(sites[0]?.target.status === "complete" && sites[0].target.value, { method: "GET", path: "http://catalog/items" });
});

test("OkHttp newCall reads the standard Request builder URL and explicit or default method", async () => {
  const source = java("Http", `class Http { OkHttpClient client; void load() {
    Request request = new Request.Builder().url("http://catalog/items").method("PATCH", null).build();
    client.newCall(request).execute();
    client.newCall(new Request.Builder().url("http://catalog/default").build()).execute();
  } }`, ["okhttp3.OkHttpClient", "okhttp3.Request"]);
  const sites = await reader.of([source], "service");
  assert.deepEqual(sites.map((site) => site.target.status === "complete" && site.target.value), [
    { method: "PATCH", path: "http://catalog/items" },
    { method: "GET", path: "http://catalog/default" },
  ]);
});

test("source-proven setters update record fields before a getter reads them", async () => {
  const source = java("Mutation", `class Query {
    String path; void setPath(String input) { this.path = input; } String getPath() { return path; }
  }
  class Mutation { RestTemplate rt; void load() {
    Query query = new Query(); query.setPath("http://catalog/items");
    rt.getForObject(query.getPath(), String.class);
  } }`);
  const sites = await reader.of([source], "service");
  assert.deepEqual(sites[0]?.target.status === "complete" && sites[0].target.value, { method: "GET", path: "http://catalog/items" });
});

test("recursive client summaries retain an explicit unknown instead of disappearing", async () => {
  const source = java("Recursive", `class Recursive { RestTemplate rt;
    void send(String url) { send(url); rt.getForObject(url, String.class); }
  }`);
  const sites = await reader.of([source], "service");
  assert.ok(sites.length > 0);
  assert.ok(sites.every((site) => site.target.status === "unknown"));
  assert.ok(sites.some((site) => site.diagnostic?.cause === "recursive"));
});

test("configuration defaults apply only to absent keys and never to conflicting values", async () => {
  const source = java("Defaults", `class Defaults { RestTemplate rt;
    @Value("\u0024{remote:http://fallback}") String base;
    void load() { rt.getForObject(base + "/items", String.class); }
  }`, [...WEB, "org.springframework.beans.factory.annotation.Value"]);
  const absent = await reader.of([source], "service");
  const conflict = await reader.of([source, file(RESOURCES, "remote: http://one\n"), file("src/main/resources/application.properties", "remote=http://two\n")], "service");
  assert.equal(absent[0]?.target.status, "complete");
  assert.equal(conflict[0]?.target.status, "unknown");
});

test("a source URL helper follows a proven null fallback and a single array element into HttpUrl", async () => {
  const source = java("UrlHelper", `@lombok.Builder @lombok.Data class Query { String staticUrl; }
    class UrlHelper { OkHttpClient client;
      HttpUrl compose(Query query, String configured) { return render(query, configured); }
      HttpUrl render(Query query, String configured) {
        String[] rendered = { query.getStaticUrl() != null ? query.getStaticUrl() : configured };
        HttpUrl.Builder builder = HttpUrl.parse(rendered[0]).newBuilder(); return builder.build();
      }
      void load() { Query query = Query.builder().build();
        HttpUrl url = compose(query, "http://catalog/items");
        client.newCall(new Request.Builder().url(url).build());
      }
    }`, ["okhttp3.OkHttpClient", "okhttp3.Request", "okhttp3.HttpUrl"]);
  const sites = await reader.of([source], "service");
  assert.deepEqual(sites[0]?.target.status === "complete" && sites[0].target.value, { method: "GET", path: "http://catalog/items" });
});

test("a run-time null check in the destination stays unknown and names the value its decided branch declares", async () => {
  const source = java("UrlHelper", `@lombok.Builder @lombok.Data class Query { String staticUrl; }
    interface Photos { String uri(); }
    class UrlHelper { OkHttpClient client; Photos photos;
      void load(String configured) {
        Query query = Query.builder().staticUrl(photos.uri()).build();
        String rendered = query.getStaticUrl() != null ? query.getStaticUrl() : "http://catalog/items";
        client.newCall(new Request.Builder().url(rendered).build());
      }
    }`, ["okhttp3.OkHttpClient", "okhttp3.Request"]);
  const [site] = await reader.of([source], "service");
  assert.equal(site?.target.status, "unknown");
  assert.deepEqual(site?.diagnostic, { cause: "destination-undecidable", alternatives: ["http://catalog/items"] });
  assert.ok(site?.target.evidence.some(({ line }) => line === 9));
});

test("a qualifier selects the implementation constructed by a named source Bean", async () => {
  const source = java("Selection", `interface Gateway { void send(String path); }
    class One implements Gateway { RestTemplate rt; public void send(String path) { rt.getForObject("http://one" + path, String.class); } }
    class Two implements Gateway { RestTemplate rt; public void send(String path) { rt.getForObject("http://two" + path, String.class); } }
    class Wiring { @org.springframework.context.annotation.Bean(name="chosen") Gateway gateway() { return new Two(); } }
    class Selection { @org.springframework.beans.factory.annotation.Qualifier("chosen") Gateway gateway;
      void load() { gateway.send("/items"); }
    }`);
  const sites = await reader.of([source], "service");
  const site = sites.find((site) => site.symbol === "Selection.load");
  assert.deepEqual(site?.target.status === "complete" && site.target.value, { method: "GET", path: "http://two/items" });
});

test("escaped mutable records never retain stale constructor, builder or setter fields", async () => {
  for (const setup of ['Query query = new Query(); query.setPath("/items");', 'Query query = new Query("/items");', 'Query query = Query.builder().path("/items").build();']) {
    const source = java("Probe", `@lombok.Builder class Query {
      String path; Query() {} Query(String path) { this.path = path; }
      void setPath(String path) { this.path = path; } String getPath() { return path; }
    }
    class Probe { RestTemplate rt;
      void retarget(Query q) { mutate(q); }
      void mutate(Query q) { q.setPath("/admin"); }
      void load() { ${setup} retarget(query); rt.getForObject("http://catalog" + query.getPath(), String.class); }
    }`);
    const sites = await reader.of([source], "service");
    assert.equal(sites.find((site) => site.symbol === "Probe.load")?.target.status, "unknown");
  }
});

test("aliases and shared mutable fields cannot establish an object value", async () => {
  for (const setup of ['Query query = new Query("/items"); Query alias = query; alias.setPath("/admin");', 'Query query = saved;']) {
    const source = java("Probe", `class Query { String path; Query(String path) { this.path = path; }
      void setPath(String path) { this.path = path; } String getPath() { return path; } }
      class Probe { RestTemplate rt; Query saved = new Query("/items");
        void retarget() { saved.setPath("/admin"); }
        void load() { ${setup} rt.getForObject("http://catalog" + query.getPath(), String.class); }
      }`);
    assert.equal((await reader.of([source], "service")).find((site) => site.symbol === "Probe.load")?.target.status, "unknown");
  }
});

test("instance field writes outside constructors never establish scalar values", async () => {
  const source = java("Probe", `class Probe { RestTemplate rt; String path;
    void retarget() { path = "/admin"; }
    void load() { rt.getForObject("http://catalog" + path, String.class); }
  }`);
  assert.equal((await reader.of([source], "service"))[0]?.target.status, "unknown");
});

test("dispatch disagreement invalidates only its own output", async () => {
  const source = java("Probe", `interface G { void send(String p); }
    class A implements G { RestTemplate rt; public void send(String p) { rt.getForObject("http://one" + p, String.class); } }
    class B implements G { RestTemplate rt; public void send(String p) { rt.getForObject("http://two" + p, String.class); } }
    class W { G g; RestTemplate rt;
      void all(String p) { rt.getForObject("http://stable" + p, String.class); g.send(p); }
    }
    class Probe { W w; void load() { w.all("/items"); } }`);
  const sites = await reader.of([source], "service");
  assert.equal(sites.length, 2);
  assert.equal(sites.filter((site) => site.target.status === "unknown").length, 1);
  assert.deepEqual(sites.find((site) => site.target.status === "complete")?.target.status === "complete", true);
});

test("deep source return evaluation degrades to unknown on stack exhaustion", async () => {
  const methods = Array.from({ length: 3000 }, (_, index) => `String value${index}() { return value${index + 1}(); }`).join("\n");
  const source = java("Deep", `class Deep { RestTemplate rt; ${methods}
    String value3000() { return "http://catalog/items"; }
    void load() { rt.getForObject(value0(), String.class); }
  }`);
  const sites = await reader.of([source], "service");
  assert.equal(sites.find((site) => site.symbol === "Deep.load")?.target.status, "unknown");
});

test("inherited mutable fields prevent an empty subclass from proving immutability", async () => {
  const source = java("Probe", `class Base { String path; void setPath(String path) { this.path = path; } String getPath() { return path; } }
    class Query extends Base { Query(String path) { this.path = path; } }
    class Probe { RestTemplate rt; void mutate(Query q) { q.setPath("/admin"); }
      void load() { Query query = new Query("/items"); mutate(query); rt.getForObject("http://catalog" + query.getPath(), String.class); }
    }`);
  assert.equal((await reader.of([source], "service"))[0]?.target.status, "unknown");
});

test("shared mutable objects cannot recover field defaults through a source getter", async () => {
  const source = java("Probe", `class Query { String path = "/items"; String getPath() { return path; } }
    class Probe { RestTemplate rt; Query query;
      void retarget() { query.path = "/admin"; }
      void load() { retarget(); rt.getForObject("http://catalog" + query.getPath(), String.class); }
    }`);
  assert.equal((await reader.of([source], "service"))[0]?.target.status, "unknown");
});

test("each request a wrapper call reaches names the library of its own request, not of another one", async () => {
  const caller = java("Caller", `class Caller { Helper helper; void load() { helper.send(); } }
    class Helper { RestTemplate rt; String url; AcmeRestClient client; void send() { rt.getForObject(url, String.class); client.get(); } }`, [...WEB, "com.acme.AcmeRestClient"]);
  const library = inLibrary(file("src/main/java/com/acme/AcmeRestClient.java", 'package com.acme; import org.springframework.web.client.RestTemplate; public class AcmeRestClient { RestTemplate rt; String url; public void get() { rt.getForObject(url, String.class); } }'));
  const sites = (await reader.of([caller], "app", [library])).filter((site) => site.symbol === "Caller.load");
  const throughLibrary = sites.filter((site) => site.target.evidence.some((place) => place.path.startsWith("(library)/")));
  const owned = sites.filter((site) => !throughLibrary.includes(site));
  assert.equal(throughLibrary.length, 1);
  assert.equal(owned.length, 1);
  assert.equal(throughLibrary[0]?.diagnostic?.source, "read");
  assert.equal(throughLibrary[0]?.target.evidence[0]?.via, "com.acme.AcmeRestClient");
  assert.equal(owned[0]?.diagnostic?.source, undefined);
  assert.equal(owned[0]?.target.evidence[0]?.via, undefined);
});

test("HTTP diagnostics distinguish a missing wrapper from a read wrapper with an undecidable destination", async () => {
  const caller = java("Caller", 'class Caller { AcmeRestClient client; void load() { client.get(); } }', [...WEB, "com.acme.AcmeRestClient"]);
  const library = inLibrary(file("src/main/java/com/acme/AcmeRestClient.java", 'package com.acme; import org.springframework.web.client.RestTemplate; public class AcmeRestClient { RestTemplate rt; String url; public void get() { rt.getForObject(url, String.class); } }'));
  const [missing] = await reader.of([caller], "app");
  const [read] = await reader.of([caller], "app", [library]);
  assert.deepEqual(missing?.diagnostic, { cause: "source-not-read", source: "not-read" });
  assert.deepEqual(read?.diagnostic, { cause: "destination-undecidable", source: "read" });
  assert.equal(read?.target.status, "unknown");
  assert.ok(read?.target.evidence.some(e => e.path.includes("(library)")));
  assert.equal(read?.target.evidence[0]?.via, "com.acme.AcmeRestClient");
});

test("HTTP diagnostics distinguish a read wrapper without a recognized request", async () => {
  const caller = java("Caller", 'class Caller { AcmeRestClient client; void load() { client.get(); } }', [...WEB, "com.acme.AcmeRestClient"]);
  const library = inLibrary(file("src/main/java/com/acme/AcmeRestClient.java", 'package com.acme; public class AcmeRestClient { public void get() {} }'));
  const [site] = await reader.of([caller], "app", [library]);
  assert.deepEqual(site?.diagnostic, { cause: "request-not-found", source: "read" });
  assert.ok(site?.target.evidence.some(e => e.path.includes("(library)")));
});

test("an unreadable library is reported as context without claiming it declares the missing wrapper", async () => {
  const caller = java("Caller", 'class Caller { AcmeRestClient client; void load() { client.get(); } }', [...WEB, "com.acme.AcmeRestClient"]);
  const library = inLibrary(file("src/Broken.java", "class Broken { !!!"));
  const [site] = await reader.of([caller], "app", [library]);
  assert.equal(site?.diagnostic?.cause, "source-not-read");
  assert.deepEqual(site?.diagnostic?.unreadableSources?.map(e => e.path), ["(library)/lib/src/Broken.java"]);
});

test("a client base the snapshot does not decide keeps the request the code writes, with the base's own cause", async () => {
  const source = java("Reports", `@Service class Reports {
      private final RestClient rest;
      Reports(RestClient.Builder builder) { this.rest = builder.baseUrl(loop()).build(); }
      String loop() { return loop(); }
      void load() { rest.get().uri("/reports/daily").retrieve().body(String.class); }
    }`);
  const [site] = await reader.of([source], "app");
  assert.deepEqual([site?.target.status, site?.stated, site?.diagnostic?.cause], ["unknown", { method: "GET", path: "/reports/daily" }, "recursive"]);
});

test("URL value diagnostics retain recursion and disagreement inside source return methods", async () => {
  const source = java("Values", `interface Base { String url(); }
    class First implements Base { public String url() { return "http://one/items"; } }
    class Second implements Base { public String url() { return "http://two/items"; } }
    class Values { RestTemplate rt; Base base;
      String loop() { return loop(); }
      void recursive() { rt.getForObject(loop(), String.class); }
      void different() { rt.getForObject(base.url(), String.class); }
    }`);
  const sites = await reader.of([source], "app");
  assert.equal(sites.find(s => s.symbol === "Values.recursive")?.diagnostic?.cause, "recursive");
  assert.equal(sites.find(s => s.symbol === "Values.different")?.diagnostic?.cause, "dispatch-disagreement");
  for (const site of sites) assert.ok(site.target.evidence.some(e => e.line !== site.line));
});

test("library evidence binds equal relative paths to their repository", async () => {
  const caller = java("Caller", 'class Caller { FirstClient first; SecondClient second; void load() { first.get(); second.get(); } }', [...WEB, "one.FirstClient", "two.SecondClient"]);
  const libraries = [
    { path: "src/Client.java", content: 'package one; import org.springframework.web.client.RestTemplate; public class FirstClient { RestTemplate rt; public void get() { rt.getForObject("http://one/items", String.class); } }', repo: "first/lib" },
    { path: "src/Client.java", content: 'package two; import org.springframework.web.client.RestTemplate; public class SecondClient { RestTemplate rt; public void get() { rt.getForObject("http://two/items", String.class); } }', repo: "second" },
  ];
  const sites = await reader.of([caller], "app", libraries);
  assert.equal(sites.length, 2);
  assert.ok(sites.every(s => s.target.status === "complete"));
  assert.deepEqual([...new Set(sites.flatMap(s => s.target.evidence.map(e => e.path).filter(path => path.startsWith("(library)/"))))].sort(), [
    "(library)/first%2Flib/src/Client.java",
    "(library)/second/src/Client.java",
  ]);
});
