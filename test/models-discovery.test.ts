import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { context, root, until, desktopView } from './helpers.ts';
import { roster, whos, keptWhos, builtinWhos, workerDisplay, workerHandles, fastWhos, spec, specFor, loadRoster, isWho, allowedEfforts, launchModels, vendorOf, isolationOf, setModelsCatalog, loadWorkerHandles } from '../src/core/roster.ts';
import type { DiscoveredModel, ExtraModel, Vendor, ModelsCache } from '../src/core/roster.ts';
import { readModelsCache, refreshModels, normalizeModels, parseCodexModels, parseTextModels } from '../src/core/models.ts';
import { readSettings, loadConfiguredRoster, keepModels, writeSettings, baselineSeenModels } from '../src/core/settings.ts';
import { checkChoice } from '../src/core/policy.ts';
import { selection } from '../src/core/workers.ts';
import { buildView } from '../src/core/view.ts';
import { HANDLES, parseMentions } from '../src/core/chat.ts';
import { wakeGate } from '../src/core/wake.ts';
import type { QueryExecutor } from '../src/core/quota.ts';

const at = '2026-10-10T01:00:00.000Z';
const fresh = (model = 'gpt-6.1-sol', shown = 'GPT 6.1 Sol'): DiscoveredModel => ({ model, shown, efforts: ['medium', 'high', 'xhigh'], fast: false });
const extra = (channel: Vendor, m: DiscoveredModel): Record<string, ExtraModel> => {
  const s = specFor(channel, m);
  return { [s.who]: { ...m, channel, fast: s.fast ?? undefined, added: at } };
};
async function registry(t: TestContext, repository = false) {
  const c = await context(t, repository), previous = process.env.XAGENTS_HOME;
  process.env.XAGENTS_HOME = c.home; loadRoster(); setModelsCatalog(null);
  t.after(() => { if (previous === undefined) delete process.env.XAGENTS_HOME; else process.env.XAGENTS_HOME = previous; loadRoster(); setModelsCatalog(null); });
  return c;
}
const sample = (name: string) => readFile(join(root, 'test/fixtures/quota', name), 'utf8');
const query: QueryExecutor = c => sample(c.file === 'grok' ? 'grok-models-real.txt' : c.file === 'cursor-agent' ? 'cursor-models-real.txt' : 'codex-models-real.json');
async function cache(home: string, models: DiscoveredModel[], error?: string) {
  const value: ModelsCache = { at, channels: { codex: { at, models, ...(error === undefined ? {} : { error }) } } };
  await mkdir(join(home, 'cache'), { recursive: true });
  await writeFile(join(home, 'cache/models.json'), JSON.stringify(value));
  return value;
}

test('通道模板：内置号不变、新选手号规范化、隔离/图标/额度/强度/快速版从通道来', () => {
  loadRoster();
  for (const who of builtinWhos) assert.equal(specFor(vendorOf(who), { ...fresh(spec(who).model), fast: true }).who, who);
  const codex = specFor('codex', { ...fresh('GPT-6.1__Sol++'), fast: true });
  assert.equal(codex.who, 'codex-6-1-sol'); assert.equal(codex.fast, null); assert.equal(codex.effortInName, false);
  assert.equal(specFor('cursor', fresh('gpt-6-astra')).who, 'cursor-gpt-6-astra');
  for (const [model, badge, pool] of [['gpt-6.1-sol', 'codex', 'api'], ['claude-fable-5', 'claude', 'api'], ['grok-5', 'grok', 'auto']]) {
    const s = specFor('cursor', { ...fresh(model), fast: true });
    assert.equal(s.isolation, 'cursor'); assert.equal(s.icon, 'cursor'); assert.equal(s.badge, badge); assert.equal(s.pool, pool);
    assert.deepEqual(s.fast, { suffix: '-fast' }); assert.equal(s.effortInName, true);
  }
  assert.deepEqual(specFor('grok', { ...fresh('grok-5'), fast: true }).fast, { model: 'grok-5-build-fast' });
  assert.throws(() => specFor('deepseek', fresh('deepseek-future')), /内置/);
  assert.throws(() => specFor('cursor', fresh('gemini-9')), /只收/);
  assert.throws(() => specFor('grok', fresh('grok-5-fast')), /基础/);
  assert.throws(() => specFor('codex', { ...fresh(), efforts: ['max'] as never[] }), /强度/);
});

