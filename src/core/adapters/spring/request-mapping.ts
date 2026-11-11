import type { Node } from "web-tree-sitter";
import type { HttpMethod } from "../../domain/entrypoints/http-route.ts";
import { externalNames, namedChildren, scopeOf, type Expr, type Gap, type GapReason, type JavaProject, type Scope, type TypeDecl } from "./java-symbols.ts";

export type Attributes = ReadonlyMap<string, readonly Expr[]>;

export interface AnnotationUse {
  name: string;
  node: Node;
  attributes: Attributes;
  scope: Scope;
}

/** A mapping annotation after composed annotations are unfolded: the verb its kind fixes and its attributes. */
export interface Mapping {
  verb: HttpMethod | undefined;
  attributes: Attributes;
}

export type MappingLookup = { mapping: Mapping } | { gap: Gap } | undefined;

/**
 * `ambiguous` carries the annotation that two files declare, one of which may make the class a controller;
 * `unmodelled` one that makes the class a handler of a Spring mapping this module does not read.
 */
export type Stereotype = "controller" | "none" | { ambiguous: AnnotationUse } | { unmodelled: AnnotationUse };

export interface SpringAnnotations {
  /** The first of the annotations that is, or composes, a request mapping; a gap when the sources do not decide it. */
  mappingIn(uses: readonly AnnotationUse[]): MappingLookup;
  stereotypeIn(uses: readonly AnnotationUse[]): Stereotype;
  /** An annotation that no source declares and the platform packages do not own: it may compose a mapping that is not read. */
  libraryAnnotationIn(uses: readonly AnnotationUse[]): AnnotationUse | undefined;
  /** The annotation this module knows that the use names, when no source declares one of that name. */
  keyOf(use: AnnotationUse): string | undefined;
}

const WEB = "org.springframework.web.bind.annotation.";
const SERVICE = "org.springframework.web.service.annotation.";
const ALIAS_FOR = "org.springframework.core.annotation.AliasFor";
const REQUEST_MAPPING = `${WEB}RequestMapping`;
const CONTROLLERS: ReadonlySet<string> = new Set([`${WEB}RestController`, "org.springframework.stereotype.Controller"]);
const VERBS: ReadonlyMap<string, HttpMethod | undefined> = new Map([
  [REQUEST_MAPPING, undefined],
  [`${WEB}GetMapping`, "GET"],
  [`${WEB}PostMapping`, "POST"],
  [`${WEB}PutMapping`, "PUT"],
  [`${WEB}DeleteMapping`, "DELETE"],
  [`${WEB}PatchMapping`, "PATCH"],
]);
const EXCHANGES: ReadonlySet<string> = new Set(
  ["HttpExchange", "GetExchange", "PostExchange", "PutExchange", "DeleteExchange", "PatchExchange"].map((name) => `${SERVICE}${name}`),
);
/** Handlers of mappings other than `RequestMappingHandlerMapping`, whose paths depend on configuration this module does not read. */
const UNMODELLED_HANDLERS: ReadonlySet<string> = new Set(["RepositoryRestController", "BasePathAwareController"].map((name) => `org.springframework.data.rest.webmvc.${name}`));
/** Stereotypes of beans that are not handlers by themselves. */
export const COMPONENTS: ReadonlySet<string> = new Set(["Service", "Component"].map((name) => `org.springframework.stereotype.${name}`));
/** The stereotypes component scanning registers a bean of its own for, besides a controller's. */
export const SCANNED_STEREOTYPES: ReadonlySet<string> = new Set([
  ...COMPONENTS,
  "org.springframework.stereotype.Repository",
  "org.springframework.context.annotation.Configuration",
]);

