import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { TestContext } from 'node:test';
import { readSettings, writeSettings } from '../src/core/settings.ts';
import { effectiveWorkers } from '../src/core/policy.ts';
import { settingsActions, settingsPatch } from '../app/main/actions.ts';
import { applyAppearance, syncBackground, WINDOW_BACKGROUND, windowBackground } from '../app/main/appearance.ts';
import { context } from './helpers.ts';

async function registry(t: TestContext) {
  const c = await context(t, false), previous = process.env.XAGENTS_HOME;
  process.env.XAGENTS_HOME = c.home;
  t.after(() => { if (previous === undefined) delete process.env.XAGENTS_HOME; else process.env.XAGENTS_HOME = previous; });
  return c;
}

test('外观：缺省和写坏了的值都按跟随系统；三个合法值原样读回，也不影响别的设置', async t => {
  const c = await registry(t), file = join(c.home, 'config.json');
  assert.equal((await readSettings()).appearance, 'system');
  for (const bad of ['dim', '', 1, null, ['dark'], { a: 1 }, 'Dark']) {
    await writeFile(file, JSON.stringify({ appearance: bad, keepAwake: false }));
    const settings = await readSettings();
    assert.equal(settings.appearance, 'system', JSON.stringify(bad)); assert.equal(settings.keepAwake, false);
  }
  for (const value of ['light', 'dark', 'system'] as const) {
    await writeSettings({ appearance: value });
    assert.equal((await readSettings()).appearance, value);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).appearance, value);
  }
  await writeSettings({ notifications: false });
  assert.equal((await readSettings()).appearance, 'system', '最后写的是 system，别的设置改动不带偏它');
  await writeSettings({ appearance: 'dark' }); await writeSettings({ keepAwake: false });
  assert.equal((await readSettings()).appearance, 'dark', '改别的设置不丢外观');
});
test('外观：写入只认三个值，其余整份拒绝、不落盘', async t => {
  const c = await registry(t);
  await writeSettings({ appearance: 'light' });
  const before = await readFile(join(c.home, 'config.json'), 'utf8');
  for (const bad of ['dim', '', 1, null, undefined, true, ['dark']]) {
    await assert.rejects(writeSettings({ appearance: bad } as never), /设置不合法/, JSON.stringify(bad));
  }
  await assert.rejects(writeSettings({ appearance: 'dark', keepAwake: 'no' } as never), /设置不合法/);
  assert.equal(await readFile(join(c.home, 'config.json'), 'utf8'), before);
});
test('外观：主进程的设置白名单只放行三个值', () => {
  for (const value of ['system', 'light', 'dark'] as const) assert.deepEqual(settingsPatch({ appearance: value }), { appearance: value });
  assert.deepEqual(settingsPatch({ appearance: 'dark', keepAwake: false }), { appearance: 'dark', keepAwake: false });
  for (const bad of ['dim', '', 1, null, undefined, ['dark'], { mode: 'dark' }]) assert.throws(() => settingsPatch({ appearance: bad }), /外观/, JSON.stringify(bad));
});
test('外观：保存成功后才应用；保存失败不应用；没有改外观时不动它；读设置带上外观', async () => {
  const applied: string[] = [];
  const base = { keepAwake: true, notifications: true, appearance: 'light' as const, workers: effectiveWorkers(undefined) };
  let fail = false;
  const actions = settingsActions({ readSettings: async () => base, writeSettings: async () => { if (fail) throw new Error('存不了'); }, getLogin: () => false, setLogin: () => {}, setAppearance: v => { applied.push(v); } }, async () => {});
  assert.equal((await actions.get([])).appearance, 'light');
  await actions.set([{ appearance: 'dark' }]); assert.deepEqual(applied, ['dark']);
  await actions.set([{ notifications: false }]); assert.deepEqual(applied, ['dark'], '没改外观就不重复应用');
  fail = true;
  await assert.rejects(actions.set([{ appearance: 'light' }]), /存不了/); assert.deepEqual(applied, ['dark'], '保存失败不应用');
  await assert.rejects(actions.set([{ appearance: 'dim' }]), /外观/); assert.deepEqual(applied, ['dark']);
});
test('外观：切换时给 nativeTheme.themeSource 赋值并换窗口底色；窗口销毁后不动它；底色和 tokens.css 的 --bg 一致', async () => {
  const theme = { themeSource: 'system' as 'system' | 'light' | 'dark', shouldUseDarkColors: false };
  const colors: string[] = [], window = { destroyed: false, isDestroyed() { return this.destroyed; }, setBackgroundColor(c: string) { colors.push(c); } };
  applyAppearance(theme, 'dark', window); assert.equal(theme.themeSource, 'dark');
  theme.shouldUseDarkColors = true; syncBackground(theme, window);
  applyAppearance(theme, 'light', window); assert.equal(theme.themeSource, 'light');
  assert.deepEqual(colors, [windowBackground(false), windowBackground(true), windowBackground(true)], '应用时按当时系统给出的深浅取底色，系统自己切换时由 updated 事件再同步');
  window.destroyed = true; applyAppearance(theme, 'system', window); assert.equal(colors.length, 3); applyAppearance(theme, 'dark'); assert.equal(theme.themeSource, 'dark');
  const tokens = await readFile(resolve('app/renderer/styles/tokens.css'), 'utf8'), [light, dark] = tokens.split('@media (prefers-color-scheme: dark)');
  assert.equal(new RegExp(`--bg:\\s*${WINDOW_BACKGROUND.light};`).test(light), true); assert.equal(new RegExp(`--bg:\\s*${WINDOW_BACKGROUND.dark};`).test(dark), true);
});
