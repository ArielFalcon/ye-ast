import { z } from "zod";
import { namespacedDigestPattern, type DigestNamespace } from "./composition-identity.ts";

/** Runtime and advertised schemas use the same namespaced identity rule as canonical key validation. */
export function compositionIdSchema<P extends DigestNamespace>(prefix: P) {
  const pattern = namespacedDigestPattern(prefix);
  return z.templateLiteral([`${prefix}:`, z.string()])
    .refine((value) => pattern.test(value), "Expected a namespaced lowercase SHA-256 identity")
    .meta({ pattern: pattern.source });
}
