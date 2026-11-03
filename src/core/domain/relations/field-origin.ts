import type { SymbolRef } from "./relation.ts";

/**
 * A class's own field whose value its declaration fixes for the life of the instance: what it injects or creates. `holds`
 * names a class of the repository, or a type from outside it as `<module>#<name>` (`global#<name>` for a name the file
 * neither imports nor declares).
 */
export interface FieldOrigin {
  owner: SymbolRef;
  field: string;
  holds: { class: SymbolRef } | { external: string };
}

/**
 * A local a declaration fixes: the class a function or constant takes from `inject()`. Calls made through it name the
 * members of that class, which the index leaves unresolved because it types no local.
 */
export interface LocalOrigin {
  owner: SymbolRef;
  local: string;
  holds: { class: SymbolRef };
}
