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

/** Bodies whose fields `this` and an unshadowed bare name reach: they hide the variables of an enclosing member. */
export const TYPE_BODIES: ReadonlySet<string> = new Set(["class_body", "interface_body", "enum_body"]);
/** Statement lists whose earlier statements declare locals and introduce pattern variables for the statements after them. */
const STATEMENT_LISTS: ReadonlySet<string> = new Set(["block", "constructor_body", "switch_block_statement_group"]);
/** Pattern nodes that declare a variable under an identifier child. */
const BINDING_PATTERNS: ReadonlySet<string> = new Set(["type_pattern", "record_pattern_component"]);
/** Statements that cannot complete normally (JLS 14.22). */
const JUMPS: ReadonlySet<string> = new Set(["return_statement", "throw_statement", "break_statement", "continue_statement", "yield_statement"]);
/** Statements that complete normally when they are reached (JLS 14.22). */
const SIMPLE_STATEMENTS: ReadonlySet<string> = new Set(["expression_statement", "local_variable_declaration", "assert_statement"]);

/** A variable in scope at a place; `unsettled` carries the name of a pattern variable whose flow scope the reading does not decide. */
export type VariableInScope = { declaration: Node } | { unsettled: Node } | undefined;
type Found = VariableInScope;
type Completion = boolean | "unknown";

/**
 * The innermost declaration of a local variable, a parameter or a pattern variable of the name in scope at `at`
 * (JLS 6.3, 6.3.1): a parameter of a method, a constructor or a lambda whose body holds it; a local an enclosing block
 * declares before it, a switch block in an earlier group; the variable of a `for`, an enhanced `for`, a `catch` or a resource around it, a resource also in
 * the resources after it; the pattern variable of a `switch` label in its rule or group and in the guard, and the
 * pattern variable an `instanceof` introduces where its condition is decided true or false: the operand after `&&` or
 * `||`, a branch of a conditional, `if` or loop, and the statements after an `if` or a loop that cannot complete
 * normally otherwise. `stopAtType` stops at the type body around `at`, whose fields hide the variables of enclosing
 * members. A pattern variable the statements after a statement may hold, where the reading cannot decide whether that
 * statement completes normally, is `unsettled`.
 */
