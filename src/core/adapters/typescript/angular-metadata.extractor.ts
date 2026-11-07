import ts from "typescript";
import { declarationCounts, isStatic } from "./syntax-names.ts";
import type { RawRouteFile } from "./angular-router.extractor.ts";
import { thisClass, unwrapped } from "./syntax.ts";
import { angularCoreExport, type FileNames } from "./angular-injection.ts";
import { TYPESCRIPT_LIB_GLOBALS } from "./typescript-lib-globals.ts";

/** A name as written: `Foo`, or `ns.Foo` for a member of a namespace import. */
export interface RawReference {
  name: string;
  member?: string;
}

export type RawOperand = { reference: RawReference; line: number } | { unreadable: true; line: number };

export type RawText = { text: string } | { unreadable: true; line: number };

export type RawTemplate = { inline: { text: string; line: number } } | { url: string; line: number } | { unreadable: true; line: number };

export interface RawAngularClass {
  kind: "component" | "directive" | "pipe" | "module";
  name: string;
  line: number;
  selector?: RawText;
  pipeName?: RawText;
  template?: RawTemplate;
  imports: RawOperand[];
  declarations: RawOperand[];
  exports: RawOperand[];
  hostDirectives: RawOperand[];
}

/** What an injection asks for: a name, or an expression that is none. */
export type RawTarget = { reference: RawReference } | { opaque: true };

/** An `inject()` call, a constructor parameter of a decorated class or an `@Inject` parameter, with the declaration it sits in. */
export interface RawInjection {
  owner?: { name: string; line: number };
  /** The local the call initializes, when it is the whole initializer of a variable declaration. */
  local?: string;
  localScope?: { start: number; end: number };
  inlineMember?: { name: string; line: number; column: number; referenceName: string };
  target: RawTarget;
  line: number;
}

/** A field of a class that its declaration fixes: an `inject()` or a constructor parameter property, or a `new` expression. */
export interface RawField {
  owner: { name: string; line: number };
  field: string;
  target: RawTarget;
  via: "inject" | "new";
}

export interface RawInstanceMethod { className: string; classLine: number; name: string; line: number }
export interface RawFieldCall { owner: { name: string; line: number }; field: string; member: string; line: number; column: number }
export interface RawLocalCall { owner: { name: string; line: number }; local: string; member: string; offset: number; line: number; column: number }
/**
 * The object a write or a reflective mutation changes: an instance of the class around `this`, what a field of that class
 * holds, a class or a value the file binds by import or top-level declaration (`prototype`: the class's prototype), or
 * an object the syntax does not place.
 */
export type RawWriteTarget =
  | { self: { name: string; line: number } }
  | { field: { owner: { name: string; line: number }; field: string } }
  | { binding: RawReference; whole?: true }
  | { prototype: RawReference }
  | { unplaced: true };
/** A write to `member` of the target, or to members no syntax names when `member` is absent. */
export interface RawWrite { target: RawWriteTarget; member?: string; line: number }
/**
 * A value that leaves its holder for code the reader does not follow: a field read used as a value, the instance an
 * `inject()` or a typed constructor parameter gives, or a field read through another object, by its name.
 */
export type RawPassed = { field: { owner: { name: string; line: number }; field: string } } | { instance: RawReference } | { fieldNamed: string };
/** `base` is the extended class as written: a platform class the file neither declares nor imports, or none when the heritage expression names no class (`extends mixin(Base)`). */
export interface RawSubclass { name?: string; line: number; base?: RawReference | "platform"; members: Set<string> }
export interface RawMemberEvidence {
  methods: RawInstanceMethod[];
  calls: RawFieldCall[];
  localCalls: RawLocalCall[];
  reads: Map<string, number>;
  declarations: Map<string, number>;
  escapedClasses: Set<string>;
  writes: RawWrite[];
  /** The classes that extend another, with the class they extend and the instance members they declare or assign. */
  subclasses: RawSubclass[];
  passed: RawPassed[];
  /** `<class>\0<line>\0<field>`: the fields other code cannot read, `private`, `protected` or `#` ones. */
  hidden: Set<string>;
  /** `ns.Name` references through a namespace import: with the imports, what the file can name. */
  qualified: RawReference[];
  /** A mutation API (`Object.assign`, `Reflect.set`, …) used as a value: what it changes cannot be bounded. */
  escapedMutator: boolean;
  unknownBinding: boolean;
  unknownProvider: boolean;
}

export interface RawSubstitution { reference: RawReference; line: number; by?: RawReference }

export interface RawAngularFile {
  classes: RawAngularClass[];
  memberEvidence: RawMemberEvidence;
  injections: RawInjection[];
  fields: RawField[];
  /**
   * The tokens a provider of this file replaces: `{ provide: X, useClass | useExisting | useFactory | useValue }`, or the
   * class an `@Injectable` with one of those options decorates; `by` is the class a `useClass` or `useExisting` names.
   */
  substituted: RawSubstitution[];
  /** The top-level arrays of this file, by name, read as lists of operands. */
  arrays: Map<string, RawOperand[]>;
}

const KINDS: Readonly<Record<string, RawAngularClass["kind"]>> = { Component: "component", Directive: "directive", Pipe: "pipe", NgModule: "module" };
/** The decorators whose classes the framework constructs with their constructor parameters. */
const CONSTRUCTED = new Set([...Object.keys(KINDS), "Injectable"]);

