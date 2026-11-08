import { posix } from "node:path";
import ts from "typescript";
import { kindOfChangedFile } from "../../domain/change/changed-file.ts";
import { isTypeScriptFile } from "../../domain/languages/typescript.ts";
import { canonicalJson } from "../../domain/shared/canonical-json.ts";
import { compareText } from "../../domain/shared/code-node.ts";
import { installVerdict, LOCKFILE_NAMES, type DeclaredBuildOutput } from "../../domain/shared/build-outputs.ts";
import type { DeclaredEntry, DeclaredTrees } from "../../ports/declared-tree.port.ts";
import type { DerivedFacts } from "../../ports/derived-facts.port.ts";
import type { Digest } from "../../ports/digest.port.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { TypeBinding, TypeBindings, TypeBindingsAnswer, TypeBindingsFault, TypeTarget, UnownedSource, UnusedOutput } from "../../ports/type-bindings.port.ts";
import type { BuildOutputInput } from "../../domain/shared/fact.ts";
import { REPOSITORY_ROOT, createConfinedHost, type ConfinedHost, type DeclaredRead, type DirectoryEntries } from "./confined-compiler-host.ts";
import { installPathOf, lockedVersions } from "./installed-packages.ts";
import { packageOf } from "./module-resolver.ts";

/** The compiler's own `include`/`exclude` matcher; internal in 6.0.3 (ADR-0008 pins that version, a test holds the call). */
type MatchFiles = (
  path: string,
  extensions: readonly string[] | undefined,
  excludes: readonly string[] | undefined,
  includes: readonly string[] | undefined,
  useCaseSensitiveFileNames: boolean,
  currentDirectory: string,
  depth: number | undefined,
  getFileSystemEntries: (path: string) => DirectoryEntries,
  realpath: (path: string) => string,
) => string[];
const matchFiles = (ts as unknown as { matchFiles: MatchFiles }).matchFiles;

/** Options a configuration may state that would emit, build incrementally or load code; never honoured (ADR-0037 decision 2). */
const NEVER_HONOURED: ts.CompilerOptions = { noEmit: true, incremental: false, composite: false, declaration: false, emitDeclarationOnly: false };

interface Group {
  options: ts.CompilerOptions;
  roots: Set<string>;
  owned: string[];
}

/** A declared path the derivation asked about, with what it found, as one comparable tag. */
interface AskedPath {
  output: number;
  path: string;
  found: string;
}

interface Derivation {
  answer: TypeBindingsAnswer;
  asked: readonly AskedPath[];
}

const SLOT = "ts-type-bindings";

/** A derivation that could not complete; thrown so no derived fact keeps it, and answered as a `fault`. */
class DerivationFault extends Error {
  constructor(readonly fault: TypeBindingsFault) {
    super(fault.kind);
  }
}

/**
 * Binds every call and `new` of the snapshot's TypeScript sources by type, test files left out as no answer follows
 * their calls (`kindOfChangedFile`), in one pass over programs that live only for
 * that pass (ADR-0037 decisions 5, 7 and 8). A source's options come from the nearest `tsconfig.json` that includes it,
 * or from the one of its references, transitively, that does; sources whose owners state equal options share a program.
 * With a query's `facts`, the answer is kept by the snapshot's content, the declarations and their install records, and a kept
 * answer is used only while every declared path it asked about answers the same; requests for one key share one pass.
 */
