import { ANYTHING, LITERAL_CLASSES, NOTHING, type KnownShape, type OperationRequest, type OperationShape, type Shape, type ShapeProperty, type UnknownShape } from "../../domain/contracts/payload-shape.ts";
import type { HttpMethod } from "../../domain/entrypoints/http-route.ts";
import { isContractDocument } from "../../domain/languages/openapi.ts";
import { canonicalJson } from "../../domain/shared/canonical-json.ts";
import { compareText } from "../../domain/shared/code-node.ts";
import type { Evidence, Finding } from "../../domain/shared/fact.ts";
import type { Literal } from "../../domain/contracts/use-operation.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { PayloadShapes } from "../../ports/payload-shapes.port.ts";
import { createDigester, DOCUMENTATION, declaredOperations, parseContract, producesOf, referencedDocuments, requestOf, targetOf, type DeclaredOperation, type Digester, type ParsedContract, type ReferencedDocuments } from "./contract-document.adapter.ts";

type Json = Record<string, unknown>;
type Kind = LiteralKindName | "array" | "object" | "null";
type LiteralKindName = (typeof LITERAL_CLASSES)[number];

/** A schema node and the file its references are relative to; `key` names the node when a reference led to it. */
interface Located {
  file: string;
  node: unknown;
  key?: string;
}

/** What a schema allows, before the shapes of its properties and elements are read. */
interface Analysis {
  allowed: Readonly<Record<Kind, boolean>>;
  /** The values an `enum` or `const` lists. */
  listed: readonly (Literal | null)[] | undefined;
  properties: ReadonlyMap<string, Located>;
  required: ReadonlySet<string>;
  open: boolean;
  items: Located | undefined;
  keywords: Readonly<Record<string, unknown>>;
}

const KIND_OF_TYPE: Readonly<Record<string, Kind>> = { string: "string", number: "number", integer: "number", boolean: "boolean", array: "array", object: "object", null: "null" };
const EVERY_KIND: Readonly<Record<Kind, boolean>> = { string: true, number: true, boolean: true, array: true, object: true, null: true };

/** Keywords that narrow a value within its class, or only describe it: no class and no listed literal changes with them. */
const IGNORED: ReadonlySet<string> = new Set([
  ...DOCUMENTATION,
  ...["title", "deprecated", "readOnly", "writeOnly", "xml", "discriminator", "default", "format", "pattern", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "minItems", "maxItems", "uniqueItems", "minProperties", "maxProperties", "$comment", "$id", "$schema"],
]);

/** Keywords that change which values a place admits in a way a value set does not state: the place is unknown. */
const UNMODELLED: readonly string[] = ["oneOf", "anyOf", "not", "patternProperties", "if", "then", "else", "prefixItems", "contains", "propertyNames", "unevaluatedProperties", "unevaluatedItems", "dependentSchemas", "additionalItems"];

/** Keywords the reader turns into the value set or the structure of a place. */
const MODELLED: ReadonlySet<string> = new Set(["type", "nullable", "x-nullable", "enum", "const", "properties", "required", "additionalProperties", "items", "allOf", "$ref"]);

/** Keywords that only document a schema. An extension (`x-`) is kept: a generator may turn it into what the wire carries. */
const DOCUMENTING: ReadonlySet<string> = new Set([...DOCUMENTATION, "title", "$comment", "$id", "$schema"]);

/** The keywords of one schema node its value set does not state, which the shape keeps for the derivation to compare. */
const keptKeywords = (node: Json): [string, unknown][] => Object.entries(node).filter(([keyword]) => !MODELLED.has(keyword) && !DOCUMENTING.has(keyword));

/** The keywords several nodes hold together: one value as itself, several distinct values of one keyword as their sorted list. */
function joinedKeywords(nodes: readonly Json[]): Readonly<Record<string, unknown>> {
  const values = new Map<string, Map<string, unknown>>();
  for (const [keyword, value] of nodes.flatMap(keptKeywords)) values.set(keyword, (values.get(keyword) ?? new Map()).set(canonicalJson(value), value));
  const joined = (distinct: Map<string, unknown>): unknown => (distinct.size === 1 ? [...distinct.values()][0] : [...distinct].sort(([a], [b]) => compareText(a, b)).map(([, value]) => value));
  return Object.fromEntries([...values].sort(([a], [b]) => compareText(a, b)).map(([keyword, distinct]) => [keyword, joined(distinct)]));
}

