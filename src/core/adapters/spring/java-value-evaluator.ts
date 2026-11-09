import type { Evidence } from "../../domain/shared/fact.ts";
import { spanOf } from "./findings.ts";
import { LOMBOK_VALUE, LOMBOK_BUILDER, LOMBOK_GETTERS, LOMBOK_CONSTRUCTORS } from "./java-value-vocabulary.ts";
import type { Closure, ObjectValue, UrlScope } from "./java-values.ts";
import { known, prevailingCause, undecided, type Evaluated, type UndecidedCause } from "../../domain/topology/evaluated.ts";
import { RUN_TIME_HOLE } from "../../domain/topology/path-template.ts";
import { bindMethod, methodsOf } from "./java-method-flow.ts";
import { NO_PROOF, type CallSiteProof } from "./java-call-site-owner.ts";
import type { Node } from "web-tree-sitter";
import type { Configuration } from "./application-config.ts";
import { argumentsOf, assignmentsOf, descendants, fieldBindings, localBindings, memberNodes, typeNameOf, type Binding } from "./java-members.ts";
import { externalNames, scopeOf, type JavaFile, type JavaProject, type MethodDecl, type TypeDecl } from "./java-symbols.ts";
import { stringLiteralValue } from "./java-literals.ts";
import { annotationUses, isAnnotation } from "./request-mapping.ts";
import { CONFIGURATION_PROPERTIES, TRANSPARENT_URI_METHODS, URI_FACTORIES, VALUE } from "./http-client-vocabulary.ts";

/** What stands for a part of a URL the code fills at run time. */

interface ConfigurationValue {
  kind: "configuration";
  key: string;
  typeName: string;
  owner: TypeDecl;
}

type HeldValue = ObjectValue | ConfigurationValue;