/** The Angular decorators, injection calls and top-level arrays of one parsed file. `shape` tells which names come from `@angular/core`. */
export function readAngularMetadataFile(sf: ts.SourceFile, shape: Pick<RawRouteFile, "imports">, proveMembers = false, coreExternal = true): RawAngularFile {
  const line = (node: ts.Node): number => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const declarations = declarationCounts(sf);
  const result: RawAngularFile = { classes: [], memberEvidence: proveMembers ? readMemberEvidence(sf, declarations, shape) : { methods: [], calls: [], localCalls: [], reads: new Map(), declarations, escapedClasses: new Set(), writes: [], subclasses: [], passed: [], hidden: new Set(), qualified: [], escapedMutator: false, unknownBinding: false, unknownProvider: false }, injections: [], fields: [], substituted: [], arrays: new Map() };

  const names: FileNames = { imports: shape.imports, declared: declarations };
  const coreName = (expression: ts.Expression): string | undefined => (coreExternal ? angularCoreExport(expression, names) : undefined);
  const decoratorsOf = (node: ts.Node): Map<string, ts.CallExpression> => {
    const found = new Map<string, ts.CallExpression>();
    for (const decorator of ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : []) {
      const name = ts.isCallExpression(decorator.expression) ? coreName(decorator.expression.expression) : undefined;
      if (name !== undefined) found.set(name, decorator.expression as ts.CallExpression);
    }
    return found;
  };
  const referenceOf = (expression: ts.Expression): RawReference | undefined => {
    const e = unwrapped(expression);
    if (ts.isIdentifier(e)) return { name: e.text };
    if (ts.isPropertyAccessExpression(e) && !e.questionDotToken && ts.isIdentifier(e.expression)) return { name: e.expression.text, member: e.name.text };
    return undefined;
  };
  const textOf = (expression: ts.Expression): string | undefined => {
    const e = unwrapped(expression);
    return ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) ? e.text : undefined;
  };
  const targetOf = (expression: ts.Expression): RawTarget => {
    const reference = referenceOf(expression);
    return reference === undefined ? { opaque: true } : { reference };
  };
  /** Erased token arguments identify a relation; field/local receiver evidence keeps its existing syntax contract. */
  const injectionTargetOf = (expression: ts.Expression): RawTarget => {
    const e = unwrapped(expression);
    return ts.isExpressionWithTypeArguments(e) ? (e.typeArguments?.length ? targetOf(e.expression) : { opaque: true }) : targetOf(e);
  };
  const operandsOf = (expression: ts.Expression): RawOperand[] => {
    const e = unwrapped(expression);
    if (ts.isArrayLiteralExpression(e)) return e.elements.flatMap((element) => operandsOf(element));
    if (ts.isSpreadElement(e)) return operandsOf(e.expression);
    /* `Module.forRoot(...)` stands for the module. */
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)) return operandsOf(e.expression.expression);
    const reference = referenceOf(e);
    return reference === undefined ? [{ unreadable: true, line: line(e) }] : [{ reference, line: line(e) }];
  };
  const hostDirectivesOf = (expression: ts.Expression): RawOperand[] => {
    const e = unwrapped(expression);
    if (!ts.isArrayLiteralExpression(e)) return operandsOf(e);
    return e.elements.flatMap((element) => {
      const entry = unwrapped(element);
      if (!ts.isObjectLiteralExpression(entry)) return operandsOf(entry);
      const directive = propertyOf(entry, "directive");
      return directive === undefined ? [{ unreadable: true as const, line: line(entry) }] : operandsOf(directive);
    });
  };
  const substitutionOf = (reference: RawReference, provider: ts.ObjectLiteralExpression): RawSubstitution => {
    const options = SUBSTITUTIONS.flatMap((option) => { const value = propertyOf(provider, option); return value === undefined ? [] : [[option, value] as const]; });
    const [option, value] = options.length === 1 ? options[0]! : [];
    const by = value !== undefined && (option === "useClass" || option === "useExisting") ? referenceOf(value) : undefined;
    return { reference, line: line(provider), ...(by === undefined ? {} : { by }) };
  };
  const textOrUnreadable = (expression: ts.Expression): RawText => {
    const text = textOf(expression);
    return text === undefined ? { unreadable: true, line: line(expression) } : { text };
  };

  const classOf = (name: ts.Identifier, decorators: Map<string, ts.CallExpression>): void => {
    const [kindName, decorator] = [...decorators].find(([decorated]) => decorated in KINDS) ?? [];
    if (kindName === undefined || decorator === undefined) return;
    const argument = decorator.arguments[0] !== undefined ? unwrapped(decorator.arguments[0]) : undefined;
    const metadata = argument !== undefined && ts.isObjectLiteralExpression(argument) ? argument : undefined;
    const read = <T>(property: string, parse: (expression: ts.Expression) => T): T | undefined => {
      const expression = metadata === undefined ? undefined : propertyOf(metadata, property);
      return expression === undefined ? undefined : parse(expression);
    };
    const raw: RawAngularClass = {
      kind: KINDS[kindName]!,
      name: name.text,
      line: line(name),
      imports: read("imports", operandsOf) ?? [],
      declarations: read("declarations", operandsOf) ?? [],
      exports: read("exports", operandsOf) ?? [],
      hostDirectives: read("hostDirectives", hostDirectivesOf) ?? [],
    };
    const selector = read("selector", textOrUnreadable);
    if (selector !== undefined) raw.selector = selector;
    const pipeName = read("name", textOrUnreadable);
    if (pipeName !== undefined && raw.kind === "pipe") raw.pipeName = pipeName;
    const template = read("template", (expression): RawTemplate => {
      const text = textOf(expression);
      return text === undefined ? { unreadable: true, line: line(expression) } : { inline: { text, line: line(expression) } };
    });
    const url = read("templateUrl", (expression): RawTemplate => {
      const text = textOf(expression);
      return text === undefined ? { unreadable: true, line: line(expression) } : { url: text, line: line(expression) };
    });
    const chosen = template ?? url;
    if (chosen !== undefined && raw.kind === "component") raw.template = chosen;
    result.classes.push(raw);
  };

  const parametersOf = (node: ts.ClassDeclaration, name: ts.Identifier): void => {
    const owner = { name: name.text, line: line(name) };
    for (const member of node.members) {
      if (!ts.isConstructorDeclaration(member)) continue;
      for (const parameter of member.parameters) {
        const parameterDecorators = decoratorsOf(parameter);
        const inject = parameterDecorators.get("Inject");
        if (inject !== undefined) {
          const argument = inject.arguments[0];
          result.injections.push({ owner, target: argument === undefined ? { opaque: true } : injectionTargetOf(argument), line: line(parameter) });
        } else if (!parameterDecorators.has("Attribute")) {
          const reference = parameter.type === undefined ? undefined : typeReference(parameter.type);
          if (reference !== undefined) result.injections.push({ owner, target: { reference }, line: line(parameter) });
        }
      }
    }
  };

  const fieldsOf = (node: ts.ClassDeclaration, name: ts.Identifier, constructed: boolean): void => {
    const owner = { name: name.text, line: line(name) };
    const assigned = assignedFields(node);
    const fixed = (field: string): boolean => !assigned.has(field);
    for (const member of node.members) {
      if (ts.isPropertyDeclaration(member) && ts.isIdentifier(member.name) && member.initializer !== undefined && !isStatic(member) && fixed(member.name.text)) {
        const initializer = unwrapped(member.initializer);
        if (ts.isCallExpression(initializer) && coreName(initializer.expression) === "inject" && initializer.arguments[0] !== undefined) result.fields.push({ owner, field: member.name.text, target: targetOf(initializer.arguments[0]), via: "inject" });
        else if (ts.isNewExpression(initializer)) result.fields.push({ owner, field: member.name.text, target: targetOf(initializer.expression), via: "new" });
      }
      if (!constructed || !ts.isConstructorDeclaration(member)) continue;
      for (const parameter of member.parameters) {
        if (!ts.isIdentifier(parameter.name) || !ts.isParameterPropertyDeclaration(parameter, member) || !fixed(parameter.name.text)) continue;
        const inject = decoratorsOf(parameter).get("Inject")?.arguments[0];
        const reference = inject === undefined ? (parameter.type === undefined ? undefined : typeReference(parameter.type)) : referenceOf(inject);
        if (reference !== undefined) result.fields.push({ owner, field: parameter.name.text, target: { reference }, via: "inject" });
      }
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name !== undefined) {
      const decorators = decoratorsOf(node);
      classOf(node.name, decorators);
      const constructed = [...decorators.keys()].some((decorated) => CONSTRUCTED.has(decorated));
      if (constructed) parametersOf(node, node.name);
      fieldsOf(node, node.name, constructed);
      const injectable = decorators.get("Injectable")?.arguments[0];
      if (injectable !== undefined && ts.isObjectLiteralExpression(injectable) && SUBSTITUTIONS.some((option) => propertyOf(injectable, option) !== undefined)) result.substituted.push(substitutionOf({ name: node.name.text }, injectable));
    }
    if (ts.isObjectLiteralExpression(node)) {
      const provided = propertyOf(node, "provide");
      const reference = provided === undefined ? undefined : referenceOf(provided);
      if (reference !== undefined && SUBSTITUTIONS.some((option) => propertyOf(node, option) !== undefined)) result.substituted.push(substitutionOf(reference, node));
    }
    if (ts.isCallExpression(node) && coreName(node.expression) === "inject" && node.arguments[0] !== undefined) {
      const owner = ownerOf(node, sf);
      const declaration = referenceOf(node.arguments[0]) !== undefined && ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name) && ts.isVariableDeclarationList(node.parent.parent) && (node.parent.parent.flags & ts.NodeFlags.Const) !== 0 ? node.parent : undefined;
      const local = declaration !== undefined && ts.isIdentifier(declaration.name) ? declaration.name.text : undefined;
      const statement = declaration?.parent.parent;
      const block = statement !== undefined && ts.isVariableStatement(statement) && ts.isBlock(statement.parent) ? statement.parent : undefined;
      const access = node.parent;
      const outer = access.parent;
      const root = ts.isIdentifier(node.expression) ? node.expression.text : ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) ? `${node.expression.expression.text}.${node.expression.name.text}` : undefined;
      const token = node.arguments[0];
      const literalToken = ts.isIdentifier(token) || (ts.isPropertyAccessExpression(token) && ts.isIdentifier(token.expression) && !token.questionDotToken);
      const inline = root !== undefined && literalToken && node.arguments.length === 1 && node.typeArguments === undefined && !ts.isOptionalChain(node)
        && ts.isPropertyAccessExpression(access) && ts.isIdentifier(access.name) && access.expression === node && !ts.isOptionalChain(access)
        && ts.isCallExpression(outer) && outer.expression === access && !ts.isOptionalChain(outer) && outer.typeArguments === undefined
        && !ts.isPropertyAccessExpression(outer.parent) && !ts.isElementAccessExpression(outer.parent) && !ts.isCallExpression(outer.parent)
        && !ts.isParenthesizedExpression(outer.parent) && !ts.isAsExpression(outer.parent) && !ts.isTypeAssertionExpression(outer.parent)
        && !ts.isNonNullExpression(outer.parent) && !ts.isSatisfiesExpression(outer.parent);
      const at = inline ? sf.getLineAndCharacterOfPosition(outer.getStart(sf)) : undefined;
      result.injections.push({
        ...(owner !== undefined ? { owner: { name: owner.name.text, line: line(owner.name) } } : {}),
        ...(local !== undefined ? { local } : {}),
        ...(declaration !== undefined && block !== undefined ? { localScope: { start: declaration.end, end: block.end } } : {}),
        ...(inline && at !== undefined ? { inlineMember: { name: access.name.text, line: at.line + 1, column: at.character + 1, referenceName: `${root}().${access.name.text}` } } : {}),
        target: injectionTargetOf(node.arguments[0]),
        line: line(node),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  for (const statement of sf.statements) {
    if (!ts.isVariableStatement(statement) || (statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue;
    for (const declaration of statement.declarationList.declarations) {
      const initializer = declaration.initializer === undefined ? undefined : unwrapped(declaration.initializer);
      if (ts.isIdentifier(declaration.name) && initializer !== undefined && ts.isArrayLiteralExpression(initializer)) result.arrays.set(declaration.name.text, operandsOf(initializer));
    }
  }
  return result;
}

/** The provider options that give a token something other than its own class. */
const SUBSTITUTIONS = ["useClass", "useExisting", "useFactory", "useValue"];

/** The fields a class assigns anywhere in its body, `this.x = …` or a compound assignment, besides their declaration. */
function assignedFields(node: ts.ClassDeclaration): Set<string> {
  const assigned = new Set<string>();
  const visit = (current: ts.Node): void => {
    if (
      ts.isBinaryExpression(current) &&
      current.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      current.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      ts.isPropertyAccessExpression(current.left) &&
      current.left.expression.kind === ts.SyntaxKind.ThisKeyword
    )
      assigned.add(current.left.name.text);
    ts.forEachChild(current, visit);
  };
  for (const member of node.members) ts.forEachChild(member, visit);
  return assigned;
}

function propertyOf(object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const property of object.properties) {
    const key = property.name !== undefined && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) ? property.name.text : undefined;
    if (key !== name) continue;
    if (ts.isPropertyAssignment(property)) return property.initializer;
    if (ts.isShorthandPropertyAssignment(property)) return property.name;
  }
  return undefined;
}

/** The class a parameter type names, leaving out `null` and `undefined`; any other type names none. */
function typeReference(type: ts.TypeNode): RawReference | undefined {
  if (ts.isUnionTypeNode(type)) {
    const named = type.types.filter((member) => !(ts.isLiteralTypeNode(member) && member.literal.kind === ts.SyntaxKind.NullKeyword) && member.kind !== ts.SyntaxKind.UndefinedKeyword);
    return named.length === 1 ? typeReference(named[0]!) : undefined;
  }
  if (!ts.isTypeReferenceNode(type)) return undefined;
  const name = type.typeName;
  if (ts.isIdentifier(name)) return { name: name.text };
  return ts.isIdentifier(name.left) ? { name: name.left.text, member: name.right.text } : undefined;
}

/** The top-level class, function or variable an expression sits in: the nearest one, the declaration an `inject()` call is made for. */
function ownerOf(node: ts.Node, sf: ts.SourceFile): { name: ts.Identifier } | undefined {
  for (let current = node.parent; current !== undefined && current !== sf; current = current.parent) {
    if (ts.isClassDeclaration(current) && current.name !== undefined) return { name: current.name };
    if (ts.isFunctionDeclaration(current) && current.name !== undefined && current.parent === sf) return { name: current.name };
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name) && current.parent.parent.parent === sf) return { name: current.name };
  }
  return undefined;
}

