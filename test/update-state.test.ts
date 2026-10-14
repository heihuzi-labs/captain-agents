import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUpdater, updateActions, UPDATE_EVERY_MS, UPDATE_FIRST_MS } from '../app/main/updater.ts';
import type { UpdaterOptions, UpdateClock } from '../app/main/updater.ts';
import { updateOffReason } from '../app/main/update-runtime.ts';
import type { UpdateState } from '../app/shared/ipc.ts';
import { feed, publicKey, signed } from './update-helpers.ts';

function fixture(extra: Partial<UpdaterOptions> = {}) {
  const states: UpdateState[] = [], saved: boolean[] = [], restarted: string[] = [];
  const options: UpdaterOptions = { version: '0.1.0', platform: 'darwin', arch: 'arm64', publicKey, autoCheck: true,
    fetchFeed: async verify => verify(signed()), download: async (pkg, progress) => { progress(3); progress(pkg.size); return 'zip'; },
    prepare: async () => 'staged', restart: async (path, version) => { restarted.push(path, version); },
    saveAutoCheck: async on => { saved.push(on); }, publish: state => { states.push(state); }, ...extra };
  return { updater: createUpdater(options), states, saved, restarted };
}
function fakeClock() {
  let now = 0, next = 0; const tasks = new Map<number, { at: number; callback(): void }>();
  const clock: UpdateClock = { now: () => now, setTimeout(callback, ms) { const id = ++next; tasks.set(id, { at: now + ms, callback }); return id; }, clearTimeout(id) { tasks.delete(id as number); } };
  return { clock, tasks, async advance(ms: number) { now += ms; for (const [id, task] of [...tasks]) if (task.at <= now) { tasks.delete(id); task.callback(); } await new Promise(resolve => setImmediate(resolve)); } };
}

