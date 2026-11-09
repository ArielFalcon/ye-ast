import type { Node } from "web-tree-sitter";

/** Nodes that declare a variable under their `name` field. */
const VARIABLE_DECLARATIONS: ReadonlySet<string> = new Set(["variable_declarator", "formal_parameter", "spread_parameter", "catch_formal_parameter", "resource", "enhanced_for_statement"]);
/** Where a bare identifier declares a variable: a lambda parameter, or a pattern variable. */
const PATTERN_OR_LAMBDA: ReadonlySet<string> = new Set(["lambda_expression", "inferred_parameters", "instanceof_expression", "type_pattern", "record_pattern_component"]);
/**
 * The variable names one scope declares, read in a single walk: the fields of every type in it, and every other
 * variable declared anywhere in it.
 */
export interface DeclaredVariables {
  fields: ReadonlySet<string>;
  locals: ReadonlySet<string>;
  localPlaces: ReadonlyMap<string, readonly { start: number; end: number }[]>;
}

/** Whether the scope declares a variable of the name anywhere but as a field. */
export function declaresLocal(scope: DeclaredVariables, name: string, at?: Node): boolean {
  return at === undefined ? scope.locals.has(name) : (scope.localPlaces.get(name) ?? []).some(({ start, end }) => start <= at.startIndex && at.endIndex <= end);
}

/** Whether the scope declares a variable of the name anywhere, a field included. */
export function declaresAnyVariable(scope: DeclaredVariables, name: string): boolean {
  return scope.fields.has(name) || scope.locals.has(name);
}

/**
 * A reader of the variables a scope declares that walks each scope once for its life. Scopes are told apart by their
 * node's id, so every tree it reads stays alive while the reader is used.
 */
export function declaredVariablesOnce(): (scope: Node) => DeclaredVariables {
  const read = new Map<number, DeclaredVariables>();
  return (scope) => {
    let declared = read.get(scope.id);
    if (declared === undefined) {
      declared = declaredVariables(scope);
      read.set(scope.id, declared);
    }
    return declared;
  };
}

function declaredVariables(scope: Node): DeclaredVariables {
  const fields = new Set<string>();
  const locals = new Set<string>();
  const localPlaces = new Map<string, { start: number; end: number }[]>();
  const keepLocal = (name: string, node: Node) => {
    locals.add(name);
    let owner = node.parent;
    while (owner !== null && owner.type !== "method_declaration" && owner.type !== "constructor_declaration") owner = owner.parent;
    localPlaces.set(name, [...(localPlaces.get(name) ?? []), { start: owner?.startIndex ?? scope.startIndex, end: owner?.endIndex ?? scope.endIndex }]);
  };
  const pending: Node[] = [scope];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (VARIABLE_DECLARATIONS.has(node.type)) {
      const name = node.childForFieldName("name")?.text;
      if (name !== undefined) (node.parent?.type === "field_declaration" ? fields.add(name) : keepLocal(name, node));
    }
    if (node.type === "identifier" && PATTERN_OR_LAMBDA.has(node.parent?.type ?? "")) keepLocal(node.text, node);
    for (const child of node.namedChildren) if (child !== null) pending.push(child);
  }
  return { fields, locals, localPlaces };
}

/** The type parameter of the innermost declaration around `name` that declares one spelled `spelling`. */
export function typeVariableAround(name: Node, spelling = name.text): Node | undefined {
  for (let scope = name.parent; scope !== null; scope = scope.parent) {
    const parameters = scope.childForFieldName("type_parameters");
    const found = parameters?.namedChildren.find((parameter) => parameter?.namedChildren[0]?.text === spelling);
    if (found !== undefined && found !== null) return found;
  }
  return undefined;
}