export function createTypeBindings({ trees, digest }: { trees: DeclaredTrees; digest: Digest }): TypeBindings {
  const running = new Map<string, Promise<Derivation>>();
  const tagOf = (entry: DeclaredEntry): string => {
    if (entry.kind === "file") return `file:${entry.path}:${digest.of(entry.content)}`;
    if (entry.kind === "directory") return `directory:${entry.path}:${entry.names.join("/")}`;
    if (entry.kind === "snapshot") return `snapshot:${entry.path}`;
    if (entry.kind === "refused") return `refused:${entry.link}`;
    if (entry.kind === "unreadable") return `unreadable:${entry.path}`;
    return "absent";
  };
  const derive = (sources: readonly SourceFile[], outputs: readonly DeclaredBuildOutput[], signal?: AbortSignal): Derivation => {
    const opened = outputs.map((output) => trees.open(output));
    unreadableIn(outputs, opened.map((tree, output) => ({ output, path: "", entry: tree.entry("") })));
    let bound: ReturnType<typeof bindAll>;
    try {
      bound = bindAll(sources, outputs, trees, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new DerivationFault({ kind: "checker-failed", detail: error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error) });
    }
    const { answer, reads } = bound;
    unreadableIn(outputs, reads);
    const asked = new Map<string, AskedPath>();
    const ask = (output: number, path: string, entry: DeclaredEntry) => asked.set(`${output}\0${path}`, { output, path, found: tagOf(entry) });
    for (const { output, path, entry } of reads) ask(output, path, entry);
    const used: BuildOutputInput[] = [];
    const unused: UnusedOutput[] = [];
    for (const [index, output] of outputs.entries()) {
      const read = reads.filter((each) => each.output === index && each.entry.kind === "file");
      const installed = [...new Set(read.flatMap(({ path }) => installPathOf(path) ?? []))].toSorted(compareText).map((path) => {
        const manifest = opened[index]!.entry(`${path}/package.json`);
        ask(index, `${path}/package.json`, manifest);
        return { path, version: manifest.kind === "file" ? versionOf(manifest.content) : undefined };
      });
      const verdict = installVerdict(lockedVersions(lockfileOf(sources, output)), installed);
      if (!verdict.usable) unused.push({ kind: output.kind, at: output.at, stale: verdict.stale });
      else {
        const lines = [...asked.values()].filter((each) => each.output === index).map(({ path, found }) => `${path}\0${found}`).toSorted(compareText);
        used.push({ kind: output.kind, at: output.at, verified: verdict.verified, digest: digest.of(lines.join("\n")) });
      }
    }
    return { answer: unused.length > 0 ? { status: "unused", outputs: unused } : { ...answer, outputs: used }, asked: [...asked.values()] };
  };
  const unchanged = (outputs: readonly DeclaredBuildOutput[], asked: readonly AskedPath[]): boolean => {
    const opened = outputs.map((output) => trees.open(output));
    return asked.every(({ output, path, found }) => opened[output] !== undefined && tagOf(opened[output].entry(path)) === found);
  };
  return {
    async of(sources, outputs, signal, facts) {
      try {
        return await answerOf(sources, outputs, signal, facts);
      } catch (error) {
        if (error instanceof DerivationFault) return { status: "fault", fault: error.fault };
        throw error;
      }
    },
  };

  async function answerOf(sources: readonly SourceFile[], outputs: readonly DeclaredBuildOutput[], signal: AbortSignal | undefined, facts: DerivedFacts | undefined): Promise<TypeBindingsAnswer> {
    if (facts === undefined) return derive(sources, outputs, signal).answer;
    const inputs = {
      layout: facts.fingerprint(sources.map(({ path, content }) => [path, content]).toSorted(([a], [b]) => compareText(a!, b!))),
      outputs: outputs.map((output) => {
        const tree = trees.open(output);
        return { ...output, record: tagOf(tree.entry(".package-lock.json")), listing: tagOf(tree.entry("")) };
      }),
    };
    const key = facts.fingerprint(inputs);
    let fresh = false;
    let pass = running.get(key);
    const shared = pass !== undefined;
    if (pass === undefined) {
      pass = facts.ofInputs(SLOT, inputs, async () => {
        fresh = true;
        return derive(sources, outputs, signal);
      });
      running.set(key, pass);
      void pass.then(
        () => running.delete(key),
        () => running.delete(key),
      );
    }
    const kept = await pass.catch((error: unknown) => {
      if (!shared || signal?.aborted) throw error;
      fresh = true;
      return derive(sources, outputs, signal);
    });
    return fresh || unchanged(outputs, kept.asked) ? kept.answer : derive(sources, outputs, signal).answer;
  }
}

/** Throws the fault of every declared path among `reads` the file system would not give, by output, in path order. */
function unreadableIn(outputs: readonly DeclaredBuildOutput[], reads: readonly DeclaredRead[]): void {
  const unreadable = outputs.flatMap((output, index) => {
    const paths = [...new Set(reads.flatMap((read) => (read.output === index && read.entry.kind === "unreadable" ? [read.entry.path] : [])))].toSorted(compareText);
    return paths.length === 0 ? [] : [{ kind: output.kind, at: output.at, paths }];
  });
  if (unreadable.length > 0) throw new DerivationFault({ kind: "unreadable", outputs: unreadable });
}

