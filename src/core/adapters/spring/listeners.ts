import type { Node } from "web-tree-sitter";
import type { Job, Listener } from "../../domain/entrypoints/entrypoint.ts";
import type { Handler } from "../../domain/entrypoints/http-route.ts";
import { declarationSpan } from "../../domain/shared/fact.ts";
import type { Evidence, Finding, UnknownSubject } from "../../domain/shared/fact.ts";
import { methodSite, spanOf, subjectOf, unknown } from "./findings.ts";
import { namedChildren, qualifiedTypeName, scopeOf, type Evaluation, type Expr, type JavaProject, type MethodDecl, type Scope, type TypeDecl } from "./java-symbols.ts";
import {
  annotationName,
  annotationUseOf,
  annotationUses,
  isScannedBean,
  EVENT_LISTENERS,
  FOREIGN_LISTENERS,
  JMS_LISTENER,
  KAFKA_LISTENER,
  LISTENER_CONTAINERS,
  RABBIT_LISTENER,
  SCHEDULED,
  type AnnotationUse,
  type SpringAnnotations,
} from "./request-mapping.ts";

interface DestinationAttributes {
  protocol: Listener["protocol"];
  attribute: string;
  /** Attributes that give destinations in a form this extractor does not read. */
  unread: readonly string[];
}

const DESTINATIONS: ReadonlyMap<string, DestinationAttributes> = new Map([
  [KAFKA_LISTENER, { protocol: "kafka", attribute: "topics", unread: ["topicPattern", "topicPartitions"] }],
  [RABBIT_LISTENER, { protocol: "rabbit", attribute: "queues", unread: ["bindings", "queuesToDeclare"] }],
  [JMS_LISTENER, { protocol: "jms", attribute: "destination", unread: [] }],
]);
const CRON_DISABLED = "-";
const TRIGGERS: readonly string[] = ["cron", "fixedDelay", "fixedDelayString", "fixedRate", "fixedRateString"];
const LONG_TRIGGERS: ReadonlySet<string> = new Set(["fixedDelay", "fixedRate"]);
const READ: ReadonlySet<string> = new Set([...DESTINATIONS.keys(), ...EVENT_LISTENERS, SCHEDULED]);
const LISTENER_KEYS: ReadonlySet<string> = new Set([...READ, ...LISTENER_CONTAINERS, ...FOREIGN_LISTENERS]);

/** Where a listener annotation sits: a method, or the class of a class-level listener. */
interface Site {
  span: Evidence;
  handler: Handler;
  method: MethodDecl | undefined;
}

interface Context {
  type: TypeDecl;
  project: JavaProject;
  annotations: SpringAnnotations;
  /** The class is a bean of its own; otherwise only something the sources may not show registers it. */
  scannedBean: boolean;
}

/**
 * The listeners and jobs a concrete class declares on its methods and, for Kafka and Rabbit, on the class itself. A
 * listener annotation the class inherits from a supertype is an unknown item: Spring's search through the hierarchy
 * differs by annotation, and this extractor does not follow it.
 */
export function listenersOf(type: TypeDecl, project: JavaProject, annotations: SpringAnnotations, scannedBean: boolean): Finding<Listener | Job>[] {
  const context: Context = { type, project, annotations, scannedBean };
  const own = [
    ...findingsAt(classSite(type), annotationUses(type.node, scopeOf(type)), context),
    ...type.methods.flatMap((method) => findingsAt(methodSite(method), annotationUses(method.node, scopeOf(type)), context)),
  ];
  const inherited = project
    .hierarchy(type)
    .types.slice(1)
    .flatMap((member) =>
      [{ node: member.node, symbol: member.qualifiedName }, ...member.methods.map((method) => ({ node: method.node, symbol: `${member.qualifiedName}.${method.name}` }))].flatMap(({ node, symbol }) => {
        const use = annotationUses(node, scopeOf(member)).find((candidate) => isListener(candidate, context, new Set()));
        return use === undefined ? [] : [unknown("no-extractor", [spanOf(member.file.path, node), spanOf(type.file.path, type.node)], subjectOfUse(use, symbol, annotations))];
      }),
    );
  return [...own, ...inherited];
}

/**
 * A scanned bean that extends a class no source declares inherits registrations (a NATS subject, a queue) that no reader
 * can see: one unknown item at the class, naming the base. A controller's absent supertype has its own item.
 */
export function unreadBaseOf(type: TypeDecl, project: JavaProject, annotations: SpringAnnotations): Finding<never>[] {
  if (type.kind !== "class" || type.isAbstract || !isScannedBean(type, annotations) || annotations.stereotypeIn(annotationUses(type.node, scopeOf(type))) === "controller") return [];
  const base = project.hierarchy(type).gaps.find((gap) => gap.kind === "missing" && !gap.isInterface);
  return base === undefined ? [] : [unknown("no-extractor", [spanOf(type.file.path, type.node), spanOf(base.file.path, base.node)], subjectOf(undefined, type.qualifiedName, base.name))];
}

function findingsAt(site: Site, uses: readonly AnnotationUse[], context: Context): Finding<Listener | Job>[] {
  const { annotations, type } = context;
  return unfolded(uses, annotations).flatMap((use): Finding<Listener | Job>[] => {
    const key = annotations.keyOf(use) ?? "";
    const at = spanOf(use.scope.file.path, use.node);
    const subject = subjectOfUse(use, site.handler.symbol, annotations);
    if (!READ.has(key)) return isListener(use, context, new Set()) ? [unknown("no-extractor", [site.span, at], subject)] : [];
    if (!context.scannedBean) return [unknown("no-extractor", [site.span, spanOf(type.file.path, type.node)], subject)];
    const destinations = DESTINATIONS.get(key);
    if (destinations !== undefined) return destinationsOf(use, destinations, site, context.project, subject);
    return key === SCHEDULED ? jobsOf(use, site, context.project, subject) : eventsOf(use, site, context.project, subject);
  });
}

