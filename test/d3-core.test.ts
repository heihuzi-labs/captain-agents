import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir, mkdir, rm, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { TestContext } from 'node:test';
import { context } from './helpers.ts';
import { createJob, readJob, updateJob } from '../src/core/job.ts';
import type { Job } from '../src/core/job.ts';
import { decide, requestRedo, markHandled } from '../src/core/decide.ts';
import { readSettings, writeSettings } from '../src/core/settings.ts';
import { effectiveWorkers } from '../src/core/policy.ts';
import { SleepMonitor } from '../src/core/sleeps.ts';
import { buildView } from '../src/core/view.ts';
import { ensureHome } from '../src/core/paths.ts';
import { addComment, awaitingReply, pendingComments } from '../src/core/comments.ts';
import { ownerActions, waitForJobs } from '../src/core/wait.ts';
import type { WaitIO } from '../src/core/wait.ts';
import { describeAction, wait } from '../src/cli/commands.ts';
import { localTime } from '../src/cli/format.ts';

async function registry(t: TestContext) {
  const c = await context(t, false), before = process.env.XAGENTS_HOME;
  process.env.XAGENTS_HOME = c.home;
  t.after(() => { if (before === undefined) delete process.env.XAGENTS_HOME; else process.env.XAGENTS_HOME = before; });
  await ensureHome();
  const job: Job = {
    id: 'one', batch: '', who: 'codex', model: 'test', effort: 'high', project: '测试',
    repo: c.repo, base: 'test', worktree: c.repo, branch: 'test', mode: 'read-only', kind: '实现',
    title: '题目', summary: '让主人能看清进展', state: 'done', created: '2026-09-29T00:00:00.000Z',
  };
  await createJob(job);
  return { ...c, job };
}

test('派活缺 summary、空白、超长或控制字符时拒绝，尚未登记任务', async t => {
  const c = await context(t, false);
  const missing = await c.cli(['run', c.task, '--who', 'codex:high']);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /请用 --summary 写一两句给主人看的‘要做什么’，用大白话，不写文件名和技术细节。/);
  for (const summary of ['   ', '文'.repeat(201), '进展\n说明', '\t进展']) {
    const result = await c.cli(['run', c.task, '--who', 'codex:high', '--summary', summary]);
    assert.equal(result.code, 1); assert.match(result.stderr, /--summary/);
  }
  assert.deepEqual(await c.jobs(), []);
  assert.deepEqual(await readdir(join(c.home, 'batches')), []);
  assert.match((await c.cli(['--help'])).stdout, /--note 给主人看的结论/);
});

test('主人拍板只记记录；负责人照办时保留原选择和时间，写结论与 handled', async t => {
  const c = await registry(t);
  for (const kind of ['adopt', 'drop'] as const) {
    await updateJob('one', j => { delete j.decision; });
    const owner = await decide('one', kind, '主人的话', 'owner');
    assert.equal(owner.state, 'done'); assert.equal(owner.decision?.by, 'owner');
    assert.equal(owner.decision?.kind, kind); assert.ok(Date.parse(owner.decision!.at));
    assert.equal(owner.decision?.handled, undefined);
    assert.deepEqual(await readdir(c.repo), []); // 无 git 仓库也不触发 git 操作。
    const result = await c.cli([kind === 'adopt' ? 'drop' : 'adopt', 'one', '--note', '已核查并照办']);
    assert.equal(result.code, 0, result.stderr);
    const lead = await readJob('one');
    assert.equal(lead.decision?.kind, kind); assert.equal(lead.decision?.at, owner.decision?.at);
    assert.equal(lead.decision?.by, 'lead'); assert.equal(lead.decision?.note, '已核查并照办');
    assert.ok(Date.parse(lead.decision!.handled!)); assert.equal(lead.state, 'done');
    assert.match(result.stdout, kind === 'adopt' ? /已采用/ : /已放弃/);
    if (kind === 'drop') assert.doesNotMatch(result.stdout, /git -C/);
  }
  const lead = await decide('one', 'adopt', '负责人自己选', 'lead');
  assert.equal(lead.decision?.by, 'lead'); assert.equal(lead.decision?.handled, undefined);
});

