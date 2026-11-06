import type { FileChange } from "../change/diff-reader.ts";
import { isJsonModuleResource, isTypeScriptSource } from "../languages/typescript.ts";
import { compareText } from "../shared/code-node.ts";
import type { Cut } from "../shared/fact.ts";
import type { ImpactBudget } from "./impact-fact.ts";
import type { ModuleDependencies, ModuleDependency, ModuleImpactValue, ModuleOrigin, ReachedModule } from "./module-dependency.ts";

type Snapshot = "base" | "head";
type RecordOfModule = { file: string; depth: number; origins: bigint; via?: ReachedModule["via"] };

/** Selected data resources have a content identity even before their first import or after their last import. */
export function moduleResources(read: ModuleDependencies, sources: readonly { path: string; content: string }[], changes: readonly FileChange[]): ModuleDependencies {
  const selected = new Set(changes.filter(({ path }) => isJsonModuleResource(path)).map(({ path }) => path));
  const accounted = new Set([...read.files.map(({ file }) => file), ...read.unread.map(({ file }) => file)]);
  const resources = sources.filter(({ path }) => selected.has(path) && !accounted.has(path));
  return resources.length === 0 ? read : { ...read, files: [...read.files, ...resources.map(({ path, content }) => ({ file: path, statements: [content], moduleOnly: true, resource: true as const }))] };
}