export const KAFKA_LISTENER = "org.springframework.kafka.annotation.KafkaListener";
export const RABBIT_LISTENER = "org.springframework.amqp.rabbit.annotation.RabbitListener";
export const JMS_LISTENER = "org.springframework.jms.annotation.JmsListener";
export const EVENT_LISTENERS: ReadonlySet<string> = new Set([
  "org.springframework.context.event.EventListener",
  "org.springframework.transaction.event.TransactionalEventListener",
  "org.springframework.modulith.events.ApplicationModuleListener",
]);
export const SCHEDULED = "org.springframework.scheduling.annotation.Scheduled";
/** The containers that collect a repeated listener or scheduling annotation. */
export const LISTENER_CONTAINERS: ReadonlySet<string> = new Set([
  `${KAFKA_LISTENER}s`,
  `${RABBIT_LISTENER}s`,
  `${JMS_LISTENER}s`,
  "org.springframework.scheduling.annotation.Schedules",
]);
/** Listener annotations of other messaging libraries, which this extractor does not read. */
export const FOREIGN_LISTENERS: ReadonlySet<string> = new Set([
  "org.springframework.cloud.stream.annotation.StreamListener",
  "io.awspring.cloud.sqs.annotation.SqsListener",
  "org.springframework.pulsar.annotation.PulsarListener",
]);

const SERVLET_APIS = ["jakarta", "javax"];
const jaxRs = (names: readonly string[]) => SERVLET_APIS.flatMap((root) => names.map((name) => `${root}.ws.rs.${name}`));
const micronaut = (names: readonly string[]) => names.map((name) => `io.micronaut.http.annotation.${name}`);

export const SPRING_BOOT_APPLICATION = "org.springframework.boot.autoconfigure.SpringBootApplication";
export const PROPERTY_SOURCES: ReadonlySet<string> = new Set([
  "org.springframework.context.annotation.PropertySource",
  "org.springframework.context.annotation.PropertySources",
]);