test('开发版、缺地址、缺公钥固定 off；其它平台 off，不调用网络', async () => {
  const base = { development: false, packaged: true, feed: 'https://example.invalid/latest.json', publicKey, platform: 'darwin' };
  assert.equal(updateOffReason(base), undefined);
  assert.equal(updateOffReason({ ...base, platform: 'win32' }), undefined);
  for (const change of [{ development: true }, { packaged: false }, { feed: '' }, { publicKey: '' }, { platform: 'linux' }]) {
    const reason = updateOffReason({ ...base, ...change }); assert.ok(reason);
    const time = fakeClock(); let calls = 0;
    const { updater } = fixture({ offReason: reason, clock: time.clock, fetchFeed: async verify => { calls++; return verify(signed()); } });
    updater.start(); await time.advance(UPDATE_EVERY_MS); assert.equal(calls, 0); assert.equal(updater.info().update.phase, 'off');
    for (const method of [updater.check, updater.download, updater.restart]) await assert.rejects(method(), new RegExp(reason));
    assert.equal(calls, 0);
    if (!('platform' in change)) assert.deepEqual(updater.info().update, { phase: 'off', reason: '这个版本不带在线更新' });
  }
});
test('检查→有新版本→下载进度→就绪→重启，桥返回的是副本', async () => {
  const { updater, states, restarted } = fixture();
  const initial = updater.info(); initial.update = { phase: 'error', message: '污染' }; assert.equal(updater.info().update.phase, 'idle');
  assert.equal((await updater.check()).phase, 'available'); await updater.download();
  assert.deepEqual(states.map(s => s.phase), ['checking', 'available', 'downloading', 'downloading', 'downloading', 'ready']);
  assert.deepEqual(states[3], { phase: 'downloading', version: '0.2.0', received: 3, size: feed().packages['darwin-arm64'].size });
  await assert.rejects(updater.check(), /已经准备好/); await updater.restart(); assert.deepEqual(restarted, ['staged', '0.2.0']); await assert.rejects(updater.restart(), /正在处理/);
});
test('相等和更旧为 idle；最低版本和缺平台为中文 error', async () => {
  for (const version of ['0.1.0', '0.0.9']) {
    const { updater } = fixture({ fetchFeed: async verify => verify(signed(feed({ version, minimumVersion: '0.0.0' }))) });
    const state = await updater.check(); assert.equal(state.phase, 'idle'); if (state.phase === 'idle') assert.ok(state.checked);
  }
  for (const extra of [{ version: '0.0.1' }, { arch: 'x64' }]) { const { updater } = fixture(extra); assert.equal((await updater.check()).phase, 'error'); }
});
for (const step of ['检查', '签名', '下载', '解压', '重启']) test(`${step}失败进入 error，之后允许重新检查`, async () => {
  const bad = async (): Promise<never> => { throw new Error('假的错误'); };
  const { updater } = fixture(step === '检查' ? { fetchFeed: bad } : step === '签名' ? { fetchFeed: async verify => verify(Buffer.from('{}')) } : step === '下载' ? { download: bad } : step === '解压' ? { prepare: bad } : { restart: bad });
  await updater.check();
  if (!['检查', '签名'].includes(step)) await updater.download();
  if (step === '重启') await updater.restart();
  const state = updater.info().update; assert.equal(state.phase, 'error'); if (state.phase === 'error') assert.match(state.message, /[\u3400-\u9fff]/u);
  await updater.check();
});
test('互斥与错误时机：检查、下载等待期间其它操作都拒绝', async () => {
  let finish!: (value: Buffer) => void;
  const { updater } = fixture({ fetchFeed: verify => new Promise(resolve => { finish = bytes => resolve(verify(bytes)); }) });
  await assert.rejects(updater.download(), /没有可下载/); await assert.rejects(updater.restart(), /还没准备好/);
  const checking = updater.check();
  for (const method of [updater.check, updater.download, updater.restart]) await assert.rejects(method(), /正在处理/);
  finish(signed()); await checking;
  let downloaded!: (path: string) => void;
  const other = fixture({ download: () => new Promise(resolve => { downloaded = resolve; }) }).updater;
  await other.check(); const downloading = other.download();
  for (const method of [other.check, other.download, other.restart]) await assert.rejects(method(), /正在处理/);
  downloaded('zip'); await downloading;
});
test('自动检查一分钟、24 小时、关闭取消、开启重排；关闭后仍可手动检查', async () => {
  const time = fakeClock(); let calls = 0;
  const { updater, saved } = fixture({ clock: time.clock, fetchFeed: async verify => { calls++; return verify(signed(feed({ version: '0.1.0' }))); } });
  updater.start(); updater.start(); assert.equal(time.tasks.size, 1);
  await time.advance(UPDATE_FIRST_MS - 1); assert.equal(calls, 0); await time.advance(1); assert.equal(calls, 1);
  await time.advance(UPDATE_EVERY_MS - 1); assert.equal(calls, 1); await time.advance(1); assert.equal(calls, 2);
  await updater.setAutoCheck(false); assert.equal(time.tasks.size, 0); await time.advance(UPDATE_EVERY_MS); assert.equal(calls, 2);
  await updater.check(); assert.equal(calls, 3);
  await updater.setAutoCheck(true); await time.advance(UPDATE_FIRST_MS); assert.equal(calls, 4); assert.deepEqual(saved, [false, true]);
  updater.stop(); await time.advance(UPDATE_EVERY_MS); assert.equal(calls, 4);
});
test('自动检查不抢下载、不丢就绪包；保存失败不改变开关', async () => {
  const time = fakeClock(); let calls = 0;
  const { updater } = fixture({ clock: time.clock, fetchFeed: async verify => { calls++; return verify(signed()); }, saveAutoCheck: async () => { throw new Error('保存失败'); } });
  updater.start(); await time.advance(UPDATE_FIRST_MS); assert.equal(calls, 1); await time.advance(UPDATE_EVERY_MS); assert.equal(calls, 1);
  await updater.download(); await time.advance(UPDATE_EVERY_MS); assert.equal(updater.info().update.phase, 'ready'); assert.equal(calls, 1);
  await assert.rejects(updater.setAutoCheck(false), /保存失败/); assert.equal(updater.info().autoCheck, true); updater.stop();
});
test('更新桥拒绝多余参数和非布尔开关', async () => {
  const { updater } = fixture(), actions = updateActions(updater);
  for (const key of ['appInfo', 'updateCheck', 'updateDownload', 'updateRestart'] as const) assert.throws(() => actions[key]([1]), /不需要参数/);
  for (const args of [[], [true, false], ['true'], [null]]) assert.throws(() => actions.setAutoUpdateCheck(args), /一个开关/);
  assert.equal(actions.appInfo([]).autoCheck, true); assert.equal((await actions.setAutoUpdateCheck([false])).autoCheck, false);
});

