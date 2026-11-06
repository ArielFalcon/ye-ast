import type { RawRouteFile } from "./angular-router.extractor.ts";

/** The declaration an exported name comes down to. */
export interface Declaration {
  file: string;
  name: string;
}

/** What a file declares, imports and exports at its top level. */
export type ModuleShape = Pick<RawRouteFile, "exports" | "declared" | "imports" | "stars">;

export type DeclarationLookup = (file: string, name: string, trail?: ReadonlySet<string>) => Promise<Declaration | undefined>;

/** `ambiguous`: two `export *` the chain passes could supply the name, so the sources do not say which declaration it is. */
export type ExportLookup = (file: string, name: string) => Promise<Declaration | "ambiguous" | undefined>;

/** `createDeclarationLookup`, telling a chain that two star exports could supply apart from one that ends nowhere. */
export function createExportLookup(
  parse: (file: string) => Promise<ModuleShape | undefined>,
  fileOf: (from: string, specifier: string) => Promise<string | undefined>,
): ExportLookup {
  /** As a module resolves an export: a star export that is ambiguous anywhere along the chain makes the name ambiguous. */
  return async (file, name) => {
    let ambiguous = false;
    const found = await createDeclarationLookup(parse, fileOf, () => (ambiguous = true))(file, name);
    return ambiguous ? "ambiguous" : found;
  };
}

/**
 * The one declaration `name` exported by `file` comes down to, following renames, `export { x } from`, `export *` and
 * re-exported imports; undefined when the chain ends nowhere, loops, or reaches two declarations.
 */
export function createDeclarationLookup(
  parse: (file: string) => Promise<ModuleShape | undefined>,
  fileOf: (from: string, specifier: string) => Promise<string | undefined>,
  onAmbiguous?: () => void,
): DeclarationLookup {
  const declarationOf: DeclarationLookup = async (file, name, trail = new Set()) => {
    const key = `${file}\0${name}`;
    if (trail.has(key)) return undefined;
    const raw = await parse(file);
    if (raw === undefined) return undefined;
    const next = new Set(trail).add(key);
    const explicit = raw.exports.get(name);
    if (explicit !== undefined) {
      if ("module" in explicit) {
        const target = await fileOf(file, explicit.module);
        return target === undefined ? undefined : declarationOf(target, explicit.imported, next);
      }
      if (raw.declared.has(explicit.local)) return { file, name: explicit.local };
      const imported = raw.imports.get(explicit.local);
      if (imported === undefined) return undefined;
      const target = await fileOf(file, imported.module);
      return target === undefined ? undefined : declarationOf(target, imported.imported, next);
    }
    /* An explicit export wins over `export *`, which never re-exports a default. */
    if (name === "default") return undefined;
    const found = new Map<string, Declaration>();
    for (const star of raw.stars) {
      const target = await fileOf(file, star);
      if (target === undefined) continue;
      const declaration = await declarationOf(target, name, next);
      if (declaration !== undefined) found.set(`${declaration.file}\0${declaration.name}`, declaration);
    }
    if (found.size > 1) onAmbiguous?.();
    return found.size === 1 ? [...found.values()][0] : undefined;
  };
  return declarationOf;
}
