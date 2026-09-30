import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { context } from './helpers.ts';
import { quote } from '../src/core/decide.ts';

test('采用只记决定、打印安全引用的命令；放弃保留副本和其他字段', async t => {
  const c = await context(t); await c.add();
  const id = 'decision-test', dir = join(c.home, 'jobs', id); await mkdir(dir);
  const file = join(dir, 'job.json');
  await writeFile(file, JSON.stringify({ id, repo: c.repo, base: c.base, worktree: c.repo, branch: `xa/${id}`, project: '测试', who: 'codex', kind: '修复', state: 'done', created: new Date().toISOString(), verify: { ok: true, steps: [] } }));
  await writeFile(join(c.repo, 'changes.txt'), 'uncommitted');
  const before = await c.git(['status', '--porcelain']), head = await c.git(['rev-parse', 'HEAD']);
  const adopted = await c.cli(['adopt', id, '--note', '核查通过']); assert.equal(adopted.code, 0, adopted.stderr);
  assert.match(adopted.stdout, /只供负责人/); assert.match(adopted.stdout, /commit -m/); assert.match(adopted.stdout, /merge -- 'xa\/decision-test'/);
  let j = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(j.decision.kind, 'adopt'); assert.equal(j.decision.note, '核查通过'); assert.ok(Date.parse(j.decision.at)); assert.equal(j.verify.ok, true);
  assert.equal(await c.git(['status', '--porcelain']), before); assert.equal(await c.git(['rev-parse', 'HEAD']), head);
  const dropped = await c.cli(['drop', id, '--note', '改用另一份']); assert.equal(dropped.code, 0, dropped.stderr); assert.doesNotMatch(dropped.stdout, /git -C/);
  j = JSON.parse(await readFile(file, 'utf8')); assert.equal(j.decision.kind, 'drop'); assert.equal(j.decision.note, '改用另一份');
  assert.equal(await readFile(join(c.repo, 'changes.txt'), 'utf8'), 'uncommitted'); assert.equal(await c.git(['rev-parse', 'HEAD']), head);
  assert.equal(quote("a' b;$(touch nope)"), "'a'\\'' b;$(touch nope)'");
});
test('main 比起点更新时提醒对齐；运行中不可决定，清理后不可采用', async t => {
  const c = await context(t); await c.add();
  const id = 'older', dir = join(c.home, 'jobs', id); await mkdir(dir);
  const file = join(dir, 'job.json'), j = { id, repo: c.repo, base: c.base, worktree: c.repo, state: 'done', created: new Date().toISOString(), who: 'codex', kind: '修复' };
  await writeFile(file, JSON.stringify(j));
  const tree = await c.git(['rev-parse', 'HEAD^{tree}']);
  const newer = await c.git(['commit-tree', tree, '-p', c.base, '-m', '测试 main 前进']); await c.git(['update-ref', 'refs/heads/main', newer]);
  const r = await c.cli(['adopt', id]); assert.equal(r.code, 0, r.stderr); assert.match(r.stdout, /先对齐/);
  await writeFile(file, JSON.stringify({ ...j, state: 'running' })); assert.equal((await c.cli(['drop', id])).code, 1);
  await writeFile(file, JSON.stringify({ ...j, cleaned: new Date().toISOString() })); assert.equal((await c.cli(['adopt', id])).code, 1);
});
