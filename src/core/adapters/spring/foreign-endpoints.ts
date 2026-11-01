import type { Finding } from "../../domain/shared/fact.ts";
import type { TypeDecl } from "./java-symbols.ts";
import { scopeOf } from "./java-symbols.ts";
import { spanOf, unknown, unknownAt, type MappedRoute } from "./findings.ts";
import { annotationUses, FOREIGN_METHOD_ENDPOINTS, FOREIGN_TYPE_ENDPOINTS, type SpringAnnotations } from "./request-mapping.ts";

/**
 * The endpoints a type declares through another HTTP server's API (JAX-RS, Micronaut, Servlet, Quarkus reactive routes),
 * which this extractor does not read: one unknown item per endpoint method, or one per type when the annotation is on
 * the type and its methods cannot be told apart.
 */
export function foreignEndpointsOf(type: TypeDecl, annotations: SpringAnnotations): Finding<MappedRoute>[] {
  const markedBy = (declaration: TypeDecl["node"], keys: ReadonlySet<string>) =>
    annotationUses(declaration, scopeOf(type)).find((use) => keys.has(annotations.keyOf(use) ?? ""));
  const methods = type.methods.flatMap((method) => {
    const use = markedBy(method.node, FOREIGN_METHOD_ENDPOINTS);
    return use === undefined ? [] : [unknownAt(method, { reason: "no-extractor", file: type.file, node: use.node })];
  });
  if (methods.length > 0) return methods;
  const use = markedBy(type.node, FOREIGN_TYPE_ENDPOINTS);
  return use === undefined ? [] : [unknown("no-extractor", [spanOf(type.file.path, use.node)])];
}
