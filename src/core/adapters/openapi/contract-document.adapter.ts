import { LineCounter, parseDocument, type Document } from "yaml";
import { isContractDocument } from "../../domain/languages/openapi.ts";
import type { HttpMethod } from "../../domain/entrypoints/http-route.ts";
import type { Finding } from "../../domain/shared/fact.ts";
import type { ContractOperation, ContractRoutes } from "../../ports/contract-routes.port.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";

const VERBS: ReadonlySet<string> = new Set(["get", "head", "post", "put", "patch", "delete", "options", "trace"]);
const OPENAPI = /^3\./;
const SWAGGER = "2.0";

export function createContractRoutes(): ContractRoutes {
  return { operations: (files) => files.flatMap((file) => (isContractDocument(file.path) ? operationsOf(file) : [])) };
}

function operationsOf(file: SourceFile): readonly Finding<ContractOperation>[] {
  const lineCounter = new LineCounter();
  let document: Document.Parsed;
  try {
    document = parseDocument(file.content, { lineCounter });
  } catch {
    return [unreadable(file.path, 1)];
  }
  const first = document.errors[0];
  if (first !== undefined) return [unreadable(file.path, first.linePos?.[0]?.line ?? 1)];
  const content = document.toJS() as { openapi?: unknown; swagger?: unknown; paths?: unknown } | null;
  if (!declaresContract(content) || typeof content?.paths !== "object" || content.paths === null) return [];
  return Object.entries(content.paths as Record<string, unknown>).flatMap(([path, item]) => operationsAt(file, document, lineCounter, path, item));
}

/** A document is a contract only when it says which contract it is: OpenAPI 3.x or Swagger 2.0. */
function declaresContract(content: { openapi?: unknown; swagger?: unknown } | null): boolean {
  if (typeof content?.openapi === "number" || typeof content?.openapi === "string") return OPENAPI.test(String(content.openapi));
  return String(content?.swagger ?? "") === SWAGGER;
}

function operationsAt(file: SourceFile, document: Document.Parsed, lineCounter: LineCounter, path: string, item: unknown): Finding<ContractOperation>[] {
  if (typeof item !== "object" || item === null) return [];
  return Object.entries(item as Record<string, unknown>).flatMap(([verb, operation]) => {
    if (!VERBS.has(verb) || typeof operation !== "object" || operation === null) return [];
    const { operationId } = operation as { operationId?: unknown };
    if (typeof operationId !== "string" || operationId === "") return [];
    const line = lineOf(document, lineCounter, ["paths", path, verb, "operationId"]);
    return [{ status: "complete", value: { operationId, method: verb.toUpperCase() as HttpMethod, path, document: file.path, line }, evidence: [{ path: file.path, line }] }];
  });
}

function lineOf(document: Document.Parsed, lineCounter: LineCounter, path: readonly string[]): number {
  const node = document.getIn([...path], true) as { range?: readonly [number, number, number] | null } | undefined;
  return node?.range === undefined || node.range === null ? 1 : lineCounter.linePos(node.range[0]).line;
}

function unreadable(path: string, line: number): Finding<never> {
  return { status: "unknown", reason: "source-unreadable", evidence: [{ path, line }] };
}
