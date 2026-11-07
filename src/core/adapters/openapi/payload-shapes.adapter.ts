import { ANYTHING, LITERAL_CLASSES, type KnownShape, type OperationShape, type Shape, type ShapeProperty, type UnknownShape } from "../../domain/contracts/payload-shape.ts";
import type { HttpMethod } from "../../domain/entrypoints/http-route.ts";
import { isContractDocument } from "../../domain/languages/openapi.ts";
import { canonicalJson } from "../../domain/shared/canonical-json.ts";
import { compareText } from "../../domain/shared/code-node.ts";
import type { Evidence, Finding } from "../../domain/shared/fact.ts";
import type { Literal } from "../../domain/contracts/use-operation.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { PayloadShapes } from "../../ports/payload-shapes.port.ts";
import { DOCUMENTATION, declaredOperations, parseContract, referencedDocuments, targetOf, type ReferencedDocuments } from "./contract-document.adapter.ts";

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

/** The keywords a branch of an `allOf` may hold for the branches to be a plain merge of open object schemas. */
const MERGEABLE: ReadonlySet<string> = new Set([...IGNORED, "type", "properties", "required", "additionalProperties", "allOf"]);

const SUCCESS = /^2(\d\d|XX)$/i;

/** The shapes of the success responses of the operations OpenAPI 3.x and Swagger 2.0 documents declare. */
export function createPayloadShapes(): PayloadShapes {
  return {
    responses: (files) => {
      const referenced = referencedDocuments(files);
      return files.flatMap((file) => (isContractDocument(file.path) ? shapesOf(file, referenced) : []));
    },
  };
}

function shapesOf(file: SourceFile, referenced: ReferencedDocuments): readonly Finding<OperationShape>[] {
  const contract = parseContract(file);
  if (contract === undefined) return [];
  if ("status" in contract) return [contract];
  return declaredOperations(contract).map(({ path, verb, operation, operationId, line }): Finding<OperationShape> => {
    const place = { path: file.path, line };
    const reader = createReader(referenced, place, file.path);
    const shape = reader.success(operation.responses);
    const value: OperationShape = { operationId, method: verb.toUpperCase() as HttpMethod, path, basePath: contract.basePath, shape, files: [...reader.files].sort(compareText) };
    return { status: "complete", value, evidence: [place] };
  });
}

const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const isListed = (value: unknown): value is Literal | null => value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";

/** Reads the schemas of one operation; a schema reached twice is one shape object, which the derivation relies on to compare it once. */
function createReader(referenced: ReferencedDocuments, place: Evidence, document: string) {
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
    const known: KnownShape = { kind: "known", values: valuesOf(analysis) };
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
      return { name, required: required.has(name), shape };
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
    return { allowed, listed, properties, required: requiredOf(node), open: node.additionalProperties !== false, items: node.items === undefined ? undefined : { file, node: node.items } };
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
    return { allowed, listed: undefined, properties, required, open: true, items: undefined };
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
      const media = isRecord(response.node.content) ? Object.values(response.node.content) : [response.node];
      for (const entry of media.length === 0 ? [undefined] : media) declared.push(isRecord(entry) && entry.schema !== undefined ? resolve(response.file, entry.schema) : undefined);
    }
    const unreadable = declared.find((entry): entry is UnknownShape => entry !== undefined && "kind" in entry);
    if (unreadable !== undefined) return unreadable;
    const schemas = declared as (Located | undefined)[];
    const identities = new Set(schemas.map((schema) => (schema === undefined ? "none" : (schema.key ?? `${schema.file}\0${canonicalJson(schema.node)}`))));
    if (identities.size > 1) return unknown("success responses declare different schemas");
    const [first] = schemas;
    return first === undefined ? NO_BODY : shapeOf(first.file, first.node);
  }

  return { files, success };
}

const NO_BODY: KnownShape = Object.freeze({ kind: "known", values: Object.freeze({ literals: Object.freeze({ boolean: [], number: [], string: [] }), array: false, object: false, null: false, absent: false }) });

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
