import ts from "typescript";
import { declarationCounts } from "./syntax-names.ts";
import { bare, type RawRouteFile } from "./angular-router.extractor.ts";

const ANGULAR_CORE = "@angular/core";

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
export interface RawMemberEvidence {
  methods: RawInstanceMethod[];
  calls: RawFieldCall[];
  localCalls: RawLocalCall[];
  reads: Map<string, number>;
  declarations: Map<string, number>;
  escapedClasses: Set<string>;
  unsafeMembers: Set<string>;
  unknownMutation: boolean;
  unknownProvider: boolean;
}

export interface RawAngularFile {
  classes: RawAngularClass[];
  memberEvidence: RawMemberEvidence;
  injections: RawInjection[];
  fields: RawField[];
  /** The tokens a provider of this file replaces: `{ provide: X, useClass | useExisting | useFactory | useValue }`, or the class an `@Injectable` with one of those options decorates. */
  substituted: RawReference[];
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
  const result: RawAngularFile = { classes: [], memberEvidence: proveMembers ? readMemberEvidence(sf, declarations) : { methods: [], calls: [], localCalls: [], reads: new Map(), declarations, escapedClasses: new Set(), unsafeMembers: new Set(), unknownMutation: false, unknownProvider: false }, injections: [], fields: [], substituted: [], arrays: new Map() };

