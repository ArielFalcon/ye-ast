import assert from "node:assert/strict";
import test from "node:test";
import { callUrl, joinedCallUrl, RUN_TIME_HOLE } from "./path-template.ts";

test("a call URL names its origin after a scheme or a bare `//`, up to the path, the query, the fragment or a value the code fills", () => {
  assert.deepEqual(
    ["https://shop:8443/api//orders?page=2#top", "//shop/orders", `http://${RUN_TIME_HOLE}/orders`, `http://shop:8080${RUN_TIME_HOLE}`, "orders/7?x=1", "/a/http://b"].map(callUrl),
    [
      { origin: "https://shop:8443", path: "/api/orders" },
      { origin: "//shop", path: "/orders" },
      { origin: "http://", path: `/${RUN_TIME_HOLE}/orders` },
      { origin: "http://shop:8080", path: `/${RUN_TIME_HOLE}` },
      { path: "/orders/7" },
      { path: "/a/http:/b" },
    ],
  );
});

test("URL parts joined one after another keep the last origin a part names, with the path that follows it", () => {
  assert.deepEqual(joinedCallUrl("http://shop/api/", "/orders", "7"), { origin: "http://shop", path: "/api/orders/7" });
  assert.deepEqual(joinedCallUrl("/api", "http://billing/v1", "invoices"), { origin: "http://billing", path: "/v1/invoices" });
  assert.deepEqual(joinedCallUrl("", "/orders"), { path: "/orders" });
});
