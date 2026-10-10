import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readAutoUpdateCheck, setAutoUpdateCheck, setNetworkAllowed, writeSettings } from '../src/core/settings.ts';
import { settingsPatch } from '../app/main/actions.ts';
import { context } from './helpers.ts';

test('自动检查缺省 true，专用函数存盘，普通补丁拒绝，并发不丢其它设置', async t => {
  const c = await context(t, false), original = process.env.XAGENTS_HOME; process.env.XAGENTS_HOME = c.home;
  t.after(() => { if (original === undefined) delete process.env.XAGENTS_HOME; else process.env.XAGENTS_HOME = original; });
  const file = join(c.home, 'config.json');
  assert.equal(await readAutoUpdateCheck(), true);
  for (const value of [null, 1, 'false', {}, []]) { await writeFile(file, JSON.stringify({ autoUpdateCheck: value })); assert.equal(await readAutoUpdateCheck(), true); }
  await writeFile(file, JSON.stringify({ custom: 42 }));
  await Promise.all([setAutoUpdateCheck(false), setNetworkAllowed(true), writeSettings({ notifications: false })]);
  assert.equal(await readAutoUpdateCheck(), false);
  const saved = JSON.parse(await readFile(file, 'utf8')); assert.equal(saved.custom, 42); assert.equal(saved.networkAllowed, true); assert.equal(saved.notifications, false);
  const before = await readFile(file, 'utf8');
  for (const value of ['true', 1, null, undefined]) await assert.rejects(setAutoUpdateCheck(value), /只能是开或关/);
  for (const value of [true, undefined]) {
    await assert.rejects(writeSettings({ autoUpdateCheck: value } as never), /不能通过普通设置补丁/);
    await assert.rejects(writeSettings(() => ({ autoUpdateCheck: value }) as never), /不能通过普通设置补丁/);
    assert.throws(() => settingsPatch({ autoUpdateCheck: value }), /不能通过普通设置补丁/);
  }
  assert.equal(await readFile(file, 'utf8'), before); await setAutoUpdateCheck(true); assert.equal(await readAutoUpdateCheck(), true);
});
