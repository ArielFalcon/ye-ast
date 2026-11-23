#!/usr/bin/env node
import { homedir } from "node:os";
import { composeCli } from "./compose.ts";
import { indexCacheDirectory } from "./index-cache-directory.ts";
import { watchInterrupts } from "./interrupts.ts";
import { runMcp } from "./mcp.ts";
import { trustRecordDirectory } from "./trust-record-directory.ts";
import { processHost } from "./process-host.ts";
import { runServe } from "./serve.ts";
import { daemonDirectory, processDaemonLink, runDaemon } from "./daemon.ts";

if (import.meta.main) {
  const interrupts = watchInterrupts(process);
  const indexCache = indexCacheDirectory({ env: process.env, platform: process.platform, home: homedir() });
  const trustDirectory = trustRecordDirectory({ env: process.env, platform: process.platform, home: homedir() });
  const environment = { env: process.env, platform: process.platform, uid: process.getuid?.() };
  const daemonAt = daemonDirectory(environment);
  const options = {
    signal: interrupts.signal,
    ...(daemonAt !== null && environment.uid !== undefined && { daemon: processDaemonLink(daemonAt, environment.uid) }),
    ...(indexCache !== null && { indexCache, cacheDirectory: indexCache }),
    ...(trustDirectory !== null && { trustDirectory }),
  };
  const argv = process.argv.slice(2);
  const [command, ...args] = argv;
  const measure = argv.includes("--measure") ? { measure: (line: string) => process.stderr.write(`${line}\n`) } : {};
  const err = (line: string): void => void process.stderr.write(`${line}\n`);
  const code =
    command === "daemon"
      ? await runDaemon(environment, interrupts.signal, err)
      : command === "serve"
      ? await runServe(args, processHost(options))
      : command === "mcp"
        ? await runMcp(args, processHost(options))
        : await composeCli({ ...options, ...measure, reportTrustFault: err, report: err })(argv, {
            out: (line) => process.stdout.write(`${line}\n`),
            err: (line) => process.stderr.write(`${line}\n`),
          });
  process.exitCode = interrupts.exitCode(code);
}
