import type { z } from "zod";

type Json = unknown;

function withOpaque(value: Json, opaque: Readonly<Record<string, string>>): Json {
  if (Array.isArray(value)) return value.map((item) => withOpaque(item, opaque));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, key === "properties" && child !== null && typeof child === "object"
    ? Object.fromEntries(Object.entries(child).map(([name, schema]) => [name, name in opaque ? { type: "object", description: opaque[name] } : withOpaque(schema, opaque)]))
    : withOpaque(child, opaque)]));
}

/**
 * Keep the root object visible to clients while retaining every runtime refinement. `opaque` publishes the named
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
          const { allOf, anyOf, oneOf, if: condition, then, else: otherwise, not, ...flat } = result;
          return withOpaque(flat, opaque) as typeof flat;
        },
      },
    },
  };
}