const LIB_GLOBALS: ReadonlySet<string> = new Set(TYPESCRIPT_LIB_GLOBALS);
const PROTOTYPE_KEYS = ["prototype", "__proto__"];
/** The reflective calls that change their first argument, and the argument that names the member when it is a literal. */
const MUTATORS: Readonly<Record<string, Readonly<Record<string, number | "keys" | "none">>>> = {
  Object: { assign: "keys", defineProperty: 1, defineProperties: "keys", setPrototypeOf: "none", getPrototypeOf: "none" },
  Reflect: { set: 1, defineProperty: 1, deleteProperty: 1, setPrototypeOf: "none", getPrototypeOf: "none" },
};

function readMemberEvidence(sf: ts.SourceFile, declarations: Map<string, number>, shape: Pick<RawRouteFile, "imports">): RawMemberEvidence {
  const result: RawMemberEvidence = { methods: [], calls: [], localCalls: [], reads: new Map(), declarations, escapedClasses: new Set(), writes: [], subclasses: [], passed: [], hidden: new Set(), qualified: [], escapedMutator: false, unknownBinding: false, unknownProvider: false };
  const redeclared = new Set<string>();
  const escapedOwners = result.escapedClasses;
  const lineOf = (node: ts.Node): number => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const key = (owner: ts.ClassDeclaration, field: string): string => `${owner.name?.text}\0${owner.name === undefined ? 0 : lineOf(owner.name)}\0${field}`;
  const topLevelThisClass = (node: ts.Node): ts.ClassDeclaration | undefined => {
    const owner = thisClass(node);
    return owner !== undefined && ts.isClassDeclaration(owner) && owner.parent === sf && owner.name !== undefined ? owner : undefined;
  };
  const owned = (owner: ts.ClassDeclaration): { name: string; line: number } => ({ name: owner.name!.text, line: lineOf(owner.name!) });
  const subclassOf = new Map<ts.ClassDeclaration, RawSubclass>();
  /** The locals and constructor parameters that hold an instance of a class the syntax names, by name. */
  const holders = new Map<string, RawReference>();
  const platform = (name: string): boolean => LIB_GLOBALS.has(name) && (declarations.get(name) ?? 0) === 0 && !shape.imports.has(name);
  /** A value made where it is written: a literal, or a platform collection (`new Uint8Array(n)`, `Array.from(…)`), never a `Proxy`. */
  const isFresh = (expression: ts.Expression): boolean => {
    const e = unwrapped(expression);
    if (isFreshLiteral(e)) return true;
    if (ts.isNewExpression(e)) return ts.isIdentifier(e.expression) && e.expression.text !== "Proxy" && platform(e.expression.text);
    return ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && ts.isIdentifier(e.expression.expression) && e.expression.expression.text === "Array" && platform("Array") && (e.expression.name.text === "from" || e.expression.name.text === "of");
  };
  const literalLocals = new Set<string>();
  const topLevelClasses = new Set<string>();
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && ts.isVariableDeclarationList(node.parent) && (node.parent.flags & ts.NodeFlags.Const) !== 0 && node.initializer !== undefined && isFresh(node.initializer)) literalLocals.add(node.name.text);
    if (ts.isClassDeclaration(node) && node.name !== undefined && node.parent === sf) topLevelClasses.add(node.name.text);
    ts.forEachChild(node, collect);
  };
  collect(sf);
  const literalFields = new Map<ts.ClassDeclaration, Set<string>>();
  const literalField = (owner: ts.ClassDeclaration, field: string): boolean => {
    let fields = literalFields.get(owner);
    if (fields === undefined) {
      const assigned = assignedFields(owner);
      fields = new Set(owner.members.flatMap((member) => ts.isPropertyDeclaration(member) && ts.isIdentifier(member.name) && !isStatic(member) && member.initializer !== undefined && isFresh(member.initializer) && !assigned.has(member.name.text) ? [member.name.text] : []));
      literalFields.set(owner, fields);
    }
    return fields.has(field);
  };
  /** What a name the file binds stands for as the object of a write: nothing for a fresh literal or a platform global. */
  const named = (name: string): RawWriteTarget | undefined => {
    const count = declarations.get(name) ?? 0;
    if (count === 0) return shape.imports.has(name) ? { binding: { name } } : LIB_GLOBALS.has(name) ? undefined : { unplaced: true };
    if (count === 1 && literalLocals.has(name)) return undefined;
    return count === 1 && topLevelClasses.has(name) ? { binding: { name } } : { unplaced: true };
  };
  const namespaced = (expression: ts.Expression): RawReference | undefined => {
    const e = unwrapped(expression);
    if (ts.isIdentifier(e)) return { name: e.text };
    return ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && (declarations.get(e.expression.text) ?? 0) === 0 && shape.imports.get(e.expression.text)?.imported === "*" ? { name: e.expression.text, member: e.name.text } : undefined;
  };
  /** The prototype of an unbound name is no class of the repository: a source class is declared or imported. */
  const prototypeOf = (expression: ts.Expression): RawWriteTarget | undefined => {
    const reference = namespaced(expression);
    if (reference === undefined) return { unplaced: true };
    const count = declarations.get(reference.name) ?? 0;
    if (reference.member !== undefined || (count === 0 && shape.imports.has(reference.name)) || (count === 1 && topLevelClasses.has(reference.name))) return { prototype: reference };
    return count === 0 ? undefined : { unplaced: true };
  };
  const isPrototypeAccess = (node: ts.Node): node is ts.PropertyAccessExpression | ts.ElementAccessExpression =>
    (ts.isPropertyAccessExpression(node) && PROTOTYPE_KEYS.includes(node.name.text)) || (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression) && PROTOTYPE_KEYS.includes(node.argumentExpression.text));
  const targetOf = (object: ts.Expression): RawWriteTarget | undefined => {
    const o = unwrapped(object);
    if (o.kind === ts.SyntaxKind.ThisKeyword) {
      const owner = topLevelThisClass(o);
      return owner === undefined ? { unplaced: true } : { self: owned(owner) };
    }
    if (isPrototypeAccess(o)) return prototypeOf(o.expression);
    if (ts.isPropertyAccessExpression(o) && o.expression.kind === ts.SyntaxKind.ThisKeyword) {
      const owner = topLevelThisClass(o);
      if (owner === undefined) return { unplaced: true };
      return literalField(owner, o.name.text) ? undefined : { field: { owner: owned(owner), field: o.name.text } };
    }
    if (ts.isIdentifier(o)) return named(o.text);
    const reference = namespaced(o);
    return reference?.member === undefined ? { unplaced: true } : { binding: reference };
  };
  const record = (object: ts.Expression, member: string | undefined, at: ts.Node): void => {
    const target = targetOf(object);
    if (target === undefined) return;
    result.writes.push({ target, ...(member === undefined ? {} : { member }), line: lineOf(at) });
    const subclass = "self" in target ? subclassOf.get(topLevelThisClass(unwrapped(object))!) : undefined;
    if (subclass === undefined) return;
    if (member !== undefined) subclass.members.add(member);
    else result.writes.push({ target: { unplaced: true }, line: lineOf(at) });
  };
  /** The declaration a local name stands for where it is read: the nearest parameter or variable of an enclosing scope. */
  const localDeclaration = (name: ts.Identifier): ts.ParameterDeclaration | ts.VariableDeclaration | undefined => {
    const named = (declaration: ts.ParameterDeclaration | ts.VariableDeclaration): boolean => ts.isIdentifier(declaration.name) && declaration.name.text === name.text;
    for (let at: ts.Node = name.parent; at !== undefined; at = at.parent) {
      const lists = ts.isFunctionLike(at) ? [] : ts.isBlock(at) || ts.isSourceFile(at) || ts.isCaseClause(at) || ts.isDefaultClause(at) ? at.statements.flatMap((statement) => (ts.isVariableStatement(statement) ? [statement.declarationList] : [])) : (ts.isForStatement(at) || ts.isForOfStatement(at) || ts.isForInStatement(at)) && at.initializer !== undefined && ts.isVariableDeclarationList(at.initializer) ? [at.initializer] : [];
      const found = ts.isFunctionLike(at) ? at.parameters.find(named) : lists.flatMap((list) => [...list.declarations]).find(named);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  /** A key the syntax shows is a number, which names no method: a numeric literal, arithmetic, `Math.*()`, or a local typed or initialized so. */
  const isNumeric = (expression: ts.Expression, depth = 0): boolean => {
    const e = unwrapped(expression);
    if (depth > 8) return false;
    if (ts.isNumericLiteral(e)) return true;
    if (ts.isPrefixUnaryExpression(e)) return e.operator !== ts.SyntaxKind.ExclamationToken;
    if (ts.isBinaryExpression(e)) return NUMERIC_OPERATORS.has(e.operatorToken.kind) || (e.operatorToken.kind === ts.SyntaxKind.PlusToken && isNumeric(e.left, depth + 1) && isNumeric(e.right, depth + 1));
    if (ts.isCallExpression(e)) return ts.isPropertyAccessExpression(e.expression) && ts.isIdentifier(e.expression.expression) && e.expression.expression.text === "Math" && platform("Math");
    if (!ts.isIdentifier(e)) return false;
    const declaration = localDeclaration(e);
    if (declaration?.type !== undefined) return declaration.type.kind === ts.SyntaxKind.NumberKeyword;
    return declaration !== undefined && ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined && isNumeric(declaration.initializer, depth + 1);
  };
  const literalKey = (expression: ts.Expression | undefined): string | undefined =>
    expression !== undefined && (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) ? expression.text : undefined;
  const written = (node: ts.Node): void => {
    const e = ts.isExpression(node) ? unwrapped(node) : node;
    if (ts.isArrayLiteralExpression(e)) e.elements.forEach(written);
    else if (ts.isObjectLiteralExpression(e)) {
      for (const property of e.properties) {
        if (ts.isPropertyAssignment(property)) written(property.initializer);
        else if (ts.isSpreadAssignment(property)) written(property.expression);
      }
    } else if (ts.isSpreadElement(e)) written(e.expression);
    else if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.EqualsToken) written(e.left);
    else if (ts.isPropertyAccessExpression(e)) {
      if (PROTOTYPE_KEYS.includes(e.name.text)) record(e.expression, undefined, e);
      else record(e.expression, e.name.text, e);
    } else if (ts.isElementAccessExpression(e)) {
      const member = literalKey(e.argumentExpression);
      if (member !== undefined && PROTOTYPE_KEYS.includes(member)) record(e.expression, undefined, e);
      else if (member !== undefined || !isNumeric(e.argumentExpression)) record(e.expression, member, e);
    } else if (ts.isIdentifier(e) && (declarations.get(e.text) ?? 0) === 0 && shape.imports.has(e.text)) result.writes.push({ target: { binding: { name: e.text }, whole: true }, line: lineOf(e) });
  };
  const mutatorOf = (expression: ts.Expression): Readonly<Record<string, number | "keys" | "none">> | undefined => {
    const e = unwrapped(expression);
    return ts.isIdentifier(e) && (e.text === "Object" || e.text === "Reflect") && !declarations.has(e.text) && !shape.imports.has(e.text) ? MUTATORS[e.text] : undefined;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const parent = node.parent;
      const name = "name" in parent && parent.name === node && !ts.isShorthandPropertyAssignment(parent);
      if (!name) result.reads.set(node.text, (result.reads.get(node.text) ?? 0) + 1);
    }
    if (ts.isWithStatement(node) || (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "eval")) {
      result.writes.push({ target: { unplaced: true }, line: lineOf(node) });
      result.unknownBinding = true;
    }
    if (ts.isReturnStatement(node) && node.expression !== undefined) {
      for (let scope = node.parent; scope !== undefined && scope !== sf; scope = scope.parent) {
        if (!ts.isFunctionLike(scope)) continue;
        if (ts.isConstructorDeclaration(scope) && ts.isClassDeclaration(scope.parent) && scope.parent.name !== undefined) {
          const owner = scope.parent;
          escapedOwners.add(`${owner.name!.text}\0${lineOf(owner.name!)}`);
        }
        break;
      }
    }
    if (ts.isCallExpression(node) && !ts.isCallChain(node) && node.typeArguments === undefined && ts.isPropertyAccessExpression(node.expression) && !ts.isPropertyAccessChain(node.expression) && ts.isIdentifier(node.expression.expression)) {
      const owner = ownerOf(node, sf);
      if (owner !== undefined) {
        const at = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        result.localCalls.push({ owner: { name: owner.name.text, line: lineOf(owner.name) }, local: node.expression.expression.text, member: node.expression.name.text, offset: node.getStart(sf), line: at.line + 1, column: at.character + 1 });
      }
    }
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && (declarations.get(node.expression.text) ?? 0) === 0 && shape.imports.get(node.expression.text)?.imported === "*") result.qualified.push({ name: node.expression.text, member: node.name.text });
    if (ts.isPropertyAccessExpression(node) && !PROTOTYPE_KEYS.includes(node.name.text) && escapes(node)) {
      const owner = node.expression.kind === ts.SyntaxKind.ThisKeyword ? topLevelThisClass(node) : undefined;
      if (owner !== undefined) result.passed.push({ field: { owner: owned(owner), field: node.name.text } });
      else if (node.expression.kind !== ts.SyntaxKind.ThisKeyword && namespaced(node) === undefined) result.passed.push({ fieldNamed: node.name.text });
    }
    const made = ts.isCallExpression(node) && angularCoreExport(node.expression, { imports: shape.imports, declared: declarations }) === "inject" && node.arguments[0] !== undefined ? namespaced(node.arguments[0]) : undefined;
    if (made !== undefined && ts.isVariableDeclaration(node.parent) && node.parent.initializer === node && ts.isIdentifier(node.parent.name)) holders.set(node.parent.name.text, made);
    else if (made !== undefined && !(ts.isPropertyDeclaration(node.parent) && node.parent.initializer === node) && escapes(node as ts.Expression)) result.passed.push({ instance: made });
    if (ts.isConstructorDeclaration(node)) {
      for (const parameter of node.parameters) {
        const typed = parameter.type === undefined ? undefined : typeReference(parameter.type);
        if (typed !== undefined && ts.isIdentifier(parameter.name) && !ts.isParameterPropertyDeclaration(parameter, node)) holders.set(parameter.name.text, typed);
      }
    }
    if (ts.isIdentifier(node) && holders.has(node.text) && !("name" in node.parent && node.parent.name === node && !ts.isShorthandPropertyAssignment(node.parent)) && escapes(node)) result.passed.push({ instance: holders.get(node.text)! });
    if (ts.isQualifiedName(node) && ts.isIdentifier(node.left) && shape.imports.get(node.left.text)?.imported === "*") result.qualified.push({ name: node.left.text, member: node.right.text });
    const heritage = ts.isClassLike(node) ? node.heritageClauses?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)?.types[0] : undefined;
    if (ts.isClassLike(node) && heritage !== undefined) {
      const written = namespaced(heritage.expression);
      const base = written !== undefined && written.member === undefined && (declarations.get(written.name) ?? 0) === 0 && !shape.imports.has(written.name) && LIB_GLOBALS.has(written.name) ? "platform" : written;
      const subclass: RawSubclass = { ...(node.name === undefined ? {} : { name: node.name.text }), line: lineOf(node.name ?? node), ...(base === undefined ? {} : { base }), members: new Set() };
      result.subclasses.push(subclass);
      if (ts.isClassDeclaration(node)) subclassOf.set(node, subclass);
      for (const member of node.members) {
        if (isStatic(member)) continue;
        if (member.name !== undefined) {
          if (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) subclass.members.add(member.name.text);
          else result.writes.push({ target: { unplaced: true }, line: lineOf(member) });
        }
        if (ts.isConstructorDeclaration(member)) {
          for (const parameter of member.parameters) {
            if (ts.isParameterPropertyDeclaration(parameter, member) && ts.isIdentifier(parameter.name)) subclass.members.add(parameter.name.text);
          }
        }
      }
    }
    if (node.kind === ts.SyntaxKind.ThisKeyword && !ts.isPropertyAccessExpression(node.parent) && !ts.isElementAccessExpression(node.parent)) {
      const owner = topLevelThisClass(node);
      if (owner?.name !== undefined) escapedOwners.add(`${owner.name.text}\0${lineOf(owner.name)}`);
    }
    if (ts.isObjectLiteralExpression(node) && propertyOf(node, "provide") !== undefined && node.properties.some((property) => ts.isSpreadAssignment(property) || (property.name !== undefined && ts.isComputedPropertyName(property.name)))) result.unknownProvider = true;
    if (ts.isObjectLiteralExpression(node) && SUBSTITUTIONS.some((name) => propertyOf(node, name) !== undefined)) {
      const provided = propertyOf(node, "provide");
      if (provided !== undefined && !ts.isIdentifier(unwrapped(provided)) && !(ts.isPropertyAccessExpression(unwrapped(provided)) && ts.isIdentifier((unwrapped(provided) as ts.PropertyAccessExpression).expression))) result.unknownProvider = true;
    }
    if (ts.isClassDeclaration(node) && node.name !== undefined && node.parent === sf) {
      const owner = node.name.text;
      const classLine = lineOf(node.name);
      const hiddenModifier = (declaration: ts.HasModifiers): boolean => (ts.getModifiers(declaration) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword || modifier.kind === ts.SyntaxKind.ProtectedKeyword);
      for (const member of node.members) {
        if (ts.isPropertyDeclaration(member) && (ts.isPrivateIdentifier(member.name) || (ts.isIdentifier(member.name) && hiddenModifier(member)))) result.hidden.add(`${owner}\0${classLine}\0${member.name.text}`);
        if (ts.isConstructorDeclaration(member)) for (const parameter of member.parameters) if (ts.isIdentifier(parameter.name) && hiddenModifier(parameter)) result.hidden.add(`${owner}\0${classLine}\0${parameter.name.text}`);
      }
      const byName = Map.groupBy(node.members.filter((m) => m.name !== undefined && ts.isIdentifier(m.name)), (m) => (m.name as ts.Identifier).text);
      const cannotProveMembers = node.members.some((member) => member.name !== undefined && ts.isComputedPropertyName(member.name)) || (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.AbstractKeyword);
      for (const [name, members] of byName) {
        if (members.length > 1) redeclared.add(key(node, name));
        if (cannotProveMembers) continue;
        const member = members[0];
        if (members.length !== 1 || member === undefined || !ts.isMethodDeclaration(member) || member.body === undefined || isStatic(member) || (ts.canHaveDecorators(member) && (ts.getDecorators(member)?.length ?? 0) > 0)) continue;
        result.methods.push({ className: owner, classLine, name, line: lineOf(member.name) });
      }
    }
    if (isPrototypeAccess(node) && !((ts.isPropertyAccessExpression(node.parent) || ts.isElementAccessExpression(node.parent)) && node.parent.expression === node)) {
      const target = prototypeOf(node.expression);
      if (target !== undefined) result.writes.push({ target, line: lineOf(node) });
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const form = mutatorOf(node.expression.expression)?.[node.expression.name.text];
      const [object, ...rest] = node.arguments;
      if (form !== undefined && object !== undefined) {
        for (const member of form === "keys" ? keysOf(rest) : [form === "none" ? undefined : literalKey(node.arguments[form])]) record(object, member !== undefined && PROTOTYPE_KEYS.includes(member) ? undefined : member, node);
      }
    }
    if (ts.isIdentifier(node) && mutatorOf(node) !== undefined && !ts.isTypeReferenceNode(node.parent)) {
      const access = node.parent;
      const method = ts.isPropertyAccessExpression(access) && access.expression === node ? access.name.text : undefined;
      const called = method !== undefined && ts.isCallExpression(access.parent) && access.parent.expression === access;
      if (method === undefined || (!called && method in mutatorOf(node)!)) result.escapedMutator = true;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) written(node.left);
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) written(node.operand);
    if (ts.isDeleteExpression(node)) written(node.expression);
    if ((ts.isForInStatement(node) || ts.isForOfStatement(node)) && !ts.isVariableDeclarationList(node.initializer)) written(node.initializer);
    if (ts.isPropertyAccessExpression(node) && node.expression.kind === ts.SyntaxKind.ThisKeyword) {
      const owner = topLevelThisClass(node);
      const member = node.parent;
      const call = member.parent;
      const direct = ts.isPropertyAccessExpression(member) && member.expression === node && !node.questionDotToken && !member.questionDotToken && ts.isCallExpression(call) && call.expression === member && !call.questionDotToken;
      if (owner !== undefined && direct && runsOnInstance(node, owner, node.name.text)) {
        const at = sf.getLineAndCharacterOfPosition(call.getStart(sf));
        result.calls.push({ owner: owned(owner), field: node.name.text, member: member.name.text, line: at.line + 1, column: at.character + 1 });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  result.calls = result.calls.filter((call) => !redeclared.has(`${call.owner.name}\0${call.owner.line}\0${call.field}`) && !escapedOwners.has(`${call.owner.name}\0${call.owner.line}`));
  return result;
}

/**
 * Whether a use of `this.<field>` runs on a constructed instance of `owner` with the field already set: inside an
 * instance method, constructor or accessor, inside a closure an instance field initializer creates, or directly in an
 * instance field initializer that follows the field's own declaration. A static member, a static block and a decorator
 * do not run on the instance.
 */
function runsOnInstance(node: ts.Node, owner: ts.ClassDeclaration, field: string): boolean {
  let deferred = false;
  for (let at: ts.Node = node.parent; at !== owner; at = at.parent) {
    if (ts.isDecorator(at) || ts.isClassStaticBlockDeclaration(at)) return false;
    if (at.parent === owner) {
      if (ts.isMethodDeclaration(at) || ts.isConstructorDeclaration(at) || ts.isGetAccessorDeclaration(at) || ts.isSetAccessorDeclaration(at)) return true;
      if (!ts.isPropertyDeclaration(at) || isStatic(at)) return false;
      if (deferred) return true;
      const index = owner.members.indexOf(at);
      return owner.members.slice(0, index).some((member) => ts.isPropertyDeclaration(member) && ts.isIdentifier(member.name) && member.name.text === field);
    }
    if (ts.isFunctionLike(at)) deferred = true;
  }
  return false;
}

const NUMERIC_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.MinusToken, ts.SyntaxKind.AsteriskToken, ts.SyntaxKind.SlashToken, ts.SyntaxKind.PercentToken,
  ts.SyntaxKind.AsteriskAsteriskToken, ts.SyntaxKind.BarToken, ts.SyntaxKind.AmpersandToken, ts.SyntaxKind.CaretToken,
  ts.SyntaxKind.LessThanLessThanToken, ts.SyntaxKind.GreaterThanGreaterThanToken, ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
]);
const COMPARISONS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.InstanceOfKeyword,
]);

