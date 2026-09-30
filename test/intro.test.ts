import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { INTRO_TEXT } from '../src/core/intro.ts';
import { exec, root } from './helpers.ts';

test('xagents intro 打印给其他 AI 的对接提示词：第一步读手册，规矩以手册为准；--help 里有这条', async () => {
  const cli = (args: string[]) => exec(process.execPath, [join(root, 'src/cli/cli.ts'), ...args], root, process.env);
  const r = await cli(['intro']);
  assert.equal(r.code, 0, r.stderr); assert.equal(r.stdout, INTRO_TEXT);
  assert.match(INTRO_TEXT, /运行 `xagents guide`/); assert.match(INTRO_TEXT, /以手册为准/); assert.match(INTRO_TEXT, /xagents inbox/);
  assert.equal((await cli(['intro', '多余'])).code, 1);
  assert.match((await cli(['--help'])).stdout, /xagents intro/);
});
