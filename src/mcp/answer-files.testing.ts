import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson } from "../core/domain/shared/canonical-json.ts";
import type { AnswerFiles, AnswerFolder } from "../core/ports/answer-files.port.ts";
import { ANSWER_FILES_META } from "./answer-files.ts";
import { RESULT_JSON_LABEL } from "./server.ts";
import type { Session, ToolResult } from "./test-session.testing.ts";

/** Answer files that keep their folders in memory: the latest answer of a key wins, as in the file adapter. */
export function memoryAnswerFiles(): { files: AnswerFiles; folders: Map<string, AnswerFolder["files"]> } {
  const keys = new Map<string, string>();
  const folders = new Map<string, AnswerFolder["files"]>();
  const files: AnswerFiles = {
    keep: async ({ tool, inputs, files: written }) => {
      const key = canonicalJson({ tool, inputs });
      const folder = keys.get(key) ?? `/answers/${tool}/${keys.size}`;
      keys.set(key, folder);
      folders.set(folder, written);
      return folder;
    },
  };
  return { files, folders };
}

/** The reply `answer.json` stands for: its guide as the presentation and its fields as the closing result JSON line, read from the folder `result` names. */
export function fullReply(result: ToolResult, folders: ReadonlyMap<string, Pick<AnswerFolder["files"], "answer.json">>): ToolResult {
  const folder = result._meta?.[ANSWER_FILES_META];
  const written = typeof folder === "string" ? folders.get(folder) : undefined;
  if (written === undefined) throw new Error(`the reply names no answer folder: ${JSON.stringify(result.content)}`);
  const { guide, ...fields } = JSON.parse(written["answer.json"]) as { guide: string };
  return { content: [{ type: "text", text: `${guide}\n${RESULT_JSON_LABEL}${JSON.stringify(fields)}` }], _meta: result._meta ?? {} };
}

/** The same reply, read from the folder a real file writer left on disk. */
export function fullReplyFromDisk(result: ToolResult): ToolResult {
  const folder = result._meta?.[ANSWER_FILES_META];
  if (typeof folder !== "string") throw new Error(`the reply names no answer folder: ${JSON.stringify(result.content)}`);
  return fullReply(result, new Map([[folder, { "answer.json": readFileSync(join(folder, "answer.json"), "utf8") }]]));
}

/**
 * A caller that asks for `mode: "full"` here wants the full result: the call goes out as the summary of the same
 * arguments and is answered with the `answer.json` the reply's folder holds, read by `read`, as an agent reads it.
 */
export async function asFull(name: string, args: unknown, call: (name: string, args: unknown) => Promise<ToolResult>, read: (result: ToolResult) => ToolResult): Promise<ToolResult> {
  const { mode, ...rest } = args as { mode?: string };
  if (mode !== "full" || "select" in rest) return call(name, args);
  const reply = await call(name, { ...rest, mode: "summary" });
  return reply.isError === true ? reply : read(reply);
}

export function answeredFromFiles(session: Session, read: (result: ToolResult) => ToolResult): Session {
  return { ...session, callTool: (name, args) => asFull(name, args, (called, calledArgs) => session.callTool(called, calledArgs), read) };
}
