import assert from "node:assert/strict";
import test from "node:test";
import { formatAccessPath } from "../../domain/contracts/access-path.ts";
import { deriveChanges } from "../../domain/contracts/shape-derivation.ts";
import type { KnownShape, OperationRequest, OperationShape, Shape } from "../../domain/contracts/payload-shape.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import { createPayloadShapes } from "./payload-shapes.adapter.ts";

const shapes = createPayloadShapes();

const response = (schema: unknown) => ({ description: "ok", content: { "application/json": { schema } } });
const operation = (responses: unknown) => ({ get: { operationId: "list", responses } });

function document(schemas: Record<string, unknown>, responses: unknown = { "200": response({ $ref: "#/components/schemas/Root" }) }): SourceFile {
  return { path: "api/openapi.yml", content: JSON.stringify({ openapi: "3.0.3", paths: { "/pets": operation(responses) }, components: { schemas } }) };
}

function rootOf(files: SourceFile[]): OperationShape {
  const [finding] = shapes.responses(files);
  assert.equal(finding?.status, "complete");
  return (finding as { value: OperationShape }).value;
}

const known = (shape: Shape): KnownShape => {
  assert.equal(shape.kind, "known");
  return shape as KnownShape;
};
const property = (shape: Shape, name: string) => known(shape).object!.properties.find((candidate) => candidate.name === name)!;
const STRING = { type: "string" };

test("a schema is read as the value set of each place, its properties sorted with their required flag", () => {
  const operationShape = rootOf([document({ Root: { type: "object", required: ["name"], properties: { zip: STRING, name: STRING, age: { type: "integer" } } } })]);
  const root = known(operationShape.shape);
  assert.deepEqual(root.values, { literals: { boolean: [], number: [], string: [] }, array: false, object: true, null: false, absent: false });
  assert.deepEqual(root.object!.properties.map(({ name, required }) => [name, required]), [["age", false], ["name", true], ["zip", false]]);
  assert.deepEqual(known(property(root, "age").shape).values.literals, { boolean: [], number: "every", string: [] });
  assert.deepEqual([operationShape.operationId, operationShape.method, operationShape.path, operationShape.basePath, operationShape.files], ["list", "GET", "/pets", "", ["api/openapi.yml"]]);
});

test("keywords constrain together: nullable and an enumeration restrict their own type, and only the listed literals of the type remain", () => {
  const root = rootOf([document({ Root: { type: "object", properties: { kind: { type: "string", enum: ["b", "a", "a", 1] }, city: { type: "string", nullable: true }, size: { type: "integer", enum: [2, 1] }, either: { type: ["string", "null"] } } } })]).shape;
  const values = (name: string) => known(property(root, name).shape).values;
  assert.deepEqual(values("kind").literals, { boolean: [], number: [], string: ["a", "b"] });
  assert.equal(values("city").null, true);
  assert.equal(values("kind").null, false);
  assert.deepEqual(values("size").literals.number, [1, 2]);
  assert.equal(values("either").null, true);
});

test("the keywords a value set does not state are kept at their place, extensions included and documentation left out, and a place without them carries none", () => {
  const root = rootOf([document({ Root: { type: "object", properties: { name: { type: "string", maxLength: 3, pattern: "^a", readOnly: true, default: "a", description: "d", title: "t", example: "x", "x-tag": 1, "x-nullable": true }, plain: STRING } } })]).shape;
  assert.deepEqual(known(property(root, "name").shape).keywords, { default: "a", maxLength: 3, pattern: "^a", readOnly: true, "x-tag": 1 });
  assert.equal("keywords" in known(property(root, "plain").shape), false);
});

test("an allOf keeps the keywords of the schema that holds it and of every branch, each value once and every distinct value of one keyword listed", () => {
  const root = known(rootOf([document({ Root: { allOf: [{ $ref: "#/components/schemas/Base" }, { type: "object", minProperties: 1, properties: { name: STRING } }], readOnly: true }, Base: { type: "object", minProperties: 2, deprecated: true, properties: { id: STRING } } })]).shape);
  assert.deepEqual(root.keywords, { deprecated: true, minProperties: [1, 2], readOnly: true });
});

