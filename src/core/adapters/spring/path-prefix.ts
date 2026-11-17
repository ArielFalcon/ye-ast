import type { Node } from "web-tree-sitter";
import type { Evidence } from "../../domain/shared/fact.ts";
import { externalNames, namedChildren, scopeOf, type JavaFile, type JavaProject, type TypeDecl } from "./java-symbols.ts";
import { spanOf } from "./findings.ts";
import { annotationUses, PROPERTY_SOURCES, type SpringAnnotations } from "./request-mapping.ts";

const HANDLER_MAPPINGS: readonly string[] = [
  "org.springframework.web.servlet.mvc.method.annotation.RequestMappingHandlerMapping",
  "org.springframework.web.reactive.result.method.annotation.RequestMappingHandlerMapping",
];

function isAddPathPrefix(call: Node): boolean {
  const args = call.childForFieldName("arguments");
  return call.childForFieldName("name")?.text === "addPathPrefix" && args !== null && namedChildren(args).length === 2;
}

/**
 * Where a file can change the path of every route: a call of `PathMatchConfigurer.addPathPrefix(String, Predicate)`.
 * Which routes a prefix reaches depends on a predicate this extractor does not evaluate.
 */
export function pathPrefixCallsIn(file: JavaFile): Evidence[] {
  return file.root
    .descendantsOfType("method_invocation")
    .filter(isAddPathPrefix)
    .map((call) => spanOf(file.path, call));
}

/** The subclasses of Spring's `RequestMappingHandlerMapping` among `types`, which can change the path of every route. */
export function pathPrefixSubclassesOf(types: readonly TypeDecl[], project: JavaProject): Evidence[] {
  return types.flatMap((type) => {
    const superclass = type.node.childForFieldName("superclass")?.namedChildren[0];
    const isSpring =
      superclass !== undefined &&
      project.lookupType(superclass.text, scopeOf(type)) === undefined &&
      externalNames(superclass.text, type.file, false).some((name) => HANDLER_MAPPINGS.includes(name));
    return isSpring ? [spanOf(type.file.path, superclass)] : [];
  });
}

/** The places in path order; places that start on one line keep the order they were given in. */
export function inPathOrder(places: readonly Evidence[]): Evidence[] {
  return places.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line));
}

const BASE_PATH_SETTERS: ReadonlySet<string> = new Set(["setContextPath", "setDefaultProperties"]);
const BASE_PATH_KEY_NAMES = ["server.servlet.context-path", "spring.mvc.servlet.path", "spring.webflux.base-path"];

/**
 * Where a file may set a base path outside the configuration files: a `setContextPath` or `setDefaultProperties` call and
 * a string literal that names a base path key. The values are not evaluated.
 */
export function basePathCallsIn(file: JavaFile): Evidence[] {
  return [
    ...file.root.descendantsOfType("method_invocation").filter((call) => BASE_PATH_SETTERS.has(call.childForFieldName("name")?.text ?? "")),
    ...file.root.descendantsOfType("string_literal").filter((literal) => BASE_PATH_KEY_NAMES.some((key) => literal.text.includes(key))),
  ].map((node) => spanOf(file.path, node));
}

/** A `@PropertySource` among the annotations of `types`; a type whose annotations cannot be read counts as one. */
export function basePathSourcesOf(types: readonly TypeDecl[], annotations: SpringAnnotations): Evidence[] {
  return types.flatMap((type) => {
    try {
      return annotationUses(type.node, scopeOf(type))
        .filter((use) => PROPERTY_SOURCES.has(annotations.keyOf(use) ?? ""))
        .map((use) => spanOf(type.file.path, use.node));
    } catch {
      return [spanOf(type.file.path, type.node)];
    }
  });
}
