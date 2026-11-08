import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { composeCli } from "./compose.ts";
import { CONTROLLER, CONTROLLER_PATH, GATEWAYS, GIT_ENV, PAGE_PATH, SERVICE_PATH, SHOP, WEB, createCompositionFixture, type CompositionFixture } from "./mcp-evidence-fixture.testing.ts";
import { createMcpServer, type McpDeps } from "../mcp/server.ts";
import { openSession, resultFields, type Session, type ToolResult } from "../mcp/test-session.testing.ts";
import { createEvidenceComposition } from "../core/application/composition/evidence-composition.ts";
import { createSha256Digest } from "../core/adapters/crypto/sha256-digest.adapter.ts";
import { composeOutput } from "../mcp/composition-schema.ts";
import type { ComposeQuery } from "../mcp/query-schema.ts";
import type { ComposeFull, ComposeReceipt, RepeatRequest } from "../mcp/composition-contract.ts";
import type { AnchorId, CompositionGraph, EntityId, FileId, PartKind, PartOf } from "../core/ports/evidence-composition.port.ts";

const COMPOSE_OUTPUT = composeOutput(createEvidenceComposition(createSha256Digest()));

const everyDeclaration = (declarations: readonly any[]): any[] => declarations.flatMap((item) => [item, ...everyDeclaration(item.children ?? [])]);

const OPERATIONS = ["ye_ast_callers", "ye_ast_compose", "ye_ast_contract_consequences", "ye_ast_decisions", "ye_ast_entrypoints", "ye_ast_importers", "ye_ast_impact", "ye_ast_outline", "ye_ast_trace", "ye_ast_workspace"].sort();
const FAULT = "ye-ast/fault";

type Fault = { kind: string; stage?: string; queryKey?: string; family?: string; cause?: { kind: string; stage?: string } };
type Call = (name: string, args: unknown) => Promise<ToolResult>;

// Readers of the wire graph: every lookup resolves a reference the graph carries, so a dangling one fails the test.

function composed(result: ToolResult): ComposeFull {
  assert.notEqual(result.isError, true, JSON.stringify(result).slice(0, 2000));
  const { text: _text, ...value } = resultFields(result) as ComposeFull & { text: string };
  assert.equal(value.kind, "composition");
  assert.equal(COMPOSE_OUTPUT.safeParse(value).success, true);
  return value;
}
function faultOf(result: ToolResult): Fault {
  assert.equal(result.isError, true, JSON.stringify(result).slice(0, 2000));
  assert.equal(result.structuredContent, undefined);
  assert.ok(result.content[0]?.text);
  return result._meta?.[FAULT] as Fault;
}
const parts = <K extends PartKind>(graph: CompositionGraph, kind: K): PartOf<K>[] => graph.parts.filter((part): part is PartOf<K> => part.kind === kind);
const one = <T>(items: readonly T[], what: string): T => {
  assert.equal(items.length, 1, `${what}: ${JSON.stringify(items).slice(0, 1500)}`);
  return items[0]!;
};
function anchor(graph: CompositionGraph, id: AnchorId) {
  const found = graph.anchors.find((item) => item.id === id);
  assert.ok(found, id);
  return found;
}
function file(graph: CompositionGraph, id: FileId) {
  const found = graph.files.find((item) => item.id === id);
  assert.ok(found, id);
  return found;
}
/** The full SnapshotRef of a file with a snapshot origin; a query-context path has none. */
function snapshotOf(graph: CompositionGraph, id: FileId) {
  const record = file(graph, id);
  assert.equal(record.origin.kind, "snapshot");
  const snapshot = graph.snapshots.find((item) => record.origin.kind === "snapshot" && item.id === record.origin.snapshot);
  assert.ok(snapshot);
  return snapshot.value;
}
/** Where an anchor points: repository, snapshot SHA, path and declarative span. */
function located(graph: CompositionGraph, id: AnchorId) {
  const { file: fileId, symbol, line, endLine } = anchor(graph, id);
  const record = file(graph, fileId);
  const snapshot = snapshotOf(graph, fileId);
  return { repo: record.repo, sha: snapshot.kind === "sha" ? snapshot.sha : snapshot.head, path: record.path, symbol, line, endLine };
}
function entity(graph: CompositionGraph, id: EntityId) {
  const found = graph.entities.find((item) => item.id === id);
  assert.ok(found, id);
  return found;
}
const relations = <K extends CompositionGraph["relations"][number]["value"]["kind"]>(graph: CompositionGraph, kind: K) =>
  graph.relations.filter((relation) => relation.value.kind === kind).map((relation) => ({ ...relation, value: relation.value as Extract<typeof relation.value, { kind: K }> }));
