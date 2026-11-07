import { createHash } from "node:crypto";
import { posix } from "node:path";
import { isMap, isScalar, LineCounter, parseDocument, type Document } from "yaml";
import type { ContractData, UnresolvedReference } from "../../domain/contracts/contract-operation.ts";
import { isContractDocument } from "../../domain/languages/openapi.ts";
import type { HttpMethod } from "../../domain/entrypoints/http-route.ts";
import { canonicalJson } from "../../domain/shared/canonical-json.ts";
import { compareText } from "../../domain/shared/code-node.ts";
import { afterOrigin } from "../../domain/topology/path-template.ts";
import type { Finding } from "../../domain/shared/fact.ts";
import type { ContractOperation, ContractRoutes } from "../../ports/contract-routes.port.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";

const VERBS: ReadonlySet<string> = new Set(["get", "head", "post", "put", "patch", "delete", "options", "trace"]);
const OPENAPI = /^3\./;
const SWAGGER = "2.0";
export const DOCUMENTATION: ReadonlySet<string> = new Set(["description", "summary", "example", "examples", "externalDocs"]);
const NAMED_MEMBERS: ReadonlySet<string> = new Set(["properties", "patternProperties"]);
const LITERAL_MEMBERS: ReadonlySet<string> = new Set(["default", "enum", "const"]);

export function createContractRoutes(): ContractRoutes {
  return {
    operations: (files) => {
      const referenced = referencedDocuments(files);
      return files.flatMap((file) => (isContractDocument(file.path) ? operationsOf(file, referenced) : []));
    },
  };
}

function operationsOf(file: SourceFile, referenced: ReferencedDocuments): readonly Finding<ContractOperation>[] {
  const contract = parseContract(file);
  if (contract === undefined) return [];
  if ("status" in contract) return [contract];
  return declaredOperations(contract).flatMap((declared) => {
    const { path, verb, operation, operationId, line } = declared;
    const response = { responses: operation.responses, produces: producesOf(contract, declared) };
    const data = dataOf(file.path, { request: requestOf(contract, declared), response }, referenced);
    return [{ status: "complete", value: { operationId, method: verb.toUpperCase() as HttpMethod, path, basePath: contract.basePath, document: file.path, line, data }, evidence: [{ path: file.path, line }] }];
  });
}

interface ContractContent {
  openapi?: unknown;
  swagger?: unknown;
  paths?: unknown;
  basePath?: unknown;
  servers?: unknown;
  consumes?: unknown;
  produces?: unknown;
}

/** A source that declares a contract, parsed once: the readers of operations and of shapes share it. */
export interface ParsedContract {
  file: SourceFile;
  document: Document.Parsed;
  lineCounter: LineCounter;
  basePath: string | undefined;
  content: ContractContent & { paths: Record<string, unknown> };
}

/** The contract a source declares, `undefined` when it declares none, or an `unknown` finding when it cannot be read. */
export function parseContract(file: SourceFile): ParsedContract | Finding<never> | undefined {
  const lineCounter = new LineCounter();
  let document: Document.Parsed;
  let content: ContractContent | null;
  try {
    document = parseDocument(file.content, { lineCounter });
    const first = document.errors[0];
    if (first !== undefined) return unreadable(file.path, first.linePos?.[0]?.line ?? 1);
    content = document.toJS() as ContractContent | null;
  } catch {
    return unreadable(file.path, 1);
  }
  if (!declaresContract(content) || typeof content?.paths !== "object" || content.paths === null) return undefined;
  return { file, document, lineCounter, basePath: basePathOf(content), content: content as ParsedContract["content"] };
}

