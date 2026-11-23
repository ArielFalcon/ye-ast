import { strict as assert } from "node:assert";
import { afterEach, beforeEach, test } from "node:test";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { Parser, type Tree } from "web-tree-sitter";
import { createSnapshotDataCache, HELD_READS } from "../core/application/snapshot/snapshot-data-cache.ts";
import { createJavaParser, createJavaTreeHolds } from "../core/adapters/tree-sitter/java-parser.adapter.ts";
import type { SourceFile } from "../core/ports/source-file.port.ts";

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;
const settled = (): NodeJS.MemoryUsage => {
  for (let pass = 0; pass < 4; pass++) gc();
  return process.memoryUsage();
};

/** The native trees not freed yet. */
const alive = new Set<Tree>();
const parse = Parser.prototype.parse;

beforeEach(() => {
  alive.clear();
  Parser.prototype.parse = function (this: Parser, ...args: Parameters<Parser["parse"]>) {
    const tree = parse.apply(this, args);
    if (tree !== null) {
      alive.add(tree);
      const free = tree.delete.bind(tree);
      tree.delete = () => {
        alive.delete(tree);
        free();
      };
    }
    return tree;
  };
});

afterEach(() => {
  Parser.prototype.parse = parse;
});

/**
 * The RSS slope over the last 100 of 200 edits a sound residence stays under: measured 14.0-16.0 KB per edit (three runs,
 * Apple M1 Max), against 185 KB per edit when no resident tree is ever let go (one leaked tree per edit).
 */
const RSS_SLOPE_TOLERANCE_BYTES = 64 * 1024;

/** The least-squares slope of samples taken every `step` edits, in bytes per edit. */
function bytesPerEdit(samples: readonly number[], step: number): number {
  const mean = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const xs = samples.map((_, at) => at * step);
  const [mx, my] = [mean(xs), mean(samples)];
  return xs.reduce((sum, x, at) => sum + (x - mx) * (samples[at]! - my), 0) / xs.reduce((sum, x) => sum + (x - mx) ** 2, 0);
}

const path = (at: number) => `src/main/java/com/example/area${at % 7}/Service${at}.java`;

/** A Spring service of the size and shape the corpus's Java backends hold; `revision` changes one statement. */
function service(at: number, revision = 0): SourceFile {
  const methods = Array.from({ length: 12 }, (_, index) => [
    `  /** Finds the ${index}th order of the customer, or none. */`,
    `  @Transactional(readOnly = true)`,
    `  public Optional<OrderDto> find${index}(Long customerId, String code) {`,
    `    if (customerId == null || code.isBlank()) {`,
    `      throw new IllegalArgumentException("customer " + customerId + " code " + code);`,
    `    }`,
    `    List<Order> orders = repository.findByCustomerIdAndCode(customerId, code.trim());`,
    `    return orders.stream().filter(order -> order.getTotal() > ${index + revision}).map(mapper::toDto).findFirst();`,
    `  }`,
  ].join("\n"));
  const content = [
    `package com.example.area${at % 7};`,
    "",
    "import java.util.List;",
    "import java.util.Optional;",
    "import org.springframework.stereotype.Service;",
    "import org.springframework.transaction.annotation.Transactional;",
    "",
    "@Service",
    `public class Service${at} {`,
    "  private final OrderRepository repository;",
    "  private final OrderMapper mapper;",
    "",
    `  public Service${at}(OrderRepository repository, OrderMapper mapper) {`,
    "    this.repository = repository;",
    "    this.mapper = mapper;",
    "  }",
    "",
    ...methods,
    "}",
    "",
  ].join("\n");
  return { path: path(at), content };
}

test("a resident tree's charge is a ceiling on the memory its tree takes, native and JavaScript", async () => {
  const holds = createJavaTreeHolds();
  const parser = await createJavaParser(holds);
  const charges: number[] = [];
  const residence = { reside: (_key: string, bytes: number) => (charges.push(bytes), true) };
  const generation = (offset: number) => {
    const hold = holds.open();
    for (const source of hold.keep(Array.from({ length: 400 }, (_, at) => service(at + offset)), residence)) assert.ok(parser.parse(source).ok);
    hold.release();
  };
  generation(0);
  charges.length = 0;

  const before = settled();
  generation(400);
  const after = settled();

  const taken = after.rss - before.rss + Math.max(0, after.heapUsed - before.heapUsed);
  const charged = charges.reduce((sum, bytes) => sum + bytes, 0);
  assert.equal(alive.size, 800);
  assert.ok(taken <= charged, `${taken} bytes taken against a charge of ${charged}`);
});

test("200 edits of one file keep the resident trees and the memory flat: only the latest contents' versions of the edited file stay beside the unchanged ones", async () => {
  const files = 40;
  const holds = createJavaTreeHolds();
  const parser = await createJavaParser(holds);
  const cache = createSnapshotDataCache("working-set");
  const rss: number[] = [];
  for (let edit = 0; edit < 200; edit++) {
    const reading = cache.beginRead({ repository: "/repo", snapshot: "live", key: `content-${edit}` });
    const hold = holds.open();
    const sources = Array.from({ length: files }, (_, at) => service(at, at === 0 ? edit : 0));
    for (const source of hold.keep(sources, reading)) assert.ok(parser.parse(source).ok);
    hold.release();
    assert.ok(alive.size <= files + 1 + HELD_READS, `edit ${edit}: ${alive.size} trees alive`);
    if (edit % 10 === 9) rss.push(settled().rss);
  }

  const slope = bytesPerEdit(rss.slice(rss.length / 2), 10);
  assert.ok(slope <= RSS_SLOPE_TOLERANCE_BYTES, `RSS rose ${Math.round(slope)} bytes per edit over the last 100 edits`);
});
