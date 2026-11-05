import type { z } from "zod";
import type { ToolFamily } from "./presentation.ts";

const stringSchema = { type: "string" };
const objectType = { type: "object" };
const arrayType = { type: "array" };
const reference = (name: string) => ({ $ref: `#/definitions/${name}` });
const objectSchema = (properties: object, required: string[] = []) => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
});

const definitions = {
  snapshot: {
    anyOf: [
      objectSchema({ kind: { const: "sha" }, repo: stringSchema, sha: stringSchema }, ["kind", "repo", "sha"]),
      objectSchema({ kind: { const: "live" }, repo: stringSchema, head: stringSchema, stateId: stringSchema }, ["kind", "repo", "head", "stateId"]),
    ],
  },
  recovery: {
    anyOf: [
      objectSchema({ version: { const: 1 }, status: { const: "available" }, resultIdentity: stringSchema, query: objectSchema({ name: stringSchema, arguments: objectType }, ["name", "arguments"]) }, ["version", "status", "resultIdentity", "query"]),
      objectSchema({ version: { const: 1 }, status: { const: "unavailable" }, reason: { enum: ["deadline", "unresolved-context", "redacted-context"] } }, ["version", "status", "reason"]),
    ],
  },
  evidence: objectSchema({ path: stringSchema, line: { type: "number" } }, ["path", "line"]),
  cuts: {
    type: "array",
    items: objectSchema({ kind: stringSchema, at: arrayType }, ["kind", "at"]),
    description: "Partial retains known results with coverage cuts; unknown has a reason and does not mean no impact.",
  },
  fact: objectSchema({ status: { enum: ["complete", "partial", "unknown"] }, value: {}, reason: stringSchema, cuts: reference("cuts"), evidence: { type: "array", items: reference("evidence") } }, ["status"]),
  source: objectSchema({
    schema: stringSchema,
    snapshot: reference("snapshot"),
    producer: objectSchema({ name: stringSchema, version: stringSchema }, ["name", "version"]),
    inputs: objectSchema({ trust: stringSchema, declaredScope: objectType }, ["trust", "declaredScope"]),
    analysis: reference("fact"),
    reads: arrayType,
    limits: arrayType,
  }, ["schema", "snapshot", "producer", "inputs", "analysis", "reads", "limits"]),
  page: objectSchema({
    limit: { type: "integer" },
    offset: { type: "integer" },
    returned: { type: "integer" },
    total: { type: "integer" },
    nextCursor: { type: "string", description: "Pass as page.cursor with the same selection and limit to continue." },
  }, ["limit", "offset", "returned", "total"]),
};

const impactValue = objectSchema({ seeds: arrayType, symbols: arrayType, entrypoints: arrayType, cost: objectType, modules: objectType, workspace: objectType, sections: objectType, links: arrayType });

const values: Record<ToolFamily, object> = {
  entrypoints: objectSchema({ entrypoints: reference("fact") }, ["entrypoints"]),
  impact: impactValue,
  callers: impactValue,
  importers: objectSchema({ files: { type: "array", items: objectSchema({ file: stringSchema, importers: arrayType, users: arrayType, unresolvedNamers: arrayType }, ["file", "importers", "users", "unresolvedNamers"]) } }, ["files"]),
  outline: objectSchema({ files: { type: "array", items: objectSchema({ file: stringSchema, declarations: arrayType, imports: arrayType }, ["file", "declarations", "imports"]) }, unheld: arrayType }, ["files", "unheld"]),
  workspace: objectSchema({ workspace: objectType, repositorySnapshots: arrayType, sections: objectType, candidates: arrayType, unserved: arrayType }, ["workspace", "repositorySnapshots", "sections", "candidates", "unserved"]),
  decisions: objectSchema({ decisions: arrayType, repositories: arrayType, source: stringSchema }, ["decisions", "repositories", "source"]),
};

function outputGuide(family: ToolFamily) {
  const ordinary = objectSchema({
    mode: { enum: ["full", "summary", "details"] },
    status: { enum: ["complete", "partial", "unknown"] },
    snapshot: reference("snapshot"),
    schema: stringSchema,
    producer: objectType,
    inputs: objectType,
    value: values[family],
    reason: stringSchema,
    cuts: reference("cuts"),
    evidence: { type: "array", items: reference("evidence") },
    recovery: reference("recovery"),
  }, ["mode", "status", "snapshot"]);
  const projection = objectSchema({
    kind: { enum: ["projection", "projection-receipt"] },
    projectionSchema: { const: 1 },
    availability: { enum: ["available", "unavailable"] },
    source: reference("source"),
    recovery: reference("recovery"),
    select: objectSchema({ kind: stringSchema }, ["kind"]),
    context: objectType,
    items: arrayType,
    page: reference("page"),
    reason: stringSchema,
    evidence: { type: "array", items: reference("evidence") },
  }, ["kind", "projectionSchema", "availability", "source", "recovery", "select"]);
  const selected = ["entrypoints", "impact", "callers"].includes(family);
  const { source, page, fact, ...ordinaryDefinitions } = definitions;
  return {
    type: "object",
    description: "Full facts include schema, snapshot, producer, inputs and evidence. Text modes return receipts. Recovery provides replay arguments and identity when available. Selected pages retain source provenance and independent availability.",
    definitions: selected ? definitions : ordinaryDefinitions,
    anyOf: selected ? [ordinary, projection] : [ordinary],
  };
}

/** Publish an intentionally concise guide; validate using the complete original schema. */
export function compactOutput<T extends z.ZodType>(schema: T, family: ToolFamily): { "~standard": T["~standard"] } {
  const standard = schema["~standard"];
  return {
    "~standard": {
      ...standard,
      jsonSchema: { ...standard.jsonSchema, output: () => outputGuide(family) },
    },
  };
}

/** Keep the root object visible to clients while retaining every runtime refinement. */
export function compactInput<T extends z.ZodType>(schema: T): { "~standard": T["~standard"] } {
  const standard = schema["~standard"];
  return {
    "~standard": {
      ...standard,
      jsonSchema: {
        ...standard.jsonSchema,
        input: (options) => {
          const result = standard.jsonSchema.input(options);
          const { allOf, anyOf, oneOf, if: condition, then, else: otherwise, not, ...flat } = result;
          return flat;
        },
      },
    },
  };
}
