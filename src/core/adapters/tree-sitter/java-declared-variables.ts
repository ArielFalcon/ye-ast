import type { Node } from "web-tree-sitter";

/** Nodes that declare a variable under their `name` field. */
const VARIABLE_DECLARATIONS: ReadonlySet<string> = new Set(["variable_declarator", "formal_parameter", "spread_parameter", "catch_formal_parameter", "resource", "enhanced_for_statement"]);
/** Where a bare identifier declares a variable: a lambda parameter, or a pattern variable. */
const PATTERN_OR_LAMBDA: ReadonlySet<string> = new Set(["lambda_expression", "inferred_parameters", "instanceof_expression", "type_pattern", "record_pattern_component"]);
/** Where the variables declared inside belong to one method or constructor rather than to the scope around it. */
const CALLABLES: ReadonlySet<string> = new Set(["method_declaration", "constructor_declaration"]);

/** A method or constructor of a scope, by its span in the source, and the variables declared in it outside any method or constructor it holds. */
interface CallableVariables {
  start: number;
  end: number;
  names: ReadonlySet<string>;
}

/**
 * The variable names one scope declares, read in a single walk: the fields of every type in it, the other variables
 * declared outside every method and constructor, and those of each method and constructor.
 */
export interface DeclaredVariables {
  fields: ReadonlySet<string>;
  outside: ReadonlySet<string>;
  callables: readonly CallableVariables[];
}

/** Whether the scope declares a variable of the name anywhere but as a field. */
export function declaresLocal(scope: DeclaredVariables, name: string): boolean {
  return scope.outside.has(name) || scope.callables.some(({ names }) => names.has(name));
}

/** Whether the scope declares a variable of the name anywhere, a field included. */
export function declaresAnyVariable(scope: DeclaredVariables, name: string): boolean {
  return scope.fields.has(name) || declaresLocal(scope, name);
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
  const outside = new Set<string>();
  const callables: { start: number; end: number; names: Set<string> }[] = [];
  const pending: { node: Node; into: Set<string> }[] = [{ node: scope, into: outside }];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const { node } = next;
    let into = next.into;
    if (CALLABLES.has(node.type)) {
      into = new Set();
      callables.push({ start: node.startIndex, end: node.endIndex, names: into });
    }
    if (VARIABLE_DECLARATIONS.has(node.type)) {
      const name = node.childForFieldName("name")?.text;
      if (name !== undefined) (node.parent?.type === "field_declaration" ? fields : into).add(name);
    }
    if (node.type === "identifier" && PATTERN_OR_LAMBDA.has(node.parent?.type ?? "")) into.add(node.text);
    for (const child of node.namedChildren) if (child !== null) pending.push({ node: child, into });
  }
  return { fields, outside, callables };
}
