import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { worktreePath } from '../src/core/project.ts';
import { context, exec, root } from './helpers.ts';

test('副本路径逐层检查父目录：内部链接允许，嵌套链接不能逃出仓库', async t => {
  const c = await context(t, false);
  const project = { name: '测试', repo: c.repo, worktreeRoot: join('copies', 'nested'), setup: [], verify: [], denyReadExtra: [] };
  await mkdir(join(c.repo, 'copies'));
  await mkdir(join(c.repo, 'inside'));
  await symlink(join(c.repo, 'inside'), join(c.repo, 'copies', 'nested'), 'junction');
  assert.equal(await worktreePath(project, 'test'), join(c.repo, 'copies', 'nested', 'xa-test'));
  await rm(join(c.repo, 'copies', 'nested'));
  await symlink(c.temp, join(c.repo, 'copies', 'nested'), 'junction');
  await assert.rejects(worktreePath(project, 'test'), /符号链接指向了仓库外/);
  await assert.rejects(worktreePath(project, 'test/../../../../outside'), /副本目录必须在仓库内/);
});

for (const missing of [true, false]) {
  test(`自动识别项目跳过${missing ? '已删除的仓库目录' : '已不是 Git 仓库的目录'}`, async t => {
    const c = await context(t);
    assert.equal((await c.add()).code, 0);
    const stale = join(c.temp, 'stale');
    await mkdir(stale);
    const init = await exec('git', ['init', '-b', 'main', stale], c.temp, c.env);
    assert.equal(init.code, 0, init.stderr);
    const added = await c.cli(['project', 'add', 'a-stale', stale]);
    assert.equal(added.code, 0, added.stderr);
    await rm(missing ? stale : join(stale, '.git'), { recursive: true });
    const found = await exec(process.execPath, ['--input-type=module', '-e', `
      import { findProject } from ${JSON.stringify(pathToFileURL(join(root, 'src/core/project.ts')).href)};
      console.log((await findProject()).name);
    `], c.repo, c.env);
    assert.equal(found.code, 0, found.stderr);
    assert.equal(found.stdout.trim(), '测试');
  });
}