test('装载原地更新所有派生清单，handle 去标点并避开内置/新增重名，重新装载可回到八位', () => {
  const before = [roster, whos, workerDisplay, fastWhos, HANDLES];
  const entries = { ...extra('codex', fresh('gpt-6.1-sol', 'Grok')), ...extra('cursor', { ...fresh('gpt-6.1-sol', 'G r o k!'), fast: true }) };
  loadRoster(entries, ['grok']);
  assert.deepEqual([roster, whos, workerDisplay, fastWhos, HANDLES], before);
  assert.throws(() => selection('codex-6-1-sol:high:fast'), /没有快速版：Codex 的快速档位/);
  assert.ok(isWho('codex-6-1-sol')); assert.equal(HANDLES['codex-6-1-sol'], 'Grok2'); assert.equal(HANDLES['cursor-gpt-6-1-sol'], 'Grok3');
  assert.deepEqual(parseMentions('@Grok2 @grok3', whos), ['codex-6-1-sol', 'cursor-gpt-6-1-sol']);
  assert.equal(workerHandles, HANDLES); assert.ok(!keptWhos.includes('grok')); assert.ok(whos.includes('grok'));
  assert.equal(isolationOf('codex-6-1-sol'), 'codex'); assert.equal(vendorOf('cursor-gpt-6-1-sol'), 'cursor');
  assert.deepEqual(allowedEfforts('codex-6-1-sol'), ['medium', 'high', 'xhigh']);
  assert.ok(fastWhos.includes('cursor-gpt-6-1-sol')); assert.equal(selection('cursor-gpt-6-1-sol:xhigh:fast').model, 'gpt-6.1-sol-xhigh-fast');
  assert.ok(launchModels().some(m => m.who === 'codex-6-1-sol' && m.model === 'gpt-6.1-sol'));
  const display = structuredClone(workerDisplay);
  loadWorkerHandles({}); assert.equal(HANDLES['codex-6-1-sol'], undefined);
  loadWorkerHandles(display); assert.equal(HANDLES['codex-6-1-sol'], 'Grok2');
  loadRoster(); assert.equal(whos.length, 8); assert.equal(HANDLES['codex-6-1-sol'], undefined);
});

test('新模型的中文短名可被 @，与核心展示的 handle 一致', () => {
  loadRoster(extra('codex', fresh('gpt-7', '中文 模型！')));
  assert.equal(spec('codex-7').handle, '中文模型');
  assert.deepEqual(parseMentions('@中文模型 请继续 @主人', ['codex-7']), ['codex-7', 'owner']);
  loadRoster();
});

test('发现：Codex 只收公开且有允许强度的模型，保留描述；Cursor 合并强度/快速版，只收三家', async () => {
  const codex = normalizeModels('codex', parseCodexModels(await sample('codex-models-real.json')));
  assert.ok(codex.length); assert.ok(!codex.some(m => m.model === 'gpt-reserve'));
  assert.ok(codex.every(m => !m.fast && m.efforts.length && m.efforts.every(e => ['medium', 'high', 'xhigh'].includes(e))));
  assert.match(codex[0].description!, /Frontier/);
  assert.deepEqual(normalizeModels('codex', parseCodexModels(JSON.stringify([
    { slug: 'gpt-hidden', visibility: 'hide', supported_reasoning_levels: [{ effort: 'high' }] },
    { slug: 'gpt-none', visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'max' }] },
    { slug: 'gpt-valid', display_name: 'Valid', visibility: 'list', supported_reasoning_levels: [{ effort: 'xhigh' }, { effort: 'max' }] },
  ]))), [{ model: 'gpt-valid', shown: 'Valid', efforts: ['xhigh'], fast: false }]);
  const cursor = normalizeModels('cursor', parseTextModels(await sample('cursor-models-real.txt'), 'cursor'));
  assert.ok(cursor.every(m => /^(claude|gpt|grok)-/.test(m.model) && m.efforts.length));
  assert.equal(new Set(cursor.map(m => m.model)).size, cursor.length);
  assert.ok(!cursor.some(m => m.model === 'gpt-5.5-extra'));
  assert.deepEqual(cursor.find(m => m.model === 'claude-sonnet-5-5')?.efforts, ['medium', 'high', 'xhigh']);
  assert.equal(cursor.find(m => m.model === 'claude-sonnet-5-5')?.fast, false);
  const one = normalizeModels('cursor', parseTextModels('gpt-6.1-sol-medium - GPT 6.1 Sol Medium\ngpt-6.1-sol-high-fast - GPT 6.1 Sol High Fast\ngemini-9-high - Gemini\nclaude-future-max - Claude Max', 'cursor'));
  assert.deepEqual(normalizeModels('cursor', parseTextModels('gemini-9-high - Gemini High', 'cursor')), []);
  assert.deepEqual(one, [{ model: 'gpt-6.1-sol', shown: 'GPT 6.1 Sol', efforts: ['medium', 'high'], fast: true }]);
  const grok = normalizeModels('grok', parseTextModels('grok-5 - Grok 5\ngrok-5-build-fast - Fast\ngrok-4 - Grok 4\ngrok-4-fast - Legacy Fast\nclaude-x-high - Other', 'grok'));
  assert.deepEqual(grok.map(m => [m.model, m.fast]), [['grok-5', true], ['grok-4', false]]);
});

