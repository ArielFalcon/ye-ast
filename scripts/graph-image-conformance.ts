import { imageConformance } from "../src/core/adapters/codegraph/graph-image.testing.ts";

/**
 * Compares the graph image of each kept index named on the command line with the SDK reader over every port method,
 * file, id and name (RFC-0040 §5). Usage: node --import tsx scripts/graph-image-conformance.ts <index-entry>...
 */
const stores = process.argv.slice(2);
if (stores.length === 0) {
  process.stderr.write("usage: graph-image-conformance <index-entry>...\n");
  process.exit(2);
}
let failed = false;
for (const store of stores) {
  const started = performance.now();
  const { checks, differences } = imageConformance(store);
  process.stdout.write(`${store}: ${checks} checks, ${differences.length === 0 ? "equal" : "DIFFERENT"} (${Math.round(performance.now() - started)} ms)\n`);
  for (const difference of differences) process.stdout.write(`  ${difference}\n`);
  failed ||= differences.length > 0;
}
process.exit(failed ? 1 : 0);
