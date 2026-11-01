import type { HttpMethod } from "../domain/entrypoints/http-route.ts";
import type { Finding } from "../domain/shared/fact.ts";
import type { SourceFile } from "./entrypoint-extractor.port.ts";

/**
 * One operation a contract document declares, named by its `operationId`. The route it serves is the contract's verb and
 * path; the handler that serves it is the code that overrides it (RFC-0007 row S5).
 */
export interface ContractOperation {
  operationId: string;
  method: HttpMethod;
  path: string;
  /**
   * What the contract puts before `path`: the Swagger 2.0 `basePath`, or the path part of its OpenAPI `servers`; empty when
   * it declares none, `undefined` when its servers disagree.
   */
  basePath: string | undefined;
  /** The contract document that declares the operation, repository-relative. */
  document: string;
  /** The line of the `operationId` in that document. */
  line: number;
}

/**
 * Reads the operations of the contract documents among the in-scope sources. A document the reader cannot parse is one
 * `unknown` finding with its place; a document that declares no operation contributes nothing.
 */
export interface ContractRoutes {
  operations(files: readonly SourceFile[]): readonly Finding<ContractOperation>[];
}