test('刷新写完整原子缓存；一家失败保留上次名单；并发失败不丢名单；读取不落盘', async t => {
  const c = await registry(t);
  assert.equal(await readModelsCache(), null); assert.deepEqual(await readdir(c.home), []);
  const first = await refreshModels(query);
  const second = await refreshModels(async command => { if (command.file === 'grok') throw new Error('程序没装'); return query(command); });
  assert.equal(second.channels.grok?.error, '程序没装'); assert.deepEqual(second.channels.grok?.models, first.channels.grok?.models);
  assert.equal(second.channels.codex?.error, undefined); assert.equal(second.channels.cursor?.error, undefined);
  await Promise.all([refreshModels(query), refreshModels(async () => { throw new Error('超时'); })]);
  const last = (await readModelsCache())!; assert.ok(last.channels.grok?.models.length);
  const before = await readFile(join(c.home, 'cache/models.json'), 'utf8');
  assert.deepEqual(await readModelsCache(), last); assert.equal(await readFile(join(c.home, 'cache/models.json'), 'utf8'), before);
  assert.deepEqual(await readdir(join(c.home, 'cache')), ['models.json']);
  await writeFile(join(c.home, 'cache/models.json'), '{'); assert.equal(await readModelsCache(), null);
  await writeFile(join(c.home, 'cache/models.json'), JSON.stringify({ at, channels: { codex: { at, models: [null] } } }));
  assert.equal((await readModelsCache())?.channels.codex, undefined);
});

test('保留整份替换，保存全信息和 seen，新模型策略默认开启；取消与重选保留旧策略', async t => {
  const c = await registry(t), m = { ...fresh(), description: '新的主力' };
  await cache(c.home, [m]);
  await keepModels('codex', [m.model]);
  let read = await readSettings();
  assert.deepEqual(read.models.dropped, ['codex', 'codex-luna']); assert.deepEqual(read.models.seen.codex, [m.model]);
  assert.equal(read.models.extra['codex-6-1-sol'].description, m.description);
  assert.deepEqual(read.workers['codex-6-1-sol'], { enabled: true, efforts: m.efforts, fast: false });
  await writeSettings({ workers: { 'codex-6-1-sol': { enabled: false, efforts: ['high'], fast: false } } });
  await keepModels('codex', []); assert.ok((await readSettings()).models.extra['codex-6-1-sol']);
  // 名单下线后仍可重新勾选历史选手，但派活被拦。
  await cache(c.home, []); await keepModels('codex', [m.model]);
  read = await readSettings(); assert.equal(read.workers['codex-6-1-sol'].enabled, false); assert.deepEqual(read.workers['codex-6-1-sol'].efforts, ['high']);
  assert.throws(() => checkChoice(read.workers, selection('codex-6-1-sol:high')), /已经不在/);
});

test('保留拒绝未知通道、错误/稀疏/重复模型列表、跨家模型、DeepSeek 新模型、选手号冲突与最后一位', async t => {
  const c = await registry(t); await cache(c.home, [fresh(), fresh('gpt-luna'), fresh('gpt-a.b'), fresh('gpt-a-b')]);
  for (const [channel, models] of [['bad', []], ['__proto__', []], ['codex', null], ['codex', new Array(1)], ['codex', ['gpt-6.1-sol', 'gpt-6.1-sol']], ['codex', ['--help']], ['codex', ['absent']], ['grok', ['gpt-6.1-sol']], ['deepseek', ['deepseek-new']]]) await assert.rejects(keepModels(channel, models));
  await assert.rejects(keepModels('codex', ['gpt-luna']), /冲突/);
  await assert.rejects(keepModels('codex', ['gpt-a.b', 'gpt-a-b']), /冲突/);
  assert.ok(!(await readdir(c.home)).includes('config.json'));
  for (const channel of ['codex', 'grok', 'cursor']) await keepModels(channel, []);
  await keepModels('deepseek', ['deepseek-flash']);
  const before = await readFile(join(c.home, 'config.json'), 'utf8');
  await assert.rejects(keepModels('deepseek', []), /至少保留一位/);
  assert.equal(await readFile(join(c.home, 'config.json'), 'utf8'), before);
  assert.deepEqual(keptWhos, ['deepseek-flash']);
});