test('下载回退的零进度原样推送，期间不进入错误状态', async () => {
  const { updater, states } = fixture({ download: async (pkg, progress) => {
    assert.deepEqual(pkg.urls, feed().packages['darwin-arm64'].urls);
    for (const count of [3, 0, 2, pkg.size]) progress(count);
    return 'zip';
  } });
  await updater.check(); await updater.download();
  assert.deepEqual(states.filter(s => s.phase === 'downloading').map(s => s.received), [0, 3, 0, 2, feed().packages['darwin-arm64'].size]);
  assert.equal(updater.info().update.phase, 'ready');
  assert.equal(states.some(s => s.phase === 'error'), false);
});

for (const conclusion of ['没有新版', '版本过旧', '缺平台']) test(`第一份清单核对通过后${conclusion}，不请求第二份`, async () => {
  const { updateClient } = await import('../app/main/update-download.ts');
  const { response } = await import('./update-helpers.ts');
  const calls: string[] = [], first = 'https://bucket.invalid/latest-v2.json';
  const client = updateClient({ feed: `${first},https://releases.invalid/latest-v2.json`, hosts: [], version: '0.1.0', fetch: async url => {
    calls.push(url.href); return response([signed(conclusion === '没有新版' ? feed({ version: '0.1.0' }) : feed())]);
  } });
  const { updater } = fixture({ fetchFeed: client.feed, ...(conclusion === '版本过旧' ? { version: '0.0.1' } : conclusion === '缺平台' ? { arch: 'x64' } : {}) });
  const state = await updater.check(); assert.equal(state.phase, conclusion === '没有新版' ? 'idle' : 'error');
  assert.deepEqual(calls, [first]);
});
test('错误的打包清单配置不影响创建更新器，检查显示配置不正确', async t => {
  const { context, exec, root } = await import('./helpers.ts');
  const { mkdir } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const c = await context(t, false), app = join(c.temp, 'Test.app'); await mkdir(app);
  const first = 'https://feeds.invalid/latest-v2.json';
  for (const value of [`${first},${first}`, `${first},`, 'http://feeds.invalid/a', Array.from({ length: 5 }, (_, i) => `https://feeds.invalid/${i}`).join(',')]) {
    const config = { development: false, packaged: true, feed: value, publicKey, hosts: [], version: '0.1.0', platform: 'darwin', arch: 'arm64', executable: join(app, 'Contents/MacOS/Test'), userData: c.temp };
    const script = `import { desktopUpdater } from './app/main/update-runtime.ts';
      const updater = await desktopUpdater({ ...${JSON.stringify(config)}, publish() {}, quit() {} });
      console.log(JSON.stringify({ before: updater.info(), checked: await updater.check(), after: updater.info() })); updater.stop();`;
    const result = await exec(process.execPath, ['--input-type=module', '-e', script], root, c.env);
    assert.equal(result.code, 0, result.stderr);
    const state = JSON.parse(result.stdout); assert.equal(state.before.update.phase, 'idle');
    assert.equal(state.checked.phase, 'error'); assert.match(state.checked.message, /更新配置不正确/);
    assert.equal(state.after.version, '0.1.0');
  }
});
test('现在不能装（Windows 上还有活在跑）：照实报原因，不重启，更新仍是已就绪，原因消失后能装', async () => {
  let reason: string | undefined = '还有 1 件活在跑。Windows 上它们用着应用的程序文件，等做完再更新。';
  const { updater, restarted } = fixture({ blocker: async () => reason });
  await updater.check(); await updater.download();
  await assert.rejects(updater.restart(), /还有 1 件活在跑/);
  assert.deepEqual(restarted, []); assert.equal(updater.info().update.phase, 'ready');
  reason = undefined; await updater.restart(); assert.deepEqual(restarted, ['staged', '0.2.0']);
});
test('Windows 的“有活在跑”检查：没派过活（登记处文件夹都没有）时不拦', async t => {
  const { mkdtemp, rm } = await import('node:fs/promises'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const home = await mkdtemp(join(tmpdir(), 'xa-blocker-')); const before = process.env.XAGENTS_HOME;
  process.env.XAGENTS_HOME = join(home, 'missing');
  t.after(async () => { if (before === undefined) delete process.env.XAGENTS_HOME; else process.env.XAGENTS_HOME = before; await rm(home, { recursive: true, force: true }); });
  const { windowsUpdateBlocker } = await import('../app/main/update-runtime.ts');
  assert.equal(await windowsUpdateBlocker(), undefined);
});
