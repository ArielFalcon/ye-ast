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
  let content: ContractContent | null;
  try {
    document = parseDocument(file.content, { lineCounter });
    const first = document.errors[0];
    if (first !== undefined) return [unreadable(file.path, first.linePos?.[0]?.line ?? 1)];
    content = document.toJS() as ContractContent | null;
  } catch {
    return [unreadable(file.path, 1)];
  }
  if (!declaresContract(content) || typeof content?.paths !== "object" || content.paths === null) return [];
  const basePath = basePathOf(content);
  return Object.entries(content.paths as Record<string, unknown>).flatMap(([path, item]) => operationsAt(file, document, lineCounter, basePath, path, item));
}

interface ContractContent {
  openapi?: unknown;
  swagger?: unknown;
  paths?: unknown;
  basePath?: unknown;
  servers?: unknown;
}

/** The path every operation is served under: Swagger 2.0 `basePath`, or the path part of the OpenAPI `servers`; `undefined` when the servers disagree. */
function basePathOf(content: ContractContent): string | undefined {
  if (content.swagger !== undefined) return typeof content.basePath === "string" ? normalized(content.basePath) : "";
  const urls = Array.isArray(content.servers) ? content.servers.flatMap((server: { url?: unknown } | null) => (typeof server?.url === "string" ? [server.url] : [])) : [];
  const paths = new Set(urls.map((url) => normalized(url.replace(/^([a-z][a-z0-9+.-]*:)?\/\/[^/?#]*/i, ""))));
  return paths.size > 1 ? undefined : (paths.values().next().value ?? "");
}

function normalized(path: string): string {
  const [bare = ""] = path.split(/[?#]/);
  const trimmed = bare.replace(/\/+$/, "");
  return trimmed === "" || trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

/** A document is a contract only when it says which contract it is: OpenAPI 3.x or Swagger 2.0. */
function declaresContract(content: { openapi?: unknown; swagger?: unknown } | null): boolean {
  if (typeof content?.openapi === "number" || typeof content?.openapi === "string") return OPENAPI.test(String(content.openapi));
  return String(content?.swagger ?? "") === SWAGGER;
}

function operationsAt(file: SourceFile, document: Document.Parsed, lineCounter: LineCounter, basePath: string | undefined, path: string, item: unknown): Finding<ContractOperation>[] {
  if (typeof item !== "object" || item === null) return [];
  return Object.entries(item as Record<string, unknown>).flatMap(([verb, operation]) => {
    if (!VERBS.has(verb) || typeof operation !== "object" || operation === null) return [];
    const { operationId } = operation as { operationId?: unknown };
    if (typeof operationId !== "string" || operationId === "") return [];
    const line = lineOf(document, lineCounter, ["paths", path, verb, "operationId"]);
    return [{ status: "complete", value: { operationId, method: verb.toUpperCase() as HttpMethod, path, basePath, document: file.path, line }, evidence: [{ path: file.path, line }] }];
  });
}

function lineOf(document: Document.Parsed, lineCounter: LineCounter, path: readonly string[]): number {
  const node = document.getIn([...path], true) as { range?: readonly [number, number, number] | null } | undefined;
  return node?.range === undefined || node.range === null ? 1 : lineCounter.linePos(node.range[0]).line;
}

function unreadable(path: string, line: number): Finding<never> {
  return { status: "unknown", reason: "source-unreadable", evidence: [{ path, line }] };
}