/** Whether a value leaves where it is read: anything but a member access or call on it, a test of it, or a write to it. */
function escapes(node: ts.Expression): boolean {
  let at: ts.Node = node;
  while (ts.isParenthesizedExpression(at.parent) || ts.isAsExpression(at.parent) || ts.isNonNullExpression(at.parent) || ts.isSatisfiesExpression(at.parent) || ts.isTypeAssertionExpression(at.parent)) at = at.parent;
  const parent = at.parent;
  if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent) || ts.isCallExpression(parent)) && parent.expression === at) return false;
  if (ts.isExpressionStatement(parent) || ts.isTemplateSpan(parent) || ts.isTypeOfExpression(parent) || ts.isVoidExpression(parent) || ts.isDeleteExpression(parent) || ts.isPostfixUnaryExpression(parent)) return false;
  if (ts.isPrefixUnaryExpression(parent)) return false;
  if (ts.isBinaryExpression(parent)) {
    const operator = parent.operatorToken.kind;
    if (COMPARISONS.has(operator)) return false;
    if (parent.left === at && operator >= ts.SyntaxKind.FirstAssignment && operator <= ts.SyntaxKind.LastAssignment) return false;
  }
  if ((ts.isIfStatement(parent) || ts.isWhileStatement(parent) || ts.isDoStatement(parent)) && parent.expression === at) return false;
  return !(ts.isConditionalExpression(parent) && parent.condition === at);
}

/** The members object literals name, or one unnamed member when a source is not a literal or a key is computed. */
function keysOf(sources: readonly ts.Expression[]): (string | undefined)[] {
  const literals = sources.map((source) => unwrapped(source));
  if (!literals.every(ts.isObjectLiteralExpression)) return [undefined];
  return literals.flatMap((literal) => literal.properties.map((property) => (property.name !== undefined && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) ? property.name.text : undefined)));
}

/** A value made fresh where it is written, which holds no class of the repository: an object or array literal. */
function isFreshLiteral(expression: ts.Expression): boolean {
  const e = unwrapped(expression);
  const ownPrototype = (property: ts.ObjectLiteralElementLike): boolean => ts.isPropertyAssignment(property) && !ts.isComputedPropertyName(property.name) && PROTOTYPE_KEYS.includes(property.name.getText()) && unwrapped(property.initializer).kind !== ts.SyntaxKind.NullKeyword;
  return (ts.isObjectLiteralExpression(e) && !e.properties.some(ownPrototype)) || ts.isArrayLiteralExpression(e);
}