const available = (requests: readonly RepeatRequest[]): ComposeQuery[] =>
  requests.map((request) => {
    assert.equal(request.status, "available", JSON.stringify(request));
    return (request as Extract<RepeatRequest, { status: "available" }>).query;
  });
/** A fact as the CLI prints it: the structured content of an original tool without presentation metadata. */
function originalFact(result: ToolResult): Record<string, any> {
  assert.notEqual(result.isError, true, JSON.stringify(result).slice(0, 2000));
  const { text: _text, mode, recovery, repositoryRoots, ...fact } = resultFields(result);
  return { ...fact, recovery };
}

// A real stdio server, launched as `ye-ast mcp` is, from the launch repository with `web` declared.

const SERVER = pathToFileURL(join(import.meta.dirname, "mcp.ts")).href;
const HOST = pathToFileURL(join(import.meta.dirname, "process-host.ts")).href;
const MAIN = `import { runMcp } from ${JSON.stringify(SERVER)};
import { processHost } from ${JSON.stringify(HOST)};
process.exitCode = await runMcp([".", "--repo", ${JSON.stringify(WEB)}, process.env.WEB_ROOT!], processHost({ signal: new AbortController().signal, trustDirectory: process.env.TRUST_ROOT!, indexCache: process.env.INDEX_ROOT! }));
`;

type Stdio = { call: Call; start(name: string, args: unknown): { id: number; reply: Promise<{ result?: ToolResult }> }; request(method: string, params?: unknown): Promise<{ result?: any }>; send(message: object): void; scratch: string; close(): Promise<number | null> };

async function startStdio(fixture: CompositionFixture): Promise<Stdio> {
  const home = join(fixture.root, "stdio");
  const scratch = join(home, "scratch");
  mkdirSync(scratch, { recursive: true });
  const entry = join(home, "main.mts");
  writeFileSync(entry, MAIN);
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), entry], {
    cwd: fixture.shop.root,
    env: { ...GIT_ENV, XDG_CACHE_HOME: join(home, "cache"), TMPDIR: scratch, WEB_ROOT: fixture.web.root, TRUST_ROOT: fixture.trustDirectory, INDEX_ROOT: join(home, "index") },
  });
  child.stderr.pipe(process.stderr);
  const replies = new Map<number, (message: { result?: any }) => void>();
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line) as { id?: number; result?: unknown };
    if (message.id !== undefined) replies.get(message.id)?.(message);
  });
  let id = 0;
  const send = (message: object) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const start = (method: string, params?: unknown) => {
    id += 1;
    const current = id;
    const reply = new Promise<{ result?: any }>((resolve) => replies.set(current, resolve));
    send({ id: current, method, ...(params !== undefined && { params }) });
    return { id: current, reply };
  };
  const request = (method: string, params?: unknown) => start(method, params).reply;
  await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } });
  send({ method: "notifications/initialized" });
  return {
    call: async (name, args) => (await request("tools/call", { name, arguments: args })).result as ToolResult,
    start: (name, args) => start("tools/call", { name, arguments: args }),
    request,
    send,
    scratch,
    close: async () => {
      child.stdin.end();
      return new Promise((resolve) => child.once("close", resolve));
    },
  };
}

const sessionOf = async (deps: McpDeps): Promise<Session> => openSession(createMcpServer(deps));

let fixture: CompositionFixture;
let stdio: Stdio;
let warm: Session;

before(async () => {
  fixture = await createCompositionFixture();
  stdio = await startStdio(fixture);
  warm = await sessionOf(fixture.deps);
});

after(async () => {
  await warm?.close();
  if (stdio) assert.equal(await stdio.close(), 0);
  fixture?.dispose();
});