test('坏模型配置逐项回退、不写盘、不允许注入隔离/快速版/最高强度；普通设置不能改模型', async t => {
  const c = await registry(t);
  const value = { models: { extra: { ...extra('codex', fresh()), 'cursor-gemini-9': { channel: 'cursor', ...fresh('gemini-9'), added: at },
    'grok-5': { channel: 'grok', ...fresh('grok-5'), added: at, fast: { model: 'grok-admin' } },
    'codex-8': { channel: 'codex', ...fresh('gpt-8'), efforts: ['max'], added: at } }, dropped: ['codex', 'unknown', 8], seen: { cursor: [null, 'gpt-8'], other: ['bad'] } } };
  const file = join(c.home, 'config.json'); await writeFile(file, JSON.stringify(value));
  const read = await readSettings(); assert.deepEqual(Object.keys(read.models.extra), ['codex-6-1-sol']); assert.deepEqual(read.models.dropped, ['codex']);
  assert.deepEqual(read.models.seen, { cursor: ['gpt-8'] }); assert.equal(await readFile(file, 'utf8'), JSON.stringify(value));
  await assert.rejects(writeSettings({ models: {} } as never));
});

test('View.models 的四个状态、只读；历史名单和档案保留，View.roster 与 workers 命令过滤取消项', async t => {
  // 第一次问到这一家：还没有基线，谁都不算新；记下基线后，再冒出来的才标“新”。
  const c = await registry(t); await cache(c.home, [fresh('gpt-7')]);
  let v = await buildView();
  const model = (model: string) => v.models.channels.find(c => c.channel === 'codex')!.models.find(m => m.model === model)!;
  assert.equal(model('gpt-7').fresh, false);
  await baselineSeenModels(await readModelsCache());
  await baselineSeenModels(await readModelsCache());   // 已有基线的通道不动
  await cache(c.home, [fresh(), fresh('gpt-7')]);
  v = await buildView(); assert.equal(model('gpt-7').fresh, false);
  assert.deepEqual([model('gpt-6.1-sol').fresh, model('gpt-6.1-sol').kept, model('gpt-6.1-sol').builtin, model('gpt-6.1-sol').gone], [true, false, false, false]);
  assert.equal(model('gpt-6-astra').builtin, true); assert.equal(model('gpt-6-astra').gone, true);
  assert.equal(v.models.channels.find(c => c.channel === 'deepseek')!.discoverable, false);
  assert.ok(v.models.channels.find(c => c.channel === 'deepseek')!.models.every(m => !m.gone && m.builtin));
  await keepModels('codex', ['gpt-6.1-sol']);
  v = await buildView(); assert.equal(model('gpt-7').fresh, false); assert.equal(model('gpt-6.1-sol').kept, true);
  await mkdir(join(c.home, 'jobs/history'), { recursive: true });
  await writeFile(join(c.home, 'jobs/history/job.json'), JSON.stringify({ id: 'history', who: 'codex-6-1-sol', model: 'gpt-6.1-sol', created: at, started: at, ended: at, state: 'done', project: '历史项目', kind: '实现', title: '旧记录', effort: 'high', decision: { kind: 'drop', at }, rating: { score: 4, tags: [], at } }));
  await keepModels('codex', []);
  const before = await readFile(join(c.home, 'config.json'), 'utf8');
  v = await desktopView(c.home); assert.equal(v.jobs[0].who, 'codex-6-1-sol'); assert.ok(v.workers['codex-6-1-sol']);
  assert.ok(v.profiles.some(p => p.who === 'codex-6-1-sol')); assert.ok(!v.roster.some(r => r.who === 'codex-6-1-sol'));
  assert.equal(await readFile(join(c.home, 'config.json'), 'utf8'), before);
  assert.ok(!(await c.cli(['workers'])).stdout.includes('codex-6-1-sol'));
  await cache(c.home, [], '没登录'); v = await buildView(); assert.equal(model('gpt-6-astra').gone, false);
});

