import { test } from "node:test";
import assert from "node:assert/strict";
import { answerPointer, delivered, envelopeText, RESULT_META, unnamedRootLines } from "./envelope.ts";
import type { SemanticQuery } from "../query-schema.ts";

const declared = [{ repoId: "shop", path: "/work/shop" }];
const query = (workspace?: unknown): SemanticQuery => ({ name: "ye_ast_callers", arguments: { targets: [], ...(workspace === undefined ? {} : { workspace }) } }) as unknown as SemanticQuery;

test("the pointer is the folder's last three segments, never the host path", () => {
  assert.equal(answerPointer("/home/dev/.cache/ye-ast/answers/trace/abc"), "answer: answers/trace/abc/answer.json");
  assert.equal(answerPointer("C:\\cache\\answers\\trace\\abc"), "answer: answers/trace/abc/answer.json");
});

test("a root line is printed for a clone the instructions and the request both left unnamed", () => {
  const roots = [{ repo: "shop", path: "/work/shop" }, { repo: "shop", path: "/other/shop" }, { repo: "web", path: "/clones/web" }, { repo: "api", path: "/clones/api-clone" }, { repo: "persisted", path: "/clones/p" }];
  const lines = unnamedRootLines(roots, declared, query({ repos: [{ path: "/clones/web" }, { path: "/x/y", id: "api" }] }));
  assert.deepEqual(lines, ["repository root: shop -> /other/shop", "repository root: persisted -> /clones/p"]);
  assert.deepEqual(unnamedRootLines(undefined, declared, query()), []);
});

test("the text is lead, body, roots and closing line; the result fields ride in _meta beside the siblings", () => {
  assert.equal(envelopeText({ lead: ["stale: x"], body: "status: complete", roots: ["repository root: a -> /a"], closing: "answer: answers/t/k/answer.json" }), "stale: x\nstatus: complete\nrepository root: a -> /a\nanswer: answers/t/k/answer.json");
  const result = delivered("text", { mode: "summary" }, { sibling: 1 });
  assert.deepEqual(result, { content: [{ type: "text", text: "text" }], _meta: { sibling: 1, [RESULT_META]: { mode: "summary" } } });
});
