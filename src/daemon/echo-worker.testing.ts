import { echoServe } from "./daemon.testing.ts";
import { runWorkerHost } from "./worker-host.ts";

/** A forked worker that answers with the echo server: the process boundary of the worker tests. */
await runWorkerHost({ channel: process, pid: process.pid, idleMs: 60_000, start: (repo, configuration) => echoServe(repo, configuration, process.pid) });
process.exit(0);
