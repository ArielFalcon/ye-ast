import { resolve } from "node:path";

const FLAG = "--cache";

/**
 * `--cache <dir>` (or `--cache=<dir>`) taken out of a command line, once: the directory resolved against `cwd` (the
 * process's own without it) and the arguments left. `undefined` when the flag is repeated, has no value, or its value
 * is empty or another flag.
 */
export function takeCacheFlag(args: readonly string[], cwd = ""): { directory?: string; rest: string[] } | undefined {
  const rest: string[] = [];
  let directory: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const inline = arg.startsWith(`${FLAG}=`);
    if (arg !== FLAG && !inline) {
      rest.push(arg);
      continue;
    }
    const value = inline ? arg.slice(FLAG.length + 1) : args[++i];
    if (directory !== undefined || value === undefined || value.trim() === "" || (!inline && value.startsWith("-"))) return undefined;
    directory = resolve(cwd, value);
  }
  return directory === undefined ? { rest } : { directory, rest };
}
