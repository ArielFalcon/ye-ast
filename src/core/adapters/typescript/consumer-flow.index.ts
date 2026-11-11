import ts from "typescript";
import { isTypeScriptSource } from "../../domain/languages/typescript.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import { moduleShape } from "./module-shape.ts";
import type { RawImport } from "./module-shape.ts";
import { createDeclarationLookup, type Declaration } from "./declaration-lookup.ts";
import { moduleResolverOf } from "./module-resolver.ts";
import { namedFunction, type NamedFunction } from "./consumer-flow.syntax.ts";
import { sourceTree } from "./source-tree.ts";
import { declarationCounts } from "./syntax-names.ts";

export interface Unit {
  file: string;
  tree: ts.SourceFile;
  imports: ReadonlyMap<string, RawImport>;
  /** How often each name is declared anywhere in the file. */
  declared: ReadonlyMap<string, number>;
  classes: ReadonlyMap<string, ts.ClassDeclaration>;
  functions: ReadonlyMap<string, NamedFunction>;
}
export type Origin = Declaration | "external" | undefined;

export interface FlowIndex {
  units: ReadonlyMap<string, Unit>;
  origin(file: string, local: string): Origin;
}

export interface Program {
  index: FlowIndex;
}

export async function buildProgram(files: readonly SourceFile[]): Promise<Program> {
  const modules = moduleResolverOf(files);
  const units = new Map<string, Unit>();
  const shapes = new Map<string, NonNullable<ReturnType<typeof moduleShape>>>();
  for (const file of files.filter((candidate) => isTypeScriptSource(candidate.path))) {
    const tree = sourceTree(file, ts.ScriptTarget.Latest, ts.ScriptKind.TS);
    const shape = moduleShape(tree);
    if (shape === undefined) continue;
    shapes.set(file.path, shape);
    units.set(file.path, describe(file.path, tree, shape.imports));
  }
  const fileOf = async (from: string, specifier: string): Promise<string | undefined> => {
    const resolved = await modules.resolve(from, specifier);
    return "file" in resolved ? resolved.file : undefined;
  };
  const declarationOf = createDeclarationLookup(async (file) => shapes.get(file), fileOf);

  const origins = new Map<string, Origin>();
  for (const unit of units.values()) {
    for (const [local, imported] of unit.imports) {
      if (imported.imported === "*") continue;
      const resolved = await modules.resolve(unit.file, imported.module);
      if ("external" in resolved) origins.set(`${unit.file}\0${local}`, "external");
      else if ("file" in resolved) origins.set(`${unit.file}\0${local}`, await declarationOf(resolved.file, imported.imported));
    }
  }
  const index: FlowIndex = { units, origin: (file, local) => origins.get(`${file}\0${local}`) };
  return { index };
}

function describe(file: string, tree: ts.SourceFile, imports: ReadonlyMap<string, RawImport>): Unit {
  const classes = new Map<string, ts.ClassDeclaration>();
  const functions = new Map<string, NamedFunction>();
  for (const statement of tree.statements) {
    if (ts.isClassDeclaration(statement) && statement.name !== undefined) classes.set(statement.name.text, statement);
    if (ts.isFunctionDeclaration(statement)) {
      const named = namedFunction(statement);
      if (named !== undefined) functions.set(named.name, named);
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const initializer = declaration.initializer;
      const named = initializer !== undefined && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) ? namedFunction(initializer) : undefined;
      if (named !== undefined) functions.set(named.name, named);
    }
  }
  return { file, tree, imports, declared: declarationCounts(tree), classes, functions };
}