test('inbox 仅列主人待照办的决定与重做；handled 幂等且保留主人身份、选择、其他字段', async t => {
  const c = await registry(t);
  assert.equal((await c.cli(['inbox'])).stdout.trim(), '没有等你照办的事');
  await decide('one', 'drop', '主人留言', 'owner');
  await requestRedo('one');
  const pending = await readJob('one');
  let inbox = await c.cli(['inbox']); assert.equal(inbox.code, 0);
  for (const text of ['one', '题目', '主人选了不要了', '主人请求重做', localTime(pending.decision!.at), localTime(pending.redo!.at)]) assert.ok(inbox.stdout.includes(text), text);
  assert.doesNotMatch(inbox.stdout, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, '给人看的时间不带 ISO 格式');
  assert.equal((await c.cli(['handled', 'one'])).code, 0);
  const handled = await readJob('one');
  assert.ok(Date.parse(handled.decision!.handled!)); assert.equal(handled.decision?.handled, handled.redo?.handled);
  assert.equal(handled.decision?.by, 'owner'); assert.equal(handled.decision?.kind, 'drop');
  assert.equal(handled.decision?.note, '主人留言'); assert.equal(handled.summary, c.job.summary);
  assert.deepEqual(await markHandled('one'), handled);
  assert.equal((await c.cli(['inbox'])).stdout.trim(), '没有等你照办的事');
  await requestRedo('one'); // 新的请求重新进入待办。
  inbox = await c.cli(['inbox']); assert.match(inbox.stdout, /主人请求重做/); assert.doesNotMatch(inbox.stdout, /主人选了不要了/);
  await markHandled('one');
  await decide('one', 'drop', undefined, 'lead');
  assert.equal((await c.cli(['inbox'])).stdout.trim(), '没有等你照办的事');
  assert.equal((await c.cli(['handled', 'missing'])).code, 1);
});

test('重做仅用于结束任务；非法参数是中文错误且不改记录', async t => {
  const c = await registry(t);
  for (const state of ['queued', 'running'] as const) {
    await updateJob('one', j => { j.state = state; });
    await assert.rejects(requestRedo('one'), /任务还没结束/);
    await assert.rejects(decide('one', 'drop', undefined, 'owner'), /任务还没结束/);
    assert.equal((await readJob('one')).redo, undefined);
  }
  for (const state of ['done', 'failed', 'stopped', 'lost'] as const) {
    await updateJob('one', j => { j.state = state; delete j.redo; });
    const job = await requestRedo('one'); assert.equal(job.redo?.by, 'owner'); assert.equal(job.state, state);
  }
  const before = await readFile(join(c.home, 'jobs/one/job.json'), 'utf8');
  for (const note of ['文'.repeat(201), 'hello\nworld', 'hi\t', '\0', '\x7f', '\x85']) {
    await assert.rejects(decide('one', 'drop', note, 'owner'), /结论最多 200 字，不能含控制字符/);
  }
  await assert.rejects(decide('one', 'wrong' as 'adopt', undefined, 'lead'), /决定只能/);
  await assert.rejects(decide('one', 'drop', undefined, 'wrong' as 'lead'), /拍板的人只能/);
  for (const action of [() => decide('missing', 'drop', undefined, 'lead'), () => requestRedo('missing'), () => markHandled('missing')]) {
    await assert.rejects(action(), /找不到任务 missing/);
  }
  assert.equal(await readFile(join(c.home, 'jobs/one/job.json'), 'utf8'), before);
  assert.equal((await decide('one', 'drop', '😀'.repeat(200), 'lead')).decision?.note, '😀'.repeat(200));
});