function lockfileOf(sources: readonly SourceFile[], output: DeclaredBuildOutput): string | undefined {
  const directory = output.at === "" ? "" : `${output.at}/`;
  for (const name of LOCKFILE_NAMES) {
    const found = sources.find(({ path }) => path === `${directory}${name}`);
    if (found !== undefined) return found.content;
  }
  return undefined;
}

function versionOf(manifest: string): string | undefined {
  try {
    const { version } = JSON.parse(manifest) as { version?: unknown };
    return typeof version === "string" ? version : undefined;
  } catch {
    return undefined;
  }
}

function bindAll(sources: readonly SourceFile[], outputs: readonly DeclaredBuildOutput[], trees: DeclaredTrees, signal?: AbortSignal): { answer: Omit<Extract<TypeBindingsAnswer, { status: "bound" }>, "outputs">; reads: readonly DeclaredRead[] } {
  const confined = createConfinedHost(sources, outputs, trees);
  const { groups, unowned } = projectsOf(sources, confined);
  const bindings: TypeBinding[] = [];
  for (const group of groups) {
    signal?.throwIfAborted();
    const program = ts.createProgram({ rootNames: [...group.roots].toSorted(compareText), options: group.options, host: confined.host });
    const checker = program.getTypeChecker();
    for (const file of group.owned) {
      signal?.throwIfAborted();
      const tree = program.getSourceFile(`${REPOSITORY_ROOT}/${file}`);
      if (tree !== undefined) bindings.push(...bindingsIn(tree, file, checker, confined));
    }
  }
  bindings.sort((a, b) => compareText(a.file, b.file) || a.line - b.line || a.column - b.column || compareText(a.name, b.name));
  return { answer: { status: "bound", bindings, unowned, refused: [...confined.refused].toSorted(compareText) }, reads: confined.reads };
}

function projectsOf(sources: readonly SourceFile[], confined: ConfinedHost): { groups: Group[]; unowned: UnownedSource[] } {
  const present = new Set(sources.map(({ path }) => path));
  const parseHost: ts.ParseConfigHost = {
    useCaseSensitiveFileNames: true,
    fileExists: confined.host.fileExists,
    readFile: confined.host.readFile,
    readDirectory: (root, extensions, excludes, includes, depth) => matchFiles(root, extensions, excludes, includes, true, REPOSITORY_ROOT, depth, confined.snapshotEntries, (path) => path),
  };
  const configs = new Map<string, ts.ParsedCommandLine | undefined>();
  const configOf = (file: string): ts.ParsedCommandLine | undefined => {
    if (!configs.has(file)) {
      const text = confined.host.readFile(file);
      const json = text === undefined ? undefined : ts.parseConfigFileTextToJson(file, text);
      configs.set(file, json === undefined || json.error !== undefined ? undefined : ts.parseJsonConfigFileContent(json.config, parseHost, posix.dirname(file), undefined, file));
    }
    return configs.get(file);
  };
  const ownersOf = (config: string, file: string, seen: Set<string>): string[] => {
    if (seen.has(config)) return [];
    seen.add(config);
    const parsed = configOf(config);
    if (parsed === undefined) return [];
    if (parsed.fileNames.includes(file)) return [config];
    return (parsed.projectReferences ?? []).flatMap((reference) => ownersOf(ts.resolveProjectReferencePath(reference), file, seen));
  };

  const groups = new Map<string, Group>();
  const unowned: UnownedSource[] = [];
  for (const path of [...present].filter((file) => isTypeScriptFile(file) && kindOfChangedFile(file) !== "test").toSorted(compareText)) {
    const nearest = nearestConfig(path, present);
    const file = `${REPOSITORY_ROOT}/${path}`;
    const owners = nearest === undefined ? [] : [...new Set(ownersOf(`${REPOSITORY_ROOT}/${nearest}`, file, new Set()))];
    if (owners.length !== 1) {
      const named = owners.length === 0 ? (nearest === undefined ? [] : [nearest]) : owners.map((owner) => owner.slice(REPOSITORY_ROOT.length + 1));
      unowned.push({ file: path, configurations: named.toSorted(compareText) });
      continue;
    }
    const parsed = configOf(owners[0]!)!;
    const { configFilePath: _named, tsBuildInfoFile: _buildInfo, plugins: _plugins, ...stated } = parsed.options;
    const options = { ...stated, ...NEVER_HONOURED };
    const key = canonicalJson(options);
    let group = groups.get(key);
    if (group === undefined) groups.set(key, (group = { options, roots: new Set(), owned: [] }));
    group.owned.push(path);
    group.roots.add(file);
    for (const declared of parsed.fileNames) if (/\.d\.[cm]?ts$/.test(declared)) group.roots.add(declared);
  }
  return { groups: [...groups.entries()].toSorted(([a], [b]) => compareText(a, b)).map(([, group]) => group), unowned };
}

