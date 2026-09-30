import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { context, until } from './helpers.ts';
import { createJob, readJob, updateJob } from '../src/core/job.ts';
import type { Job } from '../src/core/job.ts';
import { ensureHome } from '../src/core/paths.ts';
import { reportSteps, collectRealSteps, recordRealCheck, initialRealCheck } from '../src/core/real.ts';
import { decide } from '../src/core/decide.ts';
import { buildView } from '../src/core/view.ts';

async function registry(t: TestContext) {
  const c = await context(t, false), previous = process.env.XAGENTS_HOME;
  process.env.XAGENTS_HOME = c.home;
  t.after(() => { if (previous === undefined) delete process.env.XAGENTS_HOME; else process.env.XAGENTS_HOME = previous; });
  await ensureHome();
  const job: Job = { id: 'one', batch: '', who: 'codex', model: 'test', effort: 'high', project: '测试', repo: c.repo,
    base: 'test', worktree: c.repo, branch: 'test', mode: 'read-only', kind: '实现', title: '任务', summary: '测试', state: 'done', created: new Date().toISOString() };
  await createJob(job);
  return { ...c, job, dir: join(c.home, 'jobs/one') };
}
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=', 'base64');

test('报告步骤：各类列表、CRLF、节边界、围栏、最多 20 条及每条 200 字；没有节不标记', async t => {
  const c = await registry(t);
  assert.equal(reportSteps('## 结论\n- 无需浏览器'), null);
  assert.deepEqual(reportSteps('## 真实环境检查步骤\n暂未提供'), []);
  assert.deepEqual(reportSteps('## 真实环境检查步骤 ##\r\n- 打开\r\n * 看结果\r\n  12. 点击\r\n```md\r\n- 忽略代码\r\n```\r\n## 别的\r\n- 不收'), ['打开', '看结果', '点击']);
  assert.equal(reportSteps('```md\n## 真实环境检查步骤\n- 假步骤\n```'), null);
  const long = reportSteps('## 真实环境检查步骤\n' + Array.from({ length: 25 }, (_, i) => `${i + 1}. ${'😀'.repeat(205)}`).join('\n'))!;
  assert.equal(long.length, 20); assert.ok(long.every(s => [...s].length === 200));
  collectRealSteps(c.job, '## 结论\n- 正常'); assert.equal(c.job.realCheck, undefined);
  c.job.realCheck = initialRealCheck('负责人的步骤');
  collectRealSteps(c.job, '## 真实环境检查步骤\n- 选手的步骤');
  collectRealSteps(c.job, '## 真实环境检查步骤\n- 选手的步骤');
  assert.deepEqual(c.job.realCheck, { needed: true, steps: ['负责人的步骤', '选手的步骤'] });
  assert.deepEqual(initialRealCheck(true), { needed: true, steps: [] });
  assert.equal(initialRealCheck(undefined), undefined);
});

test('run --real 可有或没有说明；替身报告自动收步骤；collect 重收不重复；无节保持原状', async t => {
  const c = await context(t); await c.add();
  for (const [args, mode, expected] of [
    [['--real', '检查真实窗口'], 'real', ['检查真实窗口', '打开页面，看到任务列表', '切换深色，文字清楚', '点击详情，显示说明']],
    [['--real'], 'ok', []], [[], 'real', ['打开页面，看到任务列表', '切换深色，文字清楚', '点击详情，显示说明']], [[], 'ok', undefined],
  ] as const) {
    const before = new Set((await c.jobs()).map(j => j.id));
    const result = await c.cli(['run', c.task, '--summary', '测试标记', '--who', 'codex:medium', ...args], { XA_TEST_MODE: mode });
    assert.equal(result.code, 0, result.stderr);
    await until(c.jobs, jobs => jobs.every(j => j.state === 'done'));
    const job = (await c.jobs()).find(j => !before.has(j.id))!;
    assert.ok(job);
    assert.deepEqual(job.realCheck?.steps, expected);
    assert.equal(job.realCheck?.needed, expected === undefined ? undefined : true);
    assert.equal((await c.cli(['collect', job.id])).code, 0);
    assert.deepEqual((await c.jobs()).find(j => j.id === job.id)?.realCheck?.steps, expected);
  }
  for (const arg of [' ', '文'.repeat(201), '说明\n下一行']) {
    const r = await c.cli(['run', c.task, '--summary', '测试标记', '--who', 'codex:medium', '--real', arg]);
    assert.equal(r.code, 1); assert.match(r.stderr, /--real/);
  }
});

