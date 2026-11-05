import type { HttpMethod } from "../entrypoints/http-route.ts";

/**
 * One operation a contract document declares: the contract's verb and path. The route it serves is that verb and path;
 * the handler that serves it is the code that overrides its `operationId` (RFC-0007 row S5).
 */
export interface ContractOperation {
  /** Absent when the contract names none: no handler can be joined to the operation, but its data is still read. */
  operationId: string | undefined;
  method: HttpMethod;
  path: string;
  /**
   * What the contract puts before `path`: the Swagger 2.0 `basePath`, or the path part of its OpenAPI `servers`; empty when
   * it declares none, `undefined` when its servers disagree.
   */
  basePath: string | undefined;
  /** The contract document that declares the operation, repository-relative. */
  document: string;
  /** The line of the `operationId` in that document, or of the verb when there is none. */
  line: number;
  data: ContractData;
}

/** The data an operation exchanges, as digests that differ exactly when the data differs; documentation is left out. */
export interface ContractData {
  /** The parameters of the operation and of its path, and the request body. */
  request: string;
  response: string;
  /** The files other than the document that the data's references reach, repository-relative and sorted. */
  files: readonly string[];
  /** The references the data holds that the reader could not follow, so the digests do not cover what they name. */
  unresolved: readonly UnresolvedReference[];
}

export interface UnresolvedReference {
  ref: string;
  /** The repository file the reference names, when it names one. */
  file?: string;
}
