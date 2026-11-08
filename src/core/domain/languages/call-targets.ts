import { isExtractorConfiguration } from "./configuration.ts";
import { isJavaSource } from "./java.ts";
import { isAngularTemplate, isTypeScriptFile } from "./typescript.ts";

type Runtime = "java" | "typescript";

function runtimeOf(path: string): Runtime | undefined {
  if (isJavaSource(path)) return "java";
  return isTypeScriptFile(path) || isAngularTemplate(path) ? "typescript" : undefined;
}

/**
 * Whether a call written in `caller` may run a declaration of `declaration`: a configuration file declares nothing a
 * call runs, and a Java call never runs a TypeScript declaration nor the reverse. A file no predicate classifies may.
 */
export function mayRunDeclarationOf(caller: string, declaration: string): boolean {
  if (isExtractorConfiguration(declaration)) return false;
  const from = runtimeOf(caller);
  const to = runtimeOf(declaration);
  return from === undefined || to === undefined || from === to;
}