/** The keywords a branch of an `allOf` may hold for the branches to be a plain merge of open object schemas. */
const MERGEABLE: ReadonlySet<string> = new Set([...IGNORED, "type", "properties", "required", "additionalProperties", "allOf"]);

const SUCCESS = /^2(\d\d|XX)$/i;

/** The shapes of the success responses, and of what the requests carry, of the operations OpenAPI 3.x and Swagger 2.0 documents declare. */
export function createPayloadShapes(): PayloadShapes {
  return {
    responses: (files) => {
      const referenced = referencedDocuments(files);
      return files.flatMap((file) => (isContractDocument(file.path) ? operationsOf(file, (contract, declared, place) => responseShapeOf(contract, declared, place, referenced)) : []));
    },
    requests: (files) => {
      const referenced = referencedDocuments(files);
      return files.flatMap((file) => (isContractDocument(file.path) ? operationsOf(file, (contract, declared, place) => requestShapeOf(contract, declared, place, referenced)) : []));
    },
  };
}

type OperationIdentity = Pick<OperationShape, "operationId" | "method" | "path" | "basePath">;

/** What `read` states of each operation one contract document declares, beside the operation's identity; the document's own failure when it cannot be read. */
function operationsOf<T>(file: SourceFile, read: (contract: ParsedContract, declared: DeclaredOperation, place: Evidence) => T): readonly Finding<OperationIdentity & T>[] {
  const contract = parseContract(file);
  if (contract === undefined) return [];
  if ("status" in contract) return [contract];
  return declaredOperations(contract).map((declared) => {
    const { path, verb, operationId, line } = declared;
    const place = { path: file.path, line };
    const identity: OperationIdentity = { operationId, method: verb.toUpperCase() as HttpMethod, path, basePath: contract.basePath };
    return { status: "complete", value: { ...identity, ...read(contract, declared, place) }, evidence: [place] };
  });
}

function requestShapeOf(contract: ParsedContract, declared: DeclaredOperation, place: Evidence, referenced: ReferencedDocuments): Omit<OperationRequest, keyof OperationIdentity> {
  const reader = createReader(referenced, place, place.path, "request");
  const written = requestOf(contract, declared);
  const { body, parameters } = reader.request(written.parameters, written.requestBody);
  return { body, parameters, files: [...reader.files].sort(compareText) };
}

const LOCATIONS = ["cookie", "header", "path", "query"] as const;

/** The keywords of a Swagger 2.0 parameter that say where and how it is sent rather than what it holds. */
const PARAMETER_FIELDS: ReadonlySet<string> = new Set(["in", "name", "required", "allowEmptyValue"]);

const closedObject = (properties: readonly ShapeProperty[]): KnownShape => ({ kind: "known", values: { ...NOTHING.values, object: true }, object: { properties, open: false } });

function responseShapeOf(contract: ParsedContract, declared: DeclaredOperation, place: Evidence, referenced: ReferencedDocuments): Omit<OperationShape, keyof OperationIdentity> {
  const { operation } = declared;
  const reader = createReader(referenced, place, place.path);
  const shape = reader.success(operation.responses);
  const digester = createDigester(place.path, referenced);
  const digests = {
    request: digester.digest(requestOf(contract, declared)),
    errors: digester.digest(isRecord(operation.responses) ? Object.fromEntries(Object.entries(operation.responses).filter(([code]) => !SUCCESS.test(code))) : operation.responses),
    envelope: digester.digest({ responses: reader.envelope(operation.responses, digester.digest), produces: producesOf(contract, declared) }),
  };
  const files = new Set([...reader.files, ...digester.files(), ...digester.unresolved().flatMap(({ file: named }) => named ?? [])]);
  return { shape, files: [...files].sort(compareText), digests };
}

const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const isListed = (value: unknown): value is Literal | null => value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";

/**
 * Reads the schemas of one operation in one direction; a schema reached twice is one shape object, which the derivation
 * relies on to compare it once. In the request direction a read-only property is never required.
 */
