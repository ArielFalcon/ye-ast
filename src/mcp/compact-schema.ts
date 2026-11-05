import type { z } from "zod";

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