/** The path every operation is served under: Swagger 2.0 `basePath`, or the path part of the OpenAPI `servers`; `undefined` when the servers disagree. */
function basePathOf(content: ContractContent): string | undefined {
  if (content.swagger !== undefined) return typeof content.basePath === "string" ? normalized(content.basePath) : "";
  const urls = Array.isArray(content.servers) ? content.servers.flatMap((server: { url?: unknown } | null) => (typeof server?.url === "string" ? [server.url] : [])) : [];
  const paths = new Set(urls.map((url) => normalized(afterOrigin(url))));
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

export interface DeclaredOperation {
  path: string;
  verb: string;
  operation: Record<string, unknown>;
  /** The parameters its path item shares with every operation of the path. */
  shared: unknown;
  operationId: string | undefined;
  /** The line of the `operationId`, or of the verb when there is none. */
  line: number;
}

export function declaredOperations({ document, lineCounter, content }: ParsedContract): DeclaredOperation[] {
  return Object.entries(content.paths).flatMap(([path, item]) => {
    if (typeof item !== "object" || item === null) return [];
    const shared = (item as { parameters?: unknown }).parameters;
    return Object.entries(item as Record<string, unknown>).flatMap(([verb, operation]) => {
      if (!VERBS.has(verb) || typeof operation !== "object" || operation === null) return [];
      const declared = (operation as { operationId?: unknown }).operationId;
      const operationId = typeof declared === "string" && declared !== "" ? declared : undefined;
      const line = operationId === undefined ? keyLine(document, lineCounter, ["paths", path], verb) : lineOf(document, lineCounter, ["paths", path, verb, "operationId"]);
      return [{ path, verb, operation: operation as Record<string, unknown>, shared, operationId, line }];
    });
  });
}

function asList(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/** What an operation's request is made of: the parameters of its path and its own, its body, and the media it consumes. */
export function requestOf(contract: ParsedContract, { operation, shared }: DeclaredOperation): { parameters: unknown[]; requestBody: unknown; consumes: unknown } {
  return { parameters: [...asList(shared), ...asList(operation.parameters)], requestBody: operation.requestBody, consumes: operation.consumes ?? contract.content.consumes };
}

/** The media an operation's responses are produced in, as Swagger 2.0 states them; `undefined` in OpenAPI 3.x, whose responses name their own. */
export function producesOf(contract: ParsedContract, { operation }: DeclaredOperation): unknown {
  return operation.produces ?? contract.content.produces;
}

/** The parsed content of every source a reference may name, read once per call; `undefined` for one that does not parse. */
export interface ReferencedDocuments {
  get(path: string): { content: unknown } | undefined;
}

export function referencedDocuments(files: readonly SourceFile[]): ReferencedDocuments {
  const sources = new Map(files.map((file) => [file.path, file.content]));
  const parsed = new Map<string, { content: unknown } | undefined>();
  return {
    get(path) {
      if (!parsed.has(path)) parsed.set(path, parsedContent(sources.get(path)));
      return parsed.get(path);
    },
  };
}

function parsedContent(text: string | undefined): { content: unknown } | undefined {
  if (text === undefined) return undefined;
  try {
    const document = parseDocument(text);
    return document.errors.length > 0 ? undefined : { content: document.toJS() as unknown };
  } catch {
    return undefined;
  }
}

/** The digests of an operation's request and response data. */
function dataOf(document: string, sides: { request: unknown; response: unknown }, referenced: ReferencedDocuments): ContractData {
  const digester = createDigester(document, referenced);
  const request = digester.digest(sides.request);
  const response = digester.digest(sides.response);
  return { request, response, files: digester.files(), unresolved: digester.unresolved() };
}

export interface Digester {
  /** A digest of the data at `root`, read from `from` (the document by default), that differs exactly when the data differs. */
  digest(root: unknown, from?: string): string;
  /** The files other than the document that the digested data's references reach, sorted. */
  files(): string[];
  /** The references the digested data holds that could not be followed, sorted. */
  unresolved(): UnresolvedReference[];
}

/**
 * Digests data of one contract document. Each digest covers the data with its documentation left out, and every place its
 * references reach, each place once whatever cycle leads back to it.
 */
export function createDigester(document: string, referenced: ReferencedDocuments): Digester {
  const files = new Set<string>();
  const unresolved = new Map<string, UnresolvedReference>();
  const digest = (root: unknown, from: string = document): string => {
    const places = new Map<string, unknown>();
    const pending: { key: string; file: string; node: unknown }[] = [];
    const kept = (file: string, node: unknown): unknown =>
      withoutDocumentation(node, undefined, (ref) => {
        const target = targetOf(file, ref, referenced);
        if ("unresolved" in target) {
          unresolved.set(JSON.stringify([ref, target.unresolved.file]), target.unresolved);
          return;
        }
        if (target.file !== document) files.add(target.file);
        const key = `${target.file}#${target.pointer}`;
        if (places.has(key)) return;
        places.set(key, undefined);
        pending.push({ key, file: target.file, node: target.node });
      });
    const own = kept(from, root);
    for (let next = pending.pop(); next !== undefined; next = pending.pop()) places.set(next.key, kept(next.file, next.node));
    return createHash("sha256").update(canonicalJson([own, [...places].sort(([a], [b]) => compareText(a, b))])).digest("hex");
  };
  return {
    digest,
    files: () => [...files].sort(compareText),
    unresolved: () => [...unresolved.values()].sort((a, b) => compareText(a.ref, b.ref) || compareText(a.file ?? "", b.file ?? "")),
  };
}

/** A copy of the data without its documentation members, calling `onReference` for every `$ref` it holds. */
function withoutDocumentation(node: unknown, parentKey: string | undefined, onReference: (ref: string) => void): unknown {
  if (Array.isArray(node)) return node.map((member) => withoutDocumentation(member, undefined, onReference));
  if (typeof node !== "object" || node === null) return node;
  const named = parentKey !== undefined && NAMED_MEMBERS.has(parentKey);
  const kept: [string, unknown][] = [];
  for (const [key, member] of Object.entries(node as Record<string, unknown>)) {
    if (!named && key === "$ref" && typeof member === "string") onReference(member);
    if (!named && DOCUMENTATION.has(key)) continue;
    if (!named && LITERAL_MEMBERS.has(key)) {
      kept.push([key, member]);
      continue;
    }
    kept.push([key, withoutDocumentation(member, named ? undefined : key, onReference)]);
  }
  return Object.fromEntries(kept);
}

export type Target = { file: string; pointer: string; node: unknown } | { unresolved: UnresolvedReference };

/** The repository file a reference names, `undefined` for one that names none a repository can hold: a remote location, an absolute path, or a path above the root. */
function fileOfReference(from: string, ref: string): string | undefined {
  const hash = ref.indexOf("#");
  const location = hash === -1 ? ref : ref.slice(0, hash);
  if (/^[a-z][a-z0-9+.-]*:/i.test(location)) return undefined;
  if (location === "") return from;
  const decoded = percentDecoded(location);
  const file = decoded === undefined || posix.isAbsolute(decoded) ? undefined : posix.join(posix.dirname(from), decoded);
  return file === undefined || file.startsWith("../") ? undefined : file;
}

/** The place a reference names: a JSON pointer into its own document or into another source of the repository. */
export function targetOf(from: string, ref: string, referenced: ReferencedDocuments): Target {
  const file = fileOfReference(from, ref);
  if (file === undefined) return { unresolved: { ref } };
  const hash = ref.indexOf("#");
  const pointer = hash === -1 ? "" : ref.slice(hash + 1);
  const parsed = referenced.get(file);
  if (parsed === undefined) return { unresolved: { ref, file } };
  const node = pointer === "" ? parsed.content : nodeAt(parsed.content, pointer);
  return node === undefined ? { unresolved: { ref, file } } : { file, pointer, node };
}

/**
 * The repository files the contract documents among `files` reference, directly or through the files they reference, that
 * `files` does not hold: what a read of the sources must still take for the references to resolve.
 */
export function missingReferences(files: readonly SourceFile[]): string[] {
  const held = new Set(files.map((file) => file.path));
  const referenced = referencedDocuments(files);
  const missing = new Set<string>();
  const visited = new Set<string>();
  const pending = files.filter((file) => isContractDocument(file.path)).map((file) => file.path);
  for (let path = pending.pop(); path !== undefined; path = pending.pop()) {
    if (visited.has(path)) continue;
    visited.add(path);
    const parsed = referenced.get(path);
    if (parsed === undefined) continue;
    withoutDocumentation(parsed.content, undefined, (ref) => {
      const file = fileOfReference(path, ref);
      if (file === undefined) return;
      if (held.has(file)) pending.push(file);
      else missing.add(file);
    });
  }
  return [...missing].sort(compareText);
}

function nodeAt(root: unknown, pointer: string): unknown {
  if (!pointer.startsWith("/")) return undefined;
  let node = root;
  for (const token of pointer.slice(1).split("/")) {
    const key = percentDecoded(token)?.replaceAll("~1", "/").replaceAll("~0", "~");
    if (key === undefined || typeof node !== "object" || node === null || !Object.hasOwn(node, key)) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

function percentDecoded(text: string): string | undefined {
  try {
    return decodeURIComponent(text);
  } catch {
    return undefined;
  }
}

function lineOf(document: Document.Parsed, lineCounter: LineCounter, path: readonly string[]): number {
  const node = document.getIn([...path], true) as { range?: readonly [number, number, number] | null } | undefined;
  return node?.range === undefined || node.range === null ? 1 : lineCounter.linePos(node.range[0]).line;
}

function keyLine(document: Document.Parsed, lineCounter: LineCounter, path: readonly string[], key: string): number {
  const map = document.getIn([...path], true);
  const pair = isMap(map) ? map.items.find((item) => isScalar(item.key) && item.key.value === key) : undefined;
  const range = isScalar(pair?.key) ? pair.key.range : undefined;
  return range === undefined || range === null ? 1 : lineCounter.linePos(range[0]).line;
}

function unreadable(path: string, line: number): Finding<never> {
  return { status: "unknown", reason: "source-unreadable", evidence: [{ path, line }] };
}