function createReader(referenced: ReferencedDocuments, place: Evidence, document: string, direction: "response" | "request" = "response") {
  const files = new Set([document]);
  const shapes = new Map<string, Shape>();
  const unknown = (via: string): UnknownShape => ({ kind: "unknown", reason: "unresolved", evidence: [{ ...place, via }] });

  function resolve(file: string, written: unknown): Located | UnknownShape {
    let current: Located = { file, node: written };
    const followed = new Set<string>();
    while (isRecord(current.node) && typeof current.node.$ref === "string") {
      const ref = current.node.$ref;
      if (Object.keys(current.node).some((key) => key !== "$ref" && !DOCUMENTATION.has(key))) return unknown(`reference with siblings ${ref}`);
      const target = targetOf(current.file, ref, referenced);
      if ("unresolved" in target) {
        if (target.unresolved.file !== undefined) files.add(target.unresolved.file);
        return unknown(`unresolved reference ${ref}`);
      }
      const key = `${target.file}#${target.pointer}`;
      if (followed.has(key)) return unknown(`reference cycle ${key}`);
      followed.add(key);
      files.add(target.file);
      current = { file: target.file, node: target.node, key };
    }
    return current;
  }

  function shapeOf(file: string, written: unknown): Shape {
    const located = resolve(file, written);
    if ("kind" in located) return located;
    const held = located.key === undefined ? undefined : shapes.get(located.key);
    return held ?? build(located);
  }

  function build(located: Located): Shape {
    const analysis = analyze(located);
    const remember = (shape: Shape) => {
      if (located.key !== undefined) shapes.set(located.key, shape);
    };
    if ("kind" in analysis) {
      remember(analysis);
      return analysis;
    }
    const known: KnownShape = { kind: "known", values: valuesOf(analysis), ...(Object.keys(analysis.keywords).length === 0 ? {} : { keywords: analysis.keywords }) };
    remember(known);
    if (known.values.object) known.object = { properties: propertiesOf(analysis), open: analysis.open };
    if (known.values.array) known.elements = analysis.items === undefined ? ANYTHING : shapeOf(analysis.items.file, analysis.items.node);
    return known;
  }

  function propertiesOf({ properties, required, open }: Analysis): ShapeProperty[] {
    const names = [...new Set([...properties.keys(), ...required])].sort(compareText);
    return names.map((name) => {
      const declared = properties.get(name);
      const shape = declared !== undefined ? shapeOf(declared.file, declared.node) : open ? ANYTHING : unknown(`required property ${name} of a closed object is not declared`);
      return { name, required: required.has(name) && !(direction === "request" && declared !== undefined && readOnly(declared)), shape };
    });
  }

  function analyze(located: Located): Analysis | UnknownShape {
    const { node } = located;
    if (!isRecord(node)) return unknown("schema");
    const blocked = UNMODELLED.find((keyword) => keyword in node);
    if (blocked !== undefined) return unknown(blocked);
    if (isRecord(node.additionalProperties) && Object.keys(node.additionalProperties).length > 0) return unknown("additionalProperties schema");
    if (Array.isArray(node.items)) return unknown("tuple items");
    return "allOf" in node ? merged(located) : plain(located.file, node);
  }

  function plain(file: string, node: Json): Analysis | UnknownShape {
    const allowed = allowedKinds(node);
    const listed = "enum" in node ? node.enum : "const" in node ? [node.const] : undefined;
    if (allowed === undefined) return unknown("type");
    if (listed !== undefined && !(Array.isArray(listed) && listed.every(isListed))) return unknown("enum");
    const properties = new Map(Object.entries(isRecord(node.properties) ? node.properties : {}).map(([name, written]): [string, Located] => [name, { file, node: written }]));
    return { allowed, listed, properties, required: requiredOf(node), open: node.additionalProperties !== false, items: node.items === undefined ? undefined : { file, node: node.items }, keywords: joinedKeywords([node]) };
  }

  /** Branches are merged only when each is an open object schema whose properties are disjoint from the others' or the same schema. */
  function merged(top: Located): Analysis | UnknownShape {
    const conjuncts = conjunctsOf(top, new Set(top.key === undefined ? [] : [top.key]));
    if (!Array.isArray(conjuncts)) return conjuncts;
    const properties = new Map<string, Located>();
    const identities = new Map<string, string>();
    const required = new Set<string>();
    let allowed = EVERY_KIND;
    for (const { file, node } of conjuncts) {
      const conjunct = node as Json;
      if (Object.keys(conjunct).some((keyword) => !MERGEABLE.has(keyword) && !(keyword.startsWith("x-") && keyword !== "x-nullable"))) return unknown("allOf branch with other keywords");
      if (conjunct.type !== undefined && conjunct.type !== "object") return unknown("allOf branch that is not an object");
      if (conjunct.additionalProperties !== undefined && conjunct.additionalProperties !== true && !(isRecord(conjunct.additionalProperties) && Object.keys(conjunct.additionalProperties).length === 0)) return unknown("allOf branch that is not open");
      if (conjunct.type === "object") allowed = { ...EVERY_KIND, string: false, number: false, boolean: false, array: false, null: false };
      for (const name of requiredOf(conjunct)) required.add(name);
      for (const [name, written] of Object.entries(isRecord(conjunct.properties) ? conjunct.properties : {})) {
        const property = resolve(file, written);
        if ("kind" in property) return property;
        const identity = property.key ?? `${property.file}\0${canonicalJson(property.node)}`;
        if (identities.get(name) !== undefined && identities.get(name) !== identity) return unknown(`allOf branches declare ${name} differently`);
        identities.set(name, identity);
        properties.set(name, property);
      }
    }
    return { allowed, listed: undefined, properties, required, open: true, items: undefined, keywords: joinedKeywords([top.node as Json, ...conjuncts.map(({ node }) => node as Json)]) };
  }

  /** The nodes an `allOf` is the conjunction of, itself included when it holds keywords of its own. */
  function conjunctsOf(located: Located, trail: ReadonlySet<string>): Located[] | UnknownShape {
    const { file, node } = located;
    if (!isRecord(node)) return unknown("allOf branch");
    const own = Object.keys(node).some((keyword) => keyword !== "allOf" && !IGNORED.has(keyword) && !keyword.startsWith("x-"));
    const found: Located[] = own || node.allOf === undefined ? [located] : [];
    if (node.allOf === undefined) return found;
    if (!Array.isArray(node.allOf)) return unknown("allOf");
    for (const written of node.allOf) {
      const branch = resolve(file, written);
      if ("kind" in branch) return branch;
      if (branch.key !== undefined && trail.has(branch.key)) return unknown(`allOf cycle ${branch.key}`);
      const nested = conjunctsOf(branch, branch.key === undefined ? trail : new Set([...trail, branch.key]));
      if (!Array.isArray(nested)) return nested;
      found.push(...nested);
    }
    return found;
  }

  function readOnly(declared: Located): boolean {
    const property = resolve(declared.file, declared.node);
    return !("kind" in property) && isRecord(property.node) && property.node.readOnly === true;
  }

  /** The schemas the media of one body or response declare, `undefined` for one that declares none. */
  function mediaSchemas(located: Located): (Located | UnknownShape | undefined)[] {
    const media = isRecord(located.node) && isRecord(located.node.content) ? Object.values(located.node.content) : [located.node];
    return (media.length === 0 ? [undefined] : media).map((entry) => (isRecord(entry) && entry.schema !== undefined ? resolve(located.file, entry.schema) : undefined));
  }

  /** The one schema `declared` agree on, `unknown` when they differ, and `none` when none declares one. */
  function agreed(declared: readonly (Located | UnknownShape | undefined)[], disagreement: string, none: Shape): Shape {
    const unreadable = declared.find((entry): entry is UnknownShape => entry !== undefined && "kind" in entry);
    if (unreadable !== undefined) return unreadable;
    const schemas = declared as (Located | undefined)[];
    const identities = new Set(schemas.map((schema) => (schema === undefined ? "none" : (schema.key ?? `${schema.file}\0${canonicalJson(schema.node)}`))));
    if (identities.size > 1) return unknown(disagreement);
    const [first] = schemas;
    return first === undefined ? none : shapeOf(first.file, first.node);
  }

  /** The schema all success responses declare, `unknown` when they or their media types differ, and nothing but absence when none has a body. */
  function success(responses: unknown): Shape {
    if (!isRecord(responses)) return unknown("responses");
    const codes = Object.keys(responses).filter((code) => SUCCESS.test(code));
    if (codes.length === 0) return unknown("success response");
    const declared: (Located | UnknownShape | undefined)[] = [];
    for (const code of codes) {
      const response = resolve(document, responses[code]);
      if ("kind" in response) return response;
      if (!isRecord(response.node)) return unknown("response");
      declared.push(...mediaSchemas(response));
    }
    return agreed(declared, "success responses declare different schemas", NOTHING);
  }

  /** A parameter as written or as the reference it holds names, whatever else sits beside the reference. */
  function parameterOf(written: unknown): Located | UnknownShape {
    return isRecord(written) && typeof written.$ref === "string" ? resolve(document, { $ref: written.$ref }) : { file: document, node: written };
  }

  /** What a parameter holds: its schema, its one media schema, or (Swagger 2.0) the parameter itself. */
  function parameterShape({ file, node }: Located): Shape {
    const parameter = node as Json;
    if (parameter.schema !== undefined) return shapeOf(file, parameter.schema);
    if (parameter.content !== undefined) return agreed(mediaSchemas({ file, node: parameter }), "parameter media types declare different schemas", ANYTHING);
    return shapeOf(file, Object.fromEntries(Object.entries(parameter).filter(([key]) => !PARAMETER_FIELDS.has(key))));
  }

  /**
   * The body and parameters of one operation's request. A parameter of the operation replaces one of its path with the
   * same location and name; a Swagger 2.0 body parameter is the body, and a form makes it unknown.
   */
  function request(written: readonly unknown[], requestBody: unknown): Pick<OperationRequest, "body" | "parameters"> {
    const byLocation = new Map<string, Map<string, ShapeProperty>>(LOCATIONS.map((location) => [location, new Map()]));
    let body: OperationRequest["body"];
    for (const each of written) {
      const parameter = parameterOf(each);
      if ("kind" in parameter || !isRecord(parameter.node)) return { body, parameters: "kind" in parameter ? parameter : unknown("parameter") };
      const { in: location, name, required } = parameter.node;
      if (location === "body") body = { shape: shapeOf(parameter.file, parameter.node.schema), required: required === true };
      else if (location === "formData") body = { shape: unknown("formData"), required: false };
      else if (typeof location === "string" && typeof name === "string" && byLocation.has(location)) byLocation.get(location)!.set(name, { name, required: required === true || location === "path", shape: parameterShape(parameter) });
      else return { body, parameters: unknown("parameter") };
    }
    const parameters = closedObject(LOCATIONS.map((location) => ({ name: location, required: true, shape: closedObject([...byLocation.get(location)!.values()].sort((a, b) => compareText(a.name, b.name))) })));
    if (requestBody === undefined) return { body, parameters };
    const declared = resolve(document, requestBody);
    if ("kind" in declared || !isRecord(declared.node)) return { body: { shape: "kind" in declared ? declared : unknown("requestBody"), required: false }, parameters };
    return { body: { shape: agreed(mediaSchemas(declared), "request media types declare different schemas", ANYTHING), required: declared.node.required === true }, parameters };
  }

  /** The success responses without their schemas, each digested from the file it is declared in: what a reader receives beside the body. */
  function envelope(responses: unknown, digest: Digester["digest"]): unknown {
    if (!isRecord(responses)) return responses;
    return Object.keys(responses).filter((code) => SUCCESS.test(code)).sort(compareText).map((code) => {
      const response = resolve(document, responses[code]);
      if ("kind" in response || !isRecord(response.node)) return [code, digest(responses[code])];
      const { content } = response.node;
      const besideBody = Object.fromEntries(Object.entries(response.node).filter(([key]) => key !== "content" && key !== "schema"));
      return [code, digest({ ...besideBody, media: isRecord(content) ? Object.keys(content).sort(compareText) : undefined }, response.file)];
    });
  }

  return { files, success, envelope, request };
}

