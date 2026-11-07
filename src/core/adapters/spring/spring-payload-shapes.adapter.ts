import type { Node } from "web-tree-sitter";
import type { Entrypoint } from "../../domain/entrypoints/entrypoint.ts";
import { isJavaSource, isJvmTestFile } from "../../domain/languages/java.ts";
import { isSpringConfigFile } from "../../domain/languages/spring-config.ts";
import type { LiteralClass, ReadShape, Shape, ValueSet } from "../../domain/contracts/payload-shape.ts";
import { compareText } from "../../domain/shared/code-node.ts";
import type { Evidence, Finding, UnknownReason } from "../../domain/shared/fact.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { OperationShape, PayloadShapes } from "../../ports/payload-shapes.port.ts";
import type { JavaParser, JavaSyntaxTree } from "../tree-sitter/java-parser.adapter.ts";
import { canonicalKey, configurationsOf, type Configuration } from "./application-config.ts";
import { spanOf } from "./findings.ts";
import { enumerationNames, serializedProperties, type WireProperty } from "./jackson-properties.ts";
import { createJavaProject, describeFile, externalNames, scopeOf, type JavaFile, type JavaProject, type MethodDecl, type Scope, type TypeDecl } from "./java-symbols.ts";
import { annotationUses, isAnnotation } from "./request-mapping.ts";

type PlatformKind = LiteralClass | "collection" | "optional" | "wrapper" | "unmodelled";

const PLATFORM: ReadonlyMap<string, PlatformKind> = new Map<string, PlatformKind>([
  ...["java.lang.String", "java.lang.CharSequence", "java.lang.Character", "java.util.UUID", "java.net.URI", "java.net.URL"].map((name) => [name, "string"] as const),
  ...["Byte", "Short", "Integer", "Long", "Float", "Double", "Number"].map((name) => [`java.lang.${name}`, "number"] as const),
  ...["java.math.BigDecimal", "java.math.BigInteger"].map((name) => [name, "number"] as const),
  ["java.lang.Boolean", "boolean"],
  ...["List", "ArrayList", "LinkedList", "Collection", "Set", "HashSet", "LinkedHashSet", "TreeSet", "SortedSet", "NavigableSet", "Queue", "Deque", "ArrayDeque"].map((name) => [`java.util.${name}`, "collection"] as const),
  ["java.lang.Iterable", "collection"],
  ["java.util.Optional", "optional"],
  ...["org.springframework.http.ResponseEntity", "org.springframework.http.HttpEntity", "java.util.concurrent.Callable", "java.util.concurrent.CompletableFuture", "java.util.concurrent.CompletionStage", "org.springframework.web.context.request.async.DeferredResult", "reactor.core.publisher.Mono"].map((name) => [name, "wrapper"] as const),
  ...["java.lang.Object", "java.lang.Void", "java.lang.Enum", "com.fasterxml.jackson.databind.JsonNode", "org.springframework.data.domain.Page", "org.springframework.data.domain.Slice"].map((name) => [name, "unmodelled"] as const),
  ...["Map", "HashMap", "LinkedHashMap", "TreeMap", "SortedMap", "ConcurrentHashMap"].map((name) => [name.startsWith("Concurrent") ? `java.util.concurrent.${name}` : `java.util.${name}`, "unmodelled"] as const),
  ...["Date", "Calendar"].map((name) => [`java.util.${name}`, "unmodelled"] as const),
  ...["Instant", "LocalDate", "LocalDateTime", "LocalTime", "ZonedDateTime", "OffsetDateTime", "OffsetTime", "Duration", "Period", "YearMonth", "Year"].map((name) => [`java.time.${name}`, "unmodelled"] as const),
]);
const ENTITIES: ReadonlySet<string> = new Set(["org.springframework.http.ResponseEntity", "org.springframework.http.HttpEntity"]);
const TEXT_BODY = "java.lang.String";
const BODY_ANNOTATIONS: ReadonlySet<string> = new Set(["org.springframework.web.bind.annotation.RestController", "org.springframework.web.bind.annotation.ResponseBody"]);
const BEAN = "org.springframework.context.annotation.Bean";
const JSON_COMPONENT = "org.springframework.boot.jackson.JsonComponent";
/** The types whose bean, in a repository's code, configures the mapper the HTTP message converters write with. */
const MAPPER_BEANS: ReadonlySet<string> = new Set([
  "ObjectMapper",
  "JsonMapper",
  "Jackson2ObjectMapperBuilder",
  "Jackson2ObjectMapperBuilderCustomizer",
  "Module",
  "SimpleModule",
  "MappingJackson2HttpMessageConverter",
  "HttpMessageConverters",
  "HttpMessageConverter",
]);
const CONVERTER_HOOKS: ReadonlySet<string> = new Set(["configureMessageConverters", "extendMessageConverters"]);
const DEFAULT_CONVERTER = "MappingJackson2HttpMessageConverter";
/** The configuration prefixes that choose or configure the mapper writing HTTP bodies. */
const MAPPER_PREFIXES = ["spring.jackson", "spring.mvc.converters", "spring.http.converters"];
/** Under `spring.jackson`: the settings that change how a body is laid out or how its dates are written, never which properties it holds (dates have no modelled shape). */
const PRESENTATION_KEYS: ReadonlySet<string> = new Set(
  ["serialization.indent-output", "serialization.order-map-entries-by-keys", "serialization.fail-on-empty-beans", "serialization.close-closeable", "serialization.flush-after-write-value", "serialization.wrap-exceptions", "time-zone", "locale", "date-format"].map((key) => canonicalKey(`spring.jackson.${key}`)),
);
/** Under `spring.jackson`: the settings that only affect reading a request. */
const READING_PREFIXES = ["deserialization", "parser"].map((key) => canonicalKey(`spring.jackson.${key}`));
const MAX_UNWRAPPING = 4;