test('主人不能盖掉已有结论；重做在负责人已有结论或未照办时拒绝；逐家各判各的', async t => {
  const c = await registry(t);
  const file = join(c.home, 'jobs/one/job.json');
  await createJob({ ...c.job, id: 'two', title: '另一家' });
  const lead = await decide('one', 'adopt', '验收通过，已合并', 'lead');
  const saved = await readFile(file, 'utf8');
  await assert.rejects(decide('one', 'drop', '不要了', 'owner'), /这件活已经有结论了，不用再选。/);
  await assert.rejects(requestRedo('one'), /负责人已经有结论了，不能再请求重做。/);
  assert.equal(await readFile(file, 'utf8'), saved);
  assert.equal((await readJob('one')).state, 'done');
  const other = await decide('two', 'drop', '不要了', 'owner');
  assert.equal(other.state, 'done'); assert.equal(other.decision?.by, 'owner'); assert.equal(other.decision?.kind, 'drop');
  assert.equal((await readJob('one')).decision?.note, '验收通过，已合并');
  const overwritten = await decide('one', 'drop', '改为放弃', 'lead');
  assert.equal(overwritten.decision?.kind, 'drop'); assert.equal(overwritten.decision?.by, 'lead');
  assert.equal(overwritten.decision?.note, '改为放弃'); assert.equal(overwritten.decision?.handled, undefined);
  assert.notEqual(overwritten.decision?.at, lead.decision?.at);

  await updateJob('one', j => { delete j.decision; delete j.redo; });
  const raced = await Promise.allSettled([decide('one', 'adopt', '同时甲', 'owner'), decide('one', 'drop', '同时乙', 'owner')]);
  const won = raced.find(r => r.status === 'fulfilled') as PromiseFulfilledResult<Job> | undefined;
  const lost = raced.find(r => r.status === 'rejected') as PromiseRejectedResult | undefined;
  assert.ok(won); assert.ok(lost); assert.match(lost.reason.message, /这件活已经有结论了，不用再选。/);
  assert.deepEqual((await readJob('one')).decision, won.value.decision);
  const ownerFile = await readFile(file, 'utf8');
  await assert.rejects(decide('one', 'adopt', '再选一次', 'owner'), /这件活已经有结论了，不用再选。/);
  assert.equal(await readFile(file, 'utf8'), ownerFile);

  const redos = await Promise.allSettled([requestRedo('one'), requestRedo('one')]);
  const redoWon = redos.find(r => r.status === 'fulfilled') as PromiseFulfilledResult<Job> | undefined;
  const redoLost = redos.find(r => r.status === 'rejected') as PromiseRejectedResult | undefined;
  assert.ok(redoWon); assert.ok(redoLost); assert.match(redoLost.reason.message, /已经有一条还没照办的重做请求。/);
  assert.equal((await readJob('one')).redo?.at, redoWon.value.redo?.at);
  assert.equal((await readJob('one')).decision?.by, 'owner');
  await markHandled('one');
  const again = await requestRedo('one');
  assert.equal(again.redo?.handled, undefined); assert.notEqual(again.redo?.at, redoWon.value.redo?.at);
  await decide('one', 'adopt', '照办主人的选择', 'lead');
  const followed = await readJob('one');
  assert.equal(followed.decision?.kind, won.value.decision?.kind); assert.equal(followed.decision?.by, 'lead');
  assert.equal(followed.decision?.at, won.value.decision?.at); assert.ok(followed.decision?.handled);
  const blocked = await readFile(file, 'utf8');
  await assert.rejects(requestRedo('one'), /负责人已经有结论了，不能再请求重做。/);
  assert.equal(await readFile(file, 'utf8'), blocked);

  await updateJob('one', j => {
    const decision = { kind: 'drop' as const, note: '旧记录', at: '2026-09-29T00:00:00.000Z', by: 'lead' as const };
    delete (decision as { by?: string }).by;
    j.decision = decision; delete j.redo;
  });
  const legacy = await readFile(file, 'utf8');
  assert.equal(JSON.parse(legacy).decision.by, undefined);
  await assert.rejects(requestRedo('one'), /负责人已经有结论了，不能再请求重做。/);
  await assert.rejects(decide('one', 'adopt', '主人再选', 'owner'), /这件活已经有结论了，不用再选。/);
  assert.equal(await readFile(file, 'utf8'), legacy);
});

