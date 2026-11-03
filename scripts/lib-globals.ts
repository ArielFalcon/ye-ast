/**
 * Writes the table of names the pinned `typescript` declares in its own libraries (`RFC-0016` S10). Run it when the pin
 * moves (`ADR-0007`); `src/core/adapters/typescript/typescript-lib-globals.test.ts` fails while the two disagree.
 *
 *   node --import tsx scripts/lib-globals.ts
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { libGlobalNames } from "../src/core/adapters/typescript/typescript-lib-globals.extract.ts";

const target = join(import.meta.dirname, "..", "src", "core", "adapters", "typescript", "typescript-lib-globals.ts");
const names = libGlobalNames();
const body = [
  "/**",
  " * The names the pinned `typescript` declares in its own `lib.*.d.ts`, sorted. Generated; do not edit.",
  " * Regenerate with `node --import tsx scripts/lib-globals.ts` when the pin moves (`ADR-0007`).",
  " */",
  `export const TYPESCRIPT_LIB_GLOBALS: readonly string[] = [`,
  ...names.map((name) => `  "${name}",`),
  "];",
  "",
].join("\n");
writeFileSync(target, body);
process.stdout.write(`${names.length} names in ${target}\n`);
