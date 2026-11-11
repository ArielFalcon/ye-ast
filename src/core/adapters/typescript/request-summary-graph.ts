import type { SummaryCause } from "../../domain/topology/request-summary.ts";

interface CauseWork {
  globalVisits: number;
  rowScanned: number;
  rowVisits: number;
  rowPeak: number;
  projections: number;
}

interface RequestSummaryGraph {
  isRecursive(caller: string, callee: string): boolean;
  requestReachable(seeds: ReadonlySet<string>, work?: { visits: number }): ReadonlySet<string>;
  causeIndex(own: ReadonlyMap<string, readonly SummaryCause[]>, work?: CauseWork): {
    forCaller(caller: string): (callee: string) => ReadonlySet<SummaryCause>;
  };
}

export function requestSummaryGraph(edges: ReadonlyMap<string, readonly { callee: string }[]>): RequestSummaryGraph {
  const forward = new Map<string, string[]>();
  const reverse = new Map<string, string[]>();
  const sources = new Set<string>();
  const addVertex = (key: string): void => {
    if (!forward.has(key)) forward.set(key, []);
    if (!reverse.has(key)) reverse.set(key, []);
  };
  for (const [caller, calls] of edges) {
    addVertex(caller);
    sources.add(caller);
    for (const { callee } of calls) {
      addVertex(callee);
      forward.get(caller)!.push(callee);
      reverse.get(callee)!.push(caller);
    }
  }

  const seen = new Set<string>();
  const order: string[] = [];
  for (const start of forward.keys()) {
    if (seen.has(start)) continue;
    seen.add(start);
    const stack: { key: string; next: number }[] = [{ key: start, next: 0 }];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const adjacent = forward.get(frame.key)!;
      if (frame.next === adjacent.length) {
        order.push(frame.key);
        stack.pop();
        continue;
      }
      const next = adjacent[frame.next++]!;
      if (!seen.has(next)) {
        seen.add(next);
        stack.push({ key: next, next: 0 });
      }
    }
  }

  const members = new Map<string, string[]>();
  for (let i = order.length - 1; i >= 0; i--) {
    const start = order[i]!;
    if (members.has(start)) continue;
    const component: string[] = [];
    const stack = [start];
    members.set(start, component);
    while (stack.length > 0) {
      const key = stack.pop()!;
      component.push(key);
      for (const caller of reverse.get(key)!) {
        if (!members.has(caller)) {
          members.set(caller, component);
          stack.push(caller);
        }
      }
    }
  }
  const internalReverse = new Map<string, string[]>();
  for (const [key, callers] of reverse) {
    internalReverse.set(key, callers.filter((caller) => members.get(caller) === members.get(key)));
  }
  return {
    isRecursive: (caller, callee) => members.has(caller) && members.get(caller) === members.get(callee),
    requestReachable: (seeds, work) => {
      const reachable = new Set([...seeds].filter((key) => sources.has(key)));
      const queue = [...reachable];
      for (let i = 0; i < queue.length; i++) {
        for (const caller of reverse.get(queue[i]!) ?? []) {
          if (work) work.visits++;
          if (!reachable.has(caller)) {
            reachable.add(caller);
            queue.push(caller);
          }
        }
      }
      return reachable;
    },
    causeIndex: (own, work) => {
      const global = new Map<string, Set<SummaryCause>>();
      const queue: [string, SummaryCause][] = [];
      for (const key of forward.keys()) {
        const causes = new Set(sources.has(key) ? own.get(key) : []);
        global.set(key, causes);
        for (const cause of causes) queue.push([key, cause]);
      }
      for (let i = 0; i < queue.length; i++) {
        const [key, cause] = queue[i]!;
        for (const caller of reverse.get(key)!) {
          if (work) work.globalVisits++;
          const causes = global.get(caller)!;
          if (!causes.has(cause)) {
            causes.add(cause);
            queue.push([caller, cause]);
          }
        }
      }
      const outside = new Map<string, Set<SummaryCause>>();
      for (const [key, callees] of forward) {
        const causes = new Set(sources.has(key) ? own.get(key) : []);
        for (const callee of callees) {
          if (members.get(key) !== members.get(callee)) {
            for (const cause of global.get(callee)!) causes.add(cause);
          }
        }
        outside.set(key, causes);
      }
      return {
        forCaller: (caller) => {
          const component = members.get(caller);
          const needsRow = component !== undefined && (forward.get(caller) ?? []).some((callee) => callee !== caller && members.get(callee) === component);
          const row = new Map<string, Set<SummaryCause>>();
          if (needsRow) {
            const pending: [string, SummaryCause][] = [];
            for (const key of component) {
              if (work) work.rowScanned++;
              if (key === caller) continue;
              const causes = new Set(outside.get(key));
              row.set(key, causes);
              for (const cause of causes) pending.push([key, cause]);
            }
            if (work) work.rowPeak = Math.max(work.rowPeak, row.size);
            for (let i = 0; i < pending.length; i++) {
              const [key, cause] = pending[i]!;
              for (const predecessor of internalReverse.get(key)!) {
                if (work) work.rowVisits++;
                const causes = row.get(predecessor);
                if (causes !== undefined && !causes.has(cause)) {
                  causes.add(cause);
                  pending.push([predecessor, cause]);
                }
              }
            }
          }
          return (callee) => {
            const causes = callee === caller ? undefined : component !== undefined && members.get(callee) === component ? row.get(callee) : global.get(callee);
            if (work) work.projections += causes?.size ?? 0;
            return causes ?? new Set<SummaryCause>();
          };
        },
      };
    },
  };
}
