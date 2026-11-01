import type { Node } from "web-tree-sitter";
import type { Evidence } from "../../domain/shared/fact.ts";
import { externalNames, namedChildren, scopeOf, type JavaFile, type JavaProject } from "./java-symbols.ts";
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
 * Where the sources can change the path of every route: a call of `PathMatchConfigurer.addPathPrefix(String, Predicate)`
 * and a subclass of Spring's `RequestMappingHandlerMapping`. Which routes a prefix reaches depends on a predicate this
 * extractor does not evaluate.
 */
export function pathPrefixConfigurations(project: JavaProject, files: readonly JavaFile[]): Evidence[] {
  const calls = files.flatMap((file) =>
    file.root
      .descendantsOfType("method_invocation")
      .filter(isAddPathPrefix)
      .map((call) => spanOf(file.path, call)),
  );
  const subclasses = project.types.flatMap((type) => {
    const superclass = type.node.childForFieldName("superclass")?.namedChildren[0];
    const isSpring =
      superclass !== undefined &&
      project.lookupType(superclass.text, scopeOf(type)) === undefined &&
      externalNames(superclass.text, type.file, false).some((name) => HANDLER_MAPPINGS.includes(name));
    return isSpring ? [spanOf(type.file.path, superclass)] : [];
  });
  return [...calls, ...subclasses].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line));
}

const BASE_PATH_SETTERS: ReadonlySet<string> = new Set(["setContextPath", "setDefaultProperties"]);
const BASE_PATH_KEY_NAMES = ["server.servlet.context-path", "spring.mvc.servlet.path", "spring.webflux.base-path"];

/**
 * Where the sources may set a base path outside the configuration files: a `setContextPath` or `setDefaultProperties`
 * call, a `@PropertySource`, and a string literal that names a base path key. The values are not evaluated, and a type
 * whose annotations cannot be read counts as one.
 */
export function basePathConfigurations(project: JavaProject, files: readonly JavaFile[], annotations: SpringAnnotations): Evidence[] {
  const calls = files.flatMap((file) =>
    [
      ...file.root.descendantsOfType("method_invocation").filter((call) => BASE_PATH_SETTERS.has(call.childForFieldName("name")?.text ?? "")),
      ...file.root.descendantsOfType("string_literal").filter((literal) => BASE_PATH_KEY_NAMES.some((key) => literal.text.includes(key))),
    ].map((node) => spanOf(file.path, node)),
  );
  const sources = project.types.flatMap((type) => {
    try {
      return annotationUses(type.node, scopeOf(type))
        .filter((use) => PROPERTY_SOURCES.has(annotations.keyOf(use) ?? ""))
        .map((use) => spanOf(type.file.path, use.node));
    } catch {
      return [spanOf(type.file.path, type.node)];
    }
  });
  return [...calls, ...sources].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line));
}