export function variableInScope(name: string, at: Node, { stopAtType }: { stopAtType: boolean }): VariableInScope {
  for (let inner: Node = at, around = at.parent; around !== null; inner = around, around = around.parent) {
    if (stopAtType && TYPE_BODIES.has(around.type)) return undefined;
    const found = declaredAround(around, inner, name);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Whether a local variable, a parameter or a pattern variable of the name is decided in scope at `at`. */
export function declaresInScope(name: string, at: Node): boolean {
  const found = variableInScope(name, at, { stopAtType: false });
  return found !== undefined && "declaration" in found;
}

function declaredAround(around: Node, inner: Node, name: string): Found {
  const holdsInBody = around.childForFieldName("body")?.id === inner.id;
  const among = (declarations: readonly (Node | null | undefined)[]): Found => {
    const declaration = declarations.find((candidate) => candidate != null && declaredName(candidate)?.text === name);
    return declaration == null ? undefined : { declaration };
  };
  switch (around.type) {
    case "method_declaration":
    case "constructor_declaration":
    case "lambda_expression": {
      if (!holdsInBody) return undefined;
      const parameters = around.childForFieldName("parameters");
      return among(parameters?.type === "identifier" ? [parameters] : parameters?.namedChildren ?? []);
    }
    case "block":
    case "constructor_body":
      return statementsBefore(around, inner, name);
    case "switch_block_statement_group":
    case "switch_rule":
      return among(labelPatterns(around, inner)) ?? (around.type === "switch_block_statement_group" ? statementsBefore(around, inner, name) : undefined);
    case "switch_block":
      return among(around.namedChildren.filter((group) => group?.type === "switch_block_statement_group" && group.endIndex <= inner.startIndex).flatMap((group) => group!.namedChildren.flatMap((statement) => (statement?.type === "local_variable_declaration" ? declarators(statement) : []))));
    case "for_statement": {
      const init = around.childForFieldName("init");
      const locals = init?.type === "local_variable_declaration" && init.id !== inner.id ? among(declarators(init)) : undefined;
      const condition = around.childForFieldName("condition");
      const decided = condition !== null && inner.id !== condition.id && inner.id !== init?.id ? among(introduced(condition, true)) : undefined;
      return locals ?? decided;
    }
    case "enhanced_for_statement":
    case "catch_clause":
      return holdsInBody ? among(around.type === "catch_clause" ? around.namedChildren.filter((child) => child?.type === "catch_formal_parameter") : [around]) : undefined;
    case "try_with_resources_statement":
      return holdsInBody ? among(around.childForFieldName("resources")?.namedChildren ?? []) : undefined;
    case "resource_specification":
      return among(around.namedChildren.filter((resource) => resource !== null && resource.endIndex <= inner.startIndex));
    case "if_statement":
    case "while_statement":
    case "ternary_expression": {
      const condition = around.childForFieldName("condition");
      if (condition === null) return undefined;
      const consequence = around.childForFieldName(around.type === "while_statement" ? "body" : "consequence");
      const alternative = around.childForFieldName("alternative");
      return inner.id === consequence?.id ? among(introduced(condition, true)) : inner.id === alternative?.id ? among(introduced(condition, false)) : undefined;
    }
    case "binary_expression": {
      const operator = around.childForFieldName("operator")?.type;
      const left = around.childForFieldName("left");
      if (left === null || around.childForFieldName("right")?.id !== inner.id || (operator !== "&&" && operator !== "||")) return undefined;
      return among(introduced(left, operator === "&&"));
    }
    default:
      return undefined;
  }
}

/** The locals the statements of a list before `inner` declare, then the pattern variables those statements introduce after them, the nearest first. */
function statementsBefore(list: Node, inner: Node, name: string): Found {
  const before = list.namedChildren.filter((child): child is Node => child !== null && child.endIndex <= inner.startIndex);
  const local = before.flatMap((statement) => (statement.type === "local_variable_declaration" ? declarators(statement) : [])).find((declarator) => declaredName(declarator)?.text === name);
  if (local !== undefined) return { declaration: local };
  for (const statement of before.reverse()) {
    const after = introducedAfter(statement);
    const declaration = after.declarations.find((candidate) => declaredName(candidate)?.text === name);
    if (declaration !== undefined) return after.settled ? { declaration } : { unsettled: declaredName(declaration)! };
  }
  return undefined;
}

/**
 * The pattern variables a statement introduces for the statements after it (JLS 6.3.2): an `if` without `else` whose
 * branch cannot complete normally introduces what its condition introduces when false; an `if` with `else`, what its
 * condition introduces for the branch that completes normally when the other cannot; a `while`, `do` or `for` loop,
 * what its condition introduces when false when its body holds no `break`. `settled` is false where the reading cannot
 * decide whether a branch completes normally or whether a `break` exits the loop.
 */
function introducedAfter(statement: Node): { declarations: Node[]; settled: boolean } {
  const none = { declarations: [], settled: true };
  const condition = statement.childForFieldName("condition");
  if (statement.type === "labeled_statement") {
    const labeled = introducedAfter(statement.namedChildren.at(-1) ?? statement);
    return labeled.declarations.length === 0 ? none : { declarations: labeled.declarations, settled: false };
  }
  if (condition === null) return none;
  if (statement.type === "if_statement") {
    const consequence = completes(statement.childForFieldName("consequence"));
    const alternative = statement.childForFieldName("alternative");
    if (alternative === null) return decided(introduced(condition, false), consequence === false, consequence === "unknown");
    const otherwise = completes(alternative);
    const whenTrue = decided(introduced(condition, true), consequence === true && otherwise === false, consequence === "unknown" || otherwise === "unknown");
    return whenTrue.declarations.length > 0 ? whenTrue : decided(introduced(condition, false), consequence === false && otherwise === true, consequence === "unknown" || otherwise === "unknown");
  }
  if (statement.type === "while_statement" || statement.type === "do_statement" || statement.type === "for_statement") {
    const body = statement.childForFieldName("body");
    const breaks = body !== null && body.descendantsOfType("break_statement").length > 0;
    return decided(introduced(condition, false), !breaks, breaks);
  }
  return none;
}

function decided(declarations: Node[], introduces: boolean, undecided: boolean): { declarations: Node[]; settled: boolean } {
  if (declarations.length === 0 || (!introduces && !undecided)) return { declarations: [], settled: true };
  return { declarations, settled: !undecided };
}

/** Whether a statement can complete normally (JLS 14.22), where the reading decides it without constant expressions or `break` targets. */
function completes(statement: Node | null): Completion {
  if (statement === null) return true;
  if (JUMPS.has(statement.type)) return false;
  if (SIMPLE_STATEMENTS.has(statement.type)) return true;
  if (statement.type === "block") {
    const last = statement.namedChildren.filter((child) => child !== null && child.type !== "line_comment" && child.type !== "block_comment").at(-1);
    return last == null ? true : completes(last);
  }
  if (statement.type === "synchronized_statement") return completes(statement.childForFieldName("body"));
  if (statement.type === "if_statement") {
    const alternative = statement.childForFieldName("alternative");
    if (alternative === null) return true;
    const branches = [completes(statement.childForFieldName("consequence")), completes(alternative)];
    return branches.includes(true) ? true : branches.includes("unknown") ? "unknown" : false;
  }
  return "unknown";
}

/** The pattern variables an expression introduces when it is `truth` (JLS 6.3.1). */
function introduced(expression: Node, truth: boolean): Node[] {
  switch (expression.type) {
    case "parenthesized_expression":
      return expression.namedChildren[0] == null ? [] : introduced(expression.namedChildren[0], truth);
    case "unary_expression": {
      const operand = expression.childForFieldName("operand");
      return expression.childForFieldName("operator")?.type === "!" && operand !== null ? introduced(operand, !truth) : [];
    }
    case "binary_expression": {
      const operator = expression.childForFieldName("operator")?.type;
      if ((operator !== "&&" || !truth) && (operator !== "||" || truth)) return [];
      return [expression.childForFieldName("left"), expression.childForFieldName("right")].flatMap((operand) => (operand === null ? [] : introduced(operand, truth)));
    }
    case "instanceof_expression":
      return truth ? patternVariables(expression) : [];
    default:
      return [];
  }
}

/** The pattern variables the labels of a `switch` rule or group declare, with those its guard introduces for its body. */
function labelPatterns(around: Node, inner: Node): Node[] {
  return around.namedChildren.flatMap((label) => {
    if (label?.type !== "switch_label") return [];
    const patterns = label.namedChildren.filter((child) => child?.type === "pattern").flatMap((pattern) => patternVariables(pattern!));
    const guard = label.namedChildren.find((child) => child?.type === "guard")?.namedChildren[0];
    return inner.id === label.id || guard == null ? patterns : [...patterns, ...introduced(guard, true)];
  });
}

/** The declarations of the variables a pattern, or an `instanceof` with a pattern, binds, nested record patterns included. */
function patternVariables(pattern: Node): Node[] {
  if (pattern.type === "instanceof_expression" && pattern.childForFieldName("name") !== null) return [pattern];
  return [pattern, ...pattern.descendantsOfType([...BINDING_PATTERNS])].filter((node): node is Node => node !== null && BINDING_PATTERNS.has(node.type) && declaredName(node) !== undefined);
}

/** The name a declaration declares: its `name`, the identifier of a pattern, of a spread parameter's declarator, or the identifier of a lambda parameter. */
export function declaredName(declaration: Node): Node | undefined {
  if (declaration.type === "identifier") return declaration;
  if (BINDING_PATTERNS.has(declaration.type)) return declaration.namedChildren.find((child) => child?.type === "identifier") ?? undefined;
  if (declaration.type === "spread_parameter") return declaration.namedChildren.find((child) => child?.type === "variable_declarator")?.childForFieldName("name") ?? undefined;
  return declaration.childForFieldName("name") ?? undefined;
}

function declarators(declaration: Node): Node[] {
  return declaration.childrenForFieldName("declarator").filter((declarator): declarator is Node => declarator !== null);
}
