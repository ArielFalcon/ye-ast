import type { Node } from "web-tree-sitter";
import type { Configuration } from "./application-config.ts";
import { argumentsOf, assignmentsOf, fieldBindings, localBindings, typeNameOf, type Binding } from "./java-members.ts";
import { externalNames, scopeOf, type JavaFile, type JavaProject, type TypeDecl } from "./java-symbols.ts";
import { stringLiteralValue } from "./java-literals.ts";
import { annotationUses, type AnnotationUse } from "./request-mapping.ts";
import { CONFIGURATION_PROPERTIES, TRANSPARENT_URI_METHODS, URI_FACTORIES, VALUE } from "./http-client-vocabulary.ts";

/** What stands for a part of a URL the code fills at run time. */
export const PLACEHOLDER = "{}";

/** A call argument and the scope it is written in, which a wrapper's parameter stands for. */
export interface Closure {
  node: Node;
  scope: UrlScope;
}

/** Where an expression is written: the type, the names of its method and what a call of that method binds its parameters to. */
export interface UrlScope {
  type: TypeDecl;
  locals: ReadonlyMap<string, Binding>;
  env: ReadonlyMap<string, Closure>;
  receiver?: TypeDecl;
  configurationFile?: JavaFile;
}

const PLACEHOLDER_IN_TEXT = /\$\{([^${}:]+)(?::([^${}]*))?\}/;
const FORMAT_SPECIFIER = /%[-#+ 0,(]*\d*(?:\.\d+)?[a-zA-Z]/g;
const GETTER = /^(?:get|is)(.)(.*)$/;
const RESOLUTION_STEPS = 16;

export function isAnnotation(use: AnnotationUse, names: ReadonlySet<string> | string): boolean {
  const wanted = typeof names === "string" ? [names] : [...names];
  return externalNames(use.name, use.scope.file, false).some((candidate) => wanted.includes(candidate));
}

/**
 * The text of a URL expression: literals, constants, fields injected with `@Value` or bound by `@ConfigurationProperties`,
 * and the parameters of the method being read. What the code fills at run time is `{}`; an expression the snapshot does not
 * decide, or one that starts with such a part, is undefined.
 */
export class UrlText {
  constructor(
    private readonly project: JavaProject,
    private readonly configurationOf: (file: JavaFile) => Configuration,
  ) {}

  of(node: Node, scope: UrlScope, trail: ReadonlySet<number> = new Set()): string | undefined {
    switch (node.type) {
      case "string_literal":
        return stringLiteralValue(node.text);
      case "decimal_integer_literal":
        return node.text;
      case "parenthesized_expression":
        return this.ofFirst(node, scope, trail);
      case "binary_expression":
        return this.concatenation(node, scope, trail);
      case "identifier":
        return this.name(node.text, node, scope, trail);
      case "field_access":
        return this.access(node, scope, trail);
      case "method_invocation":
        return this.invocation(node, scope, trail);
      case "object_creation_expression":
        return typeNameOf(node.childForFieldName("type")) === "URI" ? this.ofArgument(node, 0, scope, trail) : undefined;
      default:
        return undefined;
    }
  }

  /** A string attribute of an annotation, with its placeholders resolved against the configuration. */
  attribute(node: Node, scope: UrlScope): string | undefined {
    const text = this.of(node, scope);
    return text === undefined ? undefined : this.resolve(text, scope.type.file);
  }

  resolve(text: string, file: JavaFile): string | undefined {
    let current = text;
    for (let step = 0; step < RESOLUTION_STEPS; step++) {
      const match = PLACEHOLDER_IN_TEXT.exec(current);
      if (match === null) return current;
      const value = this.property(match[1] ?? "", file) ?? match[2];
      if (value === undefined) return undefined;
      current = current.replace(match[0], () => value);
    }
    return undefined;
  }

  private property(key: string, file: JavaFile): string | undefined {
    const configured = this.configurationOf(file).valueOf(key);
    return configured.status === "found" ? configured.value : undefined;
  }

  private ofFirst(node: Node, scope: UrlScope, trail: ReadonlySet<number>): string | undefined {
    const [inner] = node.namedChildren;
    return inner === undefined ? undefined : this.of(inner, scope, trail);
  }

  private ofArgument(call: Node, index: number, scope: UrlScope, trail: ReadonlySet<number>): string | undefined {
    const argument = argumentsOf(call)[index];
    return argument === undefined ? undefined : this.of(argument, scope, trail);
  }

  private concatenation(root: Node, scope: UrlScope, trail: ReadonlySet<number>): string | undefined {
    const operands: Node[] = [];
    let current: Node | null = root;
    while (current?.type === "binary_expression") {
      if (current.childForFieldName("operator")?.text !== "+") return undefined;
      const right: Node | null = current.childForFieldName("right");
      if (right === null) return undefined;
      operands.unshift(right);
      current = current.childForFieldName("left");
    }
    if (current === null) return undefined;
    operands.unshift(current);
    const [first, ...rest] = operands.map((operand) => this.of(operand, scope, trail));
    return first === undefined ? undefined : [first, ...rest.map((part) => part ?? PLACEHOLDER)].join("");
  }

  private name(name: string, node: Node, scope: UrlScope, trail: ReadonlySet<number>): string | undefined {
    const closure = scope.env.get(name);
    if (closure !== undefined) return this.of(closure.node, closure.scope, trail);
    const local = scope.locals.get(name);
    if (local !== undefined) return this.binding(local, scope.type, scope, trail, false);
    const field = this.fieldOf(scope.type, name);
    if (field !== undefined) return this.binding(field.binding, field.owner, { type: field.owner, locals: new Map(), env: scope.env }, trail, true);
    const constant = this.project.evaluate({ node, scope: scopeOf(scope.type) });
    return "value" in constant ? constant.value : undefined;
  }

  private access(node: Node, scope: UrlScope, trail: ReadonlySet<number>): string | undefined {
    const object = node.childForFieldName("object");
    const field = node.childForFieldName("field")?.text;
    if (object?.type === "this" && field !== undefined) return this.name(field, node, scope, trail);
    const constant = this.project.evaluate({ node, scope: scopeOf(scope.type) });
    return "value" in constant ? constant.value : undefined;
  }

  private binding(binding: Binding, owner: TypeDecl, scope: UrlScope, trail: ReadonlySet<number>, isField: boolean): string | undefined {
    const value = annotationUses(binding.node, scopeOf(owner)).find((use) => isAnnotation(use, VALUE));
    const expression = value?.attributes.get("value")?.[0];
    if (expression !== undefined) return this.attribute(expression.node, { type: owner, locals: new Map(), env: new Map() });
    const assigned = isField && binding.initializer === undefined ? (assignmentsOf(owner).get(binding.name) ?? []) : [];
    const sources = binding.initializer === undefined ? assigned.map(({ value: node, member }) => ({ node, scope: { ...scope, locals: localBindings(member) } })) : [{ node: binding.initializer, scope }];
    const [only, ...others] = sources;
    if (only === undefined || others.length > 0 || trail.has(only.node.id)) return undefined;
    return this.of(only.node, only.scope, new Set(trail).add(only.node.id));
  }

  fieldOf(type: TypeDecl, name: string): { binding: Binding; owner: TypeDecl } | undefined {
    const chain = [...this.project.classChain(type)];
    for (let outer = type.outer; outer !== undefined; outer = outer.outer) chain.push(...this.project.classChain(outer));
    for (const owner of chain) {
      const binding = fieldBindings(owner).get(name);
      if (binding !== undefined) return { binding, owner };
    }
    return undefined;
  }

  private invocation(call: Node, scope: UrlScope, trail: ReadonlySet<number>): string | undefined {
    const object = call.childForFieldName("object");
    const name = call.childForFieldName("name")?.text ?? "";
    if (object?.type === "identifier" && name === "format" && object.text === "String") return this.format(call, scope, trail);
    if (object?.type === "identifier" && URI_FACTORIES.get(object.text)?.has(name) === true) return this.ofArgument(call, 0, scope, trail);
    if (object !== null && TRANSPARENT_URI_METHODS.has(name)) return this.of(object, scope, trail);
    if (object !== null && name === "path" && object.type === "method_invocation") {
      const base = this.of(object, scope, trail);
      return base === undefined ? undefined : base + (this.ofArgument(call, 0, scope, trail) ?? PLACEHOLDER);
    }
    const key = this.configuredKey(call, scope);
    if (key === undefined) return undefined;
    const value = this.property(key, scope.type.file);
    return value === undefined ? undefined : this.resolve(value, scope.type.file);
  }

  private format(call: Node, scope: UrlScope, trail: ReadonlySet<number>): string | undefined {
    const [template, ...rest] = argumentsOf(call);
    const text = template === undefined ? undefined : this.of(template, scope, trail);
    if (text === undefined) return undefined;
    const arguments_ = rest.map((argument) => this.of(argument, scope, trail) ?? PLACEHOLDER);
    let index = 0;
    return text.replace(FORMAT_SPECIFIER, () => arguments_[index++] ?? PLACEHOLDER);
  }

  /** The configuration key an accessor chain reads from a `@ConfigurationProperties` object: its prefix and the property names. */
  private configuredKey(call: Node, scope: UrlScope): string | undefined {
    const accessors: string[] = [];
    let current: Node | null = call;
    while (current?.type === "method_invocation" && argumentsOf(current).length === 0) {
      accessors.unshift(current.childForFieldName("name")?.text ?? "");
      current = current.childForFieldName("object");
    }
    const root = current?.type === "identifier" ? current.text : current?.type === "field_access" && current.childForFieldName("object")?.type === "this" ? current.childForFieldName("field")?.text : undefined;
    const held = root === undefined ? undefined : (scope.locals.get(root) ?? this.fieldOf(scope.type, root)?.binding);
    let type = held === undefined ? undefined : this.project.lookupType(held.typeName, scopeOf(scope.type));
    if (typeof type !== "object") return undefined;
    let key = this.prefixOf(type);
    for (const [index, accessor] of accessors.entries()) {
      if (key === undefined) return undefined;
      const property = GETTER.exec(accessor);
      const named = property === null ? accessor : `${property[1]?.toLowerCase()}${property[2]}`;
      key = `${key}.${named}`;
      if (index === accessors.length - 1) break;
      const nested: TypeDecl | "ambiguous" | undefined = this.project.lookupType(fieldBindings(type).get(named)?.typeName ?? "", scopeOf(type));
      if (typeof nested !== "object") return undefined;
      type = nested;
    }
    return accessors.length === 0 ? undefined : key;
  }

  private prefixOf(type: TypeDecl): string | undefined {
    const use = annotationUses(type.node, scopeOf(type)).find((candidate) => isAnnotation(candidate, CONFIGURATION_PROPERTIES));
    const expression = (use?.attributes.get("prefix") ?? use?.attributes.get("value"))?.[0];
    const evaluated = expression === undefined ? undefined : this.project.evaluate(expression);
    return evaluated !== undefined && "value" in evaluated ? evaluated.value : undefined;
  }
}