const NO_LITERALS = { boolean: [], number: [], string: [] } as const;

function valueSet(parts: Partial<ValueSet>): ValueSet {
  return { literals: NO_LITERALS, array: false, object: false, null: false, absent: false, ...parts };
}

function unknownShape(reason: UnknownReason, ...evidence: Evidence[]): Shape {
  return { kind: "unknown", reason, evidence };
}

function scalar(literalClass: LiteralClass, nullable: boolean): Shape {
  return { kind: "known", values: valueSet({ literals: { ...NO_LITERALS, [literalClass]: "every" }, null: nullable }) };
}

function withoutNull(shape: Shape): Shape {
  return shape.kind === "known" ? { ...shape, values: { ...shape.values, null: false } } : shape;
}

/** A type written in the sources and where its names are read; `env` binds the type variables of the generic class it is a member of. */
interface TypeRef {
  node: Node;
  scope: Scope;
  env: ReadonlyMap<string, TypeRef>;
  /** The type variables of the method the type is written in. */
  variables: ReadonlySet<string>;
}

type Named =
  | { kind: "primitive"; literalClass: LiteralClass }
  | { kind: "array"; element: TypeRef; dimensions: number }
  | { kind: "project"; type: TypeDecl; arguments: readonly Node[]; ref: TypeRef }
  | { kind: "platform"; fqn: string; platform: PlatformKind; arguments: readonly Node[]; ref: TypeRef }
  | { kind: "void" }
  | { kind: "bound"; ref: TypeRef }
  | { kind: "unresolved" };

interface Cached {
  shape: Shape;
  files: readonly string[];
}

interface Reading {
  project: JavaProject;
  stack: TypeDecl[];
  cache: Map<TypeDecl, Cached>;
  /** The files each shape under construction has read, innermost last. */
  readers: Set<string>[];
  cuts: number;
  subtyped: ReadonlySet<TypeDecl> | undefined;
}

function nameOf(node: Node): string {
  return (node.type === "generic_type" ? node.namedChildren[0] : node)?.text.replace(/\s+/g, "") ?? "";
}

function argumentsOf(node: Node): Node[] {
  const list = node.type === "generic_type" ? node.namedChildren.find((child) => child.type === "type_arguments") : undefined;
  return list?.namedChildren ?? [];
}

