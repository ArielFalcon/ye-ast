import { test } from "node:test";
import assert from "node:assert/strict";
import { repositoryCatalog } from "./repository-targeting.ts";

const launch = { path: "/one", repoId: "one" };

test("catalog coalesces identical entries and rejects conflicting IDs or roots", () => {
  const duplicate = repositoryCatalog(launch, [launch, { path: "/two", repoId: "constructor" }]);
  assert.equal(duplicate.valid, true);
  assert.deepEqual(duplicate.available, ["constructor", "one"]);
  assert.deepEqual(duplicate.resolve("constructor"), { ok: true, value: { path: "/two", repoId: "constructor" } });
  assert.equal(repositoryCatalog(launch, [{ path: "/two", repoId: "one" }]).valid, false);
  assert.equal(repositoryCatalog(launch, [{ path: "/one", repoId: "other" }]).valid, false);
  assert.equal(repositoryCatalog(launch, [{ path: "", repoId: "other" }]).valid, false);
});

test("ambiguous and unknown IDs cannot fall back to the launch repository", () => {
  const catalog = repositoryCatalog(launch, [{ path: "/two", repoId: "one" }]);
  const ambiguous = catalog.resolve("one");
  const unknown = catalog.resolve("One");
  assert.equal(!ambiguous.ok && ambiguous.fault.kind, "ambiguous-repository");
  assert.equal(!unknown.ok && unknown.fault.kind, "unknown-repository");
});

test("catalog copies inputs and returned bindings so host changes cannot retarget it", () => {
  const binding = { path: "/two", repoId: "two" };
  const list = [binding];
  const catalog = repositoryCatalog(launch, list);
  binding.path = "/changed";
  list.push({ path: "/three", repoId: "three" });
  const first = catalog.resolve("two");
  assert.ok(first.ok);
  first.value.path = "/altered";
  assert.deepEqual(catalog.resolve("two"), { ok: true, value: { path: "/two", repoId: "two" } });
  const unknown = catalog.resolve("three");
  assert.equal(!unknown.ok && unknown.fault.kind, "unknown-repository");
});
