import { isReadSource } from "../../domain/languages/profiles.ts";
import { liveScope } from "../../domain/snapshot/live-export.ts";
import { pathSelection } from "../../domain/shared/scope.ts";
import type { CodeGraphReader } from "../../ports/code-graph.port.ts";
import { createBaseReadings, type BaseReading } from "../snapshot/base-reading.ts";
import { createHeadReader, preparedLive, withLiveCapture } from "../snapshot/head-reading.ts";
import type { CommitExtraction, PreparedCommit } from "../snapshot/read-snapshot.ts";
import { effectSites, type TraceQueriesDeps } from "../trace/trace-queries.ts";

/** When priming lets the queries of its process run first. */
export interface PrimingTurns {
  /** Whether a query of the process is in flight: priming then ends its capture after the step it runs. */
  queryWaiting(): boolean;
  /** Settles once no query of the process is in flight, or once `signal` is aborted. */
  queriesDone(signal?: AbortSignal): Promise<void>;
}

export interface PrimingRequest {
  repo: string;
  /** The id the queries name the repository by, which the keys of its call sites carry. */
  repoId: string;
  signal?: AbortSignal | undefined;
}

/** How priming ended, and how many times it waited for the queries of its process. */
export interface PrimingOutcome {
  kind: "primed" | "aborted" | "unavailable";
  yields: number;
}

/** What one live capture holds for the priming steps run inside it. */
interface PrimingRead {
  prepared: PreparedCommit;
  tree: Pick<CommitExtraction, "export" | "sources">;
  /** The base reading over the capture's index, opened on first use; `undefined` when the index cannot be opened. */
  reading(): Promise<BaseReading | undefined>;
}

/** One priming step: `false` when what it needs cannot be read, which ends priming. */
type Step = (read: PrimingRead) => Promise<boolean>;

/**
 * Derives, ahead of any query, the snapshot facts of the live tree that no target narrows: the sources and the
 * entrypoints, the completed hierarchy and the relations, every language's module statements, each file's syntax and
 * declarations, and the call sites and data effects. Each is kept where the query that needs it looks it up, under the
 * same key, so that query finds it instead of deriving it.
 *
 * Priming pins a capture of the mirror as a query does, under its lock, and runs its steps outside the lock on the pinned
 * capture (ADR-0144). Before each step it ends the capture when a query of its process is in flight, and pins a new one
 * once those queries are done, so it primes the state they left and a query shares the process with at most the step
 * that runs. It asks for the queries again right before it takes the lock and once it holds it, so a query that arrived
 * meanwhile finds neither the lock nor a refresh ahead of its own. A value the signal cut is never kept: the derivations
 * a step calls admit nothing an abort cut.
 */
export async function primeLive(deps: TraceQueriesDeps, request: PrimingRequest, turns: PrimingTurns): Promise<PrimingOutcome> {
  const { signal } = request;
  const headReader = createHeadReader(deps);
  const readings = createBaseReadings({ ...deps, modules: deps.moduleReader });
  const scope = liveScope();
  const selected = pathSelection(scope, deps.matcher.matches);
  const signalled = signal === undefined ? {} : { signal };
  let done = 0;
  let yields = 0;
  for (;;) {
    if (turns.queryWaiting()) {
      yields += 1;
      await turns.queriesDone(signal);
    }
    if (signal?.aborted) return { kind: "aborted", yields };
    let declined = false;
    const captured = await withLiveCapture<"finished" | "yielded" | "unreadable", never>(deps, { repo: request.repo, repoId: request.repoId, live: true, ...signalled }, {
      declined: () => {
        declined = turns.queryWaiting();
        return declined;
      },
      unavailable: async () => ({ ok: true, value: declined ? "yielded" : "unreadable" }),
      use: async (held) => {
        const prepared = preparedLive(held);
        const loaded = await prepared.sources(signal);
        if (!loaded.ok) return { ok: true, value: "unreadable" };
        const tree = loaded.value;
        let store: CodeGraphReader | undefined;
        let opened: Promise<BaseReading | undefined> | undefined;
        const open = async (): Promise<BaseReading | undefined> => {
          const index = await headReader.liveReading(held.tree, tree, "trusted", scope, selected, held.head, request.repoId, { declaredConfig: {}, engines: {} }).open();
          if (typeof index === "string" || "fault" in index) return undefined;
          store = index.store;
          return readings.open(
            { tree, prepared, hold: held.hold, store: index.store, snapshot: { repo: request.repoId, kind: "live", head: held.head, stateId: held.tree.stateId }, request: { repo: request.repo, ...signalled } },
            { originPaths: tree.export.files.map(({ path }) => path).filter(selected), inScope: selected },
          );
        };
        const read: PrimingRead = { prepared, tree, reading: () => (opened ??= open()) };
        const steps = primingSteps(deps, read, request);
        try {
          while (done < steps.length) {
            if (signal?.aborted) return { ok: true, value: "unreadable" };
            if (turns.queryWaiting()) return { ok: true, value: "yielded" };
            if (!(await steps[done]!(read))) return { ok: true, value: "unreadable" };
            done += 1;
          }
          return { ok: true, value: "finished" };
        } finally {
          store?.close();
        }
      },
    });
    if (signal?.aborted) return { kind: "aborted", yields };
    if (!captured.ok || captured.value === "unreadable") return { kind: "unavailable", yields };
    if (captured.value === "finished") return { kind: "primed", yields };
  }
}

/** The steps over one capture's sources, in the order a first query is most likely to need them. */
function primingSteps(deps: TraceQueriesDeps, read: PrimingRead, request: PrimingRequest): Step[] {
  const { signal } = request;
  const { prepared, tree } = read;
  const withReading = (use: (reading: BaseReading) => Promise<unknown>): Step => async () => {
    const reading = await read.reading();
    if (reading === undefined) return false;
    await use(reading);
    return true;
  };
  const files = tree.sources.map(({ path }) => path).filter(isReadSource);
  return [
    async () => (await prepared.extract(signal)).ok,
    withReading((reading) => reading.relations()),
    async () => {
      if (deps.moduleReader !== undefined && prepared.facts !== undefined) await deps.moduleReader.extract(tree.sources, { facts: prepared.facts });
      return true;
    },
    ...files.map((file) => withReading(async (reading) => {
      await reading.syntaxOf?.(file);
      await reading.declarations.list(file);
    })),
    withReading(async (reading) => {
      const typed = await reading.typed();
      if (typed === "aborted") return;
      const sites = effectSites(deps, { tree, prepared }, { repoId: request.repoId }, typed);
      await sites.callSites();
      await sites.dataSites();
    }),
  ];
}