test('读一次设置不建锁，也不动登记处目录里的任何文件', async t => {
  const c = await registry(t);
  // 读设置不许建锁、不许写文件。锁目录建了就删，读完之后再看列表看不出来；所以三件事一起看：
  // 读之前读之后各拍一次登记处的目录树（名字、修改时间、大小），读的当中连续列目录，抓那些冒出来又消失的名字。
  // 不用 fs.watch 那套“等一段时间看有没有事件”：事件晚到会被算成读设置干的（2026-10-10 偶发失败过一次），
  // 而且沙箱里 macOS 的 FSEvents 会报 EMFILE（desktop.test.ts 里也是因此换成事件替身），断言会变成白过。
  const tree = async (dir: string, at = ''): Promise<string[]> => {
    const rows: string[] = [];
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const info = await lstat(join(dir, entry.name));
      rows.push(`${at}${entry.name} ${info.mtimeMs} ${info.size}${info.isDirectory() ? ' 目录' : ''}`);
      if (info.isDirectory()) rows.push(...await tree(join(dir, entry.name), `${at}${entry.name}/`));
    }
    return rows;
  };
  const look = async () => ({ dir: (await lstat(c.home)).mtimeMs, top: (await readdir(c.home)).sort(), rows: await tree(c.home) });
  const measure = async <T>(work: () => Promise<T>) => {
    const before = await look(), seen = new Set<string>();
    let polls = 0, stop = false;
    const polling = (async () => { while (!stop) { polls++; for (const name of await readdir(c.home)) seen.add(name); } })();
    let result: T | undefined, failure: unknown;
    try { result = await work(); } catch (error) { failure = error; }
    finally { await delay(30); stop = true; await polling; }
    const after = await look();
    if (failure !== undefined) throw failure;
    return { result: result as T, polls, extra: [...seen].filter(name => !before.top.includes(name)), before, after };
  };
  const readOnce = async () => {
    const run = await measure(readSettings);
    assert.ok(run.polls > 0, '读设置的时候没轮到列目录，建了又删的锁目录就抓不住了');
    assert.deepEqual(run.extra, [], '读设置的时候登记处目录里冒出来过东西');
    assert.deepEqual(run.after, run.before, '读设置改动了登记处目录里的文件');
    return run.result;
  };
  assert.deepEqual(await readOnce(), { keepAwake: true, notifications: true, appearance: 'system', storage: { slim: true, days: 14 }, limits: { maxRunning: 12, quotaStop: 80 }, archivedProjects: [], workers: effectiveWorkers(undefined), models: { extra: {}, dropped: [], seen: {} }, networkAllowed: false });
  await writeFile(join(c.home, 'config.json'), JSON.stringify({ keepAwake: false, notifications: true }));
  assert.equal((await readOnce()).keepAwake, false);
  // 反向对照：写一个文件、再建一个马上删掉的锁目录，上面这套必须看得见，不然前面的断言只是白过。
  const written = await measure(async () => { await writeFile(join(c.home, 'watch-probe'), 'x'); return null; });
  assert.deepEqual(written.extra, ['watch-probe'], '写了文件却没发现');
  assert.notDeepEqual(written.after, written.before, '目录变了却没发现');
  const locked = await measure(async () => {
    await mkdir(join(c.home, '.lock'));
    await delay(20);
    await rm(join(c.home, '.lock'), { recursive: true });
    return null;
  });
  assert.deepEqual(locked.extra, ['.lock'], '建了又删的锁目录却没发现');
  assert.notDeepEqual(locked.after, locked.before, '目录变了却没发现');
});