  /* The export of `@angular/core` an expression names: `inject`, or `core.inject` through a namespace import. */
  const coreName = (expression: ts.Expression): string | undefined => {
    if (ts.isIdentifier(expression)) {
      const bound = shape.imports.get(expression.text);
      return coreExternal && !declarations.has(expression.text) && bound?.module === ANGULAR_CORE ? bound.imported : undefined;
    }
    if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
      const bound = shape.imports.get(expression.expression.text);
      return coreExternal && !declarations.has(expression.expression.text) && bound?.module === ANGULAR_CORE && bound.imported === "*" ? expression.name.text : undefined;
    }
    return undefined;
  };
  const decoratorsOf = (node: ts.Node): Map<string, ts.CallExpression> => {
    const found = new Map<string, ts.CallExpression>();
    for (const decorator of ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : []) {
      const name = ts.isCallExpression(decorator.expression) ? coreName(decorator.expression.expression) : undefined;
      if (name !== undefined) found.set(name, decorator.expression as ts.CallExpression);
    }
    return found;
  };
  const referenceOf = (expression: ts.Expression): RawReference | undefined => {
    const e = bare(expression);
    if (ts.isIdentifier(e)) return { name: e.text };
    if (ts.isPropertyAccessExpression(e) && !e.questionDotToken && ts.isIdentifier(e.expression)) return { name: e.expression.text, member: e.name.text };
    return undefined;
  };
  const textOf = (expression: ts.Expression): string | undefined => {
    const e = bare(expression);
    return ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) ? e.text : undefined;
  };
  const targetOf = (expression: ts.Expression): RawTarget => {
    const reference = referenceOf(expression);
    return reference === undefined ? { opaque: true } : { reference };
  };
  const operandsOf = (expression: ts.Expression): RawOperand[] => {
    const e = bare(expression);
    if (ts.isArrayLiteralExpression(e)) return e.elements.flatMap((element) => operandsOf(element));
    if (ts.isSpreadElement(e)) return operandsOf(e.expression);
    /* `Module.forRoot(...)` stands for the module. */
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)) return operandsOf(e.expression.expression);
    const reference = referenceOf(e);
    return reference === undefined ? [{ unreadable: true, line: line(e) }] : [{ reference, line: line(e) }];
  };
  const hostDirectivesOf = (expression: ts.Expression): RawOperand[] => {
    const e = bare(expression);
    if (!ts.isArrayLiteralExpression(e)) return operandsOf(e);
    return e.elements.flatMap((element) => {
      const entry = bare(element);
      if (!ts.isObjectLiteralExpression(entry)) return operandsOf(entry);
      const directive = propertyOf(entry, "directive");
      return directive === undefined ? [{ unreadable: true as const, line: line(entry) }] : operandsOf(directive);
    });
  };
  const textOrUnreadable = (expression: ts.Expression): RawText => {
    const text = textOf(expression);
    return text === undefined ? { unreadable: true, line: line(expression) } : { text };
  };

  const classOf = (name: ts.Identifier, decorators: Map<string, ts.CallExpression>): void => {
    const [kindName, decorator] = [...decorators].find(([decorated]) => decorated in KINDS) ?? [];
    if (kindName === undefined || decorator === undefined) return;
    const argument = decorator.arguments[0] !== undefined ? bare(decorator.arguments[0]) : undefined;
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
          result.injections.push({ owner, target: argument === undefined ? { opaque: true } : targetOf(argument), line: line(parameter) });
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
        const initializer = bare(member.initializer);
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
      if (injectable !== undefined && ts.isObjectLiteralExpression(injectable) && SUBSTITUTIONS.some((option) => propertyOf(injectable, option) !== undefined)) result.substituted.push({ name: node.name.text });
    }
    if (ts.isObjectLiteralExpression(node)) {
      const provided = propertyOf(node, "provide");
      const reference = provided === undefined ? undefined : referenceOf(provided);
      if (reference !== undefined && SUBSTITUTIONS.some((option) => propertyOf(node, option) !== undefined)) result.substituted.push(reference);
    }
    if (ts.isCallExpression(node) && coreName(node.expression) === "inject" && node.arguments[0] !== undefined) {
      const owner = ownerOf(node, sf);
      const declaration = ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name) && ts.isVariableDeclarationList(node.parent.parent) && (node.parent.parent.flags & ts.NodeFlags.Const) !== 0 ? node.parent : undefined;
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
        target: targetOf(node.arguments[0]),
        line: line(node),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  for (const statement of sf.statements) {
    if (!ts.isVariableStatement(statement) || (statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue;
    for (const declaration of statement.declarationList.declarations) {
      const initializer = declaration.initializer === undefined ? undefined : bare(declaration.initializer);
      if (ts.isIdentifier(declaration.name) && initializer !== undefined && ts.isArrayLiteralExpression(initializer)) result.arrays.set(declaration.name.text, operandsOf(initializer));
    }
  }
  return result;
}

/** The provider options that give a token something other than its own class. */
const SUBSTITUTIONS = ["useClass", "useExisting", "useFactory", "useValue"];

function isStatic(member: ts.ClassElement): boolean {
  return ts.canHaveModifiers(member) && (ts.getModifiers(member) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword);
}

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

function readMemberEvidence(sf: ts.SourceFile, declarations: Map<string, number>): RawMemberEvidence {
  const result: RawMemberEvidence = { methods: [], calls: [], localCalls: [], reads: new Map(), declarations, escapedClasses: new Set(), unsafeMembers: new Set(), unknownMutation: false, unknownProvider: false };
  const unsafeFields = new Set<string>();
  const escapedOwners = result.escapedClasses;
  const key = (owner: ts.ClassDeclaration, field: string): string => `${owner.name?.text}\0${owner.name === undefined ? 0 : sf.getLineAndCharacterOfPosition(owner.name.getStart(sf)).line + 1}\0${field}`;
  const ownerOfThis = (node: ts.Node): ts.ClassDeclaration | undefined => {
    for (let at = node.parent; at !== undefined && at !== sf; at = at.parent) {
      if (ts.isClassDeclaration(at)) return at.parent === sf && at.name !== undefined ? at : undefined;
      if ((ts.isMethodDeclaration(at) || ts.isGetAccessorDeclaration(at) || ts.isSetAccessorDeclaration(at)) && !ts.isClassDeclaration(at.parent)) return undefined;
      if (ts.isFunctionLike(at) && !ts.isArrowFunction(at) && !ts.isMethodDeclaration(at) && !ts.isConstructorDeclaration(at) && !ts.isGetAccessorDeclaration(at) && !ts.isSetAccessorDeclaration(at)) return undefined;
      if ((ts.isMethodDeclaration(at) || ts.isGetAccessorDeclaration(at) || ts.isSetAccessorDeclaration(at)) && isStatic(at)) return undefined;
    }
    return undefined;
  };
  const markWrite = (node: ts.Node): void => {
    if (ts.isElementAccessExpression(node)) result.unknownMutation = true;
    if (ts.isPropertyAccessExpression(node)) result.unsafeMembers.add(node.name.text);
    ts.forEachChild(node, markWrite);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const parent = node.parent;
      const name = "name" in parent && parent.name === node && !ts.isShorthandPropertyAssignment(parent);
      if (!name) result.reads.set(node.text, (result.reads.get(node.text) ?? 0) + 1);
    }
    if (ts.isWithStatement(node) || (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "eval")) result.unknownMutation = true;
    if (ts.isCallExpression(node) && !ts.isCallChain(node) && node.typeArguments === undefined && ts.isPropertyAccessExpression(node.expression) && !ts.isPropertyAccessChain(node.expression) && ts.isIdentifier(node.expression.expression)) {
      const owner = ownerOf(node, sf);
      if (owner !== undefined) {
        const at = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        result.localCalls.push({ owner: { name: owner.name.text, line: sf.getLineAndCharacterOfPosition(owner.name.getStart(sf)).line + 1 }, local: node.expression.expression.text, member: node.expression.name.text, offset: node.getStart(sf), line: at.line + 1, column: at.character + 1 });
      }
    }
    if (ts.isClassLike(node) && node.heritageClauses?.some((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)) {
      for (const member of node.members) {
        if (isStatic(member)) continue;
        if (member.name !== undefined) {
          if (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) result.unsafeMembers.add(member.name.text);
          else result.unknownMutation = true;
        }
        if (ts.isConstructorDeclaration(member)) {
          for (const parameter of member.parameters) {
            if (ts.isParameterPropertyDeclaration(parameter, member) && ts.isIdentifier(parameter.name)) result.unsafeMembers.add(parameter.name.text);
          }
        }
      }
    }
    if (node.kind === ts.SyntaxKind.ThisKeyword && !ts.isPropertyAccessExpression(node.parent) && !ts.isElementAccessExpression(node.parent)) {
      const owner = ownerOfThis(node);
      if (owner?.name !== undefined) escapedOwners.add(`${owner.name.text}\0${sf.getLineAndCharacterOfPosition(owner.name.getStart(sf)).line + 1}`);
    }
    if (ts.isObjectLiteralExpression(node) && propertyOf(node, "provide") !== undefined && node.properties.some((property) => ts.isSpreadAssignment(property) || (property.name !== undefined && ts.isComputedPropertyName(property.name)))) result.unknownProvider = true;
    if (ts.isObjectLiteralExpression(node) && SUBSTITUTIONS.some((name) => propertyOf(node, name) !== undefined)) {
      const provided = propertyOf(node, "provide");
      if (provided !== undefined && !ts.isIdentifier(bare(provided)) && !(ts.isPropertyAccessExpression(bare(provided)) && ts.isIdentifier((bare(provided) as ts.PropertyAccessExpression).expression))) result.unknownProvider = true;
    }
    if (ts.isClassDeclaration(node) && node.name !== undefined && node.parent === sf) {
      const owner = node.name.text;
      const classLine = sf.getLineAndCharacterOfPosition(node.name.getStart(sf)).line + 1;
      const byName = Map.groupBy(node.members.filter((m) => m.name !== undefined && ts.isIdentifier(m.name)), (m) => (m.name as ts.Identifier).text);
      const cannotProveMembers = node.members.some((member) => member.name !== undefined && ts.isComputedPropertyName(member.name)) || (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.AbstractKeyword);
      for (const [name, members] of byName) {
        if (members.length > 1) unsafeFields.add(key(node, name));
        if (cannotProveMembers) continue;
        const member = members[0];
        if (members.length !== 1 || member === undefined || !ts.isMethodDeclaration(member) || member.body === undefined || isStatic(member) || (ts.canHaveDecorators(member) && (ts.getDecorators(member)?.length ?? 0) > 0)) continue;
        result.methods.push({ className: owner, classLine, name, line: sf.getLineAndCharacterOfPosition(member.name.getStart(sf)).line + 1 });
      }
    }
    if (ts.isPropertyAccessExpression(node) && (node.name.text === "prototype" || node.name.text === "__proto__")) result.unknownMutation = true;
    if (ts.isElementAccessExpression(node) && node.argumentExpression !== undefined && ts.isStringLiteral(node.argumentExpression) && ["prototype", "__proto__"].includes(node.argumentExpression.text)) result.unknownMutation = true;
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      const root = node.expression.text;
      const method = node.name.text;
      if ((root === "Object" && ["assign", "defineProperty", "defineProperties", "setPrototypeOf", "getPrototypeOf"].includes(method)) || (root === "Reflect" && ["set", "defineProperty", "setPrototypeOf", "getPrototypeOf", "deleteProperty"].includes(method))) result.unknownMutation = true;
    }
    if (ts.isIdentifier(node) && (node.text === "Object" || node.text === "Reflect") && !(ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node)) result.unknownMutation = true;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) markWrite(node.left);
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) markWrite(node.operand);
    if (ts.isDeleteExpression(node)) markWrite(node.expression);
    if ((ts.isForInStatement(node) || ts.isForOfStatement(node)) && !ts.isVariableDeclarationList(node.initializer)) markWrite(node.initializer);
    if (ts.isElementAccessExpression(node) && node.expression.kind === ts.SyntaxKind.ThisKeyword) {
      const owner = ownerOfThis(node);
      if (owner !== undefined) unsafeFields.add(`${owner.name?.text}\0${sf.getLineAndCharacterOfPosition(owner.name!.getStart(sf)).line + 1}\0*`);
    }
    if (ts.isPropertyAccessExpression(node) && node.expression.kind === ts.SyntaxKind.ThisKeyword) {
      const owner = ownerOfThis(node);
      if (owner !== undefined) {
        const field = node.name.text;
        const member = node.parent;
        const call = member.parent;
        const direct = ts.isPropertyAccessExpression(member) && member.expression === node && !node.questionDotToken && !member.questionDotToken && ts.isCallExpression(call) && call.expression === member && !call.questionDotToken;
        let methodBody = false;
        for (let parent: ts.Node | undefined = node.parent; parent !== undefined && parent !== owner; parent = parent.parent) {
          if ((ts.isMethodDeclaration(parent) || ts.isConstructorDeclaration(parent) || ts.isGetAccessorDeclaration(parent) || ts.isSetAccessorDeclaration(parent)) && parent.parent === owner) methodBody = true;
        }
        if (direct && methodBody) {
          const at = sf.getLineAndCharacterOfPosition(call.getStart(sf));
          result.calls.push({ owner: { name: owner.name!.text, line: sf.getLineAndCharacterOfPosition(owner.name!.getStart(sf)).line + 1 }, field, member: member.name.text, line: at.line + 1, column: at.character + 1 });
        } else {
          unsafeFields.add(key(owner, field));
          result.unsafeMembers.add(field);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  result.calls = result.calls.filter((call) => !unsafeFields.has(`${call.owner.name}\0${call.owner.line}\0${call.field}`) && !unsafeFields.has(`${call.owner.name}\0${call.owner.line}\0*`) && !escapedOwners.has(`${call.owner.name}\0${call.owner.line}`));
  return result;
}
