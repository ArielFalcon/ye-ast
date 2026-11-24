import { basename } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { RepositoryBinding } from "../repository-targeting.ts";
import type { SemanticQuery } from "../query-schema.ts";

/** The key of the result's `_meta` that carries the result fields (mode, status, snapshot, recovery, an unknown reason). */
export const RESULT_META = "ye-ast/result";

/** A repository root a reply states: the repository and the clone read. */
export interface RepositoryRoot { repo: string; path: string }

/** What a reply is made of: lines that precede the family's text, that text, the roots the session did not name, and the closing line. */
export interface EnvelopeParts {
  lead: readonly string[];
  body: string;
  roots: readonly string[];
  closing: string;
}

/** The text of every successful reply: the lead, the family's text (which opens with its status and snapshot), the roots and one closing line. */
export function envelopeText({ lead, body, roots, closing }: EnvelopeParts): string {
  return [...lead, body, ...roots, closing].join("\n");
}

/** A successful reply: the text, and the result fields beside the sibling signals in `_meta`. */
export function delivered(text: string, fields: Record<string, unknown>, meta: Readonly<Record<string, unknown>> = {}): CallToolResult {
  return { content: [{ type: "text", text }], _meta: { ...meta, [RESULT_META]: fields } };
}

/** The closing line of a reply that wrote a folder: `answer.json` relative to the cache directory the instructions name (`answers/<tool>/<key>`). */
export function answerPointer(folder: string): string {
  return `answer: ${folder.split(/[\\/]/).filter((segment) => segment !== "").slice(-3).join("/")}/answer.json`;
}

/** The repositories a request names: the clones it declares, by path and by id (the root's name when it gives none). */
export function requestedRepositories(query: SemanticQuery): readonly { id: string; path: string }[] {
  const { workspace, repos } = query.arguments as { workspace?: { repos?: readonly { path: string; id?: string }[] }; repos?: readonly { path: string; id?: string }[] };
  return [...(workspace?.repos ?? repos ?? [])].map(({ path, id }) => ({ id: id ?? basename(path), path }));
}

/**
 * The root lines a reply states: one per repository neither the server instructions (every declared repository with its
 * root) nor the request named, such as a persisted workspace member.
 */
export function unnamedRootLines(roots: readonly RepositoryRoot[] | undefined, declared: readonly RepositoryBinding[], query: SemanticQuery): string[] {
  const requested = requestedRepositories(query);
  return (roots ?? [])
    .filter(({ repo, path }) => !declared.some((binding) => binding.repoId === repo && binding.path === path) && !requested.some((named) => named.id === repo || named.path === path))
    .map(({ repo, path }) => `repository root: ${repo} -> ${path}`);
}