test('设置默认开启；部分写入、并发修改和旧颜色兼容，保留未知配置；损坏可恢复', async t => {
  const c = await registry(t), file = join(c.home, 'config.json');
  assert.deepEqual(await readSettings(), { keepAwake: true, notifications: true, appearance: 'system', storage: { slim: true, days: 14 }, limits: { maxRunning: 12, quotaStop: 80 }, archivedProjects: [], workers: effectiveWorkers(undefined), models: { extra: {}, dropped: [], seen: {} }, networkAllowed: false });
  await assert.rejects(readFile(file), { code: 'ENOENT' });
  await writeFile(file, JSON.stringify({ board: { columns: { running: '#123456' } }, custom: 42 }));
  assert.equal((await readSettings()).columns?.running, '#123456');
  await Promise.all([writeSettings({ keepAwake: false }), writeSettings({ notifications: false }), writeSettings({ columns: { running: '#abcdef' } })]);
  assert.deepEqual(await readSettings(), { keepAwake: false, notifications: false, appearance: 'system', storage: { slim: true, days: 14 }, limits: { maxRunning: 12, quotaStop: 80 }, archivedProjects: [], columns: { running: '#abcdef' }, workers: effectiveWorkers(undefined), models: { extra: {}, dropped: [], seen: {} }, networkAllowed: false });
  assert.equal(JSON.parse(await readFile(file, 'utf8')).custom, 42);
  await writeSettings({ keepAwake: true }); assert.equal((await readSettings()).notifications, false);
  for (const invalid of [{ keepAwake: 'no' }, { notifications: 0 }, { columns: { x: 5 } }, { other: true }, null, []]) {
    await assert.rejects(writeSettings(invalid as Parameters<typeof writeSettings>[0]), /设置不合法/);
  }
  for (const raw of ['{', 'null', '[]', '42', '{"keepAwake":"false","notifications":null,"columns":[]}']) {
    await writeFile(file, raw);
    assert.deepEqual(await readSettings(), { keepAwake: true, notifications: true, appearance: 'system', storage: { slim: true, days: 14 }, limits: { maxRunning: 12, quotaStop: 80 }, archivedProjects: [], workers: effectiveWorkers(undefined), models: { extra: {}, dropped: [], seen: {} }, networkAllowed: false });
    assert.equal(await readFile(file, 'utf8'), raw);
    await writeSettings({ notifications: false });
    assert.deepEqual(await readSettings(), { keepAwake: true, notifications: false, appearance: 'system', storage: { slim: true, days: 14 }, limits: { maxRunning: 12, quotaStop: 80 }, archivedProjects: [], workers: effectiveWorkers(undefined), models: { extra: {}, dropped: [], seen: {} }, networkAllowed: false });
  }
  assert.ok(!(await readdir(c.home)).some(name => name.endsWith('.tmp') || name === '.lock'));
});

test('假时钟判定休眠：60 秒不记、超过才记，可累计、时钟回拨不记；并发字段保留', async t => {
  await registry(t);
  await updateJob('one', j => { j.state = 'running'; });
  let now = Date.parse('2026-09-29T01:00:00.000Z');
  const monitor = new SleepMonitor('one', () => now);
  now += 2000; assert.equal(await monitor.sample(), false);
  now += 60_000; assert.equal(await monitor.sample(), false);
  const first = now; now += 60_001; assert.equal(await monitor.sample(), true);
  const second = now; now += 120_000;
  await Promise.all([monitor.sample(), updateJob('one', j => { j.summary = '更新后的说明'; })]);
  const job = await readJob('one');
  assert.equal(job.summary, '更新后的说明');
  assert.deepEqual(job.sleeps, [
    { from: new Date(first).toISOString(), to: new Date(second).toISOString() },
    { from: new Date(second).toISOString(), to: new Date(now).toISOString() },
  ]);
  now -= 300_000; assert.equal(await monitor.sample(), false);
  assert.deepEqual((await readJob('one')).sleeps, job.sleeps);
});

