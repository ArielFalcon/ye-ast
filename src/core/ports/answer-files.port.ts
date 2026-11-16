import type { IndexRetentionPolicy } from "./index-cache.port.ts";

export const ANSWER_FILE_NAMES = ["answer.json", "summary.txt", "details.txt"] as const;
export type AnswerFileName = (typeof ANSWER_FILE_NAMES)[number];

/** How long an answer folder nobody wrote again may stay, and the logical bytes all of them may occupy: a budget apart from the index cache's, of the same shape. */
export type AnswerRetentionPolicy = IndexRetentionPolicy;

export interface AnswerFolder {
  /** The query family the answer belongs to. */
  tool: string;
  /** Every input that decides the bytes of `files`; the folder's key is a digest of it and the engine identity. */
  inputs: object;
  files: Readonly<Record<AnswerFileName, string>>;
}

/**
 * Delivers an answer as a folder of files an agent can query, under ye-ast's own cache directory
 * ([ADR-0110](../../../docs/architecture/adr/0110-every-mcp-answer-is-also-written-as-a-folder-of-files-an-agent-can-query.md)).
 * The files are never read back as facts.
 */
export interface AnswerFiles {
  /**
   * The folder that holds the files of `answer`, written whole: a folder of the same key with the same `answer.json` is
   * kept, one with other bytes is replaced and reported in one line. `null` when the folder could not be written, with
   * one reported line saying why. Never rejects.
   */
  keep(answer: AnswerFolder): Promise<string | null>;
}