test("stdio discovers ten operations and composes all seven families with the facts their original tools report", async () => {
  const listed = (await stdio.request("tools/list")).result.tools as { name: string; outputSchema?: unknown }[];
  assert.deepEqual(listed.map((tool) => tool.name).sort(), OPERATIONS);
  for (const tool of listed) assert.equal(tool.outputSchema, undefined, tool.name);

  const result = await stdio.call("ye_ast_compose", { queries: fixture.queries, mode: "full" });
  const full = composed(result);
  const { graph } = full;
  assert.equal(full.verification.status, "available");
  assert.equal(graph.sources.length, 7);
  const originals = new Map<string, Record<string, any>>();
  for (const query of fixture.queries) originals.set(query.name, originalFact(await stdio.call(query.name, { ...query.arguments, mode: "full" })));

  // Every source answers at the snapshot its original reports, and its request is the original recovery or the query.
  for (const source of graph.sources) {
    const query = fixture.queries.find((item) => item.name === `ye_ast_${source.family}`)!;
    const original = originals.get(query.name)!;
    const own = graph.snapshots.find((item) => item.id === source.snapshotVector.find((entry) => entry.repo === original.snapshot.repo)?.snapshot);
    assert.deepEqual(own?.value, original.snapshot, source.family);
    const request = full.requests[source.requestIndex]!;
    if (original.recovery) {
      assert.deepEqual(request, { status: "available", strategy: "pinned-replay", query: { ...original.recovery.query, expect: original.recovery.resultIdentity } });
    } else {
      assert.deepEqual(request, { status: "available", strategy: "fresh-read", query });
    }
  }

  // entrypoints + outline: the route's handler is one declaration entity that both coordinates resolve to.
  const route = one(parts(graph, "entrypoint").filter((part) => part.entry.kind === "http-route" && part.entry.name === "GET /orders/{id}"), "route");
  const originalRoute = originals.get("ye_ast_entrypoints")!.value.entrypoints.value.find((finding: any) => finding.value?.name === "GET /orders/{id}").value;
  const handler = located(graph, (route.entry as { handler: AnchorId }).handler);
  assert.deepEqual(handler, { repo: SHOP, sha: fixture.shop.head, path: originalRoute.handler.path, symbol: originalRoute.handler.symbol, line: originalRoute.handler.line, endLine: originalRoute.handler.endLine });
  const declared = everyDeclaration(originals.get("ye_ast_outline")!.value.files[0].declarations).find((item: any) => item.name === "one");
  const declaration = one(parts(graph, "outline-declaration").filter((part) => anchor(graph, part.anchor).symbol === "one"), "declaration");
  assert.deepEqual(located(graph, declaration.anchor), { repo: SHOP, sha: fixture.shop.head, path: CONTROLLER_PATH, symbol: "one", line: declared.line, endLine: declared.endLine });
  const served = one(relations(graph, "serves-entrypoint"), "serves-entrypoint");
  const handlerEntity = entity(graph, served.value.handler);
  assert.equal(handlerEntity.kind, "declaration");
  assert.ok(handlerEntity.kind === "declaration" && handlerEntity.declarations.includes(declaration.id));
  assert.ok(handlerEntity.kind === "declaration" && handlerEntity.anchors.includes((route.entry as { handler: AnchorId }).handler));
  assert.ok(graph.connections.some((connection) => connection.rule === "handler-declaration" && connection.parts.includes(route.id) && connection.parts.includes(declaration.id)));

  // impact: every recorded seed, at its coordinate, in its order.
  const impact = originals.get("ye_ast_impact")!.value;
  const seedSource = graph.sources.find((source) => source.family === "impact")!.id;
  const seeds = parts(graph, "seed").filter((part) => part.supports.some((support) => support.source === seedSource));
  assert.deepEqual(
    seeds.map((part) => located(graph, part.anchor)).map(({ path, symbol, line }) => ({ file: path, symbol, line })).sort((a, b) => a.line - b.line),
    impact.seeds.map(({ file: path, symbol, line }: any) => ({ file: path, symbol, line })).sort((a: any, b: any) => a.line - b.line),
  );
  assert.ok(seeds.every((part) => part.comparison?.status === "available" && part.comparison.value.mergeBase === impact.mergeBase));

  // callers with a workspace: the admitted link between the repositories, as the original records it.
  const link = one<any>(originals.get("ye_ast_callers")!.value.links, "link").link;
  const match = one(relations(graph, "workspace-match"), "workspace-match").value;
  const target = entity(graph, match.to.handler);
  assert.equal(target.id, handlerEntity.id, "the link's destination is the same declaration the route and outline name");
  assert.deepEqual(
    { repo: match.from.repo, file: file(graph, match.from.file).path, line: match.from.line, symbol: match.from.symbol, to: { repo: match.to.repo, kind: match.to.kind, name: match.to.name }, transport: match.transport, basis: match.basis },
    { repo: link.from.repo, file: link.from.file, line: link.from.line, symbol: link.from.symbol, to: { repo: link.to.repo, kind: link.to.kind, name: link.to.name }, transport: link.transport, basis: link.basis },
  );
  assert.equal(snapshotOf(graph, match.from.file).kind === "sha" && (snapshotOf(graph, match.from.file) as { sha: string }).sha, fixture.web.head);

  // importers: one dependency part per recorded consumer and category, never a symbol dependence of the imported file.
  const imported = originals.get("ye_ast_importers")!.value.files[0];
  const categories: Record<string, string> = { importers: "importer", reexporters: "reexporter", dynamicImporters: "dynamic-importer", typeImporters: "type-importer", users: "user", unresolvedNamers: "unresolved-namer" };
  const expected = Object.entries(categories).flatMap(([field, category]) => (imported[field] ?? []).map((from: string) => `${from} ${category}`)).sort();
  assert.ok(expected.includes(`${PAGE_PATH} importer`), JSON.stringify(imported));
  assert.deepEqual(parts(graph, "file-dependency").filter((part) => part.category !== "outline-import").map((part) => `${file(graph, part.from).path} ${part.category}`).sort(), expected);
  for (const { value } of relations(graph, "symbol-dependence")) {
    for (const end of [value.from, value.to]) {
      const node = entity(graph, end);
      assert.ok(node.kind === "declaration" && file(graph, node.file).path !== SERVICE_PATH, "an import never becomes a call of the imported file");
    }
  }

  // workspace: every unserved outward name keeps its unserved disposition.
  const unserved = originals.get("ye_ast_workspace")!.value.unserved.map((name: any) => name.name).sort();
  assert.ok(unserved.length > 0);
  assert.deepEqual([...new Set(parts(graph, "outward-name").filter((part) => part.disposition === "unserved").map((part) => part.name))].sort(), [...new Set(unserved)].sort());

  // decisions: each gap keeps its options and their recommendation; an explicit member is not trusted by being one.
  const gaps = originals.get("ye_ast_decisions")!.value.decisions as any[];
  const shape = (gap: { kindName?: string; kind?: string; subject: string; required: boolean; allowsFreeText: boolean; options: readonly { value: string; recommended: boolean; evidence: readonly unknown[]; basis?: string }[] }) =>
    ({ kind: gap.kindName ?? gap.kind, subject: gap.subject, required: gap.required, allowsFreeText: gap.allowsFreeText, options: gap.options.map(({ value, recommended, basis, evidence }) => ({ value, recommended, basis, evidence: evidence.length })) });
  const decisionParts = parts(graph, "decision");
  assert.deepEqual(decisionParts.map((part) => [part.decisionId, shape(part)]).sort(), gaps.map((gap) => [gap.id, shape(gap)]).sort());
  const webTrust = one(decisionParts.filter((part) => part.decisionId === `trust:${WEB}`), "web trust gap");
  assert.equal(webTrust.required, true);
  assert.equal(webTrust.allowsFreeText, false);
  assert.deepEqual(webTrust.options.map((option) => [option.value, option.recommended]), [["trusted", false], ["untrusted", false]]);
});

