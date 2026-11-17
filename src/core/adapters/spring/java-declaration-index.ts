import type { DerivedFacts } from "../../ports/derived-facts.port.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { JavaParser } from "../tree-sitter/java-parser.adapter.ts";
import { JAVA_DECLARATIONS_SLOT, type JavaMarker, type NamingKind } from "./java-declaration-questions.ts";
import { declarationsOf, type DeclarationState, type JavaDeclarations } from "./java-declarations.ts";
import { claimedPlatformPackage } from "./java-symbols.ts";

export interface DeclarationIndexInputs {
  /** What the build states about the sources (ADR-0062). */
  generatesInterfaces: boolean;
  /** Whether the listing holds a JVM source that no extractor reads. */
  unreadJvm: boolean;
}

/**
 * The declarations every Java source of a snapshot states, answered by the ten primitive questions of RFC-0039: each
 * answer is plain, sorted data, compared as a string.
 */
export interface JavaDeclarationIndex {
  answer(question: string): string;
  /** The sources not read in full, in the order of the sources: unparsed, read for their declarations only, or with declarations that cannot be listed. */
  unread(): readonly { path: string; state: DeclarationState }[];
}

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
  const named = lazily(() => grouped(entries.flatMap(({ path, entry }) => entry.types.map((type) => [type.name, JSON.stringify([type.fqn, path])] as const))));
  const packages = lazily(() => new Set(inProject.flatMap(({ entry }) => prefixesOf(entry.header.packageName))));
  const typedPackages = lazily(() => new Set(entries.flatMap(({ entry }) => (entry.types.length > 0 ? [entry.header.packageName] : []))));
  const naming = lazily(() => {
    const kinds: Record<NamingKind, Map<string, Set<string>>> = { supertype: new Map(), "unplaced-supertype": new Map(), "method-reference": new Map(), annotation: new Map(), constant: new Map() };
    const add = (kind: NamingKind, name: string, path: string) => (kinds[kind].get(name) ?? kinds[kind].set(name, new Set()).get(name)!).add(path);
    for (const { path, entry } of entries) {
      for (const type of entry.types) {
        for (const supertype of type.supertypes) add("supertype", simpleName(supertype.name), path);
        for (const annotation of type.annotations) add("annotation", annotation, path);
        for (const constant of type.constantNames) add("constant", constant, path);
      }
      for (const name of entry.body.unplacedSupertypes) add("unplaced-supertype", name, path);
      for (const name of entry.body.methodReferences) add("method-reference", name, path);
    }
    return kinds;
  });
  const marked = lazily(() => grouped(entries.flatMap(({ path, entry }) => entry.body.markers.map((marker) => [marker, path] as const))));
  const claimed = lazily(() => list(new Set(inProject.flatMap(({ entry }) => claimedPlatformPackage(entry.header.packageName) ?? []))));
  const listing = lazily(() => fingerprint({ listing: entries.map(({ path, entry }) => [path, entry.content]).sort(([a], [b]) => (a! < b! ? -1 : a! > b! ? 1 : 0)) }));
  const unreadAnswer = lazily(() => JSON.stringify({ files: entries.filter(({ entry }) => entry.state !== "read").map(({ path, entry }) => [path, entry.state]).sort(([a], [b]) => (a! < b! ? -1 : a! > b! ? 1 : 0)), unreadJvm: inputs.unreadJvm }));

  const answers = new Map<string, string>();
  const answerOf = (question: string): string => {
    const [kind = "", ...rest] = question.split("|");
    const argument = rest.join("|");
    switch (kind) {
      case "file":
        return byPath.get(argument)?.content ?? "";
      case "declarations":
        return byPath.get(argument)?.declarationsDigest ?? "";
      case "declaring":
        return list(declaredBy().get(argument) ?? []);
      case "package": {
        const [which = "", ...name] = rest;
        return String(which === "prefix" ? packages().has(name.join("|")) : typedPackages().has(name.join("|")));
      }
      case "named":
        return `[${(named().get(argument) ?? []).toSorted().join(",")}]`;
      case "naming": {
        const [which = "", ...name] = rest;
        return list(naming()[which as NamingKind].get(name.join("|")) ?? []);
      }
      case "marked":
        return list(marked().get(argument as JavaMarker) ?? []);
      case "unread":
        return unreadAnswer();
      case "build":
        return argument === "claimed" ? claimed() : String(inputs.generatesInterfaces);
      case "listing":
        return listing();
      default:
        throw new Error(`unknown question: ${question}`);
    }
  };

  return {
    unread: () => entries.filter(({ entry }) => entry.state !== "read").map(({ path, entry }): { path: string; state: DeclarationState } => ({ path, state: entry })),
    answer: (question) => {
      let answer = answers.get(question);
      if (answer === undefined) {
        answer = answerOf(question);
        answers.set(question, answer);
      }
      return answer;
    },
  };
}

/** The index over `sources`: each file's declarations are the per-file fact `java-declarations`, derived again only for a file whose content changed (ADR-0116). */
export function javaDeclarationIndex(facts: DerivedFacts, parser: JavaParser, sources: readonly SourceFile[], inputs: DeclarationIndexInputs): JavaDeclarationIndex {
  const entries = sources.map((source) => ({ path: source.path, entry: facts.ofFile(JAVA_DECLARATIONS_SLOT, source, () => declarationsOf(parser, source, (value) => facts.fingerprint(value))) }));
  return createDeclarationIndex(entries, inputs, (value) => facts.fingerprint(value));
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

function simpleName(written: string): string {
  return written.split(".").at(-1) ?? "";
}