export function moduleImpact(changes: readonly FileChange[], base: ModuleDependencies, head: ModuleDependencies, budget: ImpactBudget = {}): { value: ModuleImpactValue; cuts: readonly Cut[]; covered: ReadonlySet<string> } {
  const baseFiles = new Map(base.files.map((file) => [file.file, file]));
  const headFiles = new Map(head.files.map((file) => [file.file, file]));
  const baseUnread = new Set(base.unread.map(({ file }) => file));
  const headUnread = new Set(head.unread.map(({ file }) => file));
  const origins: ModuleOrigin[] = [];
  for (const change of [...changes].sort((left, right) => compareText(left.path, right.path))) {
    const before = baseFiles.get(change.path);
    const after = headFiles.get(change.path);
    if (!isTypeScriptSource(change.path) && before?.resource !== true && after?.resource !== true) continue;
    if ((before === undefined && baseUnread.has(change.path)) || (after === undefined && headUnread.has(change.path))) continue;
    if (change.deleted && before !== undefined) origins.push({ file: change.path, change: "deleted" });
    else if ((before !== undefined || after !== undefined) && (before?.statements.length || after?.statements.length) && JSON.stringify(before?.statements ?? []) !== JSON.stringify(after?.statements ?? [])) {
      origins.push({ file: change.path, change: before === undefined && !baseUnread.has(change.path) ? "added" : "modified" });
    }
  }
  const originBits = origins.map((_, index) => 1n << BigInt(index));
  const cuts: Cut[] = [];
  const modules: ReachedModule[] = [];
  let expansionsUsed = 0;
  for (const [name, snapshot] of [["base", base], ["head", head]] as const) {
    for (const reference of snapshot.untraversed ?? []) {
      if (isTypeScriptSource(reference.file)) cuts.push({ kind: "unresolved-link", at: [`module:${name}:${reference.file}`, `${reference.file}:${reference.line} ${reference.form} outside module traversal (offset ${reference.offset})`] });
    }
    const adjacency = new Map<string, ModuleDependency[]>();
    for (const dependency of snapshot.dependencies) {
      if (!isTypeScriptSource(dependency.file)) continue;
      if (dependency.target.kind === "unresolved") {
        cuts.push({ kind: "unresolved-link", at: [`module:${name}:${dependency.file}`, `${dependency.file}:${dependency.line} ${dependency.specifier}`] });
      } else if (dependency.target.kind === "repository") {
        const entries = adjacency.get(dependency.target.file) ?? [];
        entries.push(dependency);
        adjacency.set(dependency.target.file, entries);
      }
    }
    for (const entries of adjacency.values()) entries.sort((left, right) => compareText(left.file, right.file) || left.line - right.line || compareText(left.specifier, right.specifier) || compareText(left.kind, right.kind) || Number(left.typeOnly) - Number(right.typeOnly));
    for (const unread of snapshot.unread.filter(({ file }) => isTypeScriptSource(file) || isJsonModuleResource(file)).sort((left, right) => compareText(left.file, right.file))) {
      cuts.push({ kind: "no-extractor", at: [`module:${name}:${unread.file}`] });
    }
    const files = new Set(snapshot.files.map(({ file }) => file));
    const records = new Map<string, RecordOfModule>();
    let frontier = new Map<string, bigint>();
    const expanded = new Map<string, Cut["kind"] | "open">();
    const stopped: { file: string; origins: bigint; kind: Cut["kind"]; limit: number; edges: ModuleDependency[] }[] = [];
    for (const [index, origin] of origins.entries()) {
      if (!files.has(origin.file)) continue;
      const bit = originBits[index]!;
      const record = records.get(origin.file) ?? { file: origin.file, depth: 0, origins: 0n };
      record.origins |= bit;
      records.set(origin.file, record);
      frontier.set(origin.file, (frontier.get(origin.file) ?? 0n) | bit);
    }
    for (let depth = 0; frontier.size > 0; depth++) {
      const next = new Map<string, bigint>();
      for (const [file, propagated] of [...frontier].sort(([left], [right]) => compareText(left, right))) {
        const edges = adjacency.get(file) ?? [];
        if (budget.depth !== undefined && depth >= budget.depth) {
          stopped.push({ file, origins: propagated, kind: "depth", limit: budget.depth, edges });
          continue;
        }
        let decision = expanded.get(file);
        if (decision === undefined) {
          if (budget.hubFanIn !== undefined && new Set(edges.map(({ file }) => file)).size > budget.hubFanIn) decision = "hub";
          else if (budget.expansions !== undefined && expansionsUsed >= budget.expansions) decision = "caller-budget";
          else { decision = "open"; expansionsUsed++; }
          expanded.set(file, decision);
        }
        if (decision !== "open") {
          stopped.push({ file, origins: propagated, kind: decision, limit: decision === "hub" ? budget.hubFanIn! : budget.expansions!, edges });
          continue;
        }
        for (const edge of edges) {
          let record = records.get(edge.file);
          const fresh = propagated & ~(record?.origins ?? 0n);
          if (fresh === 0n) continue;
          if (record === undefined) {
            record = { file: edge.file, depth: depth + 1, origins: 0n, via: { file, line: edge.line, specifier: edge.specifier, kind: edge.kind, typeOnly: edge.typeOnly, ...(edge.form === undefined || edge.form === "import-equals" ? {} : { form: edge.form }) } };
            records.set(edge.file, record);
          }
          record.origins |= fresh;
          next.set(edge.file, (next.get(edge.file) ?? 0n) | fresh);
        }
      }
      frontier = next;
    }
    const emitted = new Set<string>();
    for (const stop of stopped) {
      const key = `${stop.kind}\0${stop.file}`;
      if (!emitted.has(key) && stop.edges.some(({ file }) => (stop.origins & ~(records.get(file)?.origins ?? 0n)) !== 0n)) {
        cuts.push({ kind: stop.kind, at: [`module:${name}:${stop.file}`], limit: stop.limit });
        emitted.add(key);
      }
    }
    modules.push(...[...records.values()].sort((left, right) => left.depth - right.depth || compareText(left.file, right.file)).map((record): ReachedModule => ({ file: record.file, snapshot: name as Snapshot, depth: record.depth, origins: originBits.flatMap((bit, index) => (record.origins & bit) === 0n ? [] : [index]), ...(record.via === undefined ? {} : { via: record.via }) })));
  }
  const covered = new Set<string>();
  for (const origin of origins) {
    const before = baseFiles.get(origin.file);
    const after = headFiles.get(origin.file);
    if (!baseUnread.has(origin.file) && !headUnread.has(origin.file) && (before === undefined || before.moduleOnly) && (after === undefined || after.moduleOnly) && (origin.change === "added" || before !== undefined) && (origin.change === "deleted" || after !== undefined)) covered.add(origin.file);
  }
  return { value: { origins, modules, cost: { expansionsUsed } }, cuts, covered };
}