function nearestConfig(path: string, present: ReadonlySet<string>): string | undefined {
  for (let directory = posix.dirname(path); ; directory = posix.dirname(directory)) {
    const candidate = directory === "." ? "tsconfig.json" : `${directory}/tsconfig.json`;
    if (present.has(candidate)) return candidate;
    if (directory === ".") return undefined;
  }
}

function bindingsIn(tree: ts.SourceFile, file: string, checker: ts.TypeChecker, confined: ConfinedHost): TypeBinding[] {
  const found: TypeBinding[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isCallExpression(node) && node.expression.kind !== ts.SyntaxKind.ImportKeyword) || ts.isNewExpression(node)) {
      const name = calleeName(node.expression);
      const target = name === undefined ? undefined : targetOf(node, name, checker, confined);
      if (name !== undefined && target !== undefined) {
        const start = tree.getLineAndCharacterOfPosition(node.getStart(tree));
        found.push({ file, line: start.line + 1, column: start.character + 1, name: name.text, target });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return found;
}

type CalleeName = ts.Identifier | ts.PrivateIdentifier | ts.StringLiteralLike;

function calleeName(expression: ts.Expression): CalleeName | undefined {
  if (ts.isIdentifier(expression)) return expression;
  if (ts.isPropertyAccessExpression(expression)) return expression.name;
  if (ts.isElementAccessExpression(expression)) return ts.isStringLiteralLike(expression.argumentExpression) ? expression.argumentExpression : undefined;
  if (ts.isParenthesizedExpression(expression) || ts.isNonNullExpression(expression)) return calleeName(expression.expression);
  return undefined;
}

/**
 * The declaration the callee's name binds, through an alias; among its overloads, the one the checker chose. A callee
 * with no symbol binds the signature the checker chose. Declarations in more than one file (declaration merging) bind
 * nothing unless the chosen signature is one of them, and an `any` binds nothing.
 */
function targetOf(call: ts.CallExpression | ts.NewExpression, name: CalleeName, checker: ts.TypeChecker, confined: ConfinedHost): TypeTarget | undefined {
  let symbol = checker.getSymbolAtLocation(name);
  if (symbol !== undefined && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  const chosen = checker.getResolvedSignature(call)?.declaration;
  const signature = chosen !== undefined && !ts.isJSDocSignature(chosen) ? chosen : undefined;
  const declarations = symbol?.declarations ?? [];
  let declaration: ts.Declaration | undefined;
  if (declarations.length === 0) declaration = signature;
  else if (signature !== undefined && declarations.includes(signature)) declaration = signature;
  else if (new Set(declarations.map((each) => each.getSourceFile())).size === 1) declaration = declarations[0];
  if (declaration === undefined) return undefined;
  if (ts.isConstructorDeclaration(declaration)) declaration = declaration.parent;
  return placeOf(declaration, symbol, confined);
}

function placeOf(declaration: ts.Declaration, symbol: ts.Symbol | undefined, confined: ConfinedHost): TypeTarget | undefined {
  const source = declaration.getSourceFile();
  const named = ts.getNameOfDeclaration(declaration);
  const name = named?.getText(source) ?? symbol?.getName();
  if (name === undefined) return undefined;
  if (confined.isLibrary(source.fileName)) return { kind: "ambient", name };
  const declared = confined.declaredPlace(source.fileName);
  if (declared !== undefined) {
    const nested = declared.path.lastIndexOf("node_modules/");
    const module = packageOf(nested === -1 ? declared.path : declared.path.slice(nested + "node_modules/".length));
    return module === undefined ? undefined : { kind: "external", module, name };
  }
  if (!source.fileName.startsWith(`${REPOSITORY_ROOT}/`)) return undefined;
  return { kind: "repository", file: source.fileName.slice(REPOSITORY_ROOT.length + 1), line: source.getLineAndCharacterOfPosition((named ?? declaration).getStart(source)).line + 1, name };
}
