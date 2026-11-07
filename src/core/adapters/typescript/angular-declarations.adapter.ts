import { posix } from "node:path";
import ts from "typescript";
import { ANGULAR_CORE } from "./angular-injection.ts";
import { sourceTree } from "./source-tree.ts";
import { isTypeScriptSource } from "../../domain/languages/typescript.ts";
import type { AngularDeclaration, AngularDeclarationReader, AngularDecorator } from "../../ports/angular-declarations.port.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import { pathsByProject } from "./angular-projects.ts";

const DECORATORS: ReadonlySet<string> = new Set<AngularDecorator>(["Component", "Directive", "Pipe", "Injectable", "NgModule"]);

export function createAngularDeclarationReader(): AngularDeclarationReader {
  return { read: async (files) => readDeclarations(files) };
}

function readDeclarations(files: readonly SourceFile[]): AngularDeclaration[] {
  const inProjects = new Set([...pathsByProject(files.map((file) => file.path).filter(isTypeScriptSource), files, ANGULAR_CORE).byProject.values()].flat());
  return files.filter((file) => inProjects.has(file.path) && file.content.includes(ANGULAR_CORE)).flatMap(declarationsOf);
}

function declarationsOf(file: SourceFile): AngularDeclaration[] {
  const source = sourceTree(file, ts.ScriptTarget.Latest, ts.ScriptKind.TS);
  const found: AngularDeclaration[] = [];
  for (const statement of source.statements) {
    if (!ts.isClassDeclaration(statement) || statement.name === undefined) continue;
    for (const decorator of ts.getDecorators(statement) ?? []) {
      const call = decorator.expression;
      if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression) || !DECORATORS.has(call.expression.text)) continue;
      const name = call.expression.text as AngularDecorator;
      const metadata = call.arguments[0];
      const line = source.getLineAndCharacterOfPosition(statement.name.getStart(source)).line + 1;
      found.push({ file: file.path, name: statement.name.text, line, decorator: name, resources: metadata !== undefined && ts.isObjectLiteralExpression(metadata) ? resourcesOf(file.path, metadata) : [] });
    }
  }
  return found;
}

function resourcesOf(file: string, metadata: ts.ObjectLiteralExpression): string[] {
  const urls: string[] = [];
  for (const property of metadata.properties) {
    if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) continue;
    const { text } = property.name;
    if ((text === "templateUrl" || text === "styleUrl") && ts.isStringLiteralLike(property.initializer)) urls.push(property.initializer.text);
    if (text === "styleUrls" && ts.isArrayLiteralExpression(property.initializer)) {
      for (const element of property.initializer.elements) if (ts.isStringLiteralLike(element)) urls.push(element.text);
    }
  }
  return urls.map((url) => posix.join(posix.dirname(file), url)).filter((path) => !path.startsWith(".."));
}
