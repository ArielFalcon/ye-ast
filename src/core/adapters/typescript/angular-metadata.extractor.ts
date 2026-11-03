import ts from "typescript";
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

export interface RawAngularFile {
  classes: RawAngularClass[];
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
export function readAngularMetadataFile(sf: ts.SourceFile, shape: Pick<RawRouteFile, "imports">): RawAngularFile {
  const line = (node: ts.Node): number => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const result: RawAngularFile = { classes: [], injections: [], fields: [], substituted: [], arrays: new Map() };

  /* The export of `@angular/core` an expression names: `inject`, or `core.inject` through a namespace import. */
  const coreName = (expression: ts.Expression): string | undefined => {
    if (ts.isIdentifier(expression)) {
      const bound = shape.imports.get(expression.text);
      return bound?.module === ANGULAR_CORE ? bound.imported : undefined;
    }
    if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
      const bound = shape.imports.get(expression.expression.text);
      return bound?.module === ANGULAR_CORE && bound.imported === "*" ? expression.name.text : undefined;
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
    if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression)) return { name: e.expression.text, member: e.name.text };
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
      const local = ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name) ? node.parent.name.text : undefined;
      result.injections.push({
        ...(owner !== undefined ? { owner: { name: owner.name.text, line: line(owner.name) } } : {}),
        ...(local !== undefined ? { local } : {}),
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
