import ts from "typescript";
import { bindingNames, readsModuleStatements, writtenStrings } from "./syntax.ts";
import { isTypeScriptFile } from "../../domain/languages/typescript.ts";
import { compareText } from "../../domain/shared/code-node.ts";
import type { ModuleDependencies, ModuleDependency, ModuleSource, UntraversedReference } from "../../domain/impact/module-dependency.ts";
import type { ModuleTarget } from "../../domain/shared/module-target.ts";
import type { DerivedFacts } from "../../ports/derived-facts.port.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { ModuleDependenciesReader } from "../../ports/module-dependencies.port.ts";
import { defaultDeclarationName, moduleStatement } from "./import-bindings.ts";
import { createModuleResolver, manifestPackages, moduleResolverOf, packageOf } from "./module-resolver.ts";
import { sourceTree } from "./source-tree.ts";
import { declaredNames } from "./syntax-names.ts";

type PendingDependency = Omit<ModuleDependency, "target">;

export const LOCAL_REQUIRE = "the file binds its own require, so the call is not proven to load a module";

const STATEMENTS_SLOT = "ts-module-statements";
const DEFAULT_SLOT = "ts-default-declaration";
const RESOLUTIONS_SLOT = "ts-module-resolutions";

/** What one file's syntax states of its modules, which reads nothing of any other file (ADR-0115); `strings` where the statements are not read. */
type FileSyntax =
  | { strings: readonly string[] }
  | { statements: string[]; moduleOnly: boolean; unsupported: boolean; pending: PendingDependency[]; untraversed: UntraversedReference[] };

type Resolved = { target: ModuleTarget; namesNoFile?: true; stem?: string };

function readSyntax(source: SourceFile): FileSyntax {
  const file = source.path;
  const tree = sourceTree(source, ts.ScriptTarget.Latest, ts.ScriptKind.TS);
  if (!readsModuleStatements(tree)) return { strings: writtenStrings(source.content) };
  const pending: PendingDependency[] = [];
  const untraversed: UntraversedReference[] = [];
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
  return { statements, moduleOnly, unsupported, pending, untraversed };
}

