import { isJvmBuildFile, sourceGeneratorDeclaration } from "../../domain/languages/jvm-build.ts";
import type { Evidence, Finding } from "../../domain/shared/fact.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import { scopeOf, type JavaProject, type TypeDecl } from "./java-symbols.ts";
import { unknownAt, type MappedRoute } from "./findings.ts";
import { annotationUses, COMPONENTS, type SpringAnnotations } from "./request-mapping.ts";
import { compareText } from "../../domain/shared/code-node.ts";

/**
 * The first build file by path that declares a source generator, at the line of its declaration. Generated interfaces
 * reach a module through a dependency that no source shows, so the declaration holds for every module of the commit.
 */
export function sourceGeneratorIn(files: readonly SourceFile[]): Evidence | undefined {
  const declaring = files
    .filter((file) => isJvmBuildFile(file.path))
    .toSorted((a, b) => compareText(a.path, b.path))
    .flatMap((file) => {
      const declaration = sourceGeneratorDeclaration(file.path, file.content);
      return declaration === undefined ? [] : [{ path: file.path, line: declaration.line }];
    });
  return declaring[0];
}

/**
 * The methods a component implements for an interface that the sources do not give, when that interface is a generated
 * delegate: generators that split a controller from its logic emit `*Delegate` interfaces that git does not hold, and
 * the controller that calls the component is generated too. Each `@Override` method of a `*Delegate` interface is a
 * handler the sources do not show. When a build file declares a source generator, the interface may carry any name and
 * its methods need no `@Override`: each public method is one.
 */
export function delegateMethodsOf(type: TypeDecl, project: JavaProject, annotations: SpringAnnotations, generator: Evidence | undefined): Finding<MappedRoute>[] {
  const isComponent = annotationUses(type.node, scopeOf(type)).some((use) => COMPONENTS.has(annotations.keyOf(use) ?? ""));
  const delegate = isComponent
    ? project
        .hierarchy(type)
        .gaps.find((gap) => gap.kind === "missing" && gap.isInterface && (generator !== undefined || gap.name.endsWith("Delegate")))
    : undefined;
  if (delegate === undefined) return [];
  return type.methods
    .filter((method) => method.overrides || (generator !== undefined && method.modifiers.includes("public")))
    .map((method) => unknownAt(method, { reason: "no-extractor", file: delegate.file, node: delegate.node }, ...(generator === undefined ? [] : [generator])));
}
