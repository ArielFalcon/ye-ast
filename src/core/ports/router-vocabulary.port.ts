import type { FrameworkSignal } from "./framework-plugin.port.ts";

/** A name as written: the import that binds its first identifier (`imported` is `*` for a namespace) and the member names after it. */
export interface ImportedName {
  binding?: { module: string; imported: string };
  members: readonly string[];
}

/**
 * What a framework's router means, declared once by its plugin (ADR-0045 decision 12) and read by the route readers of
 * the language it is written in, which never spell it themselves.
 */
export interface RouterVocabulary {
  signal: FrameworkSignal;
  /** The routes a call with this callee registers: the root's or a child's; none for any other call. */
  configurationOf(callee: ImportedName): "root" | "child" | undefined;
  /** Whether a name is the router's own module, which composes no table of the sources. */
  isRouterModule(name: ImportedName): boolean;
}