export function createModuleDependenciesReader(): ModuleDependenciesReader {
  return {
    async extract(sources, options): Promise<ModuleDependencies> {
      const facts = options?.facts;
      const selected = options?.files === undefined ? undefined : new Set(options.files);
      const held = new Map(sources.map((source) => [source.path, source]));
      const resolver = options?.listing === undefined ? moduleResolverOf(sources, { jsonModules: true }) : createModuleResolver(async (file) => held.get(file)?.content, manifestPackages(sources), { jsonModules: true, listing: options.listing });
      const syntaxOf = (source: SourceFile): FileSyntax => (facts === undefined ? readSyntax(source) : facts.ofFile(STATEMENTS_SLOT, source, () => readSyntax(source)));
      const files: ModuleSource[] = [];
      const pending: PendingDependency[] = [];
      const unread: { file: string; reason: "source-unreadable" | "no-extractor"; reaches?: readonly string[] }[] = [];
      const bounded: { entry: number; strings: readonly string[] }[] = [];
      const untraversed: UntraversedReference[] = [];

      for (const file of [...held.keys()].sort(compareText)) {
        if (!isTypeScriptFile(file) || (selected !== undefined && !selected.has(file))) continue;
        const syntax = syntaxOf(held.get(file)!);
        if ("strings" in syntax) {
          bounded.push({ entry: unread.length, strings: syntax.strings });
          unread.push({ file, reason: "source-unreadable" });
          continue;
        }
        pending.push(...syntax.pending);
        untraversed.push(...syntax.untraversed);
        files.push({ file, statements: syntax.statements, moduleOnly: syntax.moduleOnly });
        if (syntax.unsupported) unread.push({ file, reason: "no-extractor" });
      }

      const specifiers = new Map<string, Set<string>>();
      const wanted = (from: string, specifier: string): void => void specifiers.set(from, (specifiers.get(from) ?? new Set()).add(specifier));
      for (const { file, specifier } of pending) wanted(file, specifier);
      for (const { entry, strings } of bounded) for (const specifier of strings) wanted(unread[entry]!.file, specifier);
      for (const { file, specifier, target } of untraversed) if (specifier !== undefined && target === undefined) wanted(file, specifier);
      const resolutions = new Map<string, Resolved>();
      const resolveAll = async (from: string, asked: readonly string[]): Promise<Resolved[]> =>
        Promise.all(asked.map(async (specifier): Promise<Resolved> => {
          const result = await resolver.resolve(from, specifier);
          if ("file" in result) return { target: { kind: "repository", file: result.file } };
          if ("external" in result) return { target: { kind: "external", module: packageOf(specifier) ?? specifier } };
          return { target: { kind: "unresolved", reason: result.unresolved }, ...(result.namesNoFile === undefined ? {} : { namesNoFile: result.namesNoFile }), ...(result.stem === undefined ? {} : { stem: result.stem }) };
        }));
      let layout: string | undefined;
      const resolutionsOf = (from: string, asked: readonly string[]): Promise<Resolved[]> =>
        facts === undefined ? resolveAll(from, asked) : facts.ofInputs(RESOLUTIONS_SLOT, { layout: (layout ??= facts.fingerprint(layoutOf(sources, options?.listing))), from, specifiers: asked }, () => resolveAll(from, asked));
      await Promise.all([...specifiers].map(async ([from, set]) => {
        const asked = [...set].sort(compareText);
        const answers = await resolutionsOf(from, asked);
        for (const [index, specifier] of asked.entries()) resolutions.set(JSON.stringify([from, specifier]), answers[index]!);
      }));
      const resolved = (from: string, specifier: string): Resolved => resolutions.get(JSON.stringify([from, specifier]))!;
      const resolve = (from: string, specifier: string): ModuleTarget => resolved(from, specifier).target;
      const defaults = new Map<string, string | undefined>();
      const defaultOf = (file: string): string | undefined => {
        if (!defaults.has(file)) {
          const source = held.get(file);
          const read = (): string | null => (source === undefined ? null : defaultDeclarationName(sourceTree(source, ts.ScriptTarget.Latest, ts.ScriptKind.TS)) ?? null);
          defaults.set(file, (facts === undefined || source === undefined ? read() : facts.ofFile(DEFAULT_SLOT, source, read)) ?? undefined);
        }
        return defaults.get(file);
      };
      const dependencies = pending.map((dependency): ModuleDependency => {
        const { target, namesNoFile, stem } = resolved(dependency.file, dependency.specifier);
        if (namesNoFile !== undefined || stem !== undefined) return { ...dependency, target, ...(namesNoFile === undefined ? {} : { namesNoFile }), ...(stem === undefined ? {} : { stem }) };
        if (target.kind !== "repository" || !dependency.bindings.some(({ imported }) => imported === "default")) return { ...dependency, target };
        const exportedAs = defaultOf(target.file);
        return { ...dependency, target, bindings: dependency.bindings.map((binding) => binding.imported === "default" && exportedAs !== undefined ? { ...binding, exportedAs } : binding) };
      });
      for (const { entry, strings } of bounded) {
        const from = unread[entry]!.file;
        unread[entry] = { ...unread[entry]!, reaches: [...new Set(strings.flatMap((specifier) => { const target = resolve(from, specifier); return target.kind === "repository" ? [target.file] : []; }))].sort(compareText) };
      }
      const traced = untraversed.map((reference) => reference.specifier === undefined || reference.target !== undefined ? reference : { ...reference, target: resolve(reference.file, reference.specifier) });
      const resources = new Set(dependencies.flatMap(({ target }) => target.kind === "repository" && target.file.endsWith(".json") ? [target.file] : []));
      for (const file of [...resources].sort(compareText)) files.push({ file, statements: [held.get(file)!.content], moduleOnly: true, resource: true });
      files.sort((left, right) => compareText(left.file, right.file));
      return { files, dependencies, unread, untraversed: traced };
    },
  };
}

/** Every input a specifier's resolution reads: which paths the snapshot holds, the contents of its JSON files (configurations and manifests), and the listing a `namesNoFile` proof scans. */
function layoutOf(sources: readonly SourceFile[], listing: readonly string[] | undefined): object {
  return {
    paths: sources.map(({ path }) => path).toSorted(compareText),
    json: sources.filter(({ path }) => path.endsWith(".json")).map(({ path, content }) => [path, content]).toSorted(([a], [b]) => compareText(a!, b!)),
    listing: listing === undefined ? null : listing.toSorted(compareText),
  };
}
