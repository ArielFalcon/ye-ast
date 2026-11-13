import type { Node } from "web-tree-sitter";
import type { DataEffect } from "../../domain/trace/trace-fact.ts";
import type { UnplacedCause } from "../../domain/trace/data-effect-site.ts";
import { resolve } from "./java-declared-types.ts";
import type { JavaProject, MethodDecl, TypeDecl } from "./java-symbols.ts";

type Access = DataEffect["access"];
interface Statement {
  access: Access;
  table?: string;
}

/** The statements of the XML mappers of a snapshot, by namespace and statement id. */
export type MapperStatements = ReadonlyMap<string, readonly Statement[]>;

const MAPPER = "org.apache.ibatis.annotations.Mapper";
const MAPPER_SCAN = "org.mybatis.spring.annotation.MapperScan";
const SQL_ANNOTATIONS: ReadonlyMap<string, Access> = new Map([
  ["org.apache.ibatis.annotations.Select", "read"], ["org.apache.ibatis.annotations.Insert", "write"],
  ["org.apache.ibatis.annotations.Update", "write"], ["org.apache.ibatis.annotations.Delete", "write"],
]);
const XML_STATEMENTS: ReadonlyMap<string, Access> = new Map([["select", "read"], ["insert", "write"], ["update", "write"], ["delete", "write"]]);
const MAX_INCLUDE_DEPTH = 8;

/** The result of a mapper call: the effect, or the cause the call cannot be placed as one. */
export type MapperOutcome = DataEffect | { unplaced: UnplacedCause };

/** The interfaces a snapshot declares as MyBatis mappers: those annotated `@Mapper`, and those below a `@MapperScan` package. */
export interface MapperDeclarations {
  isMapper(type: TypeDecl): boolean;
}

export function mapperDeclarations(project: JavaProject): MapperDeclarations {
  const packages = project.types.flatMap((type) => annotationsOf(type.node).flatMap((annotation) => annotationName(annotation, type, project) === MAPPER_SCAN ? scanPackages(annotation) : []));
  return {
    isMapper: (type) => type.kind === "interface" && (annotationsOf(type.node).some((annotation) => annotationName(annotation, type, project) === MAPPER) || (type.outer === undefined && packages.some((scanned) => packageOf(type) === scanned || packageOf(type).startsWith(`${scanned}.`)))),
  };
}

function packageOf(type: TypeDecl): string {
  return type.fqn.slice(0, Math.max(0, type.fqn.length - type.qualifiedName.length - 1));
}

/** The effect of `operation` on a mapper: its statement decides the access, and the table when one table is proven. */
export function mapperEffect(line: number, operation: string, type: TypeDecl, project: JavaProject, statements: MapperStatements): MapperOutcome | undefined {
  const methods = project.hierarchy(type).types.flatMap((owner) => owner.methods.filter((method) => method.name === operation));
  if (methods.some((method) => method.hasBody)) return undefined;
  const found = [...methods.flatMap((method) => annotatedStatements(method, project)), ...(statements.get(`${type.fqn}#${operation}`) ?? [])];
  if (found.length === 0) return { unplaced: "mapper-statement-absent" };
  const [statement] = found;
  if (found.length !== 1 || statement === undefined) return { unplaced: "mapper-statement-ambiguous" };
  return { kind: "data", line, operation, access: statement.access, ...(statement.table === undefined ? {} : { target: { kind: "table", name: statement.table } }) };
}

function annotatedStatements(method: MethodDecl, project: JavaProject): Statement[] {
  return annotationsOf(method.node).flatMap((annotation) => {
    const access = SQL_ANNOTATIONS.get(annotationName(annotation, method.owner, project) ?? "");
    if (access === undefined) return [];
    const sql = stringValues(annotation, "value");
    const table = sql === undefined ? undefined : sqlTable(sql.join(" "));
    return [{ access, ...(table === undefined ? {} : { table }) }];
  });
}

/** The statements of every `<mapper namespace>` document among the sources. */
export function mapperStatements(sources: readonly { path: string; content: string }[]): MapperStatements {
  const statements = new Map<string, Statement[]>();
  for (const { path, content } of sources) {
    if (!path.endsWith(".xml") || !content.includes("<mapper")) continue;
    const text = content.replace(/<!--[\s\S]*?-->/g, "");
    const namespace = /<mapper\b[^>]*\bnamespace\s*=\s*"([^"]+)"/.exec(text)?.[1];
    if (namespace === undefined) continue;
    const fragments = new Map([...text.matchAll(/<sql\b[^>]*\bid\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/sql>/g)].map((match) => [match[1]!, match[2]!] as const));
    for (const match of text.matchAll(/<(select|insert|update|delete)\b([^>]*)>([\s\S]*?)<\/\1>/g)) {
      const id = /\bid\s*=\s*"([^"]+)"/.exec(match[2]!)?.[1];
      if (id === undefined) continue;
      const table = sqlTable(plainSql(expandIncludes(match[3]!, fragments, 0)));
      const key = `${namespace}#${id}`;
      statements.set(key, [...statements.get(key) ?? [], { access: XML_STATEMENTS.get(match[1]!)!, ...(table === undefined ? {} : { table }) }]);
    }
  }
  return statements;
}

