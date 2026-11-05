import { test } from "node:test";
import assert from "node:assert/strict";
import type { ContractData, ContractOperation } from "../contracts/contract-operation.ts";
import type { Finding } from "../shared/fact.ts";
import { changedContracts } from "./changed-contracts.ts";

const DOCUMENT = "openapi/api.yaml";

function operation(name: string, data: Partial<ContractData> = {}, line = 5): Finding<ContractOperation> {
  const [method, path] = name.split(" ") as ["GET", string];
  const value: ContractOperation = { operationId: undefined, method, path, basePath: "", document: DOCUMENT, line, data: { request: "q", response: "r", files: [], unresolved: [], ...data } };
  return { status: "complete", value, evidence: [{ path: DOCUMENT, line }] };
}

const touched = (...paths: string[]) => (path: string) => paths.includes(path);
const summary = (changes: ReturnType<typeof changedContracts>["changes"]) => changes.map((change) => [change.change, `${change.method} ${change.path}`, change.parts]);

test("an operation only the head declares is added, one only the base declares is removed, and one whose data differs is altered on that side", () => {
  const base = [operation("GET /orders"), operation("POST /orders"), operation("GET /old"), operation("GET /same")];
  const head = [operation("GET /orders", { response: "r2" }), operation("POST /orders", { request: "q2" }), operation("GET /new"), operation("GET /same", {}, 40)];

  const { changes, cuts } = changedContracts(base, head, touched(DOCUMENT));

  assert.deepEqual(summary(changes), [
    ["added", "GET /new", undefined],
    ["removed", "GET /old", undefined],
    ["altered", "GET /orders", ["response"]],
    ["altered", "POST /orders", ["request"]],
  ]);
  assert.deepEqual(cuts, []);
});

test("an operation is reported only when the change touched its document or a file its data reaches", () => {
  const reaching = { files: ["openapi/schemas/money.yaml"] };
  const base = [operation("GET /orders", reaching), operation("GET /items")];
  const head = [operation("GET /orders", { ...reaching, response: "r2" }), operation("GET /items", { response: "r2" })];

  assert.deepEqual(summary(changedContracts(base, head, touched("openapi/schemas/money.yaml")).changes), [["altered", "GET /orders", ["response"]]]);
});

test("a reference the reader could not follow cuts the answer only when the change touched its document or the file it names", () => {
  const unresolved = { unresolved: [{ ref: "schemas/money.yaml#/Money", file: "openapi/schemas/money.yaml" }] };
  const unchanged = [operation("GET /orders", unresolved)];

  assert.deepEqual(changedContracts(unchanged, unchanged, touched(DOCUMENT)).cuts, [{ kind: "unresolved-link", at: [`${DOCUMENT}:5 schemas/money.yaml#/Money`] }]);
  assert.deepEqual(changedContracts(unchanged, unchanged, touched("openapi/schemas/money.yaml")).cuts, [{ kind: "unresolved-link", at: [`${DOCUMENT}:5 schemas/money.yaml#/Money`] }]);
  assert.deepEqual(changedContracts(unchanged, unchanged, touched("src/Other.java")).cuts, []);
});

test("a touched document the reader could not parse cuts the answer at it instead of reading as unchanged", () => {
  const unreadable: Finding<ContractOperation> = { status: "unknown", reason: "source-unreadable", evidence: [{ path: DOCUMENT, line: 3 }] };

  assert.deepEqual(changedContracts([operation("GET /orders")], [unreadable], touched(DOCUMENT)), {
    changes: [{ change: "removed", method: "GET", path: "/orders", document: DOCUMENT, line: 5 }],
    cuts: [{ kind: "no-extractor", at: [DOCUMENT] }],
  });
  assert.deepEqual(changedContracts([unreadable], [unreadable], touched("src/Other.java")).cuts, []);
});
