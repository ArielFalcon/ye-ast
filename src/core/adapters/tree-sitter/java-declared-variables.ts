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

/**
 * Whether a local variable or a parameter of the name is in scope at `at` (JLS 6.3): a parameter of a method, a
 * constructor or a lambda whose body holds it, a local an enclosing block declares before it, or the variable of a `for`,
 * an enhanced `for`, a `catch` or a resource around it. A pattern variable, whose scope follows flow, is not read.
 */
export function declaresInScope(name: string, at: Node): boolean {
  for (let inner: Node = at, around = at.parent; around !== null; inner = around, around = around.parent) {
    if (declaredAround(around, inner).some((declared) => declared?.text === name)) return true;
  }
  return false;
}

function declaredAround(around: Node, inner: Node): (Node | null)[] {
  const holdsInBody = around.childForFieldName("body")?.id === inner.id;
  switch (around.type) {
    case "method_declaration":
    case "constructor_declaration":
    case "lambda_expression": {
      if (!holdsInBody) return [];
      const parameters = around.childForFieldName("parameters");
      if (parameters?.type === "identifier") return [parameters];
      return (parameters?.namedChildren ?? []).map((parameter) => (parameter?.type === "identifier" ? parameter : parameter?.type === "spread_parameter" ? parameter.namedChildren.find((child) => child?.type === "variable_declarator")?.childForFieldName("name") ?? null : parameter?.childForFieldName("name") ?? null));
    }
    case "block":
    case "constructor_body":
    case "switch_block_statement_group":
      return around.namedChildren.filter((child) => child !== null && child.type === "local_variable_declaration" && child.endIndex <= inner.startIndex).flatMap((declaration) => declaratorNames(declaration!));
    case "for_statement": {
      const init = around.childForFieldName("init");
      return init?.type === "local_variable_declaration" && init.id !== inner.id ? declaratorNames(init) : [];
    }
    case "enhanced_for_statement":
    case "catch_clause":
      return holdsInBody ? [around.type === "catch_clause" ? around.namedChildren.find((child) => child?.type === "catch_formal_parameter")?.childForFieldName("name") ?? null : around.childForFieldName("name")] : [];
    case "try_with_resources_statement":
      return holdsInBody ? (around.childForFieldName("resources")?.namedChildren ?? []).map((resource) => resource?.childForFieldName("name") ?? null) : [];
    default:
      return [];
  }
}

function declaratorNames(declaration: Node): (Node | null)[] {
  return declaration.childrenForFieldName("declarator").map((declarator) => declarator?.childForFieldName("name") ?? null);
}
