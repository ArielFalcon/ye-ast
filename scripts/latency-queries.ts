/**
 * The corpus manifest of the gate (ADR-0039) read for the latency bench and the warm differential: the repositories a
 * run names as `<group>/<repo>`, and each gate query of one repository turned into the MCP tool call that asks the
 * same question at a given snapshot.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";

const ManifestSchema = z.object({
  groups: z.array(
    z.object({
      id: z.string(),
      repos: z.array(z.object({ id: z.string(), path: z.string(), sha: z.string().regex(/^[0-9a-f]{40}$/u) })),
      queries: z.array(z.object({ id: z.string(), family: z.string(), argv: z.array(z.string()).min(1) })),
    }),
  ),
});

export interface CorpusQuery {
  id: string;
  family: string;
  argv: readonly string[];
}

export interface CorpusRepository {
  /** `<group>/<repo>`, as a run names it. */
  name: string;
  path: string;
  sha: string;
  /** The gate queries whose only repository is this one. */
  queries: readonly CorpusQuery[];
}

export class CorpusError extends Error {}

const REPO_PLACEHOLDER = /\{repo:([^}]+)\}/gu;
const REPO_ARGUMENT = /^\{repo:[^}]+\}$/u;

/** The repositories `names` selects from the manifest at `file`, in the order given. */
export function corpusRepositories(file: string, names: readonly string[]): CorpusRepository[] {
  const parsed = ManifestSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.success) throw new CorpusError(`${file}: ${z.prettifyError(parsed.error)}`);
  return names.map((name) => {
    const [groupId, repoId] = name.split("/");
    const group = parsed.data.groups.find((candidate) => candidate.id === groupId);
    const repo = group?.repos.find((candidate) => candidate.id === repoId);
    if (group === undefined || repo === undefined) throw new CorpusError(`${file}: no repository ${name}`);
    const queries = group.queries.filter((query) => {
      const named = [...query.argv.join(" ").matchAll(REPO_PLACEHOLDER)].map(([, id]) => id);
      return named.length === 1 && named[0] === repoId && !query.argv.includes("{workspace}");
    });
    return { name, path: resolve(dirname(file), repo.path), sha: repo.sha, queries };
  });
}

/** One MCP tool call: its tool name and its arguments, without the snapshot fields. */
export interface ToolCall {
  tool: string;
  family: string;
  args: Record<string, unknown>;
}

export type Snapshot = { kind: "live" } | { kind: "revision"; sha: string; base: string };

const TOOLS: Readonly<Record<string, string>> = {
  map: "ye_ast_entrypoints",
  impact: "ye_ast_impact",
  callers: "ye_ast_callers",
  importers: "ye_ast_importers",
  outline: "ye_ast_outline",
  trace: "ye_ast_trace",
  workspace: "ye_ast_workspace",
  decisions: "ye_ast_decisions",
};
const BUDGET_FLAGS = new Set(["--depth", "--hub-fan-in", "--expansions"]);

/**
 * The MCP call that asks what the CLI `argv` of a gate query asks, or the reason it cannot: a flag the MCP takes at
 * launch rather than per call (`--jdk`, `--node-modules`) or a command the MCP does not serve.
 */
export function toolCallOf(argv: readonly string[]): ToolCall | { unsupported: string } {
  const [command, ...rest] = argv;
  const tool = TOOLS[command ?? ""];
  if (tool === undefined) return { unsupported: `command ${command}` };
  const args: Record<string, unknown> = {};
  const budget: Record<string, number> = {};
  const positional: string[] = [];
  const entrypoints: { kind: string; name: string }[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]!;
    const value = rest[index + 1];
    if (BUDGET_FLAGS.has(token)) {
      budget[token === "--hub-fan-in" ? "hubFanIn" : token.slice(2)] = Number(value);
      index += 1;
    } else if (token === "--base" || token === "--head") {
      args[token.slice(2)] = value;
      index += 1;
    } else if (token === "--entrypoint") {
      const colon = (value ?? "").indexOf(":");
      entrypoints.push({ kind: (value ?? "").slice(0, colon), name: (value ?? "").slice(colon + 1) });
      index += 1;
    } else if (token === "--offline") {
      args.offline = true;
    } else if (token.startsWith("--")) {
      return { unsupported: `flag ${token}` };
    } else if (!REPO_ARGUMENT.test(token)) {
      positional.push(token);
    }
  }
  if (Object.keys(budget).length > 0) args.budget = budget;
  const family = command === "map" ? "entrypoints" : command!;
  if (family === "callers" || family === "trace") args.targets = [...entrypoints, ...positional.map(targetOf)];
  if (family === "importers" || family === "outline") args.files = positional;
  return { tool, family, args };
}

/** A `file:symbol` or `file:start-end` target, as the CLI spells it. */
function targetOf(spec: string): Record<string, unknown> {
  const colon = spec.lastIndexOf(":");
  const file = spec.slice(0, colon);
  const range = /^([1-9]\d*)-([1-9]\d*)$/u.exec(spec.slice(colon + 1));
  return range === null ? { file, symbol: spec.slice(colon + 1) } : { file, start: Number(range[1]), end: Number(range[2]) };
}

/**
 * The call asked at `snapshot`. Live reads the working tree, so `impact` compares it with `HEAD` and `offline` is
 * dropped (the schema refuses it beside `live`); at a revision `impact` compares `snapshot.base` with the sha.
 */
export function atSnapshot(call: ToolCall, snapshot: Snapshot): Record<string, unknown> {
  const { head: _head, base: _base, offline, ...args } = call.args;
  if (snapshot.kind === "live") return call.family === "impact" ? { ...args, base: "HEAD", live: true } : { ...args, live: true };
  if (call.family === "impact") return { ...args, base: snapshot.base, head: snapshot.sha };
  return { ...args, ...(offline === undefined ? {} : { offline }), revision: snapshot.sha };
}
