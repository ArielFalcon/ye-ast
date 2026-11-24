import type { ImportedFile, ImportersValue } from "../../../core/domain/impact/importers-fact.ts";
import type { Cut, Fact } from "../../../core/domain/shared/fact.ts";

const base = { schema: "0.12.0", snapshot: { repo: "shop", kind: "sha", sha: "a".repeat(40) }, producer: { name: "ye-ast", version: "1" }, inputs: { trust: "untrusted", scope: "s", declaredScope: { languages: ["java", "typescript"], frameworks: ["angular", "spring"], include: [], exclude: [] }, content: "c", config: "k", declaredConfig: {}, engines: {} }, evidence: [] };
const place = (file: string, line: number) => ({ file, line });
const entry = (file: string, members: Partial<Omit<ImportedFile, "file" | "users">> & { users: readonly string[] }): ImportedFile => ({ file, importers: [], unresolvedNamers: [], ...members });
const factOf = (files: readonly ImportedFile[], extra: Partial<Fact<ImportersValue>> = {}): Fact<ImportersValue> => ({ ...base, status: "complete", ...extra, value: { files } }) as never;
const cut = (kind: Cut["kind"], places: readonly string[], reason: string, limit?: number): Cut => ({ kind, at: places, reason, ...(limit === undefined ? {} : { limit }), reach: { kind: "anything" } }) as never;

const longPaths = Array.from({ length: 30 }, (_, index) => `src/long/dependency/path/${String(index).padStart(2, "0")}.ts`);

export interface ImportersFixture { name: string; fact: Fact<ImportersValue> }

export const IMPORTERS_FIXTURES: readonly ImportersFixture[] = [
  {
    name: "memberships across every category",
    fact: factOf([
      entry("src/OrderService.java", {
        importers: ["src/OrderController.java", "src/Shared.java"],
        reexporters: ["src/barrel.ts"],
        dynamicImporters: ["src/Dynamic.ts"],
        typeImporters: ["src/Types.ts"],
        users: ["src/OrderController.java", "src/Shared.java", "src/Billing.java"],
        unresolvedNamers: ["src/Legacy.java", "src/Shared.java"],
        places: [place("src/OrderController.java", 30), place("src/OrderController.java", 12), place("src/OrderController.java", 12), place("src/Shared.java", 8), place("src/Billing.java", 44)],
      }),
    ]),
  },
  {
    name: "two targets sharing thirty related files without recorded lines",
    fact: factOf(["src/auth.service.ts", "src/session.service.ts"].map((file) => entry(file, { importers: longPaths, users: longPaths }))),
  },
  {
    name: "partial with cuts",
    fact: factOf([entry("src/OrderService.java", { importers: ["src/OrderController.java"], users: ["src/OrderController.java"], places: [place("src/OrderController.java", 12)] })], {
      status: "partial",
      cuts: [cut("depth", ["src/OrderService.java"], "depth", 3), cut("no-extractor", ["src/Unread.java", "src/Other.java"], "not-indexed"), cut("unresolved-link", ["src/B.java::B.save", "src/B.java:21 port.save", "src/C.java::C.save"], "unresolved-link")],
    }),
  },
  {
    name: "unknown fact",
    fact: ({ ...base, status: "unknown", reason: "unresolved", evidence: [{ path: "src/gone.ts", line: 1 }] } as never),
  },
  {
    name: "a file without related files",
    fact: factOf([entry("src/Empty.ts", { users: [] })]),
  },
];