function isTypeVariable(name: string, scope: Scope, method: ReadonlySet<string>): boolean {
  if (method.has(name)) return true;
  for (let type = scope.type; type !== undefined; type = type.outer) if (type.typeVariables.has(name)) return true;
  return false;
}

function named(ref: TypeRef, project: JavaProject): Named {
  const node = ref.node.type === "annotated_type" ? (ref.node.namedChildren.at(-1) ?? ref.node) : ref.node;
  const same = (replacement: Node): TypeRef => ({ ...ref, node: replacement });
  switch (node.type) {
    case "boolean_type":
      return { kind: "primitive", literalClass: "boolean" };
    case "floating_point_type":
      return { kind: "primitive", literalClass: "number" };
    case "integral_type":
      return { kind: "primitive", literalClass: node.text === "char" ? "string" : "number" };
    case "void_type":
      return { kind: "void" };
    case "array_type": {
      const element = node.childForFieldName("element");
      const dimensions = node.childForFieldName("dimensions")?.text.split("[").length;
      return element === null || dimensions === undefined ? { kind: "unresolved" } : { kind: "array", element: same(element), dimensions: dimensions - 1 };
    }
    case "type_identifier":
    case "scoped_type_identifier":
    case "generic_type":
      break;
    default:
      return { kind: "unresolved" };
  }
  const name = nameOf(node);
  const bound = ref.env.get(name);
  if (bound !== undefined) return { kind: "bound", ref: bound };
  if (isTypeVariable(name, ref.scope, ref.variables)) return { kind: "unresolved" };
  const found = project.lookupType(name, ref.scope);
  if (typeof found === "object") return { kind: "project", type: found, arguments: argumentsOf(node), ref };
  if (found === "ambiguous") return { kind: "unresolved" };
  const known = [...new Set([...externalNames(name, ref.scope.file, true), `java.lang.${name}`])].filter((candidate) => PLATFORM.has(candidate));
  const [fqn] = known;
  return known.length === 1 && fqn !== undefined ? { kind: "platform", fqn, platform: PLATFORM.get(fqn)!, arguments: argumentsOf(node), ref } : { kind: "unresolved" };
}

function typeArgument(of: Extract<Named, { arguments: readonly Node[] }>, index: number): TypeRef | undefined {
  const node = of.arguments[index];
  return node === undefined || node.type === "wildcard" ? undefined : { ...of.ref, node };
}

class ShapeReader {
  readonly #reading: Reading;

  constructor(project: JavaProject) {
    this.#reading = { project, stack: [], cache: new Map(), readers: [], cuts: 0, subtyped: undefined };
  }

  /** Reads one shape and the files it was read from. */
  read(ref: TypeRef, origin: string): ReadShape {
    const files = new Set<string>([origin]);
    this.#reading.readers.push(files);
    try {
      return { shape: this.shapeOf(ref), files: [...files].toSorted(compareText) };
    } finally {
      this.#reading.readers.pop();
    }
  }

  shapeOf(ref: TypeRef): Shape {
    const { project } = this.#reading;
    const resolved = named(ref, project);
    switch (resolved.kind) {
      case "primitive":
        return scalar(resolved.literalClass, false);
      case "void":
        return unknownShape("no-extractor", spanOf(ref.scope.file.path, ref.node));
      case "bound":
        return this.shapeOf(resolved.ref);
      case "array": {
        const base = this.shapeOf(resolved.element);
        let shape = base;
        for (let level = 0; level < resolved.dimensions; level++) {
          const bytes = level === 0 && named(resolved.element, project).kind === "primitive" && resolved.element.node.text === "byte";
          shape = bytes ? scalar("string", true) : arrayOf(shape);
        }
        return shape;
      }
      case "platform":
        return this.platformShape(resolved, ref);
      case "project":
        return this.projectShape(resolved.type, resolved);
      case "unresolved":
        return unknownShape("unresolved", spanOf(ref.scope.file.path, ref.node));
    }
  }

