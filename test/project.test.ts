import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { context, exec, root } from './helpers.ts';

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
      import { findProject } from ${JSON.stringify(join(root, 'src/core/project.ts'))};
      console.log((await findProject()).name);
    `], c.repo, c.env);
    assert.equal(found.code, 0, found.stderr);
    assert.equal(found.stdout.trim(), '测试');
  });
}