test('派活/叫醒都拦未保留和已下线，force 无效，失败查询不误判下线', async t => {
  const c = await registry(t, true); assert.equal((await c.add()).code, 0);
  await cache(c.home, [fresh()]); await keepModels('codex', ['gpt-6.1-sol']);
  for (const [who, message] of [['codex', /没有保留/], ['codex-6-1-sol', /已经不在/]] as const) {
    if (who !== 'codex') await cache(c.home, []);
    for (const force of [false, true]) {
      const result = await c.cli(['run', c.task, '--summary', '拒绝测试', '--who', `${who}:high`, ...(force ? ['--force'] : [])]);
      assert.equal(result.code, 1); assert.match(result.stderr, message);
    }
    await loadConfiguredRoster(); assert.match((await wakeGate(selection(`${who}:high`)))!.note, message);
  }
  assert.deepEqual(await c.jobs(), []);
  await cache(c.home, [], '超时');
  const policy = (await readSettings()).workers;
  assert.doesNotThrow(() => checkChoice(policy, selection('codex-6-1-sol:high')));
});

test('新进程 CLI --who/看管启动新模型，记录和实际 -m 正确；落盘后不依赖发现程序', async t => {
  const c = await registry(t, true); assert.equal((await c.add()).code, 0);
  await cache(c.home, [fresh()]); await keepModels('codex', ['gpt-6.1-sol']);
  const result = await c.cli(['run', c.task, '--summary', '新增模型派活', '--who', 'codex-6-1-sol:high']);
  assert.equal(result.code, 0, result.stderr);
  const done = await until(async () => (await c.jobs())[0], j => j?.state === 'done' || j?.state === 'failed');
  assert.equal(done.state, 'done', done.error); assert.equal(done.model, 'gpt-6.1-sol');
  const observed = JSON.parse(await readFile(join(c.home, 'jobs', done.id, 'observed.json'), 'utf8'));
  assert.equal(observed.args[observed.args.indexOf('-m') + 1], 'gpt-6.1-sol');
  assert.match((await c.cli(['--help'])).stdout, /codex-6-1-sol/);
});

test('五个进程入口都有装载；模型刷新命令只记基线、不动保留，坏子命令被拒', async t => {
  const c = await registry(t);
  for (const entry of ['src/cli/cli.ts', 'src/core/worker-entry.ts', 'src/core/team-entry.ts', 'src/core/chat-entry.ts', 'app/main/index.ts']) {
    assert.match(await readFile(join(root, entry), 'utf8'), /await loadConfiguredRoster\(\)/);
  }
  const result = await c.cli(['models', 'refresh'], { XAGENTS_QUERY_EXEC: join(root, 'test/fixtures/quota/query.ts') });
  assert.equal(result.code, 0, result.stderr); assert.match(result.stdout, /保留/); assert.ok(await readModelsCache());
  // 刷新只给第一次问到的通道记基线（seen），不替主人保留或取消任何模型。
  const config = JSON.parse(await readFile(join(c.home, 'config.json'), 'utf8'));
  assert.deepEqual(Object.keys(config), ['models']); assert.deepEqual(config.models.extra, {}); assert.deepEqual(config.models.dropped, []);
  assert.ok(Object.values(config.models.seen as Record<string, string[]>).every(list => list.length > 0));
  assert.equal((await c.cli(['models', 'keep', 'codex'])).code, 1);
});

