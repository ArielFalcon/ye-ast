import { compareText } from "../core/domain/shared/code-node.ts";
import type { Finding } from "../core/domain/shared/fact.ts";
import type { ImportOrigins } from "../core/ports/import-origins.port.ts";

/**
 * One reader of the origins of names over readers that each answer only the files of their language: per site, the
 * first complete answer (the first binding that is not `unknown`) in the order given, otherwise the first reader's
 * answer; the roots a repository replaces are every reader's.
 */
export function importOriginsByLanguage(readers: readonly ImportOrigins[]): ImportOrigins {
  return {
    origins: async (sites, signal) => firstComplete(await Promise.all(readers.map((reader) => reader.origins(sites, signal)))),
    rootOrigins: async (sites, signal) => firstComplete(await Promise.all(readers.map((reader) => reader.rootOrigins(sites, signal)))),
    rootBindings: async (sites, signal) => {
      const answers = await Promise.all(readers.map((reader) => reader.rootBindings(sites, signal)));
      return sites.map((_, index) => answers.find((answer) => answer[index]?.kind !== "unknown")?.[index] ?? { kind: "unknown" });
    },
    replacedRoots: async (signal) => {
      const replaced = await Promise.all(readers.map((reader) => reader.replacedRoots(signal)));
      return { paths: replaced.flatMap(({ paths }) => paths).toSorted((a, b) => compareText(a.join("\u0000"), b.join("\u0000"))), globalObjects: new Set(replaced.flatMap(({ globalObjects }) => [...globalObjects])), packages: new Set(replaced.flatMap(({ packages }) => [...packages])) };
    },
  };
}

function firstComplete<F extends Finding<unknown>>(answers: readonly (readonly F[])[]): F[] {
  return (answers[0] ?? []).map((first, index) => answers.find((answer) => answer[index]?.status === "complete")?.[index] ?? first);
}
