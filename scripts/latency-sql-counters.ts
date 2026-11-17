/**
 * Preloaded into the MCP server by `latency-session.ts` (`--import`): counts the `node:sqlite` statements the process
 * prepares and runs, and the rows they return, and writes one `{"ye_ast_bench":{"event":"sql",...}}` line just before
 * each query line, with the counts since the previous one. The engine's code is untouched; the codegraph SDK reads its
 * store through `node:sqlite` (RFC-0040 §2, M1).
 */
import { DatabaseSync, StatementSync } from "node:sqlite";

const counts = { prepare: 0, all: 0, get: 0, iterate: 0, run: 0, rows: 0 };

/** Replaces `method` of `prototype` with one that counts its calls, and the rows each returns, before answering as before. */
function counted(prototype: object, method: keyof typeof counts, rowsOf: (result: unknown) => number): void {
  const original = (prototype as Record<string, (...args: unknown[]) => unknown>)[method]!;
  Object.defineProperty(prototype, method, {
    configurable: true,
    writable: true,
    value: function (this: unknown, ...args: unknown[]) {
      counts[method] += 1;
      const result = original.apply(this, args);
      counts.rows += rowsOf(result);
      return result;
    },
  });
}

const none = () => 0;
counted(DatabaseSync.prototype, "prepare", none);
counted(StatementSync.prototype, "all", (rows) => (rows as unknown[]).length);
counted(StatementSync.prototype, "get", (row) => (row === undefined ? 0 : 1));
counted(StatementSync.prototype, "iterate", none);
counted(StatementSync.prototype, "run", none);

const write = process.stderr.write.bind(process.stderr) as (chunk: unknown, ...rest: unknown[]) => boolean;
process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
  if (typeof chunk === "string" && chunk.startsWith('{"ye_ast":{"event":"query"')) {
    write(`${JSON.stringify({ ye_ast_bench: { event: "sql", ...counts } })}\n`);
    for (const key of Object.keys(counts) as (keyof typeof counts)[]) counts[key] = 0;
  }
  return write(chunk, ...rest);
}) as typeof process.stderr.write;
