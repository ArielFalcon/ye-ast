import ts from "typescript";
import { isPackageManifest, isTypeScriptFile } from "../../domain/languages/typescript.ts";
import { compareText } from "../../domain/shared/code-node.ts";
import type { ModuleDependencies, ModuleDependency, ModuleSource, ModuleTarget } from "../../domain/impact/module-dependency.ts";
import type { ModuleDependenciesReader } from "../../ports/module-dependencies.port.ts";
import { createModuleResolver, manifestDependencies, packageOf } from "./module-resolver.ts";

type PendingDependency = Omit<ModuleDependency, "target">;

export function createModuleDependenciesReader(): ModuleDependenciesReader {
  return {
    async extract(sources): Promise<ModuleDependencies> {
      const texts = new Map(sources.map(({ path, content }) => [path, content]));
      const packages = new Set(sources.filter(({ path }) => isPackageManifest(path)).flatMap(({ content }) => [...manifestDependencies(content)]));
      const resolver = createModuleResolver(async (file) => texts.get(file), packages, { jsonModules: true });
      const files: ModuleSource[] = [];
      const pending: PendingDependency[] = [];
      const unread: { file: string; reason: "source-unreadable" | "no-extractor" }[] = [];
      const untraversed: NonNullable<ModuleDependencies["untraversed"]>[number][] = [];

      for (const [file, text] of [...texts].sort(([left], [right]) => compareText(left, right))) {
        if (!isTypeScriptFile(file)) continue;
        const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
        if ((tree as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length > 0) {
          unread.push({ file, reason: "source-unreadable" });
          continue;
        }
        const statements: string[] = [];
        let moduleOnly = true;
        let unsupported = false;
        const imported = new Set<string>();
        const exported: string[] = [];
        for (const statement of tree.statements) {
          if (ts.isEmptyStatement(statement)) continue;
          if (ts.isExportAssignment(statement)) {
            let expression = statement.expression;
            while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
            const binding = ts.isArrowFunction(expression) || ts.isFunctionExpression(expression) || ts.isClassExpression(expression)
              ? { declaration: ts.SyntaxKind[expression.kind], name: "name" in expression ? expression.name?.text : undefined }
              : expression.getText(tree);
            statements.push(JSON.stringify({ assignment: statement.isExportEquals ? "equals" : "default", binding }));
            moduleOnly = false;
            continue;
          }
          if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement) && !ts.isImportEqualsDeclaration(statement)) {
            moduleOnly = false;
            const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
            if (modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
              const names = ts.isVariableStatement(statement)
                ? statement.declarationList.declarations.flatMap((declaration) => bindingNames(declaration.name))
                : ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement) || ts.isModuleDeclaration(statement)
                  ? [statement.name?.text ?? "default"] : [];
              statements.push(JSON.stringify({ declaration: ts.SyntaxKind[statement.kind], names, default: modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword) }));
            }
            continue;
          }
          statements.push(statement.getText(tree));
          let specifier: ts.Expression | undefined;
          let typeOnly = false;
          let kind: ModuleDependency["kind"] = "import";
          if (ts.isImportDeclaration(statement)) {
            specifier = statement.moduleSpecifier;
            const clause = statement.importClause;
            if (clause?.name !== undefined) imported.add(clause.name.text);
            if (clause?.namedBindings !== undefined) {
              if (ts.isNamespaceImport(clause.namedBindings)) imported.add(clause.namedBindings.name.text);
              else for (const binding of clause.namedBindings.elements) imported.add(binding.name.text);
            }
            typeOnly = clause?.isTypeOnly === true || (clause?.name === undefined && clause?.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings) && clause.namedBindings.elements.length > 0 && clause.namedBindings.elements.every((element) => element.isTypeOnly));
          } else if (ts.isExportDeclaration(statement)) {
            kind = "reexport";
            specifier = statement.moduleSpecifier;
            typeOnly = statement.isTypeOnly || (statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause) && statement.exportClause.elements.length > 0 && statement.exportClause.elements.every((element) => element.isTypeOnly));
            if (specifier === undefined) {
              if (statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause)) {
                for (const binding of statement.exportClause.elements) exported.push((binding.propertyName ?? binding.name).text);
              }
              continue;
            }
          } else {
            typeOnly = statement.isTypeOnly;
            imported.add(statement.name.text);
            if (ts.isExternalModuleReference(statement.moduleReference)) specifier = statement.moduleReference.expression;
          }
          if (specifier === undefined || !ts.isStringLiteral(specifier)) {
            unsupported = true;
            moduleOnly = false;
            continue;
          }
          pending.push({ file, line: tree.getLineAndCharacterOfPosition(statement.getStart(tree)).line + 1, endLine: tree.getLineAndCharacterOfPosition(statement.end - 1).line + 1, specifier: specifier.text, kind, typeOnly });
        }
        if (moduleOnly && exported.some((name) => !imported.has(name))) {
          moduleOnly = false;
          unsupported = true;
        }
        const visit = (node: ts.Node): void => {
          const call = ts.isCallExpression(node) ? node : undefined;
          const dynamic = call?.expression.kind === ts.SyntaxKind.ImportKeyword;
          const requireCall = call !== undefined && ts.isIdentifier(call.expression) && call.expression.text === "require";
          if (dynamic || requireCall || ts.isImportTypeNode(node)) {
            const form = dynamic ? "dynamic-import" : requireCall ? "require" : "type-query";
            const offset = node.getStart(tree);
            const line = tree.getLineAndCharacterOfPosition(offset).line + 1;
            const literal = call !== undefined ? call.arguments[0] : ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined;
            if (form !== "require" && literal !== undefined && (ts.isStringLiteral(literal) || ts.isNoSubstitutionTemplateLiteral(literal))) {
              pending.push({ file, line, endLine: tree.getLineAndCharacterOfPosition(node.end - 1).line + 1, offset, specifier: literal.text, kind: "import", typeOnly: form === "type-query", form });
              statements.push(JSON.stringify({ reference: form, specifier: literal.text }));
            } else {
              untraversed.push({ file, line, offset, form });
            }
          }
          ts.forEachChild(node, visit);
        };
        visit(tree);
        files.push({ file, statements, moduleOnly });
        if (unsupported) unread.push({ file, reason: "no-extractor" });
      }

      const resolutions = new Map<string, Promise<ModuleTarget>>();
      const dependencies = await Promise.all(pending.map(async (dependency): Promise<ModuleDependency> => {
        const key = JSON.stringify([dependency.file, dependency.specifier]);
        let resolution = resolutions.get(key);
        if (resolution === undefined) {
          resolution = resolver.resolve(dependency.file, dependency.specifier).then((result): ModuleTarget => {
            if ("file" in result) return { kind: "repository", file: result.file };
            if ("external" in result) return { kind: "external", module: packageOf(dependency.specifier) ?? dependency.specifier };
            return { kind: "unresolved", reason: result.unresolved };
          });
          resolutions.set(key, resolution);
        }
        return { ...dependency, target: await resolution };
      }));
      const resources = new Set(dependencies.flatMap(({ target }) => target.kind === "repository" && target.file.endsWith(".json") ? [target.file] : []));
      for (const file of [...resources].sort(compareText)) files.push({ file, statements: [texts.get(file)!], moduleOnly: true, resource: true });
      files.sort((left, right) => compareText(left.file, right.file));
      return { files, dependencies, unread, untraversed };
    },
  };
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) => ts.isOmittedExpression(element) ? [] : bindingNames(element.name));
}
