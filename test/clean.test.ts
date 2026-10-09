import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { context } from './helpers.ts';
import { hasCode, withLock, writeJson } from '../src/core/fsx.ts';

async function finished(t: TestContext, who = 'codex:high') {
  const c = await context(t);
  assert.equal((await c.add(['--verify', 'git status --porcelain'])).code, 0);
  const started = await c.cli(['run', c.task, '--summary', '清理回归测试', '--who', who], { XA_TEST_MODE: 'change' });
  assert.equal(started.code, 0, started.stderr);
  const job = (await c.jobs())[0];
  const waited = await c.cli(['wait', job.id]);
  assert.equal(waited.code, 0, waited.stderr + waited.stdout);
  const done = (await c.jobs())[0];
  assert.equal(done.state, 'done');
  const dir = join(c.home, 'jobs', job.id);
  return { ...c, job: done, dir, tmp: join(dir, 'tmp'), patch: join(dir, 'diff.patch'), record: join(dir, 'job.json') };
}

async function restore(path: string) {
  try { await chmod(path, 0o700); }
  catch (e) { if (!hasCode(e, 'ENOENT')) throw e; }
}

test('clean 删除临时目录和新旧 Cursor 状态里的只读目录', async t => {
  const c = await finished(t);
  const state = join(c.home, 'cursor', createHash('sha256').update(c.job.id).digest('hex').slice(0, 12));
  const roots = [c.tmp, state, join(c.dir, 'cursor-state')];
  const readonly = roots.map(root => join(root, 'readonly'));
  try {
    for (const path of readonly) {
      await mkdir(path, { recursive: true });
      await writeFile(join(path, 'keep.txt'), '只读残留');
      await chmod(path, 0o555);
    }
    const result = await c.cli(['clean', c.job.id]);
    assert.equal(result.code, 0, result.stderr);
    const saved = (await c.jobs())[0];
    assert.ok(saved.cleaned); assert.ok(saved.worktreeRemoved);
    for (const path of [...roots, c.job.worktree]) await assert.rejects(lstat(path), { code: 'ENOENT' });
    assert.equal(await c.git(['branch', '--list', c.job.branch]), '');
  } finally {
    for (const path of readonly) await restore(path);
  }
});

test('clean 修复只读目录时不跟随符号链接，不改外部目录权限或内容', async t => {
  const c = await finished(t);
  const outside = join(c.temp, 'outside'), readonly = join(c.tmp, 'readonly');
  try {
    await mkdir(outside); await writeFile(join(outside, 'keep.txt'), '外部原文');
    await chmod(outside, 0o555);
    const mode = (await lstat(outside)).mode;
    await symlink(outside, join(c.dir, 'cursor-state'));
    await mkdir(readonly);
    await writeFile(join(readonly, 'keep.txt'), '强制进入权限修复');
    await symlink(outside, join(readonly, 'outside-link'));
    await symlink(join(outside, 'missing'), join(readonly, 'dangling-link'));
    await chmod(readonly, 0o555);
    const result = await c.cli(['clean', c.job.id]);
    assert.equal(result.code, 0, result.stderr);
    assert.ok((await c.jobs())[0].cleaned);
    await assert.rejects(lstat(c.tmp), { code: 'ENOENT' });
    assert.equal((await lstat(outside)).mode, mode);
    assert.deepEqual(await readdir(outside), ['keep.txt']);
    assert.equal(await readFile(join(outside, 'keep.txt'), 'utf8'), '外部原文');
  } finally {
    await restore(readonly); await restore(outside);
  }
});

for (const existing of [true, false]) test(`clean 副本和分支已手动删除，${existing ? '保留已有' : '不补建'} diff.patch`, async t => {
  const c = await finished(t);
  const patch = await readFile(c.patch);
  if (!existing) await rm(c.patch);
  await c.git(['worktree', 'remove', '--force', c.job.worktree]);
  await c.git(['branch', '-D', c.job.branch]);
  const result = await c.cli(['clean', c.job.id]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /副本已不在/);
  assert.match(result.stdout, existing ? /沿用之前存的 diff.patch/ : /没有可存的改动/);
  const saved = (await c.jobs())[0];
  assert.ok(saved.cleaned); assert.ok(saved.worktreeRemoved);
  await assert.rejects(lstat(c.tmp), { code: 'ENOENT' });
  if (existing) assert.deepEqual(await readFile(c.patch), patch);
  else await assert.rejects(lstat(c.patch), { code: 'ENOENT' });
});

