import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { context, fixture, root } from './helpers.ts';
import { checkListed, listedProviders, listedWho, unlistedProviders } from '../src/core/listed.ts';
import { buildView } from '../src/core/view.ts';
import { checkQuota, ensureQuota, queryQuota, readQuotaCache } from '../src/core/quota.ts';
import type { QuotaSnapshot } from '../src/core/quota.ts';
import { readSettings, writeSettings } from '../src/core/settings.ts';
import { whos, isolationOf } from '../src/core/roster.ts';
import { shell } from '../src/core/platform.ts';
import { guideAppendix } from '../src/core/guide.ts';

const allFound = async () => true;
async function local(t: Parameters<typeof context>[0], repository = false) {
  const c = await context(t, repository);
  const changes = { XAGENTS_HOME: c.home, CODEX_HOME: join(c.temp, 'codex-config'), XAGENTS_FAKE_WORKER: fixture };
  for (const [key, value] of Object.entries(changes)) {
    const old = process.env[key]; process.env[key] = value;
    t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
  }
  await mkdir(changes.CODEX_HOME);
  await mkdir(join(c.home, 'cache'));
  return { ...c, config: join(changes.CODEX_HOME, 'config.toml') };
}
const oldQuota = (): QuotaSnapshot => ({ queriedAt: new Date().toISOString(), providers: [
  { icon: 'codex', name: 'Codex', plan: 'pro', at: null, reached: 'week', bars: [{ label: '周额度', used: 99, reset: null, windowMinutes: 10080 }] },
  { icon: 'grok', name: 'Grok', plan: null, at: null, bars: [{ label: '本期额度', used: 12, reset: null }] },
  { icon: 'cursor', name: 'Cursor', plan: null, at: null, bars: [] },
] });
const custom = 'model_provider = "test"\n[model_providers.test]\nbase_url = "https://example.invalid/v1"\n';

test('按参数测两种系统：程序缺失、平台未开放，一家一个原因；DeepSeek 跟 Codex', async () => {
  for (const windows of [false, true]) {
    const listed = await listedProviders({ windows, found: allFound });
    assert.deepEqual(listed.filter(p => p.reason === null).map(p => p.icon), windows ? ['codex'] : ['codex', 'grok', 'cursor']);
    assert.equal(listedWho(listed, 'deepseek'), true);
    if (windows) {
      assert.deepEqual(unlistedProviders(listed), [
        { name: 'Grok', reason: 'Grok 在 Windows 版上暂时不能派' },
        { name: 'Cursor', reason: 'Cursor 在 Windows 版上暂时不能派' },
      ]);
      assert.throws(() => checkListed(listed, [{ who: 'cursor-opus' }]), /^Error: Cursor 在 Windows 版上暂时不能派$/);
    }
    const missing = await listedProviders({ windows, found: async () => false });
    assert.equal(listedWho(missing, 'codex'), false);
    assert.equal(listedWho(missing, 'deepseek-flash'), false);
    assert.throws(() => checkListed(missing, [{ who: 'deepseek' }]), /^Error: 这台电脑上没找到 Codex$/);
    assert.equal(unlistedProviders(missing).length, 3);
  }
});

