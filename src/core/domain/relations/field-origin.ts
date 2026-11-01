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
