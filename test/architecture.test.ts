import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';

test('core 的所有 import / re-export 只能留在核心或依赖包，不能回头引用 CLI 或应用', async () => {
  const core = resolve('src/core');
  for (const name of await readdir(core, { recursive: true })) {
    if (!name.endsWith('.ts')) continue;
    const source = await readFile(resolve(core, name), 'utf8');
    const imports = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;
    for (const match of source.matchAll(imports)) {
      if (!match[1].startsWith('.')) { assert.ok(!/^(?:app|src\/cli)(?:\/|$)/.test(match[1]), `${name}: ${match[1]}`); continue; }
      const target = relative(core, resolve(core, name, '..', match[1]));
      assert.ok(!target.startsWith('..'), `${name} 不得引用 ${match[1]}`);
    }
  }
});

test('应用和核心源代码不使用显式 any', async () => {
  for (const dir of ['src', 'app']) for (const name of await readdir(dir, { recursive: true })) {
    if (!/\.tsx?$/.test(name)) continue;
    assert.doesNotMatch(await readFile(resolve(dir, name), 'utf8'), /\bany\b/, `${dir}/${name}`);
  }
});

test('选手清单只在 roster.ts 里写一份：其他源代码不再并列写选手名', async () => {
  for (const dir of ['src', 'app']) for (const name of await readdir(dir, { recursive: true })) {
    if (!/\.(tsx?|html)$/.test(name) || name === 'core/roster.ts') continue;
    assert.doesNotMatch(await readFile(resolve(dir, name), 'utf8'), /cursor-(grok|opus|sonnet)/, `${dir}/${name}`);
  }
});