test("summary and details receipts preserve verification and repeat queries while findings and coverage stay in text", async () => {
  const full = composed(await warm.callTool("ye_ast_compose", { queries: fixture.queries, mode: "full" }));
  for (const mode of [undefined, "summary", "details"] as const) {
    const result = await warm.callTool("ye_ast_compose", { queries: fixture.queries, ...(mode && { mode }) });
    assert.notEqual(result.isError, true);
    const { text, ...receipt } = resultFields(result) as ComposeReceipt & { text: string };
    assert.equal(COMPOSE_OUTPUT.safeParse(receipt).success, true);
    assert.deepEqual(receipt, { kind: "composition-receipt", compositionSchema: 1, mode: mode ?? "summary", verification: full.verification, requests: full.requests });
    // The handler coordinate is in the text, so a reader needs no table to locate it.
    const handler = full.graph.anchors.find(anchor => anchor.symbol === "OrderController.one");
    assert.ok(handler);
    assert.ok(text.includes(CONTROLLER_PATH));
    assert.ok(text.includes(handler.symbol));
    assert.ok(text.includes(`${handler.line}-${handler.endLine}`), "the file block and span locate the handler");
  }
  assert.ok(full.coverage.reads.partial > 0, "partial reads stay partial in the composition");
  assert.equal(full.counts.sources, 7);
});

