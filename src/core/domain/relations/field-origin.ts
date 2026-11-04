import type { SymbolRef } from "./relation.ts";

/**
 * A class field's injected or constructed initializer. Exact member settlement also requires scope and stability evidence. `holds`
 * names a class of the repository, or a type from outside it as `<module>#<name>` (`global#<name>` for a name the file
 * neither imports nor declares).
 */
export interface FieldOrigin {
  owner: SymbolRef;
  field: string;
  holds: { class: SymbolRef } | { external: string };
}

/**
 * A constant local's initial injected class. A member call also requires evidence of lexical binding and stability.
 */
export interface LocalOrigin {
  owner: SymbolRef;
  local: string;
  holds: { class: SymbolRef };
}