test('buildView 输出新增数据和设置；旧任务标题兜底、旧决定视为负责人', async t => {
  const c = await registry(t), period = { from: '2026-09-29T01:00:00Z', to: '2026-09-29T01:02:00Z' };
  await decide('one', 'adopt', '主人的话', 'owner'); await requestRedo('one');
  await updateJob('one', j => { j.sleeps = [period]; });
  await writeSettings({ keepAwake: false, notifications: false, columns: { running: '#aabbcc' } });
  const view = await buildView(), record = await readJob('one');
  assert.equal(view.jobs[0].summary, c.job.summary); assert.deepEqual(view.jobs[0].decision, record.decision);
  assert.deepEqual(view.jobs[0].redo, record.redo); assert.deepEqual(view.jobs[0].sleeps, [period]);
  assert.deepEqual(view.settings, { keepAwake: false, notifications: false, storage: { slim: true, days: 14 }, limits: { maxRunning: 12, quotaStop: 80 }, workers: effectiveWorkers(undefined) }); assert.deepEqual(view.storage, { slimmedJobs: 0, freedBytes: 0, due: 0 }); assert.equal(view.theme?.columns.running, '#aabbcc');
  const { summary: _summary, ...legacy } = c.job;
  await writeFile(join(c.home, 'jobs/one/job.json'), JSON.stringify({ ...legacy, decision: { kind: 'adopt', at: c.job.created } }));
  await writeFile(join(c.home, 'batches/old.json'), JSON.stringify({ id: 'old', title: '旧批次', started: c.job.created, jobs: ['one'] }));
  const old = await buildView();
  assert.equal(old.jobs[0].summary, c.job.title); assert.equal(old.jobs[0].decision?.by, 'lead');
  assert.equal(old.jobs[0].redo, null); assert.deepEqual(old.jobs[0].sleeps, []); assert.equal(old.batches[0].summary, '旧批次');
  assert.equal((await c.cli(['inbox'])).stdout.trim(), '没有等你照办的事');
});

test('留言：去空白后 1–500 字、不许控制字符、换行可以；锁内追加不丢并发；不改状态', async t => {
  const c = await registry(t);
  const first = await addComment('one', '  第一行\r\n第二行  ', 'owner');
  assert.equal(first.comments?.length, 1); assert.equal(first.comments![0].text, '第一行\n第二行');
  assert.equal(first.comments![0].by, 'owner'); assert.ok(Date.parse(first.comments![0].at)); assert.equal(first.state, 'done');
  const before = await readFile(join(c.home, 'jobs/one/job.json'), 'utf8');
  for (const bad of ['', '   \n ', '文'.repeat(501), 'a\tb', 'a\0b', 'a\x7fb', 'a\x85b', 'a\u2028b']) {
    await assert.rejects(addComment('one', bad, 'owner'), /留言/, JSON.stringify(bad));
  }
  await assert.rejects(addComment('one', 'x', 'nobody' as 'owner'), /留言的人/);
  await assert.rejects(addComment('missing', 'x', 'owner'), /找不到任务 missing/);
  await assert.rejects(addComment('one', 5 as unknown as string, 'owner'), /留言要写成文字/);
  assert.equal(await readFile(join(c.home, 'jobs/one/job.json'), 'utf8'), before);
  assert.equal((await addComment('one', '😀'.repeat(500), 'owner')).comments?.at(-1)?.text, '😀'.repeat(500));
  await Promise.all(Array.from({ length: 8 }, (_, i) => addComment('one', `并发 ${i}`, i % 2 ? 'lead' : 'owner')));
  assert.equal((await readJob('one')).comments?.length, 10);
});

test('待回复只看最后一条；inbox 显示主人留言内容，reply 以负责人身份追加，回复后消失；视图带 comments', async t => {
  const c = await registry(t);
  assert.equal(awaitingReply(await readJob('one')), false);
  await addComment('one', '这份先别合并\n等我看一眼', 'owner');
  assert.equal(awaitingReply(await readJob('one')), true);
  const inbox = await c.cli(['inbox']); assert.equal(inbox.code, 0, inbox.stderr);
  for (const text of ['one', '题目', '主人留言待回复', '这份先别合并 等我看一眼']) assert.ok(inbox.stdout.includes(text), text);
  await addComment('one', '再补一句', 'owner');
  assert.deepEqual(pendingComments(await readJob('one')).map(x => x.text), ['这份先别合并\n等我看一眼', '再补一句']);
  assert.match((await c.cli(['inbox'])).stdout, /这份先别合并 等我看一眼 ｜ 再补一句/);
  assert.equal((await buildView()).jobs[0].comments.length, 2);
  const reply = await c.cli(['reply', 'one', '收到，已核对']); assert.equal(reply.code, 0, reply.stderr);
  const job = await readJob('one');
  assert.equal(job.comments?.at(-1)?.by, 'lead'); assert.equal(job.comments?.at(-1)?.text, '收到，已核对');
  assert.equal(awaitingReply(job), false);
  assert.equal((await c.cli(['inbox'])).stdout.trim(), '没有等你照办的事');
  await addComment('one', '还有一个问题', 'owner');
  assert.match((await c.cli(['inbox'])).stdout, /还有一个问题/); assert.doesNotMatch((await c.cli(['inbox'])).stdout, /收到，已核对/);
  for (const args of [['reply', 'one'], ['reply', 'one', 'a', 'b'], ['reply', 'missing', 'x'], ['reply', 'one', '   ']]) assert.equal((await c.cli(args)).code, 1, args.join(' '));
  assert.match((await c.cli(['--help'])).stdout, /xagents reply/);
});