  private platformShape(resolved: Extract<Named, { kind: "platform" }>, ref: TypeRef): Shape {
    const evidence = spanOf(ref.scope.file.path, ref.node);
    switch (resolved.platform) {
      case "boolean":
      case "number":
      case "string":
        return scalar(resolved.platform, true);
      case "collection": {
        const element = typeArgument(resolved, 0);
        return arrayOf(element === undefined ? unknownShape("unresolved", evidence) : this.shapeOf(element));
      }
      case "optional": {
        const inner = typeArgument(resolved, 0);
        return inner === undefined ? unknownShape("unresolved", evidence) : this.shapeOf(inner);
      }
      case "wrapper":
      case "unmodelled":
        return unknownShape("no-extractor", evidence);
    }
  }

  private projectShape(type: TypeDecl, resolved: Extract<Named, { kind: "project" }>): Shape {
    const reading = this.#reading;
    const { project } = reading;
    const evidence = spanOf(type.file.path, type.node);
    const generic = type.typeVariables.size > 0;
    const cached = reading.cache.get(type);
    if (cached !== undefined) {
      this.touch(cached.files);
      return cached.shape;
    }
    if (reading.stack.includes(type)) {
      reading.cuts++;
      return unknownShape("unresolved", evidence);
    }
    if (type.kind === "interface" || type.kind === "annotation") return unknownShape("unresolved", evidence);
    const cutsBefore = reading.cuts;
    const files = new Set<string>();
    reading.readers.push(files);
    reading.stack.push(type);
    let shape: Shape;
    try {
      shape = type.node.type === "enum_declaration" ? this.enumerationShape(type) : this.objectShape(type, resolved);
    } finally {
      reading.stack.pop();
      reading.readers.pop();
    }
    const read = [...project.hierarchy(type).types.map((member) => member.file.path), ...files];
    this.touch(read);
    if (!generic && reading.cuts === cutsBefore) reading.cache.set(type, { shape, files: read });
    return shape;
  }

