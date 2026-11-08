import type { z } from "zod";

const SHARED_FIELDS = new Set(["repo", "revision", "head", "live", "offline", "scope", "include", "exclude", "mode", "workspace", "repos", "gateways"]);

function publishedField(name: string, schema: unknown): unknown {
  if (!SHARED_FIELDS.has(name) || schema === null || typeof schema !== "object" || Array.isArray(schema)) return schema;
  const { description: _description, ...rest } = schema as Record<string, unknown>;
  return rest;
}

function withOpaque(value: unknown, opaque: Readonly<Record<string, string>>): unknown {
  if (Array.isArray(value)) return value.map((item) => withOpaque(item, opaque));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, key === "properties" && child !== null && typeof child === "object"
    ? Object.fromEntries(Object.entries(child).map(([name, schema]) => [name, name in opaque ? { type: "object", description: opaque[name] } : publishedField(name, withOpaque(schema, opaque))]))
    : withOpaque(child, opaque)]));
}

/**
 * Cross-field constraints in the root keywords that keep a published root a plain object: presence dependencies and at
 * most one root condition. Combinators stay nested inside a dependent schema.
 */
export type CrossField = { dependentRequired?: Record<string, readonly string[]>; dependentSchemas?: Record<string, object>; if?: object; then?: object };

/** Merge constraints: dependent schemas of one field are all applied; a second root condition is a programming error. */
export function crossField(...parts: readonly CrossField[]): CrossField {
  const required = new Map<string, string[]>();
  const schemas = new Map<string, object[]>();
  let condition: Pick<CrossField, "if" | "then"> | undefined;
  for (const part of parts) {
    for (const [field, fields] of Object.entries(part.dependentRequired ?? {})) required.set(field, [...new Set([...(required.get(field) ?? []), ...fields])]);
    for (const [field, schema] of Object.entries(part.dependentSchemas ?? {})) schemas.set(field, [...(schemas.get(field) ?? []), schema]);
    if (part.if === undefined) continue;
    if (condition !== undefined) throw new Error("a published root carries one condition");
    condition = { if: part.if, ...(part.then === undefined ? {} : { then: part.then }) };
  }
  return {
    ...(required.size ? { dependentRequired: Object.fromEntries(required) } : {}),
    ...(schemas.size ? { dependentSchemas: Object.fromEntries([...schemas].map(([field, list]) => [field, allOf(list)])) } : {}),
    ...condition,
  };
}

/** Schemas that only constrain distinct properties merge into one `properties`; any other pair is applied with allOf. */
function allOf(list: readonly object[]): object {
  if (list.length === 1) return list[0]!;
  const only = list.every((schema) => Object.keys(schema).length === 1 && "properties" in schema);
  const names = list.flatMap((schema) => Object.keys((schema as { properties?: object }).properties ?? {}));
  return only && new Set(names).size === names.length ? { properties: Object.assign({}, ...list.map((schema) => (schema as { properties: object }).properties)) } : { allOf: list };
}

const ROOT_COMBINATORS = ["allOf", "anyOf", "oneOf"] as const;

/**
 * Keep the root object visible to clients while retaining every runtime refinement and the declared cross-field
 * constraints. A root combinator cannot be published, so it fails instead of being dropped. `opaque` publishes the named
 * properties, at any depth, as described objects whose shape the agent copies from an answer or another tool.
 */
export function compactInput<T extends z.ZodType>(schema: T, opaque: Readonly<Record<string, string>> = {}): { "~standard": T["~standard"] } {
  const standard = schema["~standard"];
  return {
    "~standard": {
      ...standard,
      jsonSchema: {
        ...standard.jsonSchema,
        input: (options) => {
          const result = standard.jsonSchema.input(options);
          const combinator = ROOT_COMBINATORS.find((key) => key in result);
          if (combinator !== undefined) throw new Error(`a published input root must not carry ${combinator}; use crossField`);
          return withOpaque(result, opaque) as typeof result;
        },
      },
    },
  };
}