const PLACEHOLDER_IN_TEXT = /\$\{([^${}:]+)(?::([^${}]*))?\}/;
const FORMAT_SPECIFIER = /%[-#+ 0,(]*\d*(?:\.\d+)?[a-zA-Z]/g;
const GETTER = /^(?:get|is)(.)(.*)$/;

/** The property a getter name reads; a name that is not a getter stands for itself. */
function propertyOf(name: string): string {
  const getter = GETTER.exec(name);
  return getter === null ? name : `${getter[1]?.toLowerCase()}${getter[2]}`;
}

function enclosingMember(node: Node): Node | undefined {
  let member: Node | null = node;
  while (member !== null && member.type !== "method_declaration" && member.type !== "constructor_declaration") member = member.parent;
  return member ?? undefined;
}

function isFinal(binding: Binding): boolean {
  return binding.node.namedChildren.some((child) => child.type === "modifiers" && /\bfinal\b/.test(child.text));
}

/**
 * Source value evaluation preserves argument bindings, object fields and consuming-module configuration.
 * Runtime text uses `{}`; values the snapshot cannot decide, including exhausted evaluation stacks, are undefined.
 */
export class JavaValueEvaluator {
  private diagnostics: { cause?: UndecidedCause; evidence: Evidence[]; alternatives: Set<string> } | undefined;

  /**
   * What an evaluation written in a scope comes to: its value, or why the snapshot does not decide it. A scope method
   * flow left undecided keeps the flow's cause; otherwise the cause, the places and the alternatives the evaluation met.
   */
  evaluated<T>(scope: UrlScope, evaluate: () => T | undefined): Evaluated<T> {
    if (scope.deferred === true) return undecided("destination-undecidable");
    if (scope.undecided !== undefined) return undecided(scope.undecided);
    const previous = this.diagnostics;
    const trace: NonNullable<JavaValueEvaluator["diagnostics"]> = { evidence: [], alternatives: new Set() };
    this.diagnostics = trace;
    try {
      const value = evaluate();
      return value === undefined ? undecided(trace.cause ?? "destination-undecidable", trace.evidence, [...trace.alternatives]) : known(value);
    } finally {
      this.diagnostics = previous;
    }
  }

  /** A null check the snapshot cannot decide: undecided, recording what its decided branches hold. */
  private runTimeChoice(node: Node, scope: UrlScope, trail: ReadonlySet<number>): undefined {
    const decided = (["consequence", "alternative"] as const).flatMap((field) => {
      const branch = node.childForFieldName(field);
      const value = branch === null ? undefined : this.of(branch, scope, trail);
      return value === undefined ? [] : [value];
    });
    if (this.diagnostics !== undefined && decided.length > 0) {
      for (const value of decided) this.diagnostics.alternatives.add(value);
      this.diagnostics.evidence.push(spanOf(scope.type.file.path, node));
    }
    return undefined;
  }

  private record(cause: UndecidedCause, file: JavaFile, node: Node): void {
    if (this.diagnostics === undefined) return;
    this.diagnostics.cause = prevailingCause([this.diagnostics.cause, cause]) ?? cause;
    this.diagnostics.evidence.push(spanOf(file.path, node));
  }

  constructor(
    private readonly project: JavaProject,
    private readonly configurationOf: (file: JavaFile) => Configuration,
    private readonly proof: CallSiteProof = NO_PROOF,
  ) {}

  of(node: Node, scope: UrlScope, trail: ReadonlySet<number> = new Set()): string | undefined {
    try {
      switch (node.type) {
        case "string_literal":
          return stringLiteralValue(node.text);
        case "decimal_integer_literal":
          return node.text;
        case "parenthesized_expression":
          return this.ofFirst(node, scope, trail);
        case "array_access": {
          const array = node.childForFieldName("array");
          const index = node.childForFieldName("index");
          const binding = array?.type === "identifier" ? scope.locals.get(array.text) : undefined;
          const values = binding?.initializer;
          const value = values?.type === "array_initializer" && index?.type === "decimal_integer_literal" ? values.namedChildren[Number(index.text)] : undefined;
          return value === undefined ? undefined : this.of(value, scope, trail);
        }
        case "ternary_expression": {
          const condition = node.childForFieldName("condition");
          const left = condition?.childForFieldName("left");
          const right = condition?.childForFieldName("right");
          const operator = condition?.childForFieldName("operator")?.text;
          const nil = left === null || left === undefined || right?.type !== "null_literal" ? undefined : this.nullness(left, scope, trail);
          if (operator !== "==" && operator !== "!=") return undefined;
          if (nil === undefined) return this.runTimeChoice(node, scope, trail);
          const branch = node.childForFieldName((operator === "==" ? nil : !nil) ? "consequence" : "alternative");
          return branch === null ? undefined : this.of(branch, scope, trail);
        }
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
    } catch (error) {
      if (error instanceof RangeError) return undefined;
      throw error;
    }
  }

  /** A string attribute of an annotation, with its placeholders resolved against the configuration. */
  attribute(node: Node, scope: UrlScope): string | undefined {
    const text = this.of(node, scope);
    return text === undefined ? undefined : this.resolve(text, scope.configurationFile ?? scope.type.file);
  }

  resolve(text: string, file: JavaFile, active: ReadonlySet<string> = new Set()): string | undefined {
    let current = text;
    for (;;) {
      const match = PLACEHOLDER_IN_TEXT.exec(current);
      if (match === null) return current;
      const key = match[1] ?? "";
      if (active.has(key)) return undefined;
      const configured = this.configurationOf(file).valueOf(key);
      const value = configured.status === "found" ? configured.value : configured.status === "absent" ? match[2] : undefined;
      if (value === undefined) return undefined;
      const resolved = this.resolve(value, file, new Set(active).add(key));
      if (resolved === undefined) return undefined;
      current = current.replace(match[0], () => resolved);
    }
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
    return first === undefined ? undefined : [first, ...rest.map((part) => part ?? RUN_TIME_HOLE)].join("");
  }

  private name(name: string, node: Node, scope: UrlScope, trail: ReadonlySet<number>): string | undefined {
    const closure = scope.env.get(name);
    if (closure !== undefined) return this.of(closure.node, closure.scope, trail);
    const local = scope.locals.get(name);
    if (local !== undefined) return this.binding(local, scope.type, scope, trail, false);
    const stored = scope.instance?.fields.get(name);
    if (stored !== undefined) return this.of(stored.node, stored.scope, trail);
    const field = this.fieldOf(scope.type, name);
    if (field !== undefined) return this.binding(field.binding, field.owner, { ...scope, type: field.owner, locals: new Map() }, trail, true);
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
    if (expression !== undefined) return this.attribute(expression.node, { type: owner, locals: new Map(), env: new Map(), configurationFile: scope.configurationFile ?? scope.type.file });
    if (isField && (assignmentsOf(owner).get(binding.name) ?? []).some(({ member }) => member.type !== "constructor_declaration")) return undefined;
    if (isField && binding.initializer !== undefined && scope.instance?.constructed !== true
      && !isFinal(binding)
      && !this.immutable(owner)) return undefined;
    const assigned = isField && binding.initializer === undefined ? (assignmentsOf(owner).get(binding.name) ?? []) : [];
    const sources = binding.initializer === undefined ? assigned.map(({ value: node, member }) => ({ node, scope: { ...scope, locals: localBindings(member) } })) : [{ node: binding.initializer, scope }];
    const [only, ...others] = sources;
    if (only === undefined || others.length > 0 || trail.has(binding.node.id)) return undefined;
    return this.of(only.node, only.scope, new Set(trail).add(binding.node.id));
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
    if (object?.type === "identifier" && externalNames(object.text, scope.type.file, false).includes("okhttp3.HttpUrl") && (name === "parse" || name === "get")) return this.ofArgument(call, 0, scope, trail);
    if (object !== null && name === "newBuilder" && argumentsOf(call).length === 0) return this.of(object, scope, trail);
    if (object?.type === "identifier" && name === "format" && object.text === "String") return this.format(call, scope, trail);
    if (object?.type === "identifier" && URI_FACTORIES.get(object.text)?.has(name) === true) return this.ofArgument(call, 0, scope, trail);
    if (object !== null && TRANSPARENT_URI_METHODS.has(name)) return this.of(object, scope, trail);
    if (object !== null && name === "path" && object.type === "method_invocation") {
      const base = this.of(object, scope, trail);
      return base === undefined ? undefined : base + (this.ofArgument(call, 0, scope, trail) ?? RUN_TIME_HOLE);
    }
    const held = this.held(call, scope, trail);
    if (held?.kind === "configuration") {
      const value = this.property(held.key, scope.configurationFile ?? scope.type.file);
      return value === undefined ? undefined : this.resolve(value, scope.configurationFile ?? scope.type.file);
    }
    if (trail.has(call.id)) { this.record("recursive", scope.type.file, call); return undefined; }
    const next = new Set(trail).add(call.id);
    const receiver = object === null || object.type === "this" ? scope.instance : this.held(object, scope, next);
    const property = propertyOf(name);
    if (receiver?.kind === "record" && argumentsOf(call).length === 0) {
      const methods = this.project.classChain(receiver.type).flatMap((type) => type.methods.filter((method) => method.name === name && method.parameterTypes.length === 0));
      if (methods.length === 0 && this.generatedGetter(receiver.type, property, name)) {
        const field = receiver.fields.get(property);
        return field === undefined ? undefined : this.of(field.node, field.scope, next);
      }
    }
    const invocation = { node: call, type: scope.type, member: undefined, locals: scope.locals };
    const selections = methodsOf(invocation, this.project, this, receiver?.kind === "record" ? receiver.type : scope.receiver ?? scope.type, this.proof);
    const arity = argumentsOf(call).length;
    const declared = (type: TypeDecl) => type.methods.filter((method) => method.name === name && method.parameterTypes.length === arity && method.hasBody);
    const sourceOwner = receiver?.kind === "record" ? this.project.classChain(receiver.type).find((type) => declared(type).length > 0) : undefined;
    const ownSelections = sourceOwner === undefined || receiver?.kind !== "record" ? selections : declared(sourceOwner).map((method) => ({ method, receiver: receiver.type }));
    const values = ownSelections.map((selection) => {
      if (next.has(selection.method.node.id)) { this.record("recursive", selection.method.owner.file, selection.method.node); return undefined; }
      const returns = descendants(selection.method.node).filter((node) => node.type === "return_statement");
      if (returns.length !== 1) return undefined;
      const expression = returns[0]?.namedChildren[0];
      return expression === undefined ? undefined : this.of(expression, { ...bindMethod(selection, call, scope), ...(receiver?.kind === "record" ? { instance: receiver } : {}) }, new Set(next).add(selection.method.node.id));
    });
    const distinct = new Set(values);
    if (distinct.size > 1) for (const { method } of ownSelections) this.record("dispatch-disagreement", method.owner.file, method.node);
    return distinct.size === 1 ? values[0] : undefined;
  }

  private nullness(node: Node, scope: UrlScope, trail: ReadonlySet<number>): boolean | undefined {
    if (trail.has(node.id)) return undefined;
    const next = new Set(trail).add(node.id);
    if (node.type === "null_literal") return true;
    if (node.type === "string_literal" || node.type === "object_creation_expression") return false;
    if (node.type === "identifier") {
      const closed = scope.env.get(node.text);
      if (closed !== undefined) return this.nullness(closed.node, closed.scope, next);
      const local = scope.locals.get(node.text)?.initializer;
      return local === undefined ? undefined : this.nullness(local, scope, next);
    }
    if (node.type !== "method_invocation" || argumentsOf(node).length !== 0) return undefined;
    const object = node.childForFieldName("object");
    const name = node.childForFieldName("name")?.text ?? "";
    const property = propertyOf(name);
    const value = object === null ? scope.instance : this.held(object, scope, next);
    if (value?.kind !== "record" || !this.generatedGetter(value.type, property, name)) return undefined;
    const field = value.fields.get(property);
    if (field !== undefined) return this.nullness(field.node, field.scope, next);
    const binding = fieldBindings(value.type).get(property);
    return value.constructed === true && binding?.initializer === undefined ? true : undefined;
  }

  private generatedGetter(type: TypeDecl, field: string, name: string): boolean {
    if (type.methods.some((method) => method.name === name && method.parameterTypes.length === 0 && method.hasBody)) return false;
    if (type.node.type === "record_declaration") return name === field;
    const binding = fieldBindings(type).get(field);
    return binding !== undefined && [type.node, binding.node].some((node) => annotationUses(node, scopeOf(type)).some((use) => isAnnotation(use, LOMBOK_GETTERS)));
  }

  private immutable(type: TypeDecl): boolean {
    if (type.node.type === "record_declaration") return true;
    return this.project.classChain(type).every((owner) => annotationUses(owner.node, scopeOf(owner)).some((use) => isAnnotation(use, LOMBOK_VALUE))
      || [...fieldBindings(owner).values()].every(isFinal));
  }

  private recordIsStable(value: ObjectValue, binding: Binding, read: Node, scope: UrlScope): boolean {
    if (!scope.locals.has(binding.name) && (assignmentsOf(scope.type).get(binding.name) ?? []).length > 0) return false;
    if (this.immutable(value.type)) return true;
    if (!scope.locals.has(binding.name)) return false;
    const member = enclosingMember(read);
    if (member === undefined) return false;
    return !descendants(member).some((use) => {
      if (use.type !== "identifier" || use.text !== binding.name || use.startIndex < (binding.initializer?.endIndex ?? 0) || use.startIndex > read.startIndex) return false;
      const parent = use.parent;
      if (parent?.type === "argument_list" && parent.parent?.type === "method_invocation") {
        const call = parent.parent;
        const index = argumentsOf(call).findIndex((argument) => argument.id === use.id);
        const targets = methodsOf({ node: call, type: scope.type, member, locals: scope.locals }, this.project, this, scope.type, this.proof);
        return targets.length === 0 || !this.readOnlyParameters(targets.map(({ method }) => ({ method, index })), value.type);
      }
      if (parent?.type !== "method_invocation" || parent.childForFieldName("object")?.id !== use.id) return true;
      const name = parent.childForFieldName("name")?.text ?? "";
      return !this.generatedGetter(value.type, propertyOf(name), name)
        && !value.type.methods.some((method) => method.name === name && this.simpleAccessor(method.node));
    });
  }

  private readOnlyParameters(pending: { method: MethodDecl; index: number }[], type: TypeDecl): boolean {
    const seen = new Set<string>();
    for (let item = pending.pop(); item !== undefined; item = pending.pop()) {
      const { method, index } = item;
      const key = `${method.node.id}:${index}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const parameter = method.node.childForFieldName("parameters")?.namedChildren[index]?.childForFieldName("name")?.text;
      if (parameter === undefined) return false;
      for (const reference of descendants(method.node.childForFieldName("body") ?? method.node)) {
        if (reference.type !== "identifier" || reference.text !== parameter) continue;
        const access = reference.parent;
        if (access?.type === "argument_list" && access.parent?.type === "method_invocation") {
          const call = access.parent;
          const slot = argumentsOf(call).findIndex((argument) => argument.id === reference.id);
          const targets = methodsOf({ node: call, type: method.owner, member: method.node, locals: localBindings(method.node) }, this.project, this, method.owner, this.proof);
          if (targets.length === 0) return false;
          pending.push(...targets.map(({ method }) => ({ method, index: slot })));
          continue;
        }
        const name = access?.childForFieldName("name")?.text ?? "";
        const property = propertyOf(name);
        if (access?.type !== "method_invocation" || access.childForFieldName("object")?.id !== reference.id || argumentsOf(access).length !== 0
          || (!this.generatedGetter(type, property, name) && !type.methods.some((candidate) => candidate.name === name && candidate.parameterTypes.length === 0 && this.simpleAccessor(candidate.node)))) return false;
      }
    }
    return true;
  }

  private simpleAccessor(method: Node): boolean {
    const body = method.childForFieldName("body");
    if (body?.namedChildCount !== 1) return false;
    const statement = body.namedChildren[0];
    if (statement?.type === "return_statement") return statement.namedChildren[0]?.type === "identifier" || statement.namedChildren[0]?.type === "field_access";
    const assignment = statement?.namedChildren[0];
    const left = assignment?.childForFieldName("left");
    const right = assignment?.childForFieldName("right");
    const parameter = method.childForFieldName("parameters")?.namedChildren[0]?.childForFieldName("name");
    return assignment?.type === "assignment_expression" && left?.type === "field_access" && left.childForFieldName("object")?.type === "this" && parameter !== null && parameter !== undefined && right?.text === parameter.text;
  }

  private held(node: Node, scope: UrlScope, trail: ReadonlySet<number>): HeldValue | undefined {
    if (trail.has(node.id)) return undefined;
    const next = new Set(trail).add(node.id);
    if (node.type === "this") return scope.instance;
    if (node.type === "identifier" || node.type === "field_access") return this.heldBinding(node, scope, next);
    if (node.type === "object_creation_expression") return this.constructed(node, scope);
    if (node.type !== "method_invocation") return undefined;
    return this.heldInvocation(node, scope, next);
  }

  private heldBinding(node: Node, scope: UrlScope, next: ReadonlySet<number>): HeldValue | undefined {
    const name = node.type === "identifier" ? node.text : node.childForFieldName("object")?.type === "this" ? node.childForFieldName("field")?.text : undefined;
    if (name === undefined) return undefined;
    const closed = scope.env.get(name) ?? scope.instance?.fields.get(name);
    if (closed !== undefined) return this.held(closed.node, closed.scope, next);
    const binding = scope.locals.get(name) ?? this.fieldOf(scope.type, name)?.binding;
    if (binding === undefined) return undefined;
    if (binding.initializer !== undefined) {
      const value = this.held(binding.initializer, scope, next);
      if (value?.kind !== "record") return value;
      if (!this.recordIsStable(value, binding, node, scope)) return undefined;
      return this.withSetters(value, binding.name, node, scope);
    }
    const type = this.project.lookupType(binding.typeName, scopeOf(scope.type));
    if (typeof type !== "object") return undefined;
    const key = this.prefixOf(type);
    return key === undefined ? { kind: "record", type, fields: new Map() } : { kind: "configuration", key, typeName: type.fqn, owner: type };
  }

  private withSetters(value: ObjectValue, name: string, node: Node, scope: UrlScope): ObjectValue {
    const member = enclosingMember(node);
    if (member === undefined) return value;
    const fields = new Map(value.fields);
    const calls = descendants(member).filter((child) => child.type === "method_invocation" && child.startIndex < node.startIndex && child.childForFieldName("object")?.text === name).sort((a, b) => a.startIndex - b.startIndex);
    for (const call of calls) {
      const setter = call.childForFieldName("name")?.text ?? "";
      const methods = value.type.methods.filter((method) => method.name === setter && method.parameterTypes.length === 1);
      const [argument] = argumentsOf(call);
      const [method] = methods;
      if (methods.length !== 1 || method === undefined || argument === undefined) continue;
      const writes = descendants(method.node).filter((child) => child.type === "assignment_expression");
      const [write] = writes;
      const left = write?.childForFieldName("left");
      const right = write?.childForFieldName("right");
      const parameter = method.node.childForFieldName("parameters")?.namedChildren[0]?.childForFieldName("name")?.text;
      const field = left?.type === "field_access" && left.childForFieldName("object")?.type === "this" ? left.childForFieldName("field")?.text : undefined;
      if (writes.length !== 1 || field === undefined || right?.text !== parameter) continue;
      if (call.parent?.parent?.id !== member.childForFieldName("body")?.id || write?.parent?.parent?.id !== method.node.childForFieldName("body")?.id) fields.delete(field);
      else fields.set(field, { node: argument, scope });
    }
    return { ...value, fields };
  }

  private constructed(node: Node, scope: UrlScope): ObjectValue | undefined {
    const type = this.project.lookupType(typeNameOf(node.childForFieldName("type")), scopeOf(scope.type));
    if (typeof type !== "object") return undefined;
    const fields = new Map<string, Closure>();
    const args = argumentsOf(node);
    const constructors = memberNodes(type).filter((member) => member.type === "constructor_declaration" && (member.childForFieldName("parameters")?.namedChildCount ?? 0) === args.length);
    if (constructors.length === 1) {
      const constructor = constructors[0] as Node;
      const params = constructor.childForFieldName("parameters")?.namedChildren ?? [];
      const env = new Map(params.flatMap((parameter, index) => {
        const name = parameter.childForFieldName("name")?.text;
        const argument = args[index];
        return name === undefined || argument === undefined ? [] : [[name, { node: argument, scope }] as const];
      }));
      for (const assignment of descendants(constructor).filter((child) => child.type === "assignment_expression")) {
        const left = assignment.childForFieldName("left");
        const right = assignment.childForFieldName("right");
        const field = left?.type === "field_access" && left.childForFieldName("object")?.type === "this" ? left.childForFieldName("field")?.text : undefined;
        if (field !== undefined && right !== null) {
          if (fields.has(field) || assignment.parent?.parent?.id !== constructor.childForFieldName("body")?.id) return undefined;
          fields.set(field, { node: right, scope: { type, locals: localBindings(constructor), env, configurationFile: scope.configurationFile ?? scope.type.file } });
        }
      }
    } else if (type.node.type === "record_declaration" || annotationUses(type.node, scopeOf(type)).some((use) => isAnnotation(use, LOMBOK_CONSTRUCTORS))) {
      const names = [...fieldBindings(type).keys()];
      if (names.length !== args.length) return undefined;
      names.forEach((name, index) => { const argument = args[index]; if (argument !== undefined) fields.set(name, { node: argument, scope }); });
    } else if (args.length > 0) return undefined;
    return { kind: "record", constructed: true, type, fields };
  }

  private heldInvocation(node: Node, scope: UrlScope, next: ReadonlySet<number>): HeldValue | undefined {
    const object = node.childForFieldName("object");
    const name = node.childForFieldName("name")?.text ?? "";
    if (name === "build" && argumentsOf(node).length === 0) {
      const fields = new Map<string, Closure>();
      let current = object;
      while (current?.type === "method_invocation") {
        const setter = current.childForFieldName("name")?.text ?? "";
        const [argument] = argumentsOf(current);
        if (setter === "builder" && argument === undefined) {
          const type = this.project.lookupType(current.childForFieldName("object")?.text ?? "", scopeOf(scope.type));
          if (typeof type !== "object" || !annotationUses(type.node, scopeOf(type)).some((use) => isAnnotation(use, LOMBOK_BUILDER))) break;
          if ([...fields.keys()].some((field) => !fieldBindings(type).has(field))) return undefined;
          return { kind: "record", constructed: true, type, fields };
        }
        if (argument === undefined || argumentsOf(current).length !== 1) break;
        if (!fields.has(setter)) fields.set(setter, { node: argument, scope });
        current = current.childForFieldName("object");
      }
    }
    if (object === null) return undefined;
    const base = this.held(object, scope, next);
    if (base?.kind !== "configuration") return undefined;
    if (name === "get" && argumentsOf(node).length === 1) {
      const type = base.typeName.replace(/\s/g, "");
      if (!/^(?:java\.util\.)?Map</.test(type)) return undefined;
      const argument = argumentsOf(node)[0];
      const key = argument === undefined ? undefined : this.of(argument, scope, next);
      if (key === undefined || key.includes(RUN_TIME_HOLE)) return undefined;
      const valueType = type.slice(type.indexOf(",") + 1, -1);
      return { ...base, key: `${base.key}.${key}`, typeName: valueType };
    }
    if (argumentsOf(node).length !== 0) return undefined;
    if (!GETTER.test(name)) return undefined;
    const property = propertyOf(name);
    const type = this.project.lookupType(base.typeName, scopeOf(base.owner));
    if (typeof type !== "object") return undefined;
    const field = fieldBindings(type).get(property);
    const fieldType = field?.node.childForFieldName("type")?.text;
    return fieldType === undefined ? undefined : { kind: "configuration", key: `${base.key}.${property}`, typeName: fieldType, owner: type };
  }

  private format(call: Node, scope: UrlScope, trail: ReadonlySet<number>): string | undefined {
    const [template, ...rest] = argumentsOf(call);
    const text = template === undefined ? undefined : this.of(template, scope, trail);
    if (text === undefined) return undefined;
    const arguments_ = rest.map((argument) => this.of(argument, scope, trail) ?? RUN_TIME_HOLE);
    let index = 0;
    return text.replace(FORMAT_SPECIFIER, () => arguments_[index++] ?? RUN_TIME_HOLE);
  }

  private prefixOf(type: TypeDecl): string | undefined {
    const use = annotationUses(type.node, scopeOf(type)).find((candidate) => isAnnotation(candidate, CONFIGURATION_PROPERTIES));
    const expression = (use?.attributes.get("prefix") ?? use?.attributes.get("value"))?.[0];
    const evaluated = expression === undefined ? undefined : this.project.evaluate(expression);
    return evaluated !== undefined && "value" in evaluated ? evaluated.value : undefined;
  }
}