test("dependent acquisitions transfer exact coordinates, including a foreign link destination at its own snapshot", async () => {
  const compose = async (queries: ComposeQuery[]) => composed(await warm.callTool("ye_ast_compose", { queries, mode: "full" })).graph;

  // entrypoints -> outline -> callers, each step built from the previous answer's coordinates only.
  const entries = await compose([{ name: "ye_ast_entrypoints", arguments: { repo: SHOP, revision: fixture.shop.head } }]);
  const route = one(parts(entries, "entrypoint").filter((part) => part.entry.kind === "http-route" && part.entry.name === "GET /orders/{id}"), "route");
  const handler = located(entries, (route.entry as { handler: AnchorId }).handler);
  const outline: ComposeQuery = { name: "ye_ast_outline", arguments: { repo: handler.repo, revision: handler.sha, files: [handler.path] } };
  const callers: ComposeQuery = { name: "ye_ast_callers", arguments: { repo: handler.repo, revision: handler.sha, targets: [{ file: handler.path, symbol: handler.symbol }] } };
  const chain = await compose([{ name: "ye_ast_entrypoints", arguments: { repo: SHOP, revision: fixture.shop.head } }, outline, callers]);
  const served = one(relations(chain, "serves-entrypoint"), "serves-entrypoint");
  const node = entity(chain, served.value.handler);
  assert.ok(node.kind === "declaration" && node.declarations.length === 1, "handler bound to one outline declaration");
  const seed = one(parts(chain, "seed"), "requested target");
  const binding = chain.bindings.find((item) => item.anchor === seed.anchor)?.binding;
  assert.deepEqual(binding, { status: "resolved", entity: node.id }, "the callers target is the same declaration");

  // impact -> callers: the seed becomes a target, and the dependence both record is one relation with two attestations.
  const changed = await compose([fixture.queries[1]!]);
  const changedSeeds = parts(changed, "seed").map((part) => located(changed, part.anchor));
  assert.ok(changedSeeds.length > 0);
  const seedCallers: ComposeQuery = { name: "ye_ast_callers", arguments: { repo: SHOP, revision: fixture.shop.head, targets: changedSeeds.map(({ path, symbol }) => ({ file: path, symbol })) } };
  const both = await compose([fixture.queries[1]!, seedCallers]);
  const dependences = relations(both, "symbol-dependence");
  assert.ok(dependences.length > 0);
  for (const relation of dependences) assert.equal(new Set(relation.attestations.flatMap((item) => item.reads.map((read) => both.reads.find((r) => r.id === read)!.source))).size, 2, "impact and callers both attest it");
  assert.ok(both.connections.some((connection) => connection.rule === "change-dependent"));

  // importers -> outline: the importing file's outline import and the importer category are one file import.
  const importers = await compose([fixture.queries[3]!]);
  const importer = one(parts(importers, "file-dependency").filter((part) => part.category === "importer"), "importer");
  const consumer = file(importers, importer.from);
  const consumerSnapshot = snapshotOf(importers, importer.from);
  assert.equal(consumerSnapshot.kind, "sha");
  const imports = await compose([fixture.queries[3]!, { name: "ye_ast_outline", arguments: { repo: consumer.repo, revision: (consumerSnapshot as { sha: string }).sha, files: [consumer.path] } }]);
  const fileImport = one(relations(imports, "file-import").filter(({ value }) => { const edge = value as { from: FileId; to: FileId }; return file(imports, edge.from).path === PAGE_PATH && file(imports, edge.to).path === SERVICE_PATH; }), "file import");
  assert.equal(new Set(fileImport.attestations.flatMap((item) => item.reads.map((read) => imports.reads.find((r) => r.id === read)!.source))).size, 2);
  // Exact positive import observations may corroborate across family-specific producer policies.
  // Their original producer versions remain attached to the independent read attestations.
  assert.ok(imports.connections.some((connection) => connection.rule === "shared-file-import"));
  assert.equal(relations(imports, "symbol-dependence").length, 0, "an import is not a call");

  // From Link.to, not from entrypoints: the web change reaches shop, and the destination is read at shop's own snapshot.
  const outgoing: ComposeQuery = { name: "ye_ast_impact", arguments: { repo: WEB, base: fixture.web.base, head: fixture.web.head, workspace: { repos: [{ path: fixture.shop.root, id: SHOP, revision: fixture.shop.head }], gateways: [...GATEWAYS] }, offline: true } };
  const reach = await compose([outgoing]);
  const link = one(parts(reach, "workspace-link").filter((part) => part.link.to.repo === SHOP), "outgoing link");
  const destination = located(reach, link.link.to.handler);
  assert.equal(destination.sha, fixture.shop.head);
  const foreignOutline: ComposeQuery = { name: "ye_ast_outline", arguments: { repo: destination.repo, revision: destination.sha, files: [destination.path] } };
  const foreignCallers: ComposeQuery = { name: "ye_ast_callers", arguments: { repo: destination.repo, revision: destination.sha, targets: [{ file: destination.path, symbol: destination.symbol }] } };
  // web holds a different controller at the same relative path; it must stay a different file.
  const lookalike: ComposeQuery = { name: "ye_ast_outline", arguments: { repo: WEB, revision: fixture.web.head, files: [CONTROLLER_PATH] } };
  const transferred = await compose([outgoing, foreignOutline, foreignCallers, lookalike]);
  const match = one(relations(transferred, "workspace-match"), "workspace match");
  const foreignNode = entity(transferred, match.value.to.handler);
  assert.ok(foreignNode.kind === "declaration" && foreignNode.declarations.length === 1, JSON.stringify(foreignNode));
  assert.equal(foreignNode.kind === "declaration" && file(transferred, foreignNode.file).repo, SHOP);
  const controllers = transferred.files.filter((item) => item.path === CONTROLLER_PATH);
  assert.deepEqual(controllers.map((item) => item.repo).sort(), [SHOP, WEB]);
  const webDeclarations = parts(transferred, "outline-declaration").filter((part) => file(transferred, anchor(transferred, part.anchor).file).repo === WEB).map((part) => part.id);
  assert.ok(webDeclarations.length > 0);
  assert.ok(transferred.entities.every((item) => item.kind !== "declaration" || item.id === foreignNode.id || !item.declarations.some((id) => foreignNode.kind === "declaration" && foreignNode.declarations.includes(id))));
  assert.ok(foreignNode.kind === "declaration" && foreignNode.declarations.every((id) => !webDeclarations.includes(id)), "a look-alike path never joins");

  // An absent destination file is an unheld file, not an empty outline.
  const absent = await compose([{ name: "ye_ast_outline", arguments: { repo: SHOP, revision: fixture.shop.head, files: ["src/main/java/shop/Missing.java"] } }]);
  assert.equal(one(parts(absent, "unheld-file"), "unheld").file, one(absent.files, "absent file").id);
  assert.equal(parts(absent, "outline-file").length, 0);
});

