import { z } from "zod";
import { DEPENDENCY_SELECTION_REASONS } from "../core/domain/shared/fact.ts";

export const dependencyDiagnostic = z.strictObject({
  name: z.string(),
  reason: z.enum(DEPENDENCY_SELECTION_REASONS),
  candidates: z.array(z.string()),
});