test('副本被外面删掉后 collect 不进副本跑 git，保留已存的改动', async t => {
  const c = await finished(t);
  const patch = await readFile(c.patch);
  await c.git(['worktree', 'remove', '--force', c.job.worktree]);
  const collected = await c.cli(['collect', c.job.id]);
  assert.equal(collected.code, 0, collected.stderr);
  assert.doesNotMatch(collected.stderr, /fatal:/);
  assert.deepEqual(await readFile(c.patch), patch);
});

test('clean 接着已有 worktreeRemoved 记录清理；collect 保留补丁，verify 给中文提示', async t => {
  const c = await finished(t);
  const patch = await readFile(c.patch);
  await c.git(['worktree', 'remove', '--force', c.job.worktree]);
  await c.git(['branch', '-D', c.job.branch]);
  const removed = new Date().toISOString();
  await withLock(c.dir, () => writeJson(c.record, { ...c.job, worktreeRemoved: removed }));
  await lstat(c.tmp);
  const collected = await c.cli(['collect', c.job.id]);
  assert.equal(collected.code, 0, collected.stderr);
  assert.deepEqual(await readFile(c.patch), patch);
  const verified = await c.cli(['verify', c.job.id]);
  assert.equal(verified.code, 1);
  assert.match(verified.stderr, /副本已清理，不能再验收/);
  assert.doesNotMatch(verified.stderr, /fatal:|ENOENT/);
  const result = await c.cli(['clean', c.job.id]);
  assert.equal(result.code, 0, result.stderr);
  const saved = (await c.jobs())[0];
  assert.ok(saved.cleaned); assert.equal(saved.worktreeRemoved, removed);
  assert.deepEqual(await readFile(c.patch), patch);
  await assert.rejects(lstat(c.tmp), { code: 'ENOENT' });
});

test('clean 补权限后仍删不掉时先保存副本删除进度，修复后可以重试', async t => {
  const c = await finished(t);
  const unreadable = join(c.tmp, 'unreadable');
  try {
    await mkdir(unreadable); await writeFile(join(unreadable, 'keep.txt'), '保留');
    // u+wx 不增加读权限，因此不能遍历，必须报错并保存进度。
    await chmod(unreadable, 0o000);
    const failed = await c.cli(['clean', c.job.id]);
    assert.equal(failed.code, 1, failed.stdout);
    assert.match(failed.stderr, /删除目录树失败/);
    assert.ok(failed.stderr.includes(c.tmp));
    const saved = (await c.jobs())[0];
    assert.ok(saved.worktreeRemoved); assert.equal(saved.cleaned, undefined);
    assert.equal((await lstat(unreadable)).mode & 0o777, 0o300, '只增加 u+wx');
    await assert.rejects(lstat(c.job.worktree), { code: 'ENOENT' });
    assert.equal(await c.git(['branch', '--list', c.job.branch]), '');
    await restore(unreadable);
    const result = await c.cli(['clean', c.job.id]);
    assert.equal(result.code, 0, result.stderr);
    assert.ok((await c.jobs())[0].cleaned);
    assert.equal((await c.jobs())[0].worktreeRemoved, saved.worktreeRemoved);
    await assert.rejects(lstat(c.tmp), { code: 'ENOENT' });
  } finally { await restore(unreadable); }
});

test('clean 移动 Grok 会话失败只提醒，照样清理完成', async t => {
  const c = await finished(t, 'grok:high');
  const home = join(c.temp, 'user-home');
  const session = join(home, '.grok/sessions', encodeURIComponent(await realpath(c.job.worktree)));
  await mkdir(session, { recursive: true }); await writeFile(join(session, 'chat.json'), '{}');
  const blockedTrash = join(c.temp, 'not-a-directory'); await writeFile(blockedTrash, '阻止移动');
  const result = await c.cli(['clean', c.job.id], { HOME: home, XAGENTS_TRASH: blockedTrash });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /没能把 Grok 会话文件夹移进废纸篓/);
  const done = (await c.jobs())[0];
  assert.ok(done.cleaned); assert.equal(done.pendingGrokSessions, undefined);
  await lstat(session);
  await assert.rejects(lstat(c.tmp), { code: 'ENOENT' });
});

test('clean 不删除存在但不属于登记 Git 副本的目录', async t => {
  const c = await finished(t);
  await c.git(['worktree', 'remove', '--force', c.job.worktree]);
  await mkdir(c.job.worktree); await writeFile(join(c.job.worktree, 'keep.txt'), '不得删除');
  const result = await c.cli(['clean', c.job.id]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /不属于登记的 Git 副本/);
  assert.equal(await readFile(join(c.job.worktree, 'keep.txt'), 'utf8'), '不得删除');
  const saved = (await c.jobs())[0];
  assert.equal(saved.cleaned, undefined); assert.equal(saved.worktreeRemoved, undefined);
});