/** A scheduled annotation stands for a job; any other listener annotation, for a listener. */
function subjectOfUse(use: AnnotationUse, symbol: string, annotations: SpringAnnotations): UnknownSubject {
  const raisedBy = annotationName(use, annotations);
  return subjectOf(raisedBy === SCHEDULED ? "job" : "listener", symbol, raisedBy);
}

/** A container's annotations take its place. */
function unfolded(uses: readonly AnnotationUse[], annotations: SpringAnnotations): AnnotationUse[] {
  return uses.flatMap((use) =>
    LISTENER_CONTAINERS.has(annotations.keyOf(use) ?? "")
      ? (use.attributes.get("value") ?? []).filter((expr) => expr.node.type.endsWith("annotation")).map((expr) => annotationUseOf(expr.node, expr.scope))
      : [use],
  );
}

/** A listener annotation, another library's included, or an annotation the repository declares that composes one. */
function isListener(use: AnnotationUse, context: Context, visiting: ReadonlySet<TypeDecl>): boolean {
  if (LISTENER_KEYS.has(context.annotations.keyOf(use) ?? "")) return true;
  const declared = context.project.lookupType(use.name, use.scope);
  if (typeof declared !== "object" || visiting.has(declared)) return false;
  const inner = new Set(visiting).add(declared);
  return annotationUses(declared.node, scopeOf(declared)).some((meta) => isListener(meta, context, inner));
}

function destinationsOf(use: AnnotationUse, { protocol, attribute, unread }: DestinationAttributes, site: Site, project: JavaProject, subject: UnknownSubject): Finding<Listener>[] {
  const at = spanOf(use.scope.file.path, use.node);
  const notRead = unread.filter((name) => use.attributes.has(name)).map(() => unknown("no-extractor", [site.span, at], subject));
  const listeners = (use.attributes.get(attribute) ?? []).map((expr) =>
    valued(project.evaluate(expr), expr, site, subject, (destination): Listener => ({ kind: "listener", name: `${protocol} ${destination}`, protocol, destination, handler: site.handler })),
  );
  return listeners.length === 0 && notRead.length === 0 ? [unknown("unresolved", [site.span, at], subject)] : [...listeners, ...notRead];
}

/** One item per event type: the `classes` or `value` attribute, else the type of the method's single parameter. */
function eventsOf(use: AnnotationUse, site: Site, project: JavaProject, subject: UnknownSubject): Finding<Listener>[] {
  const classes = use.attributes.get("classes") ?? use.attributes.get("value") ?? [];
  const event = (type: Node | null | undefined, scope: Scope, evidence: readonly Evidence[]): Finding<Listener> => {
    const name = (type?.type === "generic_type" ? type.namedChildren[0] : type)?.text;
    const qualified = name === undefined ? undefined : qualifiedTypeName(name, scope, project);
    if (qualified === undefined) return unknown("unresolved", evidence, subject);
    const value: Listener = { kind: "listener", name: `event ${qualified}`, protocol: "event", destination: qualified, handler: site.handler };
    return { status: "complete", value, evidence: [site.span] };
  };
  if (classes.length > 0) {
    return classes.map((expr) => event(expr.node.type === "class_literal" ? expr.node.namedChildren[0] : undefined, expr.scope, [site.span, spanOf(expr.scope.file.path, expr.node)]));
  }
  const parameters = site.method?.node.childForFieldName("parameters");
  const [parameter, ...others] = parameters === null || parameters === undefined ? [] : namedChildren(parameters);
  if (site.method === undefined || parameter === undefined || others.length > 0) return [unknown("unresolved", [site.span], subject)];
  return [event(parameter.childForFieldName("type"), scopeOf(site.method.owner), [site.span])];
}

/**
 * A job is triggered by exactly one of the trigger attributes; a one-time task, or one that names several, is not read.
 * A cron of `-` disables the task, so it is no job.
 */
function jobsOf(use: AnnotationUse, site: Site, project: JavaProject, subject: UnknownSubject): Finding<Job>[] {
  const [attribute, ...others] = TRIGGERS.filter((name) => use.attributes.has(name));
  const expr = attribute === undefined ? undefined : use.attributes.get(attribute)?.[0];
  if (attribute === undefined || expr === undefined || others.length > 0) return [unknown("no-extractor", [site.span, spanOf(use.scope.file.path, use.node)], subject)];
  const evaluation = LONG_TRIGGERS.has(attribute) ? project.evaluateLong(expr) : project.evaluate(expr);
  if (attribute === "cron" && "value" in evaluation && evaluation.value === CRON_DISABLED) return [];
  return [valued(evaluation, expr, site, subject, (value): Job => ({ kind: "job", name: `scheduled ${attribute}=${value}`, trigger: { attribute, value }, handler: site.handler }))];
}

function valued<T>(evaluation: Evaluation, expr: Expr, site: Site, subject: UnknownSubject, item: (value: string) => T): Finding<T> {
  if ("gap" in evaluation) return unknown(evaluation.gap, [site.span, spanOf(expr.scope.file.path, expr.node)], subject);
  return { status: "complete", value: item(evaluation.value), evidence: [site.span] };
}

function classSite(type: TypeDecl): Site {
  const span = spanOf(type.file.path, type.node);
  return { span, handler: { path: span.path, symbol: type.qualifiedName, line: span.line, ...declarationSpan(span.line, span.endLine) }, method: undefined };
}
