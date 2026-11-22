import type { DerivedFacts } from "../../ports/derived-facts.port.ts";
import type { SourceFile } from "../../ports/entrypoint-extractor.port.ts";
import type { ParseHold } from "../../ports/parse-holds.port.ts";
import type { JavaParser } from "../tree-sitter/java-parser.adapter.ts";
import { javaDeclarationIndex, type DeclarationIndexInputs, type JavaDeclarationIndex } from "./java-declaration-index.ts";
import { questions } from "./java-declaration-questions.ts";
import { heldJavaProject, ReleasedParseHoldError, type HeldJavaProject } from "./java-project.ts";
import type { JavaFile, JavaProject, ProjectBuild } from "./java-symbols.ts";

/** What a reader needs to keep its answers by the questions they asked of the declaration index (RFC-0039). */
export interface KeptReads {
  facts: DerivedFacts;
  hold: ParseHold;
  index(): Promise<JavaDeclarationIndex>;
}

/** The reads of a snapshot's Java sources, kept by the questions their derivations ask of one declaration index built when first asked. */
export function keptReads(facts: DerivedFacts, hold: ParseHold, parser: () => Promise<JavaParser>, sources: readonly SourceFile[], inputs: DeclarationIndexInputs): KeptReads {
  let indexed: Promise<JavaDeclarationIndex> | undefined;
  return { facts, hold, index: () => (indexed ??= parser().then((read) => javaDeclarationIndex(facts, read, hold.keep(sources), inputs))) };
}

/** The project a derivation reads and the files by path that project holds, with the question-asking function that records its reads. */
interface FileReading {
  project: JavaProject;
  /** A file read by path records the question of its content, whether the sources hold it or not. */
  files: { get(path: string): JavaFile | undefined };
  asked(question: string): string;
}

/** The project over the read's sources, or over them and the declarations of the sources that do not parse (`declarations`). */
export type ReadOver = "sources" | "declarations";

const filesOfHeld = new WeakMap<HeldJavaProject, Record<ReadOver, ReadonlyMap<string, JavaFile>>>();

/** The project a read holds over `sources` for `over`, with its files by path. */
export async function heldProject(hold: ParseHold, parser: () => Promise<JavaParser>, sources: readonly SourceFile[], build: ProjectBuild, over: ReadOver = "sources"): Promise<{ project: JavaProject; files: ReadonlyMap<string, JavaFile> }> {
  const held = await heldJavaProject(hold, parser, sources, [], build);
  let files = filesOfHeld.get(held);
  if (files === undefined) {
    files = { sources: new Map(held.files.map(({ file }) => [file.path, file])), declarations: new Map([...held.files.map(({ file }) => file), ...held.declared].map((file) => [file.path, file])) };
    filesOfHeld.set(held, files);
  }
  return { project: over === "sources" ? held.project : held.declarations, files: files[over] };
}

/** The held project of one query, built on first use; every use checks the hold is still open, so a released hold is never read. */
export function heldProjectOnce(hold: ParseHold, parser: () => Promise<JavaParser>, sources: readonly SourceFile[], build: ProjectBuild, over: ReadOver = "sources"): () => ReturnType<typeof heldProject> {
  let project: ReturnType<typeof heldProject> | undefined;
  return () => (hold.open() ? (project ??= heldProject(hold, parser, sources, build, over)) : Promise.reject(new ReleasedParseHoldError()));
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * One answer per site, derived per file of sites and kept by the questions each derivation asked (ADR-0119): the sites of
 * a file are reduced to their distinct places, in order, and `derive` answers them in one reading of the file's project.
 * A site in a file the sources do not hold answers `unknown` and keeps nothing.
 */
export async function keptByFile<S extends { file: string }, A>(
  kept: KeptReads,
  reading: { slot: string; parser: () => Promise<JavaParser>; sources: readonly SourceFile[]; build: ProjectBuild; over: ReadOver },
  sites: readonly S[],
  placeOf: (site: S) => string,
  unknown: A,
  derive: (reading: FileReading, places: readonly S[]) => readonly A[],
): Promise<readonly A[]> {
  if (sites.length === 0) return [];
  const index = await kept.index();
  const results: A[] = sites.map(() => unknown);
  const projectOf = heldProjectOnce(kept.hold, reading.parser, reading.sources, reading.build, reading.over);
  for (const [path, entries] of Map.groupBy(sites.entries(), ([, site]) => site.file)) {
    const content = index.answer(questions.file(path));
    if (content === "") continue;
    const places = [...new Map(entries.map(([, site]) => [placeOf(site), site])).entries()].sort(([a], [b]) => byText(a, b));
    const subject = { path, content, places: places.map(([place]) => place), generatesInterfaces: reading.build.generatesInterfaces === true };
    const answers = await kept.facts.ofReads(reading.slot, subject, index.answerIfKnown, async (record) => {
      const { project: over, files } = await projectOf();
      const asked = (question: string): string => {
        const answer = index.answer(question);
        record(question, answer);
        return answer;
      };
      const recorded = { get: (at: string) => (asked(questions.file(at)), files.get(at)) };
      return over.reading((question) => void asked(question), () => derive({ project: over, files: recorded, asked }, places.map(([, site]) => site)));
    });
    const at = new Map(places.map(([place], position) => [place, position]));
    for (const [position, site] of entries) results[position] = answers[at.get(placeOf(site))!]!;
  }
  return results;
}

/**
 * One answer per file of `paths`, each derived over its file alone and kept by the questions it asked (ADR-0119), asked
 * in order until `stops` holds of an answer: the first such answer, or `undefined` when none stops. A file the sources do
 * not hold is skipped. Every derivation that misses shares one held project.
 */
export async function keptFirstByFile<A>(
  kept: KeptReads,
  reading: { slot: string; parser: () => Promise<JavaParser>; sources: readonly SourceFile[]; build: ProjectBuild; over: ReadOver },
  paths: readonly string[],
  stops: (answer: A) => boolean,
  derive: (reading: FileReading, path: string) => A,
): Promise<A | undefined> {
  const index = await kept.index();
  const projectOf = heldProjectOnce(kept.hold, reading.parser, reading.sources, reading.build, reading.over);
  for (const path of paths) {
    const content = index.answer(questions.file(path));
    if (content === "") continue;
    const subject = { path, content, generatesInterfaces: reading.build.generatesInterfaces === true };
    const answer = await kept.facts.ofReads<A>(reading.slot, subject, index.answerIfKnown, async (record) => {
      const { project: over, files } = await projectOf();
      const asked = (question: string): string => {
        const answer = index.answer(question);
        record(question, answer);
        return answer;
      };
      const recorded = { get: (at: string) => (asked(questions.file(at)), files.get(at)) };
      return over.reading((question) => void asked(question), () => derive({ project: over, files: recorded, asked }, path));
    });
    if (stops(answer)) return answer;
  }
  return undefined;
}
