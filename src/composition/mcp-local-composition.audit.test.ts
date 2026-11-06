import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeQueries } from './compose.ts';
import { createMcpServer } from '../mcp/server.ts';
import { createSha256Digest } from '../core/adapters/crypto/sha256-digest.adapter.ts';
import { openSession, resultFields } from '../mcp/test-session.testing.ts';

const everyDeclaration = (declarations: readonly any[]): any[] => declarations.flatMap((item) => [item, ...everyDeclaration(item.children ?? [])]);

test('local composed queries remain stable across all ordered pairs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ye-audit-'));
  const repo = join(root, 'shop');
  mkdirSync(repo);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.com' };
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  mkdirSync(join(repo, 'src'), { recursive: true });
  const controller = `package shop;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;
@RestController
class OrderController {
  @GetMapping("/orders")
  String one() { return service(); }
  String service() { return "OLD"; }
}
`;
  writeFileSync(join(repo, 'src/OrderController.java'), controller);
  writeFileSync(join(repo, 'src/service.ts'), 'export function service() { return 1; }\n');
  writeFileSync(join(repo, 'src/consumer.ts'), 'import { service } from "./service";\nexport function consumer() { return service(); }\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  writeFileSync(join(repo, 'src/OrderController.java'), controller.replace('OLD', 'NEW'));
  git('add', '-A');
  git('commit', '-qm', 'change');
  const head = git('rev-parse', 'HEAD');
  const q = composeQueries({ scratchRoot: root, indexCache: join(root, 'index'), trustDirectory: join(root, 'trust'), cacheDirectory: join(root, 'cache') });
  const session = await openSession(createMcpServer({ ...q, digest: createSha256Digest(), repository: { path: repo, repoId: 'shop' } }));
  try {
    const requests: Record<string, object> = {
      entrypoints: { revision: head },
      callers: { revision: head, targets: [{ file: 'src/OrderController.java', symbol: 'OrderController.service' }] },
      outline: { revision: head, files: ['src/OrderController.java'] },
      importers: { revision: head, files: ['src/service.ts'] },
      impact: { base, head, changed: ['src/OrderController.java'] },
    };
    const call = async (name: string) => {
      const result = await session.callTool(`ye_ast_${name}`, { ...requests[name], mode: 'full' });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      return resultFields(result);
    };
    const facts: Record<string, any> = {};
    for (const name of Object.keys(requests)) facts[name] = await call(name);
    for (const a of Object.keys(requests)) {
      for (const b of Object.keys(requests)) {
        if (a === b) continue;
        assert.deepEqual(await call(a), facts[a], `${a} before ${b}`);
        assert.deepEqual(await call(b), facts[b], `${b} after ${a}`);
        assert.deepEqual(await call(a), facts[a], `${a} after ${b}`);
      }
    }
    for (const name of Object.keys(requests)) assert.equal(facts[name].snapshot.sha, head, name);
    assert.match(JSON.stringify(facts.entrypoints.value), /\/orders/);
    assert.match(JSON.stringify(facts.importers.value), /src\/consumer\.ts/);
    for (const name of Object.keys(requests)) {
      assert.equal(facts[name].snapshot.repo, 'shop');
      assert.equal(facts[name].repositoryRoots[0].path, repo);
    }
    const route = facts.entrypoints.value.entrypoints.value.find((x: any) => x.value?.name === 'GET /orders').value;
    const handler = route.handler;
    const outline = facts.outline.value.files[0];
    const method = everyDeclaration(outline.declarations).find((x: any) => x.name === 'one');
    assert.equal(handler.path, outline.file);
    assert.ok(handler.line <= method.endLine && method.line <= handler.endLine);
    assert.deepEqual(facts.impact.value.entrypoints, facts.callers.value.entrypoints);
    assert.deepEqual(facts.impact.value.seeds.map(({file, symbol, line}: any) => ({file, symbol, line})), facts.callers.value.seeds.map(({file, symbol, line}: any) => ({file, symbol, line})));
    const seed = facts.impact.value.seeds[0];
    const transferredCallers = await session.callTool('ye_ast_callers', { revision: head, targets: [{ file: seed.file, symbol: seed.symbol }], mode: 'full' });
    assert.notEqual(transferredCallers.isError, true);
    assert.deepEqual(resultFields(transferredCallers).value.entrypoints, facts.impact.value.entrypoints);
    const transferredOutline = await session.callTool('ye_ast_outline', { revision: head, files: [handler.path], mode: 'full' });
    assert.deepEqual(resultFields(transferredOutline).value, facts.outline.value);
    const importer = facts.importers.value.files[0].importers[0];
    const importerOutline = await session.callTool('ye_ast_outline', { revision: head, files: [importer], mode: 'full' });
    assert.notEqual(importerOutline.isError, true);
    assert.equal(resultFields(importerOutline).value.files[0].file, 'src/consumer.ts');
    assert.ok(resultFields(importerOutline).value.files[0].imports.length > 0);
    for (const name of ['entrypoints', 'callers', 'impact']) {
      for (const mode of ['summary', 'details']) {
        const result = await session.callTool(`ye_ast_${name}`, { ...requests[name], mode });
        assert.notEqual(result.isError, true);
        assert.deepEqual(resultFields(result).recovery, facts[name].recovery);
        assert.deepEqual(resultFields(result).snapshot, facts[name].snapshot);
      }
    }
  } finally {
    await session.close();
    rmSync(root, { recursive: true, force: true });
  }
});
