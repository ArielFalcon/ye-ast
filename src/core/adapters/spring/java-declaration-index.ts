import type { DerivedFacts, RecordedAnswers } from "../../ports/derived-facts.port.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { JavaParser } from "../tree-sitter/java-parser.adapter.ts";
import { BUILD_PARTS, JAVA_DECLARATIONS_SLOT, JAVA_MARKERS, NAMING_KINDS, PACKAGE_QUESTIONS, questions, type BuildPart, type JavaMarker, type NamingKind, type PackageQuestion } from "./java-declaration-questions.ts";
import { declarationsOf, type BodySummary, type DeclaredType, type DeclarationState, type JavaDeclarations } from "./java-declarations.ts";
import { claimedPlatformPackage, writtenSimpleName } from "./java-symbols.ts";

export interface DeclarationIndexInputs {
  /** What the build states about the sources (ADR-0062). */
  generatesInterfaces: boolean;
  /** Whether the listing holds a JVM source that no extractor reads. */
  unreadJvm: boolean;
}

/**
 * The declarations every Java source of a snapshot states, answered by the ten primitive questions of RFC-0039: each
 * answer is plain, sorted data, compared as a string. Its fingerprint digests every file and input the answers depend on
 * (ADR-0128).
 */
export interface JavaDeclarationIndex extends RecordedAnswers {
  /** The answer to a question the vocabulary names; any other question is an `UnknownDeclarationQuestionError`. */
  answer(question: string): string;
  /** What a derivation kept earlier asks of a snapshot that may not know the question: `undefined` when the vocabulary does not name it. */
  answerIfKnown(question: string): string | undefined;
  /** The sources not read in full, in the order of the sources: unparsed, read for their declarations only, or with declarations that cannot be listed. */
  unread(): readonly { path: string; state: DeclarationState }[];
  readonly version: object;
  /** The questions that may answer otherwise than in the index `earlier` is the version of: the ones the edited files' difference names (ADR-0145). */
  changedSince(earlier: object): ((question: string) => boolean) | undefined;
}

export class UnknownDeclarationQuestionError extends Error {
  constructor(readonly question: string) {
    super("the declaration index does not answer this question");
    this.name = "UnknownDeclarationQuestionError";
  }
}

const isOf = <T extends string>(vocabulary: readonly T[], word: string | undefined): word is T => vocabulary.includes(word as T);

interface Located {
  path: string;
  entry: JavaDeclarations;
}

const list = (paths: Iterable<string>): string => JSON.stringify([...paths].sort());

