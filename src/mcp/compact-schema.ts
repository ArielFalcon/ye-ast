import type { z } from "zod";

type Json = unknown;

function withoutDescriptions(value: Json): Json {
  if (Array.isArray(value)) return value.map(withoutDescriptions);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key, child]) => key !== "description" || typeof child !== "string").map(([key, child]) => [key, withoutDescriptions(child)]));
}

/**
 * Keep the root object visible to clients while retaining every runtime refinement. `undescribedIn` names a root
 * property whose nested descriptions repeat those of other published tools; its own description stays.
 */
export function compactInput<T extends z.ZodType>(schema: T, options: { undescribedIn?: string } = {}): { "~standard": T["~standard"] } {
  const standard = schema["~standard"];
  return {
    "~standard": {
      ...standard,
      jsonSchema: {
        ...standard.jsonSchema,
        input: (jsonOptions) => {
          const result = standard.jsonSchema.input(jsonOptions);
          const { allOf, anyOf, oneOf, if: condition, then, else: otherwise, not, ...flat } = result;
          const property = options.undescribedIn;
          const properties = flat.properties as Record<string, Record<string, Json>> | undefined;
          if (property === undefined || properties?.[property] === undefined) return flat;
          const { description, ...rest } = properties[property];
          const bare = { ...(withoutDescriptions(rest) as Record<string, Json>), ...(description === undefined ? {} : { description }) };
          return { ...flat, properties: { ...properties, [property]: bare } };
        },
      },
    },
  };
}