test('主人留言的 handled：回复、handled 命令都记处理时间，之后不再待办；旧的留言（之后有负责人回复）也不算待办', async t => {
  const c = await registry(t);
  await addComment('one', '第一条', 'owner'); await addComment('one', '第二条', 'owner');
  assert.equal(pendingComments(await readJob('one')).length, 2);
  await addComment('one', '回复', 'lead');
  let job = await readJob('one');
  assert.ok(job.comments!.slice(0, 2).every(x => Date.parse(x.handled!)), '负责人回复后，主人此前的留言都有 handled');
  assert.equal(job.comments![2].handled, undefined); assert.equal(pendingComments(job).length, 0); assert.equal(awaitingReply(job), false);
  await addComment('one', '第三条', 'owner');
  assert.equal(awaitingReply(await readJob('one')), true);
  assert.equal((await c.cli(['handled', 'one'])).code, 0);
  job = await readJob('one');
  assert.ok(Date.parse(job.comments!.at(-1)!.handled!)); assert.equal(pendingComments(job).length, 0); assert.equal(awaitingReply(job), false);
  assert.equal((await c.cli(['inbox'])).stdout.trim(), '没有等你照办的事');
  // 没有 handled 字段的旧数据：只要之后有负责人留言，就不算待办。
  await updateJob('one', j => { j.comments = [{ by: 'owner', text: '旧', at: '2026-09-29T00:00:00.000Z' }, { by: 'lead', text: '旧回复', at: '2026-09-29T00:01:00.000Z' }]; });
  assert.equal(pendingComments(await readJob('one')).length, 0);
});

// 用可替换的读取函数和睡眠，不真的等时间：每次“睡眠”时按剧本改一下登记处里的任务。
function script(jobs: Job[], steps: ((jobs: Job[]) => void)[]) {
  const calls = { sleeps: 0, polls: 0 };
  const io: WaitIO = {
    list: async () => structuredClone(jobs), select: async id => { calls.polls++; return structuredClone(jobs.filter(j => j.id === id || j.batch === id)); },
    refresh: async () => {}, sleep: async () => { calls.sleeps++; steps[calls.sleeps - 1]?.(jobs); if (calls.sleeps > 20) throw new Error('等太久了'); },
  };
  return { io, calls };
}
const running = (id: string, extra: Partial<Job> = {}): Job => ({ id, batch: id, who: 'codex', model: 'm', effort: 'high', project: 't', repo: '/x', base: 'x', worktree: '/x', branch: 'x', mode: 'read-only', kind: '实现', title: `题目${id}`, summary: 's', state: 'running', created: '2026-09-29T00:00:00.000Z', pid: process.pid, ...extra });
const comment = (text: string, at: string) => ({ by: 'owner' as const, text, at });

test('wait：活先结束 → 正常返回，不管别的；结束的同时带回新动作', async () => {
  const jobs = [running('a')];
  const { io, calls } = script(jobs, [j => { j[0].state = 'done'; }]);
  const result = await waitForJobs('a', io);
  assert.equal(result.reason, 'finished'); assert.equal(calls.sleeps, 1); assert.deepEqual(result.fresh, []);
  const both = [running('a')];
  const second = script(both, [j => { j[0].state = 'failed'; j[0].comments = [comment('顺手一句', '2026-09-29T01:00:00.000Z')]; }]);
  const r2 = await waitForJobs('a', second.io);
  assert.equal(r2.reason, 'finished'); assert.equal(r2.fresh.length, 1); assert.equal(r2.fresh[0].kind, 'comment');
});

