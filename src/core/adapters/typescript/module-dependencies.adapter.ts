import ts from "typescript";
import { bindingNames, hasSyntaxErrors } from "./syntax.ts";
import { isTypeScriptFile } from "../../domain/languages/typescript.ts";
import { compareText } from "../../domain/shared/code-node.ts";
import type { ModuleDependencies, ModuleDependency, ModuleSource, UntraversedReference } from "../../domain/impact/module-dependency.ts";
import type { ModuleTarget } from "../../domain/shared/module-target.ts";
import type { ModuleDependenciesReader } from "../../ports/module-dependencies.port.ts";
import { defaultDeclarationName, moduleStatement } from "./import-bindings.ts";
import { moduleResolverOf, packageOf } from "./module-resolver.ts";
import { sourceTree } from "./source-tree.ts";
import { declaredNames } from "./syntax-names.ts";

type PendingDependency = Omit<ModuleDependency, "target">;

export const LOCAL_REQUIRE = "the file binds its own require, so the call is not proven to load a module";

export function createModuleDependenciesReader(): ModuleDependenciesReader {
  return {
    async extract(sources, options): Promise<ModuleDependencies> {
      const selected = options?.files === undefined ? undefined : new Set(options.files);
      const held = new Map(sources.map((source) => [source.path, source]));
      const resolver = moduleResolverOf(sources, { jsonModules: true });
      const parse = (file: string): ts.SourceFile => sourceTree(held.get(file)!, ts.ScriptTarget.Latest, ts.ScriptKind.TS);
      const files: ModuleSource[] = [];
      const pending: PendingDependency[] = [];
      const unread: { file: string; reason: "source-unreadable" | "no-extractor" }[] = [];
      const untraversed: UntraversedReference[] = [];

      for (const file of [...held.keys()].sort(compareText)) {
        if (!isTypeScriptFile(file) || (selected !== undefined && !selected.has(file))) continue;
        const tree = parse(file);
        if (hasSyntaxErrors(tree)) {
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
          if (ts.isExportDeclaration(statement) && statement.moduleSpecifier === undefined) {
            if (statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause)) {
              for (const binding of statement.exportClause.elements) exported.push((binding.propertyName ?? binding.name).text);
            }
            continue;
          }
          const read = moduleStatement(statement, tree)!;
          if (read.kind === "import") for (const { local } of read.bindings) imported.add(local!);
          if (read.specifier === undefined) {
            unsupported = true;
            moduleOnly = false;
            continue;
          }
          const offset = statement.getStart(tree);
          pending.push({ file, line: tree.getLineAndCharacterOfPosition(offset).line + 1, offset, endLine: tree.getLineAndCharacterOfPosition(statement.end - 1).line + 1, specifier: read.specifier, kind: read.kind, typeOnly: read.typeOnly, ...(read.form === undefined ? {} : { form: read.form }), bindings: read.bindings });
        }
        if (moduleOnly && exported.some((name) => !imported.has(name))) {
          moduleOnly = false;
          unsupported = true;
        }
        const ownRequire = imported.has("require") || declaredNames(tree).has("require");
        const visit = (node: ts.Node): void => {
          const call = ts.isCallExpression(node) ? node : undefined;
          const dynamic = call?.expression.kind === ts.SyntaxKind.ImportKeyword;
          const requireCall = call !== undefined && ts.isIdentifier(call.expression) && call.expression.text === "require";
          if (dynamic || requireCall || ts.isImportTypeNode(node)) {
            const form = dynamic ? "dynamic-import" : requireCall ? "require" : "type-query";
            const offset = node.getStart(tree);
            const line = tree.getLineAndCharacterOfPosition(offset).line + 1;
            const literal = call !== undefined ? call.arguments[0] : ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined;
            const specifier = literal !== undefined && (ts.isStringLiteral(literal) || ts.isNoSubstitutionTemplateLiteral(literal)) ? literal.text : undefined;
            const endLine = tree.getLineAndCharacterOfPosition(node.end - 1).line + 1;
            if (form !== "require" && specifier !== undefined) {
              pending.push({ file, line, endLine, offset, specifier, kind: "import", typeOnly: form === "type-query", form, bindings: [] });
              statements.push(JSON.stringify({ reference: form, specifier }));
            } else {
              untraversed.push({ file, line, offset, form, ...(specifier === undefined ? {} : { endLine, specifier }), ...(requireCall && ownRequire ? { target: { kind: "unresolved", reason: LOCAL_REQUIRE } } : {}) });
            }
          }
          ts.forEachChild(node, visit);
        };
        visit(tree);
        files.push({ file, statements, moduleOnly });
        if (unsupported) unread.push({ file, reason: "no-extractor" });
      }

      const resolutions = new Map<string, Promise<ModuleTarget>>();
      const resolve = (from: string, specifier: string): Promise<ModuleTarget> => {
        const key = JSON.stringify([from, specifier]);
        let resolution = resolutions.get(key);
        if (resolution === undefined) {
          resolution = resolver.resolve(from, specifier).then((result): ModuleTarget => {
            if ("file" in result) return { kind: "repository", file: result.file };
            if ("external" in result) return { kind: "external", module: packageOf(specifier) ?? specifier };
            return { kind: "unresolved", reason: result.unresolved };
          });
          resolutions.set(key, resolution);
        }
        return resolution;
      };
      const defaults = new Map<string, string | undefined>();
      const defaultOf = (file: string): string | undefined => {
        if (!defaults.has(file)) {
          defaults.set(file, held.has(file) ? defaultDeclarationName(parse(file)) : undefined);
        }
        return defaults.get(file);
      };
      const dependencies = await Promise.all(pending.map(async (dependency): Promise<ModuleDependency> => {
        const target = await resolve(dependency.file, dependency.specifier);
        if (target.kind !== "repository" || !dependency.bindings.some(({ imported }) => imported === "default")) return { ...dependency, target };
        const exportedAs = defaultOf(target.file);
        return { ...dependency, target, bindings: dependency.bindings.map((binding) => binding.imported === "default" && exportedAs !== undefined ? { ...binding, exportedAs } : binding) };
      }));
      const traced = await Promise.all(untraversed.map(async (reference) => reference.specifier === undefined || reference.target !== undefined ? reference : { ...reference, target: await resolve(reference.file, reference.specifier) }));
      const resources = new Set(dependencies.flatMap(({ target }) => target.kind === "repository" && target.file.endsWith(".json") ? [target.file] : []));
      for (const file of [...resources].sort(compareText)) files.push({ file, statements: [held.get(file)!.content], moduleOnly: true, resource: true });
      files.sort((left, right) => compareText(left.file, right.file));
      return { files, dependencies, unread, untraversed: traced };
    },
  };
}

