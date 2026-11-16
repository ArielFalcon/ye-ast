import ts from "typescript";
import type { SymbolRef } from "../../domain/relations/relation.ts";
import type { DeclaredTrees } from "../../ports/declared-tree.port.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { RawReceiver } from "./angular-metadata.extractor.ts";
import { createConfinedHost, REPOSITORY_ROOT } from "./confined-compiler-host.ts";

/** The compiler reads the snapshot and its own libraries only, with no configuration of the repository and no installed package. */
const OPTIONS: ts.CompilerOptions = { noEmit: true, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.Preserve, moduleResolution: ts.ModuleResolutionKind.Bundler, types: [], skipLibCheck: true, experimentalDecorators: true };
const NO_TREES: DeclaredTrees = { open: () => ({ entry: () => ({ kind: "absent" }) }) };
const UNBOUNDED = ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never | ts.TypeFlags.Instantiable;

export interface ReceiverTypes {
  /**
   * Whether the object at `receiver` may be an instance of `instance`'s class. False only when the checker proves it: the
   * receiver has a declared type and the class instance type is not assignable to it. Anything the checker cannot bound
   * (an `any`, an unresolved type, a type parameter, a class whose own type it cannot read in full) answers true.
   */
  mayHold(file: string, receiver: RawReceiver, instance: SymbolRef): boolean;
}

/**
 * Answers from one program over `paths` of the snapshot, built on the first question and kept for the read. Options are the
 * default ones, the most permissive assignability, so a class is excluded only where no mode of the language accepts it.
 */
export function createReceiverTypes(sources: readonly SourceFile[], paths: readonly string[]): ReceiverTypes {
  let held: { program: ts.Program; checker: ts.TypeChecker } | undefined;
  const checking = () => {
    if (held === undefined) {
      const program = ts.createProgram({ rootNames: paths.map((path) => `${REPOSITORY_ROOT}/${path}`), options: OPTIONS, host: createConfinedHost(sources, [], NO_TREES).host });
      held = { program, checker: program.getTypeChecker() };
    }
    return held;
  };
  const answers = new Map<string, boolean>();

  const excluded = (file: string, receiver: RawReceiver, instance: SymbolRef): boolean => {
    const { program, checker } = checking();
    const tree = program.getSourceFile(`${REPOSITORY_ROOT}/${file}`);
    const node = tree === undefined ? undefined : nodeAt(tree, receiver);
    if (node === undefined || inGenericScope(node)) return false;
    const target = declaredTypeOf(checker, node);
    if (unbounded(target)) return false;
    const type = instanceTypeOf(program, checker, instance);
    return type !== undefined && !checker.isTypeAssignableTo(type, target);
  };

  return {
    mayHold(file, receiver, instance) {
      const key = `${file}\0${receiver.start}\0${receiver.end}\0${instance.path}\0${instance.symbol}\0${instance.line}`;
      let answer = answers.get(key);
      if (answer === undefined) answers.set(key, (answer = !excluded(file, receiver, instance)));
      return answer;
    },
  };
}

function unbounded(type: ts.Type): boolean {
  return (type.flags & UNBOUNDED) !== 0 || (type.isUnionOrIntersection() && type.types.some(unbounded));
}

/** A variable's own declared type, not the one control flow narrows it to; any other object, the type at its place. */
function declaredTypeOf(checker: ts.TypeChecker, node: ts.Expression): ts.Type {
  let symbol = ts.isIdentifier(node) ? checker.getSymbolAtLocation(node) : undefined;
  if (symbol !== undefined && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  return symbol !== undefined && symbol.flags & ts.SymbolFlags.Variable ? checker.getTypeOfSymbol(symbol) : checker.getTypeAtLocation(node);
}

function basesResolved(checker: ts.TypeChecker, type: ts.Type): boolean {
  const extended = (type.symbol?.declarations ?? []).some((declaration) => ts.isClassLike(declaration) && declaration.heritageClauses?.some((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword));
  if (!extended) return true;
  const bases = checker.getBaseTypes(type as ts.InterfaceType);
  return bases.length > 0 && bases.every((base) => basesResolved(checker, base));
}

/** The instance type of a class declared at the top level of its file without type parameters, when every class above it is read in full. */
function instanceTypeOf(program: ts.Program, checker: ts.TypeChecker, instance: SymbolRef): ts.Type | undefined {
  const tree = program.getSourceFile(`${REPOSITORY_ROOT}/${instance.path}`);
  const declaration = tree?.statements.find((statement): statement is ts.ClassDeclaration => ts.isClassDeclaration(statement) && statement.name?.text === instance.symbol && tree.getLineAndCharacterOfPosition(statement.name.getStart(tree)).line + 1 === instance.line);
  const symbol = declaration?.name === undefined || declaration.typeParameters !== undefined ? undefined : checker.getSymbolAtLocation(declaration.name);
  const type = symbol === undefined ? undefined : checker.getDeclaredTypeOfSymbol(symbol);
  return type !== undefined && basesResolved(checker, type) ? type : undefined;
}

function nodeAt(tree: ts.SourceFile, { start, end }: RawReceiver): ts.Expression | undefined {
  const find = (node: ts.Node): ts.Expression | undefined => {
    if (ts.isExpression(node) && node.getStart(tree) === start && node.getEnd() === end) return node;
    return ts.forEachChild(node, (child) => (child.getFullStart() <= start && child.getEnd() >= end ? find(child) : undefined));
  };
  return find(tree);
}

/** A type parameter of an enclosing declaration may stand for a type the caller picks, whatever the object's type shows. */
function inGenericScope(node: ts.Node): boolean {
  for (let at: ts.Node | undefined = node; at !== undefined; at = at.parent) if ((ts.isFunctionLike(at) || ts.isClassLike(at)) && at.typeParameters !== undefined) return true;
  return false;
}