/** The kinds a `type` allows, `undefined` for one this reader does not know; `nullable` adds null to a declared type. */
function allowedKinds(node: Json): Record<Kind, boolean> | undefined {
  if (node.type === undefined) return { ...EVERY_KIND };
  const names = Array.isArray(node.type) ? node.type : [node.type];
  const allowed: Record<Kind, boolean> = { string: false, number: false, boolean: false, array: false, object: false, null: node.nullable === true || node["x-nullable"] === true };
  for (const name of names) {
    if (typeof name !== "string" || !Object.hasOwn(KIND_OF_TYPE, name)) return undefined;
    allowed[KIND_OF_TYPE[name]!] = true;
  }
  return allowed;
}

const requiredOf = (node: Json): Set<string> => new Set(Array.isArray(node.required) ? node.required.filter((name): name is string => typeof name === "string") : []);

function valuesOf({ allowed, listed }: Analysis): KnownShape["values"] {
  const of = (valueClass: LiteralKindName) => {
    if (!allowed[valueClass]) return [];
    if (listed === undefined) return "every" as const;
    return [...new Set(listed.filter((literal): literal is Literal => typeof literal === valueClass))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  };
  return {
    literals: { boolean: of("boolean"), number: of("number"), string: of("string") },
    array: allowed.array && listed === undefined,
    object: allowed.object && listed === undefined,
    null: allowed.null && (listed === undefined || listed.includes(null)),
    absent: false,
  };
}
