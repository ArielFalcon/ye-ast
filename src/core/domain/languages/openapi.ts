const CONTRACT_EXTENSION = /\.(ya?ml|json)$/i;
const CONTRACT_NAMES: ReadonlySet<string> = new Set(["openapi", "swagger"]);

/**
 * A document a contract may be written in: YAML or JSON, and a path segment that names OpenAPI or Swagger. The path is the
 * only signal a snapshot gives before the document is read; its content decides whether it declares operations.
 */
export function isContractDocument(path: string): boolean {
  if (!CONTRACT_EXTENSION.test(path)) return false;
  return path
    .split("/")
    .some((segment) => CONTRACT_NAMES.has(segment.replace(CONTRACT_EXTENSION, "").toLowerCase()));
}