test('real 命令：pass/fail/skip，截图复制并重编号，覆盖时归档旧截图；看板不含路径', async t => {
  const c = await registry(t), a = join(c.temp, '带原名.PNG'), b = join(c.temp, '第二张.jpg');
  await writeFile(a, png); await writeFile(b, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  let r = await c.cli(['real', 'one', '--pass', '--note', '窗口检查通过', '--shot', a, '--shot', b]);
  assert.equal(r.code, 0, r.stderr);
  let j = await readJob('one'); assert.equal(j.realCheck?.result?.ok, true);
  assert.deepEqual(j.realCheck?.result?.shots, ['01.png', '02.jpg']);
  assert.deepEqual(await readFile(join(c.dir, 'shots/01.png')), png);
  assert.deepEqual(await readFile(a), png);
  let view = (await buildView()).jobs[0].realCheck!;
  assert.deepEqual(view, { needed: true, steps: [], result: { ok: true, note: '窗口检查通过', at: j.realCheck!.result!.at, shotCount: 2 }, skipped: null });
  assert.ok(!JSON.stringify(view).includes(c.temp)); assert.ok(!JSON.stringify(view).includes('01.png'));
  r = await c.cli(['real', 'one', '--fail', '--note', '按钮没反应', '--shot', a]); assert.equal(r.code, 0, r.stderr);
  j = await readJob('one'); assert.equal(j.realCheck?.result?.ok, false); assert.equal(j.realCheck?.result?.by, 'lead');
  const archives = await readdir(join(c.dir, 'shots-old')); assert.equal(archives.length, 1);
  assert.deepEqual((await readdir(join(c.dir, 'shots-old', archives[0]))).sort(), ['01.png', '02.jpg']);
  assert.deepEqual(await readdir(join(c.dir, 'shots')), ['01.png']);
  r = await c.cli(['real', 'one', '--skip', '只改文档']); assert.equal(r.code, 0, r.stderr);
  j = await readJob('one'); assert.equal(j.realCheck?.result, undefined); assert.equal(j.realCheck?.skipped?.reason, '只改文档');
  assert.equal((await readdir(join(c.dir, 'shots-old'))).length, 2); assert.deepEqual(await readdir(join(c.dir, 'shots')), []);
  view = (await buildView()).jobs[0].realCheck!; assert.equal(view.result, null); assert.equal(view.skipped?.reason, '只改文档');
  await recordRealCheck('one', { ok: true, note: '重新通过' }); assert.equal((await readJob('one')).realCheck?.skipped, undefined);
});

test('real 拒绝无效选项、说明、格式、数量、大小及未结束任务；失败不改旧记录和截图', async t => {
  const c = await registry(t), shot = join(c.temp, 'shot.png'); await writeFile(shot, png);
  await recordRealCheck('one', { ok: true, note: '原结果', shots: [shot] });
  const before = await readFile(join(c.dir, 'job.json'), 'utf8');
  for (const args of [[], ['--pass'], ['--pass', '--fail', '--note', '结果'], ['--skip', '原因', '--note', '结果'], ['--skip', '原因', '--shot', shot],
    ...[' ', '文'.repeat(201), '换\n行', 'a\x7fb', 'a\x85b'].map(note => ['--pass', '--note', note])]) {
    assert.equal((await c.cli(['real', 'one', ...args])).code, 1, JSON.stringify(args));
  }
  for (const name of ['bad.svg', 'fake.png']) {
    const file = join(c.temp, name); await writeFile(file, '<svg/>');
    await assert.rejects(recordRealCheck('one', { ok: false, note: '结果', shots: [file] }), /截图/);
  }
  const large = join(c.temp, 'large.png'); await writeFile(large, Buffer.alloc(10 * 1024 * 1024 + 1));
  await assert.rejects(recordRealCheck('one', { ok: true, note: '结果', shots: [large] }), /10 MB/);
  await assert.rejects(recordRealCheck('one', { ok: true, note: '结果', shots: Array(11).fill(shot) }), /10 张/);
  const link = join(c.temp, 'link.png'); await symlink(shot, link);
  await assert.rejects(recordRealCheck('one', { ok: true, note: '结果', shots: [link] }));
  await assert.rejects(recordRealCheck('one', { ok: true, note: '结果', shots: [shot, join(c.temp, 'missing.png')] }));
  assert.equal(await readFile(join(c.dir, 'job.json'), 'utf8'), before);
  assert.deepEqual(await readFile(join(c.dir, 'shots/01.png')), png);
  assert.deepEqual(await readdir(join(c.dir, 'shots-old')), []);
  assert.ok(!(await readdir(c.dir)).some(name => name.startsWith('.shots-')));
  const exact = Buffer.alloc(10 * 1024 * 1024); png.copy(exact); await writeFile(large, exact);
  await recordRealCheck('one', { ok: true, note: '😀'.repeat(200), shots: Array(10).fill(large) });
  assert.equal((await readJob('one')).realCheck?.result?.shots.length, 10);
  for (const state of ['queued', 'running'] as const) {
    await updateJob('one', j => { j.state = state; });
    await assert.rejects(recordRealCheck('one', { skip: '不需要' }), /还没结束/);
  }
  await updateJob('one', j => { j.state = 'done'; });
  assert.equal((await c.cli(['real', 'missing', '--pass', '--note', '说明'])).code, 1);
});

test('采用把关：待验/没过拒绝，通过/跳过放行；主人只记决定，负责人照办时仍把关', async t => {
  await registry(t);
  await updateJob('one', j => { j.realCheck = { needed: true, steps: [] }; });
  await assert.rejects(decide('one', 'adopt', undefined, 'lead'), /真实环境验收.*xagents real one --pass/);
  await recordRealCheck('one', { ok: false, note: '没过' });
  await assert.rejects(decide('one', 'adopt', undefined, 'lead'), /真实环境验收/);
  await decide('one', 'adopt', undefined, 'owner');
  assert.equal((await readJob('one')).decision?.by, 'owner');
  await assert.rejects(decide('one', 'drop', undefined, 'lead'), /真实环境验收/);
  assert.equal((await readJob('one')).decision?.handled, undefined);
  await recordRealCheck('one', { ok: true, note: '通过' });
  assert.equal((await decide('one', 'adopt', undefined, 'lead')).decision?.by, 'lead');
  await recordRealCheck('one', { skip: '不需要' }); await decide('one', 'adopt', undefined, 'lead');
  await recordRealCheck('one', { ok: false, note: '重验失败' });
  await assert.rejects(decide('one', 'adopt', undefined, 'lead'), /真实环境验收/);
  await decide('one', 'drop', undefined, 'lead');
  await updateJob('one', j => { delete j.realCheck; }); await decide('one', 'adopt', undefined, 'lead');
});

