import { isExtractorConfiguration } from "./configuration.ts";
import { isJavaSource } from "./java.ts";
import { isAngularTemplate, isTypeScriptFile } from "./typescript.ts";

type Runtime = "java" | "typescript";

function runtimeOf(path: string): Runtime | undefined {
  if (isJavaSource(path)) return "java";
  return isTypeScriptFile(path) || isAngularTemplate(path) ? "typescript" : undefined;
}

/**
 * Whether code in `from` may name, read or run a declaration of `to`: Java code never reaches a TypeScript declaration
 * nor the reverse. A file no predicate classifies, a configuration file among them, may be reached from either.
 */
export function sharesRuntime(from: string, to: string): boolean {
  const caller = runtimeOf(from);
  const declaration = runtimeOf(to);
  return caller === undefined || declaration === undefined || caller === declaration;
}

/** Whether a call written in `caller` may run a declaration of `declaration`: a configuration file declares nothing a call runs. */
export function mayRunDeclarationOf(caller: string, declaration: string): boolean {
  return !isExtractorConfiguration(declaration) && sharesRuntime(caller, declaration);
}
