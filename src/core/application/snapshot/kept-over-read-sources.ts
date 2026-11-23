import type { DerivedFacts, RecordedAnswers } from "../../ports/derived-facts.port.ts";
import type { SourceFile } from "../../ports/source-file.port.ts";

/**
 * What a stage over a whole source list derives, kept by the contents it read (ADR-0153). The paths of the list, in
 * order, and `inputs` name the subject; each content the stage reads is a recorded question answered by the file's
 * identity: its blob id, else its content's fingerprint. An edit of a file the stage never read reuses the kept value;
 * an edit of one it read, or an added, deleted or renamed path, derives it again. Without `facts` nothing is kept.
 */
export function keptOverReadSources<T>(facts: DerivedFacts | undefined, slot: string, files: readonly SourceFile[], inputs: object, derive: (files: readonly SourceFile[]) => Promise<T>): Promise<T> {
  if (facts === undefined) return derive(files);
  const identities = new Map(files.map((file) => [file.path, file.blob ?? facts.fingerprint({ content: file.content })]));
  const answers: RecordedAnswers = {
    fingerprint: facts.fingerprint(files.map(({ path }) => [path, identities.get(path)])),
    answerIfKnown: (path) => identities.get(path),
  };
  const subject = { inputs, listing: facts.fingerprint(files.map(({ path }) => path)) };
  return facts.ofReads(slot, subject, answers, (record) => {
    const read = new Set<string>();
    const recordOnce = (path: string): void => {
      if (read.has(path)) return;
      read.add(path);
      record(path, identities.get(path)!);
    };
    return derive(files.map((file) => recording(file, recordOnce)));
  });
}

/** A copy of `file` that reports its path the first time anything reads its content. */
function recording(file: SourceFile, onRead: (path: string) => void): SourceFile {
  return {
    path: file.path,
    ...(file.blob === undefined ? {} : { blob: file.blob }),
    get content() {
      onRead(file.path);
      return file.content;
    },
  };
}