export function createDeclarationIndex(entries: readonly Located[], inputs: DeclarationIndexInputs, fingerprint: (inputs: object) => string): JavaDeclarationIndex {
  const byPath = new Map(entries.map(({ path, entry }) => [path, entry]));
  const inProject = entries.filter(({ entry }) => entry.state === "read" || entry.state === "unreadable");
  const lazily = <T>(build: () => T): (() => T) => {
    let built: T | undefined;
    return () => (built ??= build());
  };
  const declaredBy = lazily(() => grouped(entries.flatMap(({ path, entry }) => entry.types.map((type) => [type.fqn, path] as const))));
  const namedTypes = lazily(() => grouped(entries.flatMap(({ path, entry }) => entry.types.map((type) => [type.name, JSON.stringify([type.fqn, path])] as const))));
  const packages = lazily(() => new Set(inProject.flatMap(({ entry }) => prefixesOf(entry.header.packageName))));
  const typedPackages = lazily(() => new Set(entries.flatMap(({ entry }) => (entry.types.length > 0 ? [entry.header.packageName] : []))));
  const naming = lazily(() => namingsOf(entries.map(({ path, entry }) => ({ path, types: entry.types, body: entry.body }))));
  const marked = lazily(() => grouped(entries.flatMap(({ path, entry }) => entry.body.markers.map((marker) => [marker, path] as const))));
  const claimed = lazily(() => list(new Set(inProject.flatMap(({ entry }) => claimedPlatformPackage(entry.header.packageName) ?? []))));
  const listing = lazily(() => fingerprint({ listing: entries.map(({ path, entry }) => [path, entry.content]).sort(([a], [b]) => (a! < b! ? -1 : a! > b! ? 1 : 0)) }));
  const indexed = lazily(() => fingerprint({ listing: listing(), inputs }));
  const unreadAnswer = lazily(() => JSON.stringify({ files: entries.filter(({ entry }) => entry.state !== "read").map(({ path, entry }) => [path, entry.state]).sort(([a], [b]) => (a! < b! ? -1 : a! > b! ? 1 : 0)), unreadJvm: inputs.unreadJvm }));

  const answers = new Map<string, string>();
  const answerOf = (question: string): string | undefined => {
    const [kind = "", ...rest] = question.split("|");
    const argument = rest.join("|");
    const [which, ...named] = rest;
    const name = named.join("|");
    switch (kind) {
      case "file":
        return rest.length > 0 ? (byPath.get(argument)?.content ?? "") : undefined;
      case "declarations":
        return rest.length > 0 ? (byPath.get(argument)?.declarationsDigest ?? "") : undefined;
      case "declaring":
        return rest.length > 0 ? list(declaredBy().get(argument) ?? []) : undefined;
      case "package":
        return isOf<PackageQuestion>(PACKAGE_QUESTIONS, which) ? String(which === "prefix" ? packages().has(name) : typedPackages().has(name)) : undefined;
      case "named":
        return rest.length > 0 ? `[${(namedTypes().get(argument) ?? []).toSorted().join(",")}]` : undefined;
      case "naming":
        return isOf<NamingKind>(NAMING_KINDS, which) ? list(naming()[which].get(name) ?? []) : undefined;
      case "marked":
        return isOf<JavaMarker>(JAVA_MARKERS, argument) ? list(marked().get(argument) ?? []) : undefined;
      case "unread":
        return rest.length === 0 ? unreadAnswer() : undefined;
      case "build":
        return isOf<BuildPart>(BUILD_PARTS, argument) ? (argument === "claimed" ? claimed() : String(inputs.generatesInterfaces)) : undefined;
      case "listing":
        return rest.length === 0 ? listing() : undefined;
      default:
        return undefined;
    }
  };
  const answerIfKnown = (question: string): string | undefined => {
    let answer = answers.get(question);
    if (answer === undefined) {
      answer = answerOf(question);
      if (answer !== undefined) answers.set(question, answer);
    }
    return answer;
  };

  const version: IndexVersion = { files: byPath, inputs };
  versions.add(version);
  const changedSinceVersion = new WeakMap<IndexVersion, ReadonlySet<string>>();
  return {
    get fingerprint() {
      return indexed();
    },
    version,
    changedSince: (earlier) => {
      if (!versions.has(earlier)) return undefined;
      const known = earlier as IndexVersion;
      let changed = changedSinceVersion.get(known);
      if (changed === undefined) {
        changed = changedQuestions(known, version);
        changedSinceVersion.set(known, changed);
      }
      return (question) => changed.has(question);
    },
    unread: () => entries.filter(({ entry }) => entry.state !== "read").map(({ path, entry }): { path: string; state: DeclarationState } => ({ path, state: entry })),
    answerIfKnown,
    answer: (question) => {
      const answer = answerIfKnown(question);
      if (answer === undefined) throw new UnknownDeclarationQuestionError(question);
      return answer;
    },
  };
}

/** What an index keeps to tell later indexes which questions changed since it: its entries by path and its inputs. */
interface IndexVersion {
  files: ReadonlyMap<string, JavaDeclarations>;
  inputs: DeclarationIndexInputs;
}

const versions = new WeakSet<object>();

/** The questions whose answers may differ between two indexes: the ones whose value differs in what an edited file contributes to them, and the ones an input changed. */
function changedQuestions(earlier: IndexVersion, later: IndexVersion): ReadonlySet<string> {
  const changed = new Set<string>();
  if (earlier.inputs.unreadJvm !== later.inputs.unreadJvm) changed.add(questions.unread());
  if (earlier.inputs.generatesInterfaces !== later.inputs.generatesInterfaces) changed.add(questions.build("generatesInterfaces"));
  for (const path of new Set([...earlier.files.keys(), ...later.files.keys()])) {
    const before = earlier.files.get(path);
    const after = later.files.get(path);
    if (before?.content === after?.content) continue;
    const was = contributionOf(path, before);
    const is = contributionOf(path, after);
    for (const question of new Set([...was.keys(), ...is.keys()])) if (was.get(question) !== is.get(question)) changed.add(question);
  }
  return changed;
}

