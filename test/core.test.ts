import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { writeFile, readFile, readdir, mkdir, utimes } from 'node:fs/promises';
import { ensureHome } from '../src/core/paths.ts';
import { writeAtomic, readJson, withLock } from '../src/core/fsx.ts';
import { reserveJob, reserveBatch, stem } from '../src/core/ids.ts';
import { context, exec, root } from './helpers.ts';

test('占号使用上海日期、净化题目名，任务及批号碰撞递增', async t => {
  const c = await context(t, false); process.env.XAGENTS_HOME = c.home; await ensureHome();
  const date = new Date('2026-09-28T16:01:00Z');
  const ids = await Promise.all(Array.from({ length: 4 }, () => reserveJob('codex', 'fix_me.md', date)));
  assert.deepEqual(ids.sort(), ['0929-0001-codex-fix-me', '0929-0001-codex-fix-me-2', '0929-0001-codex-fix-me-3', '0929-0001-codex-fix-me-4']);
  assert.equal(await reserveBatch('fix.md', date), '0929-0001-fix');
  assert.equal(await reserveBatch('fix.md', date), '0929-0001-fix-2');
  assert.equal(stem('中文.md'), 'task');
});
test('原子写进程写到一半被杀，旧文件仍是完整 JSON', async t => {
  const c = await context(t, false), file = join(c.temp, 'value.json');
  await writeAtomic(file, '{"old":true}');
  const child = spawn(process.execPath, [join(root, 'test/fixtures/fs-child.ts'), 'partial', c.temp], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const close = once(child, 'close');
  await once(child.stdout, 'data'); child.kill('SIGKILL'); await close;
  assert.deepEqual(await readJson(file), { old: true });
  assert.ok((await readdir(c.temp)).some(n => n.endsWith('.tmp')));
  await writeAtomic(file, '{"new":true}');
  assert.deepEqual(await readJson(file), { new: true });
});
test('跨进程竞争文件锁不丢更新；抛异常后可再次拿锁', async t => {
  const c = await context(t, false); await writeFile(join(c.temp, 'value.json'), '0');
  const results = await Promise.all(Array.from({ length: 6 }, () => exec(process.execPath, [join(root, 'test/fixtures/fs-child.ts'), 'increment', c.temp], c.temp, c.env)));
  for (const r of results) assert.equal(r.code, 0, r.stderr);
  assert.equal(await readJson(join(c.temp, 'value.json')), 6);
  await assert.rejects(withLock(c.temp, () => { throw new Error('模拟失败'); }), /模拟失败/);
  assert.equal(await withLock(c.temp, () => '释放了'), '释放了');
});
test('锁持有者被杀后自动回收，空锁也可回收', async t => {
  const c = await context(t, false);
  const child = spawn(process.execPath, [join(root, 'test/fixtures/fs-child.ts'), 'hold', c.temp], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const close = once(child, 'close'); await once(child.stdout, 'data'); child.kill('SIGKILL'); await close;
  assert.equal(await withLock(c.temp, () => '恢复'), '恢复');
  const lock = join(c.temp, '.lock'); await mkdir(lock); await utimes(lock, new Date(0), new Date(0));
  assert.equal(await withLock(c.temp, () => '空锁恢复'), '空锁恢复');
  await mkdir(lock);
  await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: child.pid, at: new Date().toISOString() }));
  const marker = join(lock, 'reaping.json'); await writeFile(marker, '{'); await utimes(marker, new Date(0), new Date(0));
  assert.equal(await withLock(c.temp, () => '回收中断恢复'), '回收中断恢复');
});