/** An `<include refid>` becomes its fragment's body; one that names no fragment of the document stays, which hides the table. */
function expandIncludes(body: string, fragments: ReadonlyMap<string, string>, depth: number): string {
  return body.replace(/<include\b[^>]*\brefid\s*=\s*"([^"]+)"[^>]*\/>|<include\b[^>]*\brefid\s*=\s*"([^"]+)"[^>]*>[\s\S]*?<\/include>/g, (whole, direct: string | undefined, nested: string | undefined) => {
    const fragment = fragments.get(direct ?? nested ?? "");
    return fragment === undefined || depth >= MAX_INCLUDE_DEPTH ? "${unresolved}" : expandIncludes(fragment, fragments, depth + 1);
  });
}

/** The SQL text of a statement body: dynamic tags dropped, CDATA unwrapped. */
function plainSql(body: string): string {
  const literal: string[] = [];
  const hidden = body.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, text: string) => `\u0000${literal.push(text) - 1}\u0000`);
  return hidden.replace(/<\/?[A-Za-z][^>]*>/g, " ").replace(/\u0000(\d+)\u0000/g, (_, index: string) => literal[Number(index)]!);
}

const TABLE_REFERENCE = /(?<!\b(?:for|key)\s+)\b(?:from|join|into|update)\s+([`"[]?[A-Za-z_][\w.]*[`"\]]?)/gi;
const TABLE_LIST = /\bfrom\s+[\w.`"]+(?:\s+(?:as\s+)?\w+)?\s*,/i;

/** The one table a SQL text names, or none when it names several, lists them, or builds a name at run time. */
function sqlTable(sql: string): string | undefined {
  if (sql.includes("${") || TABLE_LIST.test(sql)) return undefined;
  const tables = new Map<string, string>();
  for (const match of sql.matchAll(TABLE_REFERENCE)) {
    const name = match[1]!.replace(/[`"[\]]/g, "");
    tables.set(name.toLowerCase(), name);
  }
  return tables.size === 1 ? [...tables.values()][0] : undefined;
}

function annotationsOf(declaration: Node): Node[] {
  const modifiers = declaration.namedChildren.find((child) => child.type === "modifiers");
  return (modifiers?.namedChildren ?? []).filter((node) => node.type === "annotation" || node.type === "marker_annotation");
}

function annotationName(annotation: Node, type: TypeDecl, project: JavaProject): string | undefined {
  const name = annotation.childForFieldName("name");
  if (name === null) return undefined;
  const found = resolve(name, type.file, project, type.outer, name, true);
  return found?.kind === "platform" || found?.kind === "library" ? found.fqn : undefined;
}

/** The packages a `@MapperScan` names; none when it filters the scan by annotation or marker, which a package alone does not decide. */
function scanPackages(annotation: Node): string[] {
  const pairs = argumentPairs(annotation);
  if (pairs.some(({ key }) => key === "annotationClass" || key === "markerInterface")) return [];
  return pairs.filter(({ key }) => key === "value" || key === "basePackages").flatMap(({ value }) => literalsOf(value) ?? []);
}

function stringValues(annotation: Node, name: string): string[] | undefined {
  const pair = argumentPairs(annotation).find(({ key }) => key === name);
  return pair === undefined ? undefined : literalsOf(pair.value);
}

function argumentPairs(annotation: Node): { key: string; value: Node }[] {
  const list = annotation.childForFieldName("arguments");
  return (list?.namedChildren ?? []).flatMap((node) => {
    if (node.type !== "element_value_pair") return [{ key: "value", value: node }];
    const key = node.childForFieldName("key")?.text;
    const value = node.childForFieldName("value");
    return key === undefined || value === null ? [] : [{ key, value }];
  });
}

/** The string literals of a value, a single one or an array of them; none when any element is not a plain literal. */
function literalsOf(value: Node): string[] | undefined {
  const elements = value.type === "element_value_array_initializer" ? value.namedChildren : [value];
  const texts = elements.map((element) => element.type === "string_literal" ? element.text.replace(/^"""\s*|\s*"""$/g, "").replace(/^"|"$/g, "") : undefined);
  return texts.every((text) => text !== undefined) ? texts as string[] : undefined;
}
