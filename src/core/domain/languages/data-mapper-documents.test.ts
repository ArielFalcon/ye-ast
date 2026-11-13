import { test } from "node:test";
import assert from "node:assert/strict";
import { isMapperDocument } from "./data-mapper-documents.ts";

test("a mapper document is an XML file under a module's main sources or resources; test resources and a look-alike root are not", () => {
  assert.equal(isMapperDocument("src/main/resources/mapper/UserMapper.xml"), true);
  assert.equal(isMapperDocument("orders/src/main/java/shop/mapper/UserMapper.xml"), true);
  assert.equal(isMapperDocument("src/test/resources/mapper/UserMapper.xml"), false);
  assert.equal(isMapperDocument("docs/src/main-notes/mapper/UserMapper.xml"), false);
  assert.equal(isMapperDocument("src/main/resources/mapper/UserMapper.yml"), false);
});
