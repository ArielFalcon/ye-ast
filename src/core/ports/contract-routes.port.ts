import type { ContractOperation } from "../domain/contracts/contract-operation.ts";
import type { Finding } from "../domain/shared/fact.ts";
import type { SourceFile } from "./entrypoint-extractor.port.ts";

export type { ContractOperation } from "../domain/contracts/contract-operation.ts";

/**
 * Reads the operations of the contract documents among the in-scope sources, following the references their data holds
 * into the other sources. A document the reader cannot parse is one `unknown` finding with its place; a document that
 * declares no operation contributes nothing.
 */
export interface ContractRoutes {
  operations(files: readonly SourceFile[]): readonly Finding<ContractOperation>[];
}