/** Annotations of non-Spring HTTP servers that declare the endpoint on the type, so its methods cannot be told apart. */
export const FOREIGN_TYPE_ENDPOINTS: ReadonlySet<string> = new Set([
  ...jaxRs(["Path"]),
  ...micronaut(["Controller"]),
  ...SERVLET_APIS.map((root) => `${root}.servlet.annotation.WebServlet`),
]);
/** Annotations of non-Spring HTTP servers that declare an endpoint on a method. */
export const FOREIGN_METHOD_ENDPOINTS: ReadonlySet<string> = new Set([
  ...jaxRs(["Path", "GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]),
  ...micronaut(["Get", "Post", "Put", "Delete", "Patch", "Head", "Options", "Trace"]),
  ...["Route", "Routes"].map((name) => `io.quarkus.vertx.web.${name}`),
]);
const KNOWN: ReadonlySet<string> = new Set([
  ...CONTROLLERS,
  ...UNMODELLED_HANDLERS,
  ...VERBS.keys(),
  ...EXCHANGES,
  ALIAS_FOR,
  "com.netflix.graphql.dgs.DgsData",
  "com.netflix.graphql.dgs.DgsComponent",
  ...SCANNED_STEREOTYPES,
  ...FOREIGN_TYPE_ENDPOINTS,
  ...FOREIGN_METHOD_ENDPOINTS,
  SPRING_BOOT_APPLICATION,
  ...PROPERTY_SOURCES,
  KAFKA_LISTENER,
  RABBIT_LISTENER,
  JMS_LISTENER,
  ...EVENT_LISTENERS,
  SCHEDULED,
  ...LISTENER_CONTAINERS,
  ...FOREIGN_LISTENERS,
]);
/** The attributes of a mapping annotation that decide a route and that Spring 6.2 lets a composed annotation override by name. */
const CONVENTION_ATTRIBUTES: readonly string[] = ["path", "method"];

export function annotationUses(declaration: Node, scope: Scope): AnnotationUse[] {
  const modifiers = declaration.namedChildren.find((child) => child.type === "modifiers");
  if (modifiers === undefined) return [];
  return namedChildren(modifiers)
    .filter((node) => node.type === "annotation" || node.type === "marker_annotation")
    .map((node) => annotationUseOf(node, scope));
}

/** An annotation node, written on a declaration or nested in another annotation's attribute. */
export function annotationUseOf(node: Node, scope: Scope): AnnotationUse {
  return { name: node.childForFieldName("name")?.text ?? "", node, attributes: attributesOf(node, scope), scope };
}

/** `value` and `path` are aliases of one attribute. */
export function pathExpressions(attributes: Attributes): readonly Expr[] | undefined {
  return attributes.get("path") ?? attributes.get("value");
}

type Reference =
  | { kind: "declared"; type: TypeDecl }
  /** `key` is the Spring annotation the name resolves to, when it is one this module knows. */
  | { kind: "external"; key: string | undefined; library: boolean }
  | { kind: "ambiguous" };

export function createSpringAnnotations(project: JavaProject): SpringAnnotations {
  function resolveName(name: string, scope: Scope): Reference {
    const found = project.lookupType(name, scope);
    if (found === "ambiguous") return { kind: "ambiguous" };
    if (found !== undefined) return { kind: "declared", type: found };
    const names = externalNames(name, scope.file, false);
    const key = names.find((candidate) => KNOWN.has(candidate));
    return { kind: "external", key, library: key === undefined && !names.every(project.isPlatformName) };
  }

  function keyOf(reference: Reference): string | undefined {
    return reference.kind === "declared" ? reference.type.fqn : reference.kind === "external" ? reference.key : undefined;
  }

  function mappingOf(use: AnnotationUse, visiting: ReadonlySet<TypeDecl>): MappingLookup {
    const gapAt = (reason: GapReason): MappingLookup => ({ gap: { reason, file: use.scope.file, node: use.node } });
    const reference = resolveName(use.name, use.scope);
    if (reference.kind === "ambiguous") return gapAt("unresolved");
    if (reference.kind === "external") {
      if (reference.key !== undefined && VERBS.has(reference.key)) return { mapping: { verb: VERBS.get(reference.key), attributes: use.attributes } };
      return reference.key !== undefined && EXCHANGES.has(reference.key) ? gapAt("no-extractor") : undefined;
    }
    const declared = reference.type;
    if (declared.kind !== "annotation" || visiting.has(declared)) return undefined;
    const inner = new Set(visiting).add(declared);
    for (const meta of annotationUses(declared.node, scopeOf(declared))) {
      const found = mappingOf(applyAliases(meta, declared, use), inner);
      if (found === undefined) continue;
      return "mapping" in found && overridesByConvention(declared, meta) ? gapAt("unresolved") : found;
    }
    return undefined;
  }

  function aliasOf(element: Node, scope: Scope): AnnotationUse | undefined {
    return annotationUses(element, scope).find((candidate) => keyOf(resolveName(candidate.name, scope)) === ALIAS_FOR);
  }

  /** The attributes `use` passes to `meta` through the `@AliasFor` of the composed annotation's own attributes. */
  function applyAliases(meta: AnnotationUse, composed: TypeDecl, use: AnnotationUse): AnnotationUse {
    const scope = scopeOf(composed);
    const targetReference = resolveName(meta.name, scope);
    const target = keyOf(targetReference);
    const attributes = new Map(meta.attributes);
    for (const element of elementsOf(composed)) {
      const name = element.childForFieldName("name")?.text;
      const alias = aliasOf(element, scope);
      const aliased = alias?.attributes.get("annotation")?.[0]?.node.text.replace(/\.class$/, "");
      if (name === undefined || alias === undefined || aliased === undefined) continue;
      if (keyOf(resolveName(aliased, scope)) !== target) continue;
      const defaultValue = element.childForFieldName("value");
      const provided = use.attributes.get(name) ?? (defaultValue === null ? undefined : valueExpressions(defaultValue, scope));
      if (provided === undefined || provided.length === 0) continue;
      const attribute = alias.attributes.get("attribute") ?? alias.attributes.get("value");
      const evaluated = attribute?.[0] === undefined ? undefined : project.evaluate(attribute[0]);
      const targetName = evaluated !== undefined && "value" in evaluated ? evaluated.value : name;
      if (targetReference.kind === "external" && (targetName === "path" || targetName === "value")) {
        attributes.delete("value");
        attributes.set("path", provided);
      } else {
        attributes.set(targetName, provided);
      }
    }
    return { ...meta, attributes };
  }

  /**
   * Spring 6.2 also lets an attribute of a composed annotation override the same-named attribute of its meta-annotation
   * without `@AliasFor`; Spring 7 does not. The route differs between the two when the attribute decides it.
   */
  function overridesByConvention(composed: TypeDecl, meta: AnnotationUse): boolean {
    const scope = scopeOf(composed);
    const target = resolveName(meta.name, scope);
    return elementsOf(composed).some((element) => {
      const name = element.childForFieldName("name")?.text ?? "";
      return CONVENTION_ATTRIBUTES.includes(name) && aliasOf(element, scope) === undefined && declaresAttribute(target, name);
    });
  }

  function declaresAttribute(reference: Reference, name: string): boolean {
    if (reference.kind === "declared") return elementsOf(reference.type).some((element) => element.childForFieldName("name")?.text === name);
    if (reference.kind === "ambiguous" || reference.key === undefined || !VERBS.has(reference.key)) return false;
    return name === "path" || reference.key === REQUEST_MAPPING;
  }

  function stereotypeIn(uses: readonly AnnotationUse[], visiting: ReadonlySet<TypeDecl>): Stereotype {
    let result: Stereotype = "none";
    for (const use of uses) {
      const reference = resolveName(use.name, use.scope);
      let found: Stereotype = "none";
      if (reference.kind === "ambiguous") found = { ambiguous: use };
      else if (reference.kind === "external") found = externalStereotype(reference.key, use);
      else if (reference.type.kind === "annotation" && !visiting.has(reference.type)) {
        found = stereotypeIn(annotationUses(reference.type.node, scopeOf(reference.type)), new Set(visiting).add(reference.type));
      }
      if (found === "controller") return found;
      if (found !== "none") result = found;
    }
    return result;
  }

  function externalStereotype(key: string | undefined, use: AnnotationUse): Stereotype {
    if (key === undefined) return "none";
    return CONTROLLERS.has(key) ? "controller" : UNMODELLED_HANDLERS.has(key) ? { unmodelled: use } : "none";
  }

  return {
    mappingIn(uses) {
      let gap: MappingLookup;
      for (const use of uses) {
        const found = mappingOf(use, new Set());
        if (found !== undefined && "mapping" in found) return found;
        gap ??= found;
      }
      return gap;
    },
    stereotypeIn: (uses) => stereotypeIn(uses, new Set()),
    keyOf(use) {
      const reference = resolveName(use.name, use.scope);
      return reference.kind === "external" ? reference.key : undefined;
    },
    libraryAnnotationIn: (uses) =>
      uses.find((use) => {
        const reference = resolveName(use.name, use.scope);
        return reference.kind === "external" && reference.library;
      }),
  };
}

function elementsOf(annotation: TypeDecl): Node[] {
  const body = annotation.node.childForFieldName("body");
  return body === null ? [] : namedChildren(body).filter((child) => child.type === "annotation_type_element_declaration");
}

function attributesOf(annotation: Node, scope: Scope): Attributes {
  const attributes = new Map<string, readonly Expr[]>();
  const list = annotation.childForFieldName("arguments");
  for (const argument of list === null ? [] : namedChildren(list)) {
    if (argument.type === "element_value_pair") {
      const key = argument.childForFieldName("key")?.text;
      const value = argument.childForFieldName("value");
      if (key !== undefined && value !== null) attributes.set(key, valueExpressions(value, scope));
    } else {
      attributes.set("value", valueExpressions(argument, scope));
    }
  }
  return attributes;
}

function valueExpressions(value: Node, scope: Scope): Expr[] {
  const nodes = value.type === "element_value_array_initializer" ? namedChildren(value) : [value];
  return nodes.map((node) => ({ node, scope }));
}

export function isAnnotation(use: AnnotationUse, names: ReadonlySet<string> | string): boolean {
  const wanted = typeof names === "string" ? [names] : [...names];
  return externalNames(use.name, use.scope.file, false).some((candidate) => wanted.includes(candidate));
}

/**
 * Component scanning reads only the class's own annotations (`@Component` is not `@Inherited`), so a class that
 * inherits its stereotype is a bean only if something the sources may not show registers it.
 */
export function isScannedBean(type: TypeDecl, annotations: SpringAnnotations): boolean {
  const own = annotationUses(type.node, scopeOf(type));
  return annotations.stereotypeIn(own) === "controller" || own.some((use) => SCANNED_STEREOTYPES.has(annotations.keyOf(use) ?? ""));
}