test("the digests of an operation change exactly with its request, its non-success responses, and its success responses' status, media types and headers, never with its success schema", () => {
  const read = (operationOf: (schema: unknown) => Record<string, unknown>, components: Record<string, unknown> = {}) => {
    const content = JSON.stringify({ openapi: "3.0.3", paths: { "/pets": { get: { operationId: "list", ...operationOf({ $ref: "#/components/schemas/Root" }) } } }, components: { schemas: { Root: STRING }, ...components } });
    return rootOf([{ path: "api/openapi.yml", content }]).digests!;
  };
  const ok = (schema: unknown) => ({ "200": { description: "ok", content: { "application/json": { schema } } } });
  const base = read((schema) => ({ responses: ok(schema) }));
  const differing = (digests: typeof base) => (["request", "errors", "envelope"] as const).filter((part) => digests[part] !== base[part]);
  assert.deepEqual(differing(read((schema) => ({ parameters: [{ in: "query", name: "page", schema: STRING }], responses: ok(schema) }))), ["request"]);
  assert.deepEqual(differing(read((schema) => ({ responses: { ...ok(schema), "404": { description: "missing", content: { "application/json": { schema } } } } }))), ["errors"]);
  assert.deepEqual(differing(read((schema) => ({ responses: { "201": ok(schema)["200"] } }))), ["envelope"]);
  assert.deepEqual(differing(read((schema) => ({ responses: { "200": { description: "ok", content: { "application/hal+json": { schema } } } } }))), ["envelope"]);
  assert.deepEqual(differing(read((schema) => ({ responses: { "200": { ...ok(schema)["200"], headers: { "X-Total": { $ref: "#/components/headers/Total" } } } } }), { headers: { Total: { schema: STRING } } })), ["envelope"]);
  assert.deepEqual(differing(read((schema) => ({ responses: { "200": { ...ok(schema)["200"], headers: { "X-Total": { $ref: "#/components/headers/Total" } } } } }), { headers: { Total: { schema: { type: "integer" } } } })), ["envelope"]);
  assert.deepEqual(differing(read((schema) => ({ responses: ok(schema) }), { schemas: { Root: { type: "integer" } } })), []);
});

test("the request digest leaves out the schemas the request shapes compare, and changes with what a writer sends beside them", () => {
  const PET = { type: "object", properties: { name: STRING } };
  const page = (schema: unknown, extra: Record<string, unknown> = {}) => ({ in: "query", name: "page", schema, ...extra });
  const TRACE = { in: "header", name: "X-Trace", schema: STRING };
  const body = (schema: unknown, media = "application/json") => ({ content: { [media]: { schema } } });
  const digestOf = (get: Record<string, unknown>, schemas: Record<string, unknown> = { Pet: PET, Page: { type: "integer" } }, version: Record<string, unknown> = { openapi: "3.0.3" }) =>
    rootOf([{ path: "api/openapi.yml", content: JSON.stringify({ ...version, paths: { "/pets": { post: { ...get, responses: { "200": { description: "ok" } } } } }, components: { schemas } }) }]).digests!.request;
  const base = digestOf({ parameters: [page({ $ref: "#/components/schemas/Page" }), TRACE], requestBody: body({ $ref: "#/components/schemas/Pet" }) });
  const unchanged = {
    renamed: digestOf({ parameters: [page({ $ref: "#/components/schemas/PageNumber" }), TRACE], requestBody: body({ $ref: "#/components/schemas/Animal" }) }, { Animal: PET, PageNumber: { type: "integer" } }),
    inline: digestOf({ parameters: [page({ type: "integer" }), TRACE], requestBody: body(PET) }),
    split: digestOf({ parameters: [page({ $ref: "#/components/schemas/Page" }), TRACE], requestBody: body({ allOf: [{ $ref: "#/components/schemas/Pet" }, { type: "object" }] }) }),
    reordered: digestOf({ parameters: [TRACE, page({ $ref: "#/components/schemas/Page" })], requestBody: body({ $ref: "#/components/schemas/Pet" }) }),
  };
  assert.deepEqual(Object.entries(unchanged).filter(([, digest]) => digest !== base).map(([variant]) => variant), []);
  const changed = {
    media: digestOf({ parameters: [page({ $ref: "#/components/schemas/Page" }), TRACE], requestBody: body({ $ref: "#/components/schemas/Pet" }, "application/xml") }),
    serialization: digestOf({ parameters: [page({ $ref: "#/components/schemas/Page" }, { style: "deepObject" }), TRACE], requestBody: body({ $ref: "#/components/schemas/Pet" }) }),
  };
  assert.deepEqual(Object.entries(changed).filter(([, digest]) => digest === base).map(([variant]) => variant), []);
  const swagger = (parameter: Record<string, unknown>) => digestOf({ parameters: [{ in: "query", name: "page", ...parameter }] }, {}, { swagger: "2.0" });
  assert.equal(swagger({ type: "integer" }), swagger({ type: "string" }));
  assert.notEqual(swagger({ type: "integer" }), swagger({ type: "integer", allowEmptyValue: true }));
});

