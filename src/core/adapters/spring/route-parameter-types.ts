import type { Node } from "web-tree-sitter";
import { isParseStrictType, type ParseStrictType, type RouteParameterTypes } from "../../domain/entrypoints/route-parameter.ts";
import { externalNames, namedChildren, scopeOf, type JavaProject, type MethodDecl } from "./java-symbols.ts";
import { annotationUseOf, isAnnotation } from "./request-mapping.ts";

const PATH_VARIABLE = "org.springframework.web.bind.annotation.PathVariable";
const JAVA_UUID = "java.util.UUID";
const PRIMITIVES: ReadonlySet<string> = new Set(["integral_type", "floating_point_type"]);

/**
 * The parse-strict types a handler declares for its `@PathVariable` parameters, by variable name (the annotation's
 * `value` or `name`, else the parameter's). A parameter whose type is not written as one of the closed set, or whose
 * name the sources do not decide, states nothing. A handler that implements a generated contract interface carries no
 * annotation of its own: there a parameter named like one of the contract path's `contractVariables` is that variable.
 */
export function pathVariableTypesOf(handler: MethodDecl, project: JavaProject, contractVariables: ReadonlySet<string> = new Set()): RouteParameterTypes | undefined {
  const scope = scopeOf(handler.owner);
  const types: Record<string, ParseStrictType> = {};
  for (const parameter of namedChildren(handler.node.childForFieldName("parameters") ?? handler.node).filter((node) => node.type === "formal_parameter")) {
    const modifiers = parameter.namedChildren.find((child) => child.type === "modifiers");
    const use = modifiers === undefined ? undefined : namedChildren(modifiers).map((node) => annotationUseOf(node, scope)).find((candidate) => isAnnotation(candidate, PATH_VARIABLE));
    const type = typeOf(parameter.childForFieldName("type"), handler, project);
    const own = parameter.childForFieldName("name")?.text;
    if (type === undefined || own === undefined) continue;
    if (use === undefined) {
      if (contractVariables.has(own)) types[own] = type;
      continue;
    }
    const declared = use.attributes.get("value") ?? use.attributes.get("name");
    const evaluated = declared?.length === 1 ? project.evaluate(declared[0]!) : undefined;
    const name = declared === undefined ? own : evaluated !== undefined && "value" in evaluated ? evaluated.value : undefined;
    if (name !== undefined && name !== "") types[name] = type;
  }
  return Object.keys(types).length === 0 ? undefined : types;
}

function typeOf(written: Node | null, handler: MethodDecl, project: JavaProject): ParseStrictType | undefined {
  if (written === null) return undefined;
  const text = written.text.replace(/\s+/g, "");
  if (PRIMITIVES.has(written.type)) return isParseStrictType(text) ? text : undefined;
  if (written.type !== "type_identifier" && written.type !== "scoped_type_identifier") return undefined;
  const scope = scopeOf(handler.owner);
  if (project.lookupType(text, scope) !== undefined) return undefined;
  const simple = text.split(".").pop() ?? "";
  if (!isParseStrictType(simple)) return undefined;
  if (simple === "UUID") return externalNames(text, scope.file, false).includes(JAVA_UUID) ? simple : undefined;
  const bare = text === simple && !scope.file.singleImports.has(simple);
  return bare || text === `java.lang.${simple}` ? simple : undefined;
}