  private touch(files: readonly string[]): void {
    for (const reader of this.#reading.readers) for (const file of files) reader.add(file);
  }

  private enumerationShape(type: TypeDecl): Shape {
    const read = enumerationNames(type, this.#reading.project);
    if ("unknown" in read) return unknownShape(read.unknown.reason, read.unknown.evidence);
    return { kind: "known", values: valueSet({ literals: { ...NO_LITERALS, string: read.names }, null: true }) };
  }

  private objectShape(type: TypeDecl, resolved: Extract<Named, { kind: "project" }>): Shape {
    const { project } = this.#reading;
    const read = serializedProperties(type, project);
    if ("unknown" in read) return unknownShape(read.unknown.reason, read.unknown.evidence);
    const bindings = [...type.typeVariables].flatMap((variable, index) => {
      const argument = typeArgument(resolved, index);
      return argument === undefined ? [] : [[variable, argument] as const];
    });
    const env = new Map(bindings);
    const properties = read.properties.map((property) => this.propertyOf(property, type, env));
    return { kind: "known", values: valueSet({ object: true, null: true }), object: { properties, open: this.isOpen(type) } };
  }

  private propertyOf(property: WireProperty, owner: TypeDecl, env: ReadonlyMap<string, TypeRef>): { name: string; required: boolean; shape: Shape } {
    const ownMember = property.type.scope.type === owner;
    const ref: TypeRef = { ...property.type, env: ownMember ? env : new Map(), variables: new Set() };
    const resolved = named(ref, this.#reading.project);
    const optional = resolved.kind === "platform" && resolved.platform === "optional";
    if (property.undecided !== undefined) return { name: property.name, required: false, shape: unknownShape("no-extractor", property.undecided) };
    if (property.inclusion === "other") return { name: property.name, required: false, shape: unknownShape("no-extractor", spanOf(property.type.scope.file.path, property.type.node)) };
    const shape = this.shapeOf(ref);
    const dropsNull = property.inclusion === "non-null" && !optional && (shape.kind === "unknown" || shape.values.null);
    return { name: property.name, required: !dropsNull, shape: dropsNull ? withoutNull(shape) : shape };
  }

  /** A class a run-time subclass may stand for writes properties its declaration does not list. */
  private isOpen(type: TypeDecl): boolean {
    const reading = this.#reading;
    if (type.node.type === "record_declaration") return false;
    reading.subtyped ??= new Set(reading.project.types.flatMap((candidate) => reading.project.classChain(candidate).slice(1)));
    return type.isAbstract || reading.subtyped.has(type);
  }
}

function arrayOf(elements: Shape): Shape {
  return { kind: "known", values: valueSet({ array: true, null: true }), elements };
}

function handlerIndex(project: JavaProject): Map<string, MethodDecl> {
  const index = new Map<string, MethodDecl>();
  for (const type of project.types) {
    for (const method of type.methods) index.set(`${type.file.path}:${method.node.startPosition.row + 1}:${type.qualifiedName}.${method.name}`, method);
  }
  return index;
}

function isPresentation(key: string): boolean {
  return PRESENTATION_KEYS.has(key) || READING_PREFIXES.some((prefix) => key === prefix || key.startsWith(`${prefix}.`) || key.startsWith(`${prefix}[`));
}

/** What the configuration files of a module say about the mapper: the places that can change what a body holds, and every file that declares a setting of it. */
interface MapperSettings {
  changing: Evidence[];
  files: string[];
}

function mapperSettings(configuration: Configuration): MapperSettings {
  const changing: Evidence[] = [];
  const files = new Set<string>();
  for (const prefix of MAPPER_PREFIXES) {
    const { keys, undecided } = configuration.keysUnder(prefix);
    for (const { key, evidence } of keys) {
      files.add(evidence.path);
      if (!isPresentation(key)) changing.push(evidence);
    }
    for (const evidence of undecided) {
      files.add(evidence.path);
      changing.push(evidence);
    }
  }
  return { changing, files: [...files] };
}

/** Whether a converter hook only registers the mapper Spring would build by default, so it changes nothing about what bodies hold. */
function keepsDefaultMapper(method: MethodDecl, project: JavaProject): boolean {
  const statements = method.node.childForFieldName("body")?.namedChildren.filter((child) => !child.type.endsWith("comment")) ?? [];
  const scope = scopeOf(method.owner);
  return statements.every((statement) => {
    const call = statement.type === "expression_statement" ? statement.namedChildren[0] : undefined;
    if (call?.type !== "method_invocation" || call.childForFieldName("name")?.text !== "add") return false;
    const [added, ...others] = call.childForFieldName("arguments")?.namedChildren ?? [];
    const type = added?.type === "object_creation_expression" ? added.childForFieldName("type") : null;
    if (others.length > 0 || type === null || type === undefined || added?.childForFieldName("arguments")?.namedChildren.length !== 0) return false;
    const simple = nameOf(type).split(".").pop() ?? "";
    return simple === DEFAULT_CONVERTER && project.lookupType(simple, scope) === undefined;
  });
}

/** Where the repository's code configures the mapper that writes HTTP bodies; the bodies of an application that does are not the default's. */
function codeMapperConfiguration(project: JavaProject): Evidence[] {
  const found: Evidence[] = [];
  for (const type of project.types) {
    const scope = scopeOf(type);
    if (annotationUses(type.node, scope).some((use) => isAnnotation(use, JSON_COMPONENT))) found.push(spanOf(type.file.path, type.node));
    for (const method of type.methods) {
      if (CONVERTER_HOOKS.has(method.name) && !keepsDefaultMapper(method, project)) found.push(spanOf(type.file.path, method.node));
      const returns = method.node.childForFieldName("type");
      const simple = returns === null ? "" : (nameOf(returns).split(".").pop() ?? "");
      if (MAPPER_BEANS.has(simple) && annotationUses(method.node, scope).some((use) => isAnnotation(use, BEAN))) found.push(spanOf(type.file.path, method.node));
    }
  }
  return found;
}

function bySpan(a: Evidence, b: Evidence): number {
  return compareText(a.path, b.path) || a.line - b.line;
}

function withFiles(read: ReadShape, ...more: readonly (readonly string[])[]): ReadShape {
  return { ...read, files: [...new Set([...read.files, ...more.flat()])].toSorted(compareText) };
}

/** Whether Spring writes the handler's return value as the body: the class or the method says so, or the value is an entity. */
function writesBody(handler: MethodDecl, project: JavaProject, entity: boolean): boolean {
  if (entity) return true;
  const own = annotationUses(handler.node, scopeOf(handler.owner));
  if (own.some((use) => isAnnotation(use, BODY_ANNOTATIONS))) return true;
  return project.hierarchy(handler.owner).types.some((type) => annotationUses(type.node, scopeOf(type)).some((use) => isAnnotation(use, BODY_ANNOTATIONS)));
}

function responseOf(handler: MethodDecl, reader: ShapeReader, project: JavaProject): ReadShape {
  const path = handler.owner.file.path;
  const span = spanOf(path, handler.node);
  const returned = handler.node.childForFieldName("type");
  if (returned === null) return { shape: unknownShape("unresolved", span), files: [path] };
  let ref: TypeRef | undefined = { node: returned, scope: scopeOf(handler.owner), env: new Map(), variables: handler.typeVariables };
  let entity = false;
  for (let depth = 0; ref !== undefined && depth < MAX_UNWRAPPING; depth++) {
    const resolved = named(ref, project);
    if (resolved.kind !== "platform" || resolved.platform !== "wrapper") break;
    entity ||= ENTITIES.has(resolved.fqn);
    ref = typeArgument(resolved, 0);
  }
  if (ref === undefined) return { shape: unknownShape("unresolved", span), files: [path] };
  const body = named(ref, project);
  if (!writesBody(handler, project, entity) || body.kind === "void" || (body.kind === "platform" && body.fqn === TEXT_BODY)) {
    return { shape: unknownShape("no-extractor", span), files: [path] };
  }
  return reader.read(ref, path);
}

export type RouteReader = (files: readonly SourceFile[]) => readonly Finding<Entrypoint>[];

/**
 * `PayloadShapes` over Spring handlers under Jackson's default configuration. The operations are the HTTP routes `readRoutes`
 * finds; each is identified by its verb and the path the code maps (the configuration's base path is not added), and its
 * shape is read from its handler's return type over the one Java project of the sources.
 */
export function createSpringPayloadShapes(parser: JavaParser, readRoutes: RouteReader): PayloadShapes {
  return {
    responses(files) {
      const routes = readRoutes(files).flatMap((finding) => (finding.status === "complete" && finding.value.kind === "http-route" ? [{ route: finding.value, evidence: finding.evidence }] : []));
      if (routes.length === 0) return [];
      const trees: JavaSyntaxTree[] = [];
      try {
        const parsed: JavaFile[] = [];
        for (const source of files) {
          if (!isJavaSource(source.path) || isJvmTestFile(source.path)) continue;
          const result = parser.parse(source.content);
          if (!result.ok) continue;
          trees.push(result.value);
          parsed.push(describeFile(source.path, result.value.root));
        }
        const project = createJavaProject(parsed);
        const handlers = handlerIndex(project);
        const code = codeMapperConfiguration(project);
        const configurationOf = configurationsOf(files.filter((file) => isSpringConfigFile(file.path)));
        const settingsOf = new Map<Configuration, MapperSettings>();
        const reader = new ShapeReader(project);
        const shapes = new Map<string, ReadShape>();
        return routes.map(({ route, evidence }): Finding<OperationShape> => {
          const { handler } = route;
          const key = `${handler.path}:${handler.line}:${handler.symbol}`;
          const method = handlers.get(key);
          let read = shapes.get(key);
          if (read === undefined) {
            if (method === undefined) read = { shape: unknownShape("source-unreadable", { path: handler.path, line: handler.line }), files: [handler.path] };
            else {
              const configuration = configurationOf(method.owner.file);
              const settings = settingsOf.get(configuration) ?? mapperSettings(configuration);
              settingsOf.set(configuration, settings);
              const configured = [...code, ...settings.changing].toSorted(bySpan);
              read =
                configured.length > 0
                  ? withFiles({ shape: unknownShape("no-extractor", ...configured), files: [handler.path] }, configured.map(({ path }) => path), settings.files)
                  : withFiles(responseOf(method, reader, project), settings.files);
            }
            shapes.set(key, read);
          }
          return { status: "complete", value: { operationId: undefined, method: route.method, path: route.path, basePath: "", ...read }, evidence };
        });
      } finally {
        for (const tree of trees) tree.dispose();
      }
    },
  };
}
