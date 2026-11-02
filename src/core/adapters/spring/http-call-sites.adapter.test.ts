import { before, test } from "node:test";
import assert from "node:assert/strict";
import type { CallSite, CallSiteReader } from "../../domain/topology/call-site.ts";
import { createJavaParser } from "../tree-sitter/java-parser.adapter.ts";
import { createJavaHttpCallSites } from "./java-call-sites.adapter.ts";

const WEB = ["org.springframework.web.client.RestTemplate", "org.springframework.web.client.RestClient", "org.springframework.http.HttpMethod", "org.springframework.stereotype.Service"];
const RESOURCES = "src/main/resources/application.yml";

let reader: CallSiteReader;

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

async function read(files: readonly { path: string; content: string }[], libraries: readonly { path: string; content: string }[] = []): Promise<string[]> {
  return describe(await reader.of(files, "orders-svc", libraries));
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
    "GET /invoices/{} via http://billing-svc:8080 BillingClient.find@BillingClient.java:9",
    "POST /payments via http://billing-svc:8080 BillingClient.pay@BillingClient.java:10",
    "DELETE /payments/7 via http://billing-svc:8080 BillingClient.drop@BillingClient.java:11",
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
    "GET /api/parcels/{id} via http://shipping-svc:9000 ShippingClient.track@ShippingClient.java:11",
    "PUT /api/parcels/1 via http://shipping-svc:9000 ShippingClient.relabel@ShippingClient.java:12",
    "POST /cancellations via http://shipping-svc:9000 ShippingClient.cancel@ShippingClient.java:13",
  ]);
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
    "GET /api/invoices via http://billing-svc:8080 BillingClient.a@BillingClient.java:12",
    "GET /status via http://fallback-svc:80 BillingClient.b@BillingClient.java:13",
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

  assert.deepEqual(await read([properties, client, configuration]), ["GET /invoices via http://billing-svc:8080 BillingClient.a@BillingClient.java:9"]);
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

  assert.deepEqual(await read([client]), ["GET /invoices/{}/lines via http://billing-svc:8080 BillingClient.a@BillingClient.java:10", "unknown BillingClient.b@BillingClient.java:11"]);
});

test("a method that forwards its parameter into a request is a wrapper: its callers are the call sites, and its own body is not", async () => {
  const wrapper = java(
    "Gateway",
    ["@Service class Gateway {", "  private final RestTemplate rt;", "  String fetch(String path) { return rt.getForObject(\"http://billing-svc:8080\" + path, String.class); }", "}"].join("\n"),
  );
  const caller = java("Reports", ["@Service class Reports {", "  private final Gateway gateway;", "  void load() { gateway.fetch(\"/reports/daily\"); }", "}"].join("\n"));

  assert.deepEqual(await read([wrapper, caller]), ["GET /reports/daily via http://billing-svc:8080 Reports.load@Reports.java:8"]);
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

test("a library whose source is given is read through its wrappers; a method that forwards no parameter stays a cut", async () => {
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

  assert.deepEqual(await read([client, configuration], library), ["GET /invoices via http://billing-svc:8080 BillingClient.a@BillingClient.java:9", "unknown BillingClient.a@BillingClient.java:9 via com.acme.http.AcmeRestClient"]);
});

test("test sources are not call sites", async () => {
  const test = file("src/test/java/app/BillingClientTest.java", "package app;\nimport org.springframework.web.client.RestTemplate;\nclass BillingClientTest { RestTemplate rt; void a() { rt.getForObject(\"http://x/y\", String.class); } }");

  assert.deepEqual(await read([test]), []);
});