function requestOf(content: unknown, path = "api/openapi.yml"): OperationRequest {
  const [finding] = shapes.requests!([{ path, content: JSON.stringify(content) }]);
  assert.equal(finding?.status, "complete");
  return (finding as { value: OperationRequest }).value;
}
const fields = (shape: Shape) => known(shape).object!.properties.map(({ name, required }) => [name, required]);

test("a request is read in the request direction: a read-only property is never required, a path parameter always is, the body's own requirement is apart from its properties', and the parameters are one closed object per location", () => {
  const request = requestOf({
    openapi: "3.0.3",
    paths: {
      "/pets/{id}": {
        parameters: [{ in: "path", name: "id", schema: { type: "integer" } }],
        post: { parameters: [{ $ref: "#/components/parameters/Page", required: false }, { in: "header", name: "X-Trace", schema: STRING }], requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/Pet" } } } }, responses: { "200": { description: "ok" } } },
      },
    },
    components: { schemas: { Pet: { type: "object", required: ["id", "name"], properties: { id: { type: "integer", readOnly: true }, name: STRING } } }, parameters: { Page: { in: "query", name: "page", required: true, schema: { type: "integer" } } } },
  });
  assert.equal(request.body!.required, true);
  assert.deepEqual(fields(request.body!.shape), [["id", false], ["name", true]]);
  const parameters = known(request.parameters);
  assert.equal(parameters.object!.open, false);
  assert.deepEqual(fields(parameters), [["cookie", true], ["header", true], ["path", true], ["query", true]]);
  const at = (location: string) => known(property(parameters, location).shape);
  assert.deepEqual([fields(at("path")), fields(at("query")), fields(at("header")), fields(at("cookie"))], [[["id", true]], [["page", true]], [["X-Trace", false]], []]);
  assert.equal(at("query").object!.open, false);
  assert.deepEqual(known(property(at("query"), "page").shape).values.literals.number, "every");
});

test("a body whose media types declare different schemas, or a Swagger 2.0 form, is unknown; a Swagger 2.0 body parameter is the body; an operation without one has none", () => {
  const twoSchemas = requestOf({ openapi: "3.0.3", paths: { "/pets": { post: { requestBody: { content: { "application/json": { schema: STRING }, "text/plain": { schema: { type: "integer" } } } }, responses: {} } } } });
  assert.deepEqual([twoSchemas.body!.shape.kind, twoSchemas.body!.required], ["unknown", false]);
  const swagger = (parameters: unknown[]) => requestOf({ swagger: "2.0", paths: { "/pets": { post: { parameters, responses: {} } } } }, "api/swagger.json");
  const body = swagger([{ in: "body", name: "pet", required: true, schema: { type: "object", properties: { name: STRING } } }, { in: "query", name: "dry", type: "boolean" }]);
  assert.deepEqual([body.body!.required, fields(body.body!.shape), known(property(known(property(known(body.parameters), "query").shape), "dry").shape).values.literals.boolean], [true, [["name", false]], "every"]);
  assert.equal(swagger([{ in: "formData", name: "file", type: "file" }]).body!.shape.kind, "unknown");
  assert.equal(requestOf({ openapi: "3.0.3", paths: { "/pets": { get: { responses: {} } } } }).body, undefined);
});

test("a Swagger 2.0 document gives its response schema and the base path the contract declares", () => {
  const file: SourceFile = { path: "api/swagger.json", content: JSON.stringify({ swagger: "2.0", basePath: "/api", paths: { "/pets": operation({ "200": { description: "ok", schema: { type: "array", items: STRING } } }) } }) };
  const result = rootOf([file]);
  assert.equal(result.basePath, "/api");
  assert.deepEqual(known(known(result.shape).elements!).values.literals.string, "every");
});

test("one schema reached by two paths is one shape object, and a recursive schema is a cycle in the graph", () => {
  const root = rootOf([document({ Root: { type: "object", properties: { billing: { $ref: "#/components/schemas/Address" }, shipping: { $ref: "#/components/schemas/Address" } } }, Address: { type: "object", properties: { city: STRING, next: { $ref: "#/components/schemas/Address" } } } })]).shape;
  const billing = property(root, "billing").shape;
  assert.equal(billing, property(root, "shipping").shape);
  assert.equal(property(billing, "next").shape, billing);
});

test("a reference into another file is followed and that file is listed among those the shape was read from", () => {
  const types: SourceFile = { path: "api/types.yml", content: JSON.stringify({ Pet: { type: "object", properties: { id: STRING } } }) };
  const main = document({}, { "200": response({ $ref: "types.yml#/Pet" }) });
  const result = rootOf([main, types]);
  assert.equal(property(result.shape, "id").name, "id");
  assert.deepEqual(result.files, ["api/openapi.yml", "api/types.yml"]);
});

test("the files of an operation list those its request schemas reach, followed or not, so a change to a schema only the request uses is a change to the operation", () => {
  const get = { operationId: "create", parameters: [{ in: "query", name: "page", schema: { $ref: "params.yml#/Page" } }], requestBody: { content: { "application/json": { schema: { $ref: "body.yml#/Pet" } } } }, responses: { "204": { description: "none" } } };
  const main: SourceFile = { path: "api/openapi.yml", content: JSON.stringify({ openapi: "3.0.3", paths: { "/pets": { post: get } } }) };
  assert.deepEqual(rootOf([main, { path: "api/body.yml", content: JSON.stringify({ Pet: STRING }) }]).files, ["api/body.yml", "api/openapi.yml", "api/params.yml"]);
});

test("a reference the sources cannot answer keeps the file it names among the files of the shape, so a revision that holds the file changes the shape", () => {
  const main = document({}, { "200": response({ $ref: "types.yml#/Pet" }) });
  const [absent, held] = [rootOf([main]), rootOf([main, { path: "api/types.yml", content: JSON.stringify({ Pet: STRING }) }])];
  assert.deepEqual([absent.shape.kind, absent.files], ["unknown", ["api/openapi.yml", "api/types.yml"]]);
  assert.deepEqual([held.shape.kind, held.files], ["known", ["api/openapi.yml", "api/types.yml"]]);
});

test("oneOf, anyOf, not, a schema in additionalProperties, a reference that cannot be followed and one with sibling keywords are unknown at their place, with it in the evidence, and the rest is still read", () => {
  const root = rootOf([
    document({ Root: { type: "object", properties: { a: { oneOf: [STRING] }, b: { anyOf: [STRING] }, c: { not: STRING }, d: { type: "object", additionalProperties: STRING }, e: { $ref: "#/components/schemas/Missing" }, g: { $ref: "#/components/schemas/Other", nullable: true }, f: STRING } }, Other: STRING }),
  ]).shape;
  for (const name of ["a", "b", "c", "d", "e", "g"]) {
    const shape = property(root, name).shape;
    assert.deepEqual([shape.kind, shape.kind === "unknown" && shape.reason, shape.kind === "unknown" && shape.evidence[0]!.path], ["unknown", "unresolved", "api/openapi.yml"]);
  }
  assert.equal(property(root, "f").shape.kind, "known");
});

test("an allOf of open object branches with disjoint or identical properties is their merge: open, every property, every required name", () => {
  const root = known(rootOf([document({ Root: { allOf: [{ $ref: "#/components/schemas/Base" }, { type: "object", required: ["name"], properties: { name: STRING, id: STRING } }] }, Base: { type: "object", required: ["id"], properties: { id: STRING } } })]).shape);
  assert.equal(root.object!.open, true);
  assert.deepEqual(root.object!.properties.map(({ name, required }) => [name, required]), [["id", true], ["name", true]]);
  assert.deepEqual([root.values.object, root.values.null, root.values.array], [true, false, false]);
});

test("an allOf is unknown when a branch is closed, declares a property differently or holds keywords beyond an object schema", () => {
  const unknownRoot = (root: unknown, extra: Record<string, unknown> = {}) => rootOf([document({ Root: root, Base: { type: "object", properties: { id: STRING } }, ...extra })]).shape.kind;
  const base = { $ref: "#/components/schemas/Base" };
  assert.equal(unknownRoot({ allOf: [base, { type: "object", additionalProperties: false, properties: { name: STRING } }] }), "unknown");
  assert.equal(unknownRoot({ allOf: [base, { type: "object", properties: { id: { type: "integer" } } }] }), "unknown");
  assert.equal(unknownRoot({ allOf: [base, { type: "object", nullable: true }] }), "unknown");
  assert.equal(unknownRoot({ allOf: [base, { type: "object", properties: { name: STRING } }] }), "known");
});

test("an object is open unless additionalProperties is false; a required name it does not declare is every value when open and unknown when closed", () => {
  const root = (extra: Record<string, unknown>) => rootOf([document({ Root: { type: "object", required: ["x"], ...extra } })]).shape;
  assert.equal(known(root({})).object!.open, true);
  assert.deepEqual([property(root({}), "x").required, known(property(root({}), "x").shape).values.object], [true, true]);
  assert.equal(known(root({ additionalProperties: false })).object!.open, false);
  assert.equal(property(root({ additionalProperties: false }), "x").shape.kind, "unknown");
});

test("success responses that do not all declare the same schema make the root unknown; the same schema under several media types does not", () => {
  const root = (responses: unknown) => rootOf([document({ Root: { type: "object" } }, responses)]).shape;
  const ref = { $ref: "#/components/schemas/Root" };
  assert.equal(root({ "200": response(ref), "204": { description: "none" } }).kind, "unknown");
  assert.equal(root({ "200": response(ref), "201": response(STRING) }).kind, "unknown");
  assert.equal(root({ "200": { description: "ok", content: { "application/json": { schema: ref }, "text/plain": {} } } }).kind, "unknown");
  assert.equal(root({ "200": { description: "ok", content: { "application/json": { schema: ref }, "application/xml": { schema: ref } } }, "201": response(ref) }).kind, "known");
});

test("a success response with an empty content map is a response without a body: it takes part in the agreement and, alone, holds nothing", () => {
  const root = (responses: unknown) => rootOf([document({ Root: { type: "object" } }, responses)]).shape;
  const ref = { $ref: "#/components/schemas/Root" };
  assert.equal(root({ "200": response(ref), "204": { description: "none", content: {} } }).kind, "unknown");
  assert.deepEqual(known(root({ "204": { description: "none", content: {} } })).values, known(root({ "204": { description: "none" } })).values);
});

test("an operation with success responses but no body has a place that holds nothing, and one with no success response is unknown", () => {
  const root = (responses: unknown) => rootOf([document({}, responses)]).shape;
  assert.deepEqual(known(root({ "204": { description: "none" } })).values, { literals: { boolean: [], number: [], string: [] }, array: false, object: false, null: false, absent: false });
  assert.equal(root({ default: response(STRING) }).kind, "unknown");
});

test("a document that cannot be parsed is one unknown finding at its first line, and a source that declares no contract contributes nothing", () => {
  const broken: SourceFile = { path: "api/openapi.yml", content: "openapi: 3.0.3\npaths: [" };
  const plain: SourceFile = { path: "api/openapi.yml", content: "title: not a contract" };
  assert.deepEqual(shapes.responses([broken]).map((finding) => [finding.status, finding.evidence[0]?.path]), [["unknown", "api/openapi.yml"]]);
  assert.deepEqual(shapes.responses([plain]), []);
});

test("the shapes of two revisions of a published schema derive what the change did: a property dropped from an open merge, an enumeration opened, one schema under two paths and a recursive one", () => {
  const revision = (fields: Record<string, unknown>, kind: unknown, city: unknown) => ({
    Root: { type: "object", properties: { pet: { $ref: "#/components/schemas/Pet" }, billing: { $ref: "#/components/schemas/Address" }, shipping: { $ref: "#/components/schemas/Address" }, kind } },
    PetFields: { type: "object", properties: fields, required: ["name"] },
    Pet: { allOf: [{ $ref: "#/components/schemas/PetFields" }, { type: "object", properties: { id: { type: "integer" } }, required: ["id"] }] },
    Address: { type: "object", properties: { city, next: { $ref: "#/components/schemas/Address" } } },
  });
  const base = rootOf([document(revision({ name: STRING, typeId: { type: "integer" } }, { type: "string", enum: ["CAT", "DOG"] }, STRING))]).shape;
  const head = rootOf([document(revision({ name: STRING }, STRING, { type: "string", nullable: true }))]).shape;
  const derived = deriveChanges(base, head);
  const byPath = new Map(derived.hypotheses.map(({ property: path, change }) => [formatAccessPath(path), change]));
  assert.deepEqual([...byPath.keys()], ["billing.city", "kind", "pet.typeId", "shipping.city"]);
  assert.deepEqual(byPath.get("kind")!.entries, [{ type: "string" }]);
  assert.deepEqual(byPath.get("kind")!.oldGuarantee!.literals.string, ["CAT", "DOG"]);
  assert.deepEqual(byPath.get("pet.typeId")!.entries, ["nullable", { type: "boolean" }, { type: "string" }, { type: "array" }, { type: "object" }]);
  assert.deepEqual(byPath.get("billing.city")!.entries, ["nullable"]);
  assert.deepEqual(derived.frontiers.map(({ path, kind }) => [formatAccessPath(path), kind]), [["billing.next", "recursive-shape"], ["shipping.next", "recursive-shape"]]);
});