test("three acquisition orders compose the same canonical result in a warm session and in cold sessions", async () => {
  const [entrypoints, impact, callers, importers, outline, workspace, decisions] = fixture.queries as [ComposeQuery, ComposeQuery, ComposeQuery, ComposeQuery, ComposeQuery, ComposeQuery, ComposeQuery];
  const orders = {
    original: fixture.queries,
    reverse: [...fixture.queries].reverse(),
    // alternate the repository each query is selected for: shop, web, shop, shop, shop, shop, shop
    interleaved: [entrypoints, importers, outline, callers, workspace, impact, decisions],
  };
  const results: Record<string, unknown> = {};
  for (const [name, queries] of Object.entries(orders)) {
    results[`warm ${name}`] = composed(await warm.callTool("ye_ast_compose", { queries, mode: "full" }));
    const cold = await sessionOf(fixture.coldDeps());
    try {
      results[`cold ${name}`] = composed(await cold.callTool("ye_ast_compose", { queries, mode: "full" }));
    } finally { await cold.close(); }
  }
  const [first, ...rest] = Object.entries(results);
  // Fresh index directories record the same provenance here; any difference would surface as a different identity.
  for (const [name, value] of rest) assert.deepEqual(value, first![1], `${name} vs ${first![0]}`);
  // A repeated query, once with its source assertion, executes once and keeps the same composition.
  const pinned = (first![1] as ComposeFull).requests.map((request) => (request.status === "available" ? request.query : undefined)).find((query) => query?.name === "ye_ast_entrypoints")!;
  const repeated = composed(await warm.callTool("ye_ast_compose", { queries: [...fixture.queries, pinned], mode: "full" }));
  assert.deepEqual(repeated.verification, (first![1] as ComposeFull).verification);
});