test('wait：主人先留言 → 立刻叫醒，任何任务上的新动作（留言、用这份、重做）都算', async () => {
  for (const [action, kind] of [
    [(j: Job[]) => { j[1].comments = [comment('停一下，我有话说', '2026-09-29T01:00:00.000Z')]; }, 'comment'],
    [(j: Job[]) => { j[1].decision = { kind: 'adopt', by: 'owner', at: '2026-09-29T01:00:00.000Z' }; }, 'adopt'],
    [(j: Job[]) => { j[1].redo = { by: 'owner', at: '2026-09-29T01:00:00.000Z' }; }, 'redo'],
  ] as const) {
    const jobs = [running('a'), running('other', { state: 'done' })];
    const { io, calls } = script(jobs, [() => {}, action]);
    const result = await waitForJobs('a', io);
    assert.equal(result.reason, 'owner', kind); assert.equal(calls.sleeps, 2); assert.equal(result.fresh.length, 1);
    assert.equal(result.fresh[0].kind, kind); assert.equal(result.fresh[0].id, 'other');
  }
});

test('wait：等待前已经在待办里的旧留言和旧决定不触发；处理掉再来新的才触发', async () => {
  const jobs = [running('a', { comments: [comment('老留言', '2026-09-28T00:00:00.000Z')], decision: { kind: 'drop', by: 'owner', at: '2026-09-28T00:00:00.000Z' }, redo: { by: 'owner', at: '2026-09-28T00:00:00.000Z' } })];
  assert.equal(ownerActions(jobs).length, 3);
  const { io, calls } = script(jobs, [() => {}, () => {}, j => { j[0].state = 'done'; }]);
  const result = await waitForJobs('a', io);
  assert.equal(result.reason, 'finished'); assert.equal(calls.sleeps, 3); assert.deepEqual(result.fresh, [], '旧事项不触发');
  // 旧留言被负责人处理后，新的留言才触发，且只带回新的那条。
  const later = [running('a', { comments: [comment('老留言', '2026-09-28T00:00:00.000Z')] })];
  const s2 = script(later, [j => { j[0].comments![0].handled = '2026-09-29T00:30:00.000Z'; }, j => { j[0].comments!.push(comment('新留言', '2026-09-29T01:00:00.000Z')); }]);
  const r2 = await waitForJobs('a', s2.io);
  assert.equal(r2.reason, 'owner'); assert.deepEqual(r2.fresh.map(a => a.text), ['新留言']);
});

test('wait 命令：被叫醒时用人话打印任务、动作、留言原文和时间，退出码 3；活做完退出 0；--help 写了退出码', async t => {
  const lines: string[] = [], log = console.log;
  console.log = (text: unknown) => { lines.push(String(text)); };
  try {
    const jobs = [running('a'), running('b', { state: 'done' })];
    const { io } = script(jobs, [j => { j[1].comments = [comment('这份先别合并\n等我说', '2026-09-29T01:00:00.000Z')]; }]);
    assert.equal(await wait('a', io), 3);
    const text = lines.join('\n');
    for (const part of ['主人有新的动作', '任务 b（题目b）', '主人留言', '这份先别合并', '等我说', '处理完', 'xagents wait a']) assert.ok(text.includes(part), part);
    assert.match(describeAction({ id: 'x', title: 't', key: 'k', kind: 'adopt', at: '2026-09-29T01:00:00.000Z' }), /主人选了用这份/);
    lines.length = 0;
    const done = [running('a')];
    assert.equal(await wait('a', script(done, [j => { j[0].state = 'done'; }]).io), 0);
    assert.doesNotMatch(lines.join('\n'), /主人有新的动作/);
  } finally { console.log = log; }
  const c = await registry(t);
  assert.match((await c.cli(['--help'])).stdout, /wait 的退出码：0 都做完了，1 有出错或失联，3 主人有新动作/);
});
