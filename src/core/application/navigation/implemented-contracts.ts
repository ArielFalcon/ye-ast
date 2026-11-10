import { hasTyping } from "../../domain/languages/profiles.ts";
import { kindOfChangedFile } from "../../domain/change/changed-file.ts";
import type { CodeGraphReader, GraphNodeId } from "../../ports/code-graph.port.ts";
import type { ImplementedDeclarations, ImportOrigins } from "../../ports/import-origins.port.ts";
import type { GraphNavigation } from "./graph-navigation.ts";

/**
 * The supertype declarations of every Java method whose class has a supertype in the repository, asked of the origins once
 * for a reading (RFC-0024 U4). The graph gives the methods; a method with no repository supertype is never asked.
 */
export async function implementedContractsOf(store: CodeGraphReader, files: readonly string[], navigation: GraphNavigation, origins: ImportOrigins | undefined): Promise<ReadonlyMap<GraphNodeId, ImplementedDeclarations>> {
  if (origins === undefined) return new Map();
  const methods = store.symbolsInFiles(files).filter((symbol) => symbol.kind === "method" && hasTyping(symbol.file, "nominal") && kindOfChangedFile(symbol.file) !== "test" && navigation.ownersOf(symbol).some((owner) => navigation.typesAround(owner, "up").length > 0));
  if (methods.length === 0) return new Map();
  const answers = await origins.implementedDeclarations(methods.map((symbol) => ({ file: symbol.file, start: symbol.startLine, name: symbol.name })));
  return new Map(methods.map((symbol, index) => [symbol.id, answers[index] ?? { kind: "unknown" }]));
}