test("receipt requests verify after interleaved original selections and foreign queries, and fail once external trust changes", async () => {
  const own = await createCompositionFixture();
  const session = await sessionOf(own.deps);
  try {
    const first = composed(await session.callTool("ye_ast_compose", { queries: own.queries, mode: "full" }));
    assert.equal(first.verification.status, "available");
    const identity = (first.verification as { identity: string }).identity;
    const repeat = { queries: available(first.requests), expect: identity };
    // Original selections and pages, and an unrelated foreign query, between the two compositions.
    const entry = own.queries[0]!;
    const page = await session.callTool("ye_ast_entrypoints", { ...entry.arguments, select: { kind: "entrypoint-evidence", findingIndex: 0 }, page: { limit: 1 } });
    assert.notEqual(page.isError, true, JSON.stringify(page));
    assert.notEqual((await session.callTool("ye_ast_outline", { repo: WEB, revision: own.web.head, files: [PAGE_PATH] })).isError, true);
    // Branch tips move; every request is pinned to a full SHA, so the set still verifies.
    for (const repo of [own.shop, own.web]) {
      writeFileSync(join(repo.root, "NOTES.md"), "moved\n");
      own.git(repo, "add", "-A");
      own.git(repo, "commit", "-q", "-m", "move tip");
    }
    const again = await session.callTool("ye_ast_compose", { ...repeat, mode: "full" });
    assert.deepEqual(composed(again).verification, first.verification);
    // A fresh session with no handles verifies the same requests.
    const cold = await sessionOf(own.coldDeps());
    try { assert.deepEqual(composed(await cold.callTool("ye_ast_compose", { ...repeat, mode: "full" })).verification, first.verification); } finally { await cold.close(); }

    const decisions = composed(await session.callTool("ye_ast_compose", { queries: [own.queries[6]!], mode: "full" }));
    assert.equal(decisions.verification.status, "available");
    const decisionsOnly = { queries: available(decisions.requests), expect: (decisions.verification as { identity: string }).identity };
    // Trusting web is user context outside the commits: decisions change, so the composition no longer verifies.
    const errors: string[] = [];
    assert.equal(await composeCli({ scratchRoot: own.root, trustDirectory: own.trustDirectory })(["init", "--trust", "trusted", own.web.root], { out: () => {}, err: (line) => errors.push(line) }), 0, errors.join("\n"));
    // The pinned workspace callers recipe records member trust and fails first; a fresh-read decisions set fails as a whole.
    const changed = faultOf(await session.callTool("ye_ast_compose", repeat));
    assert.equal(changed.kind, "composition-source-fault");
    assert.equal(changed.family, "callers");
    assert.deepEqual([changed.cause?.kind, changed.cause?.stage], ["result-changed", "source-identity"]);
    const fresh = faultOf(await session.callTool("ye_ast_compose", decisionsOnly));
    assert.deepEqual([fresh.kind, fresh.stage], ["result-changed", "composition"]);
    const current = composed(await session.callTool("ye_ast_compose", { queries: own.queries, mode: "full" }));
    assert.notDeepEqual(current.verification, first.verification);
    assert.ok(parts(first.graph, "decision").some((part) => part.decisionId === `trust:${WEB}`));
    assert.equal(parts(current.graph, "decision").some((part) => part.decisionId === `trust:${WEB}`), false, "the user's trust record, not membership, closed the gap");
  } finally {
    await session.close();
    own.dispose();
  }
});

test("invalid compose requests fail before any query is dispatched", async () => {
  const { deps, directory } = fixture.coldState();
  const session = await sessionOf(deps);
  const written = () => readdirSync(directory, { recursive: true }).filter((entry) => entry !== "scratch").sort();
  try {
    const entry = fixture.queries[0]!;
    const outline = fixture.queries[4]!;
    const huge = { name: "ye_ast_outline", arguments: { ...outline.arguments, files: ["ñ".repeat(600_000)] } };
    const invalid: [string, unknown][] = [
      ["no queries", { queries: [] }],
      ["seventeen queries", { queries: Array.from({ length: 17 }, () => entry) }],
      ["nested mode", { queries: [{ ...entry, arguments: { ...entry.arguments, mode: "full" } }] }],
      ["root select", { queries: [entry], select: { kind: "entrypoint-evidence", findingIndex: 0 } }],
      ["recursive compose", { queries: [{ name: "ye_ast_compose", arguments: { queries: [entry] } }] }],
      ["expect on outline", { queries: [{ ...outline, expect: `mcp-r1:${"0".repeat(64)}` }] }],
      ["zero deadline", { queries: [entry], deadlineMs: 0 }],
    ];
    for (const [name, args] of invalid) {
      const result = await session.callTool("ye_ast_compose", args);
      assert.equal(result.isError, true, name);
      assert.equal(result.structuredContent, undefined, name);
    }
    // 600000 two-byte characters are one character short of nothing and well over 1 MiB once encoded.
    const tooLarge = faultOf(await session.callTool("ye_ast_compose", { queries: [huge] }));
    assert.equal(tooLarge.kind, "composition-request-too-large");
    const conflicting = faultOf(await session.callTool("ye_ast_compose", { queries: [{ ...entry, expect: `mcp-r1:${"1".repeat(64)}` }, { ...entry, expect: `mcp-r1:${"2".repeat(64)}` }] }));
    assert.equal(conflicting.kind, "composition-conflicting-expectations");
    const undeclared = await session.callTool("ye_ast_compose", { queries: [outline, { ...entry, arguments: { ...entry.arguments, repo: "nowhere" } }] });
    assert.equal(undeclared.isError, true);
    assert.deepEqual(written(), [], "no index or cache entry was written");
    composed(await session.callTool("ye_ast_compose", { queries: [outline], mode: "full" }));
    assert.notDeepEqual(written(), [], "a valid composition does write, so the probe can observe dispatch");
  } finally { await session.close(); }
});

