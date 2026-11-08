import type { OperationRequest, OperationShape } from "../domain/contracts/payload-shape.ts";
import type { Finding } from "../domain/shared/fact.ts";
import type { SourceFile } from "./entrypoint-extractor.port.ts";

export type { OperationRequest, OperationShape } from "../domain/contracts/payload-shape.ts";

/**
 * Reads the shapes of the success responses of the operations the in-scope sources of one snapshot declare or implement.
 * An operation whose response the reader cannot state is one `unknown` finding with its place; a source that declares no
 * operation contributes nothing.
 */
export interface PayloadShapes {
  responses(files: readonly SourceFile[]): readonly Finding<OperationShape>[];
  /** What the operations accept, in the request direction; absent for a reader that states no request. */
  requests?(files: readonly SourceFile[]): readonly Finding<OperationRequest>[];
}