/** What one file contributes to the answer of each question it takes part in, as a value two versions of the file compare: no question outside it depends on the file. */
function contributionOf(path: string, entry: JavaDeclarations | undefined): ReadonlyMap<string, string> {
  const values = new Map<string, string>();
  if (entry === undefined) return values;
  const add = (question: string, value: string) => values.set(question, values.has(question) ? `${values.get(question)}\n${value}` : value);
  add(questions.file(path), entry.content);
  add(questions.declarations(path), entry.declarationsDigest);
  add(questions.listing(), entry.content);
  if (entry.state !== "read") add(questions.unread(), entry.state);
  const inProject = entry.state === "read" || entry.state === "unreadable";
  const packageName = entry.header.packageName;
  if (inProject) for (const prefix of prefixesOf(packageName)) add(questions.package("prefix", prefix), "");
  if (entry.types.length > 0) add(questions.package("typed", packageName), "");
  const claim = inProject ? claimedPlatformPackage(packageName) : undefined;
  if (claim !== undefined) add(questions.build("claimed"), claim);
  for (const type of entry.types) {
    add(questions.declaring(type.fqn), "");
    add(questions.named(type.name), type.fqn);
  }
  for (const marker of entry.body.markers) add(questions.marked(marker), "");
  const namings = namingsOf([{ path, types: entry.types, body: entry.body }]);
  for (const kind of NAMING_KINDS) for (const name of namings[kind].keys()) values.set(questions.naming(kind, name), "");
  return values;
}

/** The index over `sources`: each file's declarations are the per-file fact `java-declarations`, derived again only for a file whose content changed (ADR-0116). */
export function javaDeclarationIndex(facts: DerivedFacts, parser: JavaParser, sources: readonly SourceFile[], inputs: DeclarationIndexInputs): JavaDeclarationIndex {
  const entries = sources.map((source) => ({ path: source.path, entry: facts.ofFile(JAVA_DECLARATIONS_SLOT, source, () => declarationsOf(parser, source, (value) => facts.fingerprint(value))) }));
  return createDeclarationIndex(entries, inputs, (value) => facts.fingerprint(value));
}

/** The paths of the files that write each name, by kind of writing: what `naming` answers. */
export type Namings = Record<NamingKind, Map<string, Set<string>>>;

export function namingsOf(files: readonly { path: string; types: readonly DeclaredType[]; body: BodySummary }[]): Namings {
  const kinds = Object.fromEntries(NAMING_KINDS.map((kind) => [kind, new Map<string, Set<string>>()])) as Namings;
  const add = (kind: NamingKind, name: string, path: string) => (kinds[kind].get(name) ?? kinds[kind].set(name, new Set()).get(name)!).add(path);
  for (const { path, types, body } of files) {
    for (const type of types) {
      for (const supertype of type.supertypes) add("supertype", writtenSimpleName(supertype.name), path);
      for (const annotation of type.annotations) add("annotation", annotation, path);
      for (const constant of type.constantNames) add("constant", constant, path);
    }
    for (const name of body.unplacedSupertypes) add("unplaced-supertype", name, path);
    for (const name of body.methodReferences) add("method-reference", name, path);
  }
  return kinds;
}

function grouped<K, V>(pairs: readonly (readonly [K, V])[]): Map<K, V[]> {
  const groups = new Map<K, V[]>();
  for (const [key, value] of pairs) (groups.get(key) ?? groups.set(key, []).get(key)!).push(value);
  return groups;
}

function prefixesOf(packageName: string): string[] {
  if (packageName === "") return [];
  const parts = packageName.split(".");
  return parts.map((_, end) => parts.slice(0, end + 1).join("."));
}