test("a failing source, a batch deadline and a cancellation end without a composition and the process keeps answering", async () => {
  const [entrypoints, , , , outline] = fixture.queries as ComposeQuery[];
  const missing: ComposeQuery = { name: "ye_ast_callers", arguments: { repo: SHOP, revision: fixture.shop.head, targets: [{ file: CONTROLLER_PATH, symbol: "OrderController.absent" }] } };
  const failed = faultOf(await stdio.call("ye_ast_compose", { queries: [entrypoints!, outline!, missing] }));
  assert.equal(failed.kind, "composition-source-fault");
  assert.equal(failed.cause?.kind, "unknown-symbol");
  assert.match(failed.queryKey ?? "", /^q1:\d+$/);

  const late = faultOf(await stdio.call("ye_ast_compose", { queries: fixture.queries, deadlineMs: 1 }));
  assert.equal(late.kind, "deadline");

  const cancelled = stdio.start("ye_ast_compose", { queries: fixture.queries.map((query) => query.name === "ye_ast_impact" ? { ...query, arguments: { ...query.arguments, budget: { depth: 50 } } } : query) });
  stdio.send({ method: "notifications/cancelled", params: { requestId: cancelled.id } });
  const next = composed(await stdio.call("ye_ast_compose", { queries: fixture.queries, mode: "full" }));
  assert.equal(next.verification.status, "available");
  assert.deepEqual(next, composed(await warm.callTool("ye_ast_compose", { queries: fixture.queries, mode: "full" })), "stdio and in-memory transports return the same composition");
  // Abandoned work has released its temporary directories once later calls completed (tsx keeps its own cache there).
  await stdio.call("ye_ast_outline", { ...outline!.arguments });
  assert.deepEqual(readdirSync(stdio.scratch).filter((entry) => !entry.startsWith("tsx-")), []);
});

test("a trusted live capture never joins a commit snapshot that shares its head, and a later edit fails the pinned request", async () => {
  const own = await createCompositionFixture();
  const session = await sessionOf(own.deps);
  try {
    const errors: string[] = [];
    assert.equal(await composeCli({ scratchRoot: own.root, trustDirectory: own.trustDirectory })(["init", "--trust", "trusted", own.shop.root], { out: () => {}, err: (line) => errors.push(line) }), 0, errors.join("\n"));
    const liveEntries: ComposeQuery = { name: "ye_ast_entrypoints", arguments: { repo: SHOP, live: true } };
    const liveOutline: ComposeQuery = { name: "ye_ast_outline", arguments: { repo: SHOP, live: true, files: [CONTROLLER_PATH] } };
    const shaOutline = own.queries[4]!;
    const mixed = composed(await session.callTool("ye_ast_compose", { queries: [liveEntries, shaOutline], mode: "full" }));
    const kinds = mixed.graph.snapshots.filter((item) => item.value.repo === SHOP).map((item) => item.value);
    assert.deepEqual(kinds.map((item) => item.kind).sort(), ["live", "sha"]);
    assert.ok(kinds.some((item) => item.kind === "live" && item.head === own.shop.head && item.stateId.length > 0));
    const difference = one(mixed.coverage.issues.filter((issue) => issue.kind === "snapshot-difference"), "snapshot difference");
    assert.equal(difference.kind === "snapshot-difference" && difference.snapshots.length, 2);
    assert.equal(mixed.graph.connections.some((connection) => connection.rule === "handler-declaration"), false);
    // The route still names its handler, but the handler is not bound to the commit's outline declaration.
    for (const { value } of relations(mixed.graph, "serves-entrypoint")) {
      const handler = entity(mixed.graph, value.handler);
      assert.ok(handler.kind === "declaration" && handler.declarations.length === 0, JSON.stringify(handler));
    }

    const live = composed(await session.callTool("ye_ast_compose", { queries: [liveEntries, liveOutline], mode: "full" }));
    assert.ok(live.graph.connections.some((connection) => connection.rule === "handler-declaration"), "one live capture state joins");
    const pinned = live.requests.find((request) => request.status === "available" && request.strategy === "pinned-replay");
    assert.ok(pinned);
    writeFileSync(join(own.shop.root, CONTROLLER_PATH), CONTROLLER.replace("/orders", "/edited"));
    const repeat = { queries: available(live.requests), ...(live.verification.status === "available" && { expect: live.verification.identity }) };
    const changed = faultOf(await session.callTool("ye_ast_compose", repeat));
    assert.ok(["result-changed", "composition-source-fault"].includes(changed.kind), JSON.stringify(changed));
    if (changed.kind === "composition-source-fault") assert.equal(changed.cause?.kind, "result-changed");
    assert.ok(existsSync(join(own.shop.root, CONTROLLER_PATH)));
  } finally {
    await session.close();
    own.dispose();
  }
});