test('独立推进进程：小队和群聊能启动新选手，群聊续接前重新检查取消保留', async t => {
  const c = await registry(t, true); assert.equal((await c.add()).code, 0);
  await cache(c.home, [fresh()]); await keepModels('codex', ['gpt-6.1-sol']);
  const start = await c.cli(['team', 'start', c.task, '--summary', '新增模型写作搭档', '--writer', 'codex-6-1-sol:high', '--reviewer', 'grok:high']);
  assert.equal(start.code, 0, start.stderr);
  const teams = await readdir(join(c.home, 'teams'));
  const teamId = teams.find(n => !n.startsWith('.'))!;
  const readTeam = async () => JSON.parse(await readFile(join(c.home, 'teams', teamId, 'team.json'), 'utf8'));
  t.after(async () => { const team = await readTeam().catch(() => null); if (team?.pid) { try { process.kill(team.pid, 'SIGKILL'); } catch {} } });
  const team = await until(readTeam, v => v.state !== 'running', 30_000);
  assert.equal(team.reason, 'passed', team.note); assert.equal(team.writer.who, 'codex-6-1-sol');
  const created = await c.cli(['chat', 'new', '测试', '--member', 'codex-6-1-sol:high', '--title', '新增模型群聊']);
  assert.equal(created.code, 0, created.stderr);
  const chatId = (await readdir(join(c.home, 'chats'))).find(n => !n.startsWith('.'))!;
  const readChat = async () => JSON.parse(await readFile(join(c.home, 'chats', chatId, 'chat.json'), 'utf8'));
  t.after(async () => { const chat = await readChat().catch(() => null); if (chat?.pid) { try { process.kill(chat.pid, 'SIGKILL'); } catch {} } });
  const said = await c.cli(['chat', 'say', chatId, '@GPT61Sol 做一遍']); assert.equal(said.code, 0, said.stderr);
  const first = await until(readChat, v => v.members[0].job && !v.pid && !v.busy && !v.queue.length, 30_000);
  const jobId = first.members[0].job;
  const firstJob = (await c.jobs()).find(j => j.id === jobId)!; assert.equal(firstJob.state, 'done', firstJob.error);
  const saidAgain = await c.cli(['chat', 'say', chatId, '@GPT61Sol 再做一遍']); assert.equal(saidAgain.code, 0, saidAgain.stderr);
  await until(async () => ({ chat: await readChat(), job: (await c.jobs()).find(j => j.id === jobId)! }), v => !v.chat.pid && v.job.resume?.round === 2 && v.job.state === 'done', 30_000);
  await keepModels('codex', []);
  const blocked = await c.cli(['chat', 'say', chatId, '@GPT61Sol 第三次']); assert.equal(blocked.code, 0, blocked.stderr);
  await until(readChat, v => !v.pid && !v.busy && !v.queue.length, 30_000);
  const messages = await readFile(join(c.home, 'chats', chatId, 'messages.jsonl'), 'utf8'); assert.match(messages, /没有保留/);
  assert.equal((await c.jobs()).find(j => j.id === jobId)?.resume?.round, 2);
});

test('保留与设置并发更新在同一把锁里，不丢其他家的选择或原设置', async t => {
  const c = await registry(t); await cache(c.home, [fresh()]);
  await Promise.all([keepModels('codex', ['gpt-6.1-sol']), keepModels('grok', []), writeSettings({ notifications: false })]);
  const current = await readSettings();
  assert.equal(current.notifications, false); assert.ok(current.models.extra['codex-6-1-sol']);
  assert.deepEqual(new Set(current.models.dropped), new Set(['codex', 'codex-luna', 'grok']));
  assert.deepEqual((await readdir(c.home)).filter(n => n === '.lock' || n.endsWith('.tmp')), []);
});

test('Cursor 合并回一个模型时，名字里的档位字样（Low、None、Fast、No Thinking）去掉，别的留着', () => {
  const list = [
    { slug: 'gpt-5.5-none', name: 'GPT-5.5 1M None' }, { slug: 'gpt-5.5-high', name: 'GPT-5.5 1M High' }, { slug: 'gpt-5.5-high-fast', name: 'GPT-5.5 1M High Fast' },
    { slug: 'claude-haiku-5-5-low', name: 'Claude Haiku 5.5  Low No Thinking' }, { slug: 'claude-haiku-5-5-medium', name: 'Claude Haiku 5.5 Medium No Thinking' },
    { slug: 'claude-fable-5-1-thinking-low', name: 'Claude Fable 5.1 1M Low Thinking (NO ZDR)' }, { slug: 'claude-fable-5-1-thinking-xhigh', name: 'Claude Fable 5.1 1M XHigh Thinking (NO ZDR)' },
    // 带思考的那版名字里没写 Thinking：补上，不和上面那行同名。
    { slug: 'claude-haiku-5-5-thinking-high', name: 'Claude Haiku 5.5  High' },
  ];
  assert.deepEqual(normalizeModels('cursor', list).map(m => [m.model, m.shown, m.efforts.join(','), m.fast]), [
    ['gpt-5.5', 'GPT-5.5 1M', 'high', true], ['claude-haiku-5-5', 'Claude Haiku 5.5', 'medium', false], ['claude-fable-5-1-thinking', 'Claude Fable 5.1 1M Thinking (NO ZDR)', 'xhigh', false],
    ['claude-haiku-5-5-thinking', 'Claude Haiku 5.5 Thinking', 'high', false]]);
});
