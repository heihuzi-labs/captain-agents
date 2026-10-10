import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { context } from './helpers.ts';
import { ensureHome, jobDir } from '../src/core/paths.ts';
import { addWorktree, saveDiff } from '../src/core/worktree.ts';
import type { Job } from '../src/core/job.ts';

test('保存的改动带上二进制文件、不受本机 diff 设置影响：全新检出同一起点后 git apply 成功、字节一致', async t => {
  const c = await context(t);
  // 平台自己的 git 调用读的是本进程环境：隔开本机的 git 配置，再模拟会改坏补丁格式的设置。
  const hostile = { 'diff.noprefix': 'true', 'diff.mnemonicPrefix': 'true', 'color.ui': 'always', 'color.diff': 'always' };
  Object.assign(process.env, { XAGENTS_HOME: c.home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: String(Object.keys(hostile).length) },
    ...Object.entries(hostile).map(([key, value], i) => ({ [`GIT_CONFIG_KEY_${i}`]: key, [`GIT_CONFIG_VALUE_${i}`]: value })));
  await ensureHome();
  // 起点里有一个已跟踪的二进制文件（带 0 字节，git 才会当成二进制）。
  await writeFile(join(c.repo, 'logo.png'), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0x0d]), randomBytes(2048)]));
  await c.git(['add', 'logo.png']); await c.git(['commit', '-q', '-m', '加图片']);
  const base = await c.git(['rev-parse', 'HEAD']);
  const job = { id: '1003-0001-codex-binary', repo: c.repo, worktree: join(c.temp, 'worktree'), branch: 'xa/binary', base } as Job;
  await addWorktree(job); await mkdir(jobDir(job.id));

  const changed: Record<string, Buffer> = {
    'logo.png': Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]), randomBytes(3000)]),
    'assets/新 图标.bin': Buffer.concat([Buffer.from([0, 0xff, 0xfe]), randomBytes(1500)]),
    'base.txt': Buffer.from('改过的起点\n'),
    'notes.txt': Buffer.from('新增的文字\n'),
  };
  await mkdir(join(job.worktree, 'assets'));
  for (const [file, bytes] of Object.entries(changed)) await writeFile(join(job.worktree, file), bytes);

  await saveDiff(job);
  const patch = join(jobDir(job.id), 'diff.patch'), text = await readFile(patch, 'utf8');
  assert.doesNotMatch(text, /^Binary files /m); assert.ok(!text.includes('\x1b['));
  assert.match(text, /^diff --git a\/logo\.png b\/logo\.png$/m);
  assert.equal(text.match(/^GIT binary patch$/gm)?.length, 2);
  assert.match(text, /^-起点$/m); assert.match(text, /^\+新增的文字$/m);

  // 在另一份全新克隆里回到同一起点，整份补丁一次打上。
  const fresh = join(c.temp, 'fresh');
  await c.git(['clone', '-q', '--no-checkout', c.repo, fresh]);
  await c.git(['-C', fresh, 'checkout', '-q', '--detach', base]);
  await c.git(['-C', fresh, 'apply', '--check', patch]);
  await c.git(['-C', fresh, 'apply', patch]);
  for (const [file, bytes] of Object.entries(changed)) assert.ok((await readFile(join(fresh, file))).equals(bytes), file);
  const status = await c.git(['-C', fresh, 'status', '--porcelain', '--untracked-files=all']);
  assert.deepEqual(status.split('\n').map(line => line.trim()).sort(), ['?? "assets/\\346\\226\\260 \\345\\233\\276\\346\\240\\207.bin"', '?? notes.txt', 'M base.txt', 'M logo.png']);
});
