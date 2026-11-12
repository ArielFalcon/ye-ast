import ts from "typescript";
import type { FrameworkPlugin } from "../../ports/framework-plugin.port.ts";
import type { FrameworkMemberBinding } from "../../ports/framework-members.port.ts";
import { manifestsOf, projectOf } from "./angular-projects.ts";
import { moduleShape } from "./module-shape.ts";
import { declarationCounts } from "./syntax-names.ts";
import { importedNameOf } from "./imported-name.ts";
import { sourceTree } from "./source-tree.ts";
import { hasModifier, propertyNameText, unwrapped } from "./syntax.ts";

const PACKAGE = "@ngrx/signals";

export function createSignalsStorePlugin(): FrameworkPlugin {
  return {
    languages: ["typescript"],
    signal: { dependency: PACKAGE, module: PACKAGE },
    members(sources) {
      const projects = manifestsOf(sources);
      return {
        async bindings(file) {
          if (projectOf(file.path, projects)?.dependencies.has(PACKAGE) !== true) return [];
          const tree = sourceTree(file, ts.ScriptTarget.Latest);
          const shape = moduleShape(tree);
          if (shape === undefined) return [];
          const counts = declarationCounts(tree);
          const exported = (expression: ts.Expression, module = PACKAGE): string | undefined => {
            const name = importedNameOf(unwrapped(expression), shape.imports, counts);
            if (name?.binding?.module !== module) return undefined;
            return name.binding.imported === "*" ? name.members.length === 1 ? name.members[0] : undefined : name.members.length === 0 ? name.binding.imported : undefined;
          };
          const imports = [...shape.imports.values()].filter(({ module, typeOnly }) => module === PACKAGE && !typeOnly);
          if (!imports.some(({ imported }) => imported === "signalStore" || imported === "*") || !imports.some(({ imported }) => imported === "withMethods" || imported === "*")) return [];
          const result: FrameworkMemberBinding[] = [];
          const visit = (node: ts.Node): void => {
            if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
              const call = unwrapped(node.initializer);
              if (ts.isCallExpression(call) && exported(call.expression) === "signalStore") {
                for (const arg of call.arguments) {
                  const feature = unwrapped(arg);
                  if (!ts.isCallExpression(feature) || exported(feature.expression) !== "withMethods") continue;
                  const factory = feature.arguments[0] === undefined ? undefined : unwrapped(feature.arguments[0]);
                  if (factory === undefined || (!ts.isArrowFunction(factory) && !ts.isFunctionExpression(factory))) continue;
                  if (hasModifier(factory, ts.SyntaxKind.AsyncKeyword) || (ts.isFunctionExpression(factory) && factory.asteriskToken !== undefined)) continue;
                  const returns: (ts.Expression | undefined)[] = [];
                  const read = (body: ts.Node): void => {
                    if (ts.isFunctionLike(body)) return;
                    if (ts.isReturnStatement(body)) returns.push(body.expression);
                    else ts.forEachChild(body, read);
                  };
                  if (ts.isBlock(factory.body)) read(factory.body); else returns.push(factory.body);
                  if (returns.length !== 1 || returns[0] === undefined) continue;
                  if (ts.isBlock(factory.body)) {
                    const last = factory.body.statements.at(-1);
                    if (last === undefined || !ts.isReturnStatement(last) || last.expression !== returns[0]) continue;
                  }
                  const literal = unwrapped(returns[0]!);
                  if (!ts.isObjectLiteralExpression(literal) || literal.properties.some(ts.isSpreadAssignment)) continue;
                  for (const property of literal.properties) {
                    if (ts.isSpreadAssignment(property)) continue;
                    const name = propertyNameText(property.name);
                    if (name === undefined) continue;
                    const value = ts.isPropertyAssignment(property) ? unwrapped(property.initializer) : undefined;
                    const deferredFactory = value !== undefined && ts.isCallExpression(value) && exported(value.expression, "@ngrx/signals/rxjs-interop") === "rxMethod";
                    const method = ts.isMethodDeclaration(property) || ts.isGetAccessor(property) || ts.isSetAccessor(property);
                    const functionValue = value !== undefined && (ts.isArrowFunction(value) || ts.isFunctionExpression(value));
                    const callable = method || deferredFactory ? property : functionValue ? value : undefined;
                    if (callable === undefined) continue;
                    const member = tree.getLineAndCharacterOfPosition(callable.getStart(tree));
                    const holder = tree.getLineAndCharacterOfPosition(node.getStart(tree));
                    const end = tree.getLineAndCharacterOfPosition(callable.getEnd());
                    const container = tree.getLineAndCharacterOfPosition(literal.getStart(tree));
                    const start = { line: member.line + 1, column: member.character };
                    result.push({
                      member: start,
                      holder: { path: file.path, symbol: node.name.text, line: holder.line + 1 },
                      evidence: { framework: PACKAGE, file: file.path, line: tree.getLineAndCharacterOfPosition(feature.getStart(tree)).line + 1 },
                      ...(deferredFactory ? {
                        deferredFactory: true,
                        declaration: {
                          name, kind: "method", invoked: true,
                          span: { start, end: { line: end.line + 1, column: end.character } },
                          container: { line: container.line + 1, column: container.character },
                        },
                      } : {}),
                    });
                  }
                }
              }
            }
            ts.forEachChild(node, visit);
          };
          visit(tree);
          return result;
        },
      };
    },
  };
}