test('真实查找用 Codex 派活路径；替身下三家都算找到，平台限制仍生效', async t => {
  const c = await local(t);
  for (const windows of [false, true]) {
    const listed = await listedProviders({ windows });
    assert.equal(listed.filter(p => p.reason === null).length, windows ? 1 : 3);
  }
  const old = process.env.XAGENTS_CODEX;
  t.after(() => { if (old === undefined) delete process.env.XAGENTS_CODEX; else process.env.XAGENTS_CODEX = old; });
  delete process.env.XAGENTS_FAKE_WORKER;
  process.env.XAGENTS_CODEX = join(c.temp, 'missing-codex');
  assert.equal((await listedProviders({ windows: true }))[0].reason, '这台电脑上没找到 Codex');
  process.env.XAGENTS_CODEX = c.task;
  assert.equal((await listedProviders({ windows: true }))[0].reason, null);
  process.env.XAGENTS_CODEX = c.temp;
  assert.equal((await listedProviders({ windows: true }))[0].reason, '这台电脑上没找到 Codex');
  // shell 与派活用同一搜索路径；先定位 Windows 的 Git sh，再切到完全受控的 PATH。
  shell('true');
  const bin = join(c.temp, 'bin'); await mkdir(bin);
  const previousPath = process.env.PATH; process.env.PATH = bin;
  t.after(() => { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; });
  await writeFile(join(bin, 'grok'), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
  let listed = await listedProviders({ windows: false });
  assert.equal(listed.find(p => p.icon === 'grok')?.reason, null);
  assert.equal(listed.find(p => p.icon === 'cursor')?.reason, '这台电脑上没找到 Cursor');
  await writeFile(join(bin, 'cursor-agent'), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
  listed = await listedProviders({ windows: false });
  assert.equal(listed.find(p => p.icon === 'cursor')?.reason, null);
});

test('看板只列找到且平台开放的选手和额度；设置原样保留；每次重新检查', async t => {
  const c = await local(t);
  const stored = { workers: { grok: { enabled: false, efforts: ['high'], fast: false } } };
  await writeFile(join(c.home, 'config.json'), JSON.stringify(stored));
  await writeFile(join(c.home, 'cache/quota.json'), JSON.stringify(oldQuota()));
  for (const windows of [false, true]) {
    const view = await buildView({ windows, found: async icon => icon !== 'cursor' });
    assert.deepEqual(view.roster.map(p => p.who), whos.filter(w => windows ? isolationOf(w) === 'codex' : isolationOf(w) !== 'cursor'));
    assert.deepEqual(view.quota.map(p => p.icon), windows ? ['codex'] : ['codex', 'grok']);
    assert.equal(view.unlisted.length, windows ? 2 : 1);
    assert.deepEqual(view.settings.workers.grok, stored.workers.grok);
  }
  assert.equal((await buildView({ windows: false, found: allFound })).roster.length, whos.length);
  assert.equal((await buildView({ windows: false, found: async () => false })).roster.length, 0);
  assert.deepEqual(JSON.parse(await readFile(join(c.home, 'config.json'), 'utf8')), stored);
});

test('没找到程序直接拒绝，force 不放行；没有任务、批次或副本', async t => {
  const c = await context(t);
  await c.add();
  for (const who of ['codex:high', 'deepseek:high']) {
    const result = await c.cli(['run', c.task, '--summary', '测试未安装的程序', '--who', who, '--force'], {
      XAGENTS_FAKE_WORKER: '', XAGENTS_CODEX: join(c.temp, 'missing-codex'), PATH: '',
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /这台电脑上没找到 Codex/);
  }
  assert.deepEqual(await c.jobs(), []);
  const { readdir } = await import('node:fs/promises');
  assert.deepEqual(await readdir(join(c.home, 'batches')), []);
  assert.deepEqual(await c.git(['worktree', 'list', '--porcelain']).then(s => s.match(/^worktree /gm)), ['worktree ']);
});

test('workers 和手册只列本机选手，未列出原因在末尾；无额度缓存也说明自定义接口', async t => {
  const c = await local(t);
  const result = await c.cli(['workers'], { XAGENTS_FAKE_WORKER: '', XAGENTS_CODEX: c.task, PATH: '' });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Codex（codex）/);
  assert.doesNotMatch(result.stdout, /Grok（grok）|Cursor ·/);
  assert.match(result.stdout.trim().split('\n').at(-1)!, /Grok.*；.*Cursor/);
  await writeFile(c.config, custom);
  const guide = await guideAppendix({ windows: true, found: allFound });
  assert.match(guide, /Codex：接的是自定义接口，不查额度/);
  assert.doesNotMatch(guide, /（grok）|（cursor-opus）|- Grok：|- Cursor/);
  assert.equal(guide.trim().split('\n').at(-1), 'Grok 在 Windows 版上暂时不能派；Cursor 在 Windows 版上暂时不能派');
});

test('自定义接口不碰会话记录，丢弃旧数字和触顶标记；缓存、看板、停派检查都不带 Codex', async t => {
  const c = await local(t, true), cache = join(c.home, 'cache/quota.json');
  await c.add();
  await writeFile(cache, JSON.stringify(oldQuota()));
  await writeFile(c.config, custom);
  const read = await readQuotaCache();
  assert.deepEqual(read?.providers.map(p => p.icon), ['grok', 'cursor']);
  const fresh = await ensureQuota({ windows: false, found: allFound });
  assert.doesNotThrow(() => checkQuota(fresh, [{ who: 'codex' }, { who: 'codex-luna' }, { who: 'deepseek' }], false, 50));
  assert.deepEqual((await buildView({ windows: false, found: allFound })).quota.map(p => p.icon), ['grok', 'cursor']);
  const dispatched = await c.cli(['run', c.task, '--summary', '自定义接口不按旧额度停派', '--who', 'codex:high']);
  assert.equal(dispatched.code, 0, dispatched.stderr);
  assert.equal((await c.jobs())[0].quota_before?.providers.some(p => p.icon === 'codex'), false);
  let sessionReads = 0;
  const snapshot = await queryQuota({ windows: false, found: allFound,
    get sessionsDir() { sessionReads++; throw new Error('不该读取会话目录'); },
    execute: async () => { throw new Error('离线测试'); },
  });
  assert.equal(sessionReads, 0);
  assert.deepEqual(snapshot.providers.map(p => p.icon), ['grok', 'cursor']);
  assert.equal(snapshot.providers[0].bars[0].used, 12, '其他厂家仍保留上次数据');
  assert.deepEqual(JSON.parse(await readFile(cache, 'utf8')), snapshot);
  assert.doesNotMatch(await readFile(cache, 'utf8'), /codex|Codex|99|week/);
  const cli = await c.cli(['quota'], { CODEX_HOME: join(c.temp, 'codex-config') });
  assert.equal(cli.code, 0, cli.stderr);
  assert.match(cli.stdout, /Codex：接的是自定义接口，不查额度/);
  assert.doesNotMatch(cli.stdout, /99%|已触顶/);
});

test('部分厂家、空缓存合法；重复或未知厂家非法；切回官方及时补查 Codex', async t => {
  const c = await local(t), cache = join(c.home, 'cache/quota.json');
  for (const providers of [[], oldQuota().providers.slice(1)]) {
    const snapshot = { queriedAt: new Date().toISOString(), providers };
    await writeFile(cache, JSON.stringify(snapshot));
    assert.deepEqual(await readQuotaCache(), snapshot);
  }
  for (const providers of [[oldQuota().providers[0], oldQuota().providers[0]], [{ ...oldQuota().providers[0], icon: 'unknown' }]]) {
    await writeFile(cache, JSON.stringify({ queriedAt: new Date().toISOString(), providers }));
    assert.equal(await readQuotaCache(), null);
  }
  await writeFile(cache, JSON.stringify({ queriedAt: new Date().toISOString(), providers: [] }));
  const official = await ensureQuota({ windows: true, found: allFound, sessionsDir: join(root, 'test/fixtures/quota') });
  assert.equal(official.providers.length, 1);
  assert.equal(official.providers[0].bars[1].used, 63.2);
  await writeFile(c.config, custom);
  assert.deepEqual((await queryQuota({ windows: true, found: allFound })).providers, []);
});

test('更新可见选手时不抹掉隐藏厂家的设置，不能靠隐藏选手保住最后一个开关', async t => {
  const c = await local(t);
  // 只有 Codex 文件存在；Grok/Cursor 搜索路径留空，且不启动任何真实程序。
  delete process.env.XAGENTS_FAKE_WORKER;
  const oldPath = process.env.PATH, oldCodex = process.env.XAGENTS_CODEX;
  process.env.PATH = ''; process.env.XAGENTS_CODEX = c.task;
  t.after(() => {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    if (oldCodex === undefined) delete process.env.XAGENTS_CODEX; else process.env.XAGENTS_CODEX = oldCodex;
  });
  const initial = await readSettings();
  const off = Object.fromEntries(whos.filter(w => isolationOf(w) === 'codex').map(w => [w, { ...initial.workers[w], enabled: false }]));
  await assert.rejects(writeSettings({ workers: off }), /至少要有一位选手开着/);
  await writeSettings({ workers: { codex: { ...initial.workers.codex, efforts: ['high'] } } });
  assert.deepEqual((await readSettings()).workers.grok, initial.workers.grok);
});
