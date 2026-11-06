import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorkspaceEvidence } from "./outward-names.adapter.ts";

const evidence = createWorkspaceEvidence();

function names(files: { path: string; content: string }[]): string[] {
  return evidence.names(files).map((name) => `${name.kind} ${name.name}@${name.evidence[0]?.line}`);
}

test("a URL a service configuration declares is an outward name at the line that writes it", () => {
  const config = ["spring:", "  clients:", "    systems:", "      orders:", "        endpoints:", "          getOrder:", "            url: http://orders-svc.b2c:8080/orders/{id}", "            method: GET"].join("\n");

  assert.deepEqual(names([{ path: "src/main/resources/application.yaml", content: config }]), ["configuration-url http://orders-svc.b2c:8080/orders/{id}@7"]);
});

test("a properties document names its URLs the same way, and a value that is not an absolute URL is not a name", () => {
  const config = ["external.url=http://events-svc:9000/publish", "local.url=/relative/path"].join("\n");

  assert.deepEqual(names([{ path: "src/main/resources/application.properties", content: config }]), ["configuration-url http://events-svc:9000/publish@1"]);
});

test("a coordinate a Maven or npm manifest depends on is an outward name, with the group when it declares one", () => {
  const pom = ["<project>", "  <dependencies>", "    <dependency>", "      <groupId>com.shop</groupId>", "      <artifactId>events-lib</artifactId>", "      <version>1.0.0</version>", "    </dependency>", "  </dependencies>", "</project>"].join("\n");
  const manifest = JSON.stringify({ name: "shop-web", dependencies: { "@shop/ui-kit": "1.0.0" } }, null, 2);

  assert.deepEqual(names([{ path: "pom.xml", content: pom }, { path: "package.json", content: manifest }]), ["dependency @shop/ui-kit@4", "dependency com.shop:events-lib@3"]);
});

test("a dependency is named by its own coordinates, never by those of an exclusion it declares", () => {
  const pom = ["<project>", "  <dependencies>", "    <dependency>", "      <groupId>com.shop</groupId>", "      <artifactId>events-lib</artifactId>", "      <exclusions>", "        <exclusion>", "          <groupId>org.crypto</groupId>", "          <artifactId>provider</artifactId>", "        </exclusion>", "      </exclusions>", "    </dependency>", "  </dependencies>", "</project>"].join("\n");

  assert.deepEqual(names([{ path: "pom.xml", content: pom }]), ["dependency com.shop:events-lib@3"]);
});

test("a registry a Maven build declares is an outward name by its host", () => {
  const pom = ["<project>", "  <repositories>", "    <repository>", "      <id>shop</id>", "      <url>https://packages.example.com/repository/maven</url>", "    </repository>", "  </repositories>", "</project>"].join("\n");

  assert.deepEqual(names([{ path: "pom.xml", content: pom }]), ["registry https://packages.example.com@3"]);
});

test("the artifact a repository declares as its own is read outside its parent block", () => {
  const pom = ["<project>", "  <parent>", "    <groupId>com.shop</groupId>", "    <artifactId>library-parent</artifactId>", "  </parent>", "  <groupId>com.shop</groupId>", "  <artifactId>events-lib</artifactId>", "</project>"].join("\n");

  assert.deepEqual(evidence.artifacts([{ path: "pom.xml", content: pom }]), ["com.shop:events-lib"]);
});

test("the artifact a repository declares as its own ignores the coordinates of its dependencies and plugins", () => {
  const pom = ["<project>", "  <groupId>com.shop</groupId>", "  <artifactId>orders-svc</artifactId>", "  <dependencies>", "    <dependency>", "      <groupId>com.shop</groupId>", "      <artifactId>events-lib</artifactId>", "    </dependency>", "  </dependencies>", "  <build>", "    <plugins>", "      <plugin>", "        <groupId>org.tools</groupId>", "        <artifactId>mutation-plugin</artifactId>", "      </plugin>", "    </plugins>", "  </build>", "</project>"].join("\n");

  assert.deepEqual(evidence.artifacts([{ path: "pom.xml", content: pom }]), ["com.shop:orders-svc"]);
});
