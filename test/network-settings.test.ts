import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readSettings, writeSettings, setNetworkAllowed } from '../src/core/settings.ts';
import { context } from './helpers.ts';

async function registry(t: TestContext) {
  const c = await context(t, false), previous = process.env.XAGENTS_HOME;
  process.env.XAGENTS_HOME = c.home;
  t.after(() => { if (previous === undefined) delete process.env.XAGENTS_HOME; else process.env.XAGENTS_HOME = previous; });
  return { ...c, file: join(c.home, 'config.json') };
}

test('联网总开关缺省关、写坏按关；旧项目字段忽略不报错', async t => {
  const c = await registry(t);
  assert.equal((await readSettings()).networkAllowed, false);
  for (const value of [undefined, null, false, 1, 'true', {}, []]) {
    await writeFile(c.file, JSON.stringify({ networkAllowed: value, network: { 甲: { level: 'open', allow: [] } } }));
    const settings = await readSettings();
    assert.equal(settings.networkAllowed, false);
    assert.equal(Object.hasOwn(settings, 'network'), false);
  }
  for (const raw of ['{broken', 'null', '[]']) {
    await writeFile(c.file, raw); assert.equal((await readSettings()).networkAllowed, false);
  }
  await setNetworkAllowed(true); assert.equal((await readSettings()).networkAllowed, true);
  await setNetworkAllowed(false); assert.equal((await readSettings()).networkAllowed, false);
});

test('只有专用入口能改开关；并发普通设置不丢值，保存去掉旧 network', async t => {
  const c = await registry(t);
  await writeFile(c.file, JSON.stringify({ network: { old: 'broken' }, denyReadHome: ['custom-secret'], custom: 42 }));
  await Promise.all([setNetworkAllowed(true), writeSettings({ notifications: false })]);
  assert.equal((await readSettings()).networkAllowed, true);
  assert.equal((await readSettings()).notifications, false);
  const stored = JSON.parse(await readFile(c.file, 'utf8'));
  assert.equal(Object.hasOwn(stored, 'network'), false);
  assert.deepEqual(stored.denyReadHome, ['custom-secret']); assert.equal(stored.custom, 42);
  const before = await readFile(c.file, 'utf8');
  for (const patch of [{ networkAllowed: false }, { networkAllowed: undefined }, { network: {} }]) {
    await assert.rejects(writeSettings(patch as never), /不能通过普通设置补丁修改/);
    await assert.rejects(writeSettings(() => patch as never), /不能通过普通设置补丁修改/);
  }
  for (const value of ['true', 1, null, undefined, []]) await assert.rejects(setNetworkAllowed(value), /只能是开或关/);
  assert.equal(await readFile(c.file, 'utf8'), before);
});

test('CLI 只读显示总开关，项目不带联网列，不再有联网专项自检或修改入口', async t => {
  const c = await registry(t);
  for (const on of [false, true]) {
    await setNetworkAllowed(on);
    const result = await c.cli(['workers']); assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.trim().split('\n').at(-1), `选手联网：${on ? '开（打开后网络完全不限）' : '关'}（设置 → 联网）`);
  }
  const list = await c.cli(['project', 'list']); assert.equal(list.code, 0, list.stderr);
  assert.doesNotMatch(list.stdout, /联网/);
  const before = await readFile(c.file, 'utf8');
  for (const command of [['project', 'network', '甲', 'off'], ['workers', '--network', 'true'], ['selfcheck', '--network', '甲']]) {
    assert.equal((await c.cli(command)).code, 1);
  }
  assert.equal(await readFile(c.file, 'utf8'), before);
});
