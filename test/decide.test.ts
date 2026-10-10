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
  // 合并提示里的分支以任务记录为准（群成员的活共用群的分支）。
  const shared = 'decision-shared', sharedDir = join(c.home, 'jobs', shared); await mkdir(sharedDir);
  await writeFile(join(sharedDir, 'job.json'), JSON.stringify({ ...JSON.parse(await readFile(file, 'utf8')), id: shared, branch: 'xa/chat-demo', decision: undefined }));
  assert.match((await c.cli(['adopt', shared])).stdout, /merge -- 'xa\/chat-demo'/);
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

test('能改文件的活：没验收、验收没过都不能采用；验收通过或写明免验理由才行；只读的活和主人拍板不受影响', async t => {
  const c = await context(t); await c.add();
  const put = async (id: string, extra: Record<string, unknown>) => {
    const dir = join(c.home, 'jobs', id); await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'job.json'), JSON.stringify({ id, repo: c.repo, base: c.base, worktree: c.repo, branch: `xa/${id}`, project: '测试', who: 'codex', kind: '实现', mode: 'workspace-write', state: 'done', created: new Date().toISOString(), ...extra }));
    return async () => JSON.parse(await readFile(join(dir, 'job.json'), 'utf8'));
  };
  const out = (r: { stdout: string; stderr: string }) => r.stdout + r.stderr;
  // 没验收：拦下，告诉负责人两条出路；放弃不受影响。
  const missing = await put('gate-missing', {});
  let r = await c.cli(['adopt', 'gate-missing', '--note', '结论']);
  assert.equal(r.code, 1); assert.match(out(r), /采用前要先验收：xagents verify gate-missing/); assert.match(out(r), /--skip "理由"/);
  assert.equal((await missing()).decision, undefined);
  // 理由必须写，写了才放行；理由记在任务记录里。
  assert.equal((await c.cli(['verify', 'gate-missing', '--skip', '  '])).code, 1);
  assert.equal((await c.cli(['verify', 'gate-missing', '--skip', '只改了文档'])).code, 0);
  assert.equal((await missing()).verifySkip.reason, '只改了文档'); assert.equal((await missing()).verify, undefined);
  assert.equal((await c.cli(['adopt', 'gate-missing', '--note', '结论'])).code, 0);
  // 验收没过：拦下；写明与这件活无关的理由后放行，没过的记录还在。
  const failed = await put('gate-failed', { verify: { ok: false, at: new Date().toISOString(), seconds: 1, steps: [{ cmd: 'x', ok: false, exit: 1, summary: '退出码 1' }] } });
  r = await c.cli(['adopt', 'gate-failed']); assert.equal(r.code, 1); assert.match(out(r), /验收没过，不能采用/);
  assert.equal((await c.cli(['verify', 'gate-failed', '--skip', '主线本来就有一条不稳的测试，与这件活无关'])).code, 0);
  assert.equal((await c.cli(['adopt', 'gate-failed'])).code, 0); assert.equal((await failed()).verify.ok, false);
  // 主人在应用里选“用这份”只是记下；负责人照办时仍要过这道关。
  const owned = await put('gate-owner', { decision: { kind: 'adopt', at: new Date().toISOString(), by: 'owner' } });
  r = await c.cli(['adopt', 'gate-owner', '--note', '照办']); assert.equal(r.code, 1); assert.match(out(r), /采用前要先验收/);
  assert.equal((await owned()).decision.handled, undefined);
  // 只读的活、放弃：照旧。
  await put('gate-ro', { mode: 'read-only', kind: '审查' }); assert.equal((await c.cli(['adopt', 'gate-ro', '--note', '审查意见属实'])).code, 0);
  await put('gate-drop', {}); assert.equal((await c.cli(['drop', 'gate-drop', '--note', '不用了'])).code, 0);
  // 还在跑的活不能先写免验理由。
  await put('gate-running', { state: 'running' }); assert.equal((await c.cli(['verify', 'gate-running', '--skip', '提前写'])).code, 1);
  // 状态表的验收一栏写的是现状。
  const table = (await c.cli(['status', '--all'])).stdout;
  const cell = (id: string) => table.split('\n').find(l => l.includes(` ${id} `)) ?? '';
  assert.match(cell('gate-missing'), /免验/); assert.match(cell('gate-failed'), /免验/); assert.match(cell('gate-owner'), /没验/);
  assert.doesNotMatch(cell('gate-ro'), /没验|免验/); assert.doesNotMatch(cell('gate-drop'), /没验|免验/);
});
