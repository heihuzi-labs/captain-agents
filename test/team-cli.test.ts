import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { context } from './helpers.ts';
import { readTeam, sayInTeam } from '../src/core/team.ts';
import { ensureHome } from '../src/core/paths.ts';
import type { Team } from '../src/core/team.ts';
import { reasonText } from '../src/core/team-text.ts';

const at = '2026-10-10T02:00:00.000Z';

function sampleTeam(id = 't-1010-0300', extra: Partial<Team> = {}): Team {
  return { id, mode: 'pair', project: 'xagents', repo: '/repo', base: 'abc', kind: '实现', title: '测试小队', summary: '测试小队', task: '# 题目',
    writer: { who: 'grok', effort: 'high', job: 'w-job' }, reviewer: { who: 'deepseek', effort: 'high', job: 'r-job' },
    round: 1, phase: 'write', maxRounds: 3, maxMinutes: 60, state: 'running', created: at, ...extra };
}
async function putTeam(c: Awaited<ReturnType<typeof context>>, team: Team, messages: unknown[] = []) {
  const dir = join(c.home, 'teams', team.id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'team.json'), JSON.stringify(team, null, 2) + '\n');
  if (messages.length) await writeFile(join(dir, 'channel.jsonl'), messages.map(m => JSON.stringify(m)).join('\n') + '\n');
}
async function putJob(c: Awaited<ReturnType<typeof context>>, id: string, extra: Record<string, unknown> = {}) {
  await mkdir(join(c.home, 'jobs', id), { recursive: true });
  await writeFile(join(c.home, 'jobs', id, 'job.json'), JSON.stringify({
    id, batch: `批-${id}`, project: '测试', repo: c.repo, base: 'abc', worktree: c.repo, branch: `xa/${id}`,
    who: 'codex', model: 'm', effort: 'high', mode: 'workspace-write', kind: '实现', title: `题目 ${id}`, summary: '测试用',
    state: 'done', created: at, started: at, ended: at, seconds: 300, ...extra,
  }, null, 2) + '\n');
}

test('reasonText：七种原因的中文', () => {
  assert.deepEqual(['passed', 'disagree', 'unclear', 'brake', 'blocked', 'failed', 'lost'].map(reasonText), [
    '审查说通过了', '轮数用完，还有必须改的没谈拢', '审查报告里找不到结论', '到了刹车线', '叫醒前被拦下', '有一轮没做完', '推进小队的后台不在了',
  ]);
});

test('team status：一张表；给队号时再列两件活和最近 5 条频道（平台一行、报告三行）', async t => {
  const c = await context(t, false);
  const messages = [
    { id: 1, at, round: 1, from: 'platform', kind: 'event', text: '开队' },
    { id: 2, at, round: 1, from: 'writer', kind: 'report', text: '第1轮报告\n第二行\n第三行\n第四行\n第五行' },
    { id: 3, at, round: 1, from: 'reviewer', kind: 'review', text: '结论\n意见一\n意见二\n意见三' },
    { id: 4, at, round: 2, from: 'writer', kind: 'report', text: '第2轮报告' },
    { id: 5, at, round: 2, from: 'reviewer', kind: 'review', text: '通过' },
    { id: 6, at, round: 2, from: 'platform', kind: 'event', text: '第二轮开始' },
  ];
  // 用时按开队到收场的钟点时间算：开队 10 分钟后收场。
  const created = new Date(Date.now() - 20 * 60000).toISOString(), ended = new Date(Date.now() - 10 * 60000).toISOString();
  await putTeam(c, sampleTeam('t-1010-0300', { state: 'lead', reason: 'disagree', note: '3轮没谈拢', created, ended }), messages);
  await putJob(c, 'w-job', { team: { id: 't-1010-0300', role: 'writer' }, who: 'grok' });
  await putJob(c, 'r-job', { team: { id: 't-1010-0300', role: 'reviewer' }, who: 'deepseek' });
  const all = await c.cli(['team', 'status']);
  assert.equal(all.code, 0, all.stderr);
  assert.match(all.stdout, /t-1010-0300/);
  assert.match(all.stdout, /等负责人：轮数用完，还有必须改的没谈拢（3轮没谈拢）/);
  assert.match(all.stdout, /1\/3/);
  assert.match(all.stdout, /10\/60 分/);
  const detail = await c.cli(['team', 'status', 't-1010-0300']);
  assert.equal(detail.code, 0, detail.stderr);
  assert.match(detail.stdout, /队员任务：w-job（写）、r-job（审）/);
  assert.match(detail.stdout, /平台：第二轮开始/);
  assert.match(detail.stdout, /写手：第1轮报告\n第二行\n第三行/);
  assert.doesNotMatch(detail.stdout, /第四行/);
  assert.doesNotMatch(detail.stdout, /开队/); // 只取最近 5 条
});

test('team log：缺省最近 20 条，--all 全出；去掉控制字符', async t => {
  const c = await context(t, false);
  const messages = Array.from({ length: 25 }, (_, i) => ({ id: i + 1, at, round: 1, from: 'platform', kind: 'event', text: `第${i + 1}条\u0007控制` }));
  await putTeam(c, sampleTeam(), messages);
  const log = await c.cli(['team', 'log', 't-1010-0300']);
  assert.equal(log.code, 0, log.stderr);
  assert.match(log.stdout, /第25条/);
  assert.match(log.stdout, /第6条/);
  assert.doesNotMatch(log.stdout, /第5条/);
  assert.doesNotMatch(log.stdout, /\u0007/);
  assert.match(log.stdout, /第25条控制/);
  const all = await c.cli(['team', 'log', 't-1010-0300', '--all']);
  assert.match(all.stdout, /第1条/);
  assert.match(all.stdout, /第25条/);
});

test('team say：负责人说话，把主人此前的话记为已处理', async t => {
  const c = await context(t, false);
  await putTeam(c, sampleTeam(), [
    { id: 1, at, round: 1, from: 'owner', kind: 'say', text: '主人的话' },
  ]);
  const say = await c.cli(['team', 'say', 't-1010-0300', '负责人回话']);
  assert.equal(say.code, 0, say.stderr);
  assert.match(say.stdout, /负责人回话/);
  const lines = (await readFile(join(c.home, 'teams', 't-1010-0300', 'channel.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l));
  assert.ok(lines[0].handled, '负责人说话时记为已处理');
  assert.equal(lines.length, 2);
  assert.equal(lines[1].from, 'lead');
});

test('wait 队号：lead 退出码 4 并打印原因，ended 退出码 0；期间主人新动作退出码 3', async t => {
  const c = await context(t, false), previous = process.env.XAGENTS_HOME;
  process.env.XAGENTS_HOME = c.home;
  await ensureHome();
  t.after(() => { if (previous === undefined) delete process.env.XAGENTS_HOME; else process.env.XAGENTS_HOME = previous; });
  const { wait } = await import('../src/cli/commands.ts');
  await putTeam(c, sampleTeam('t-lead', { state: 'lead', reason: 'passed' }));
  const lines: string[] = [], log = console.log;
  console.log = (x: unknown) => { lines.push(String(x)); };
  try { assert.equal(await wait('t-lead'), 4); } finally { console.log = log; }
  assert.ok(lines.some(l => l.includes('审查说通过了')), lines.join('\n'));
  await putTeam(c, sampleTeam('t-end', { state: 'ended' }));
  assert.equal(await wait('t-end'), 0);
  // running 的小队：第一次睡眠后主人在频道里说一句，要被叫醒（退出码 3）。
  await putTeam(c, sampleTeam('t-run'));
  let sleeps = 0;
  const io = {
    list: async () => [],
    teams: async () => [await readTeam('t-run')],
    select: async () => [],
    refresh: async () => {},
    sleep: async () => { if (++sleeps === 1) await sayInTeam('t-run', '先停一下', 'owner'); if (sleeps > 20) throw new Error('等太久了'); },
  };
  assert.equal(await wait('t-run', io), 3);
});

test('小队 running 时，对队员 adopt/drop/verify/clean 一律拦下', async t => {
  const c = await context(t);
  await putTeam(c, sampleTeam('t-run'));
  await putJob(c, 'w-job', { team: { id: 't-run', role: 'writer' }, who: 'grok' });
  for (const args of [['adopt', 'w-job'], ['drop', 'w-job'], ['verify', 'w-job'], ['clean', 'w-job']]) {
    const r = await c.cli(args);
    assert.equal(r.code, 1, args.join(' '));
    assert.match(r.stderr, /小队还在进行，先 xagents wait t-run 或 xagents team stop t-run/);
  }
  // 小队收场后不再拦。
  await putTeam(c, sampleTeam('t-run', { state: 'ended' }));
  assert.doesNotMatch((await c.cli(['drop', 'w-job'])).stderr, /小队还在进行/);
});

test('clean 队号：清两件活，沿用已拍板须先打分', async t => {
  const c = await context(t);
  await putTeam(c, sampleTeam('t-end', { state: 'ended' }));
  await putJob(c, 'w-job', { team: { id: 't-end', role: 'writer' }, who: 'grok', decision: { kind: 'adopt', at, by: 'lead' } });
  await putJob(c, 'r-job', { team: { id: 't-end', role: 'reviewer' }, who: 'deepseek', decision: { kind: 'adopt', at, by: 'lead' } });
  const fail = await c.cli(['clean', 't-end']);
  assert.equal(fail.code, 1);
  assert.match(fail.stderr, /已拍板但还没打分/);
  assert.match(fail.stderr, /w-job、r-job/);
});

test('status <队号> 列两件活；inbox 收进小队频道里主人的话', async t => {
  const c = await context(t, false);
  await putTeam(c, sampleTeam('t-in', { state: 'running' }), [
    { id: 1, at, round: 1, from: 'owner', kind: 'say', text: '先停一下' },
  ]);
  await putJob(c, 'w-job', { team: { id: 't-in', role: 'writer' }, who: 'grok' });
  await putJob(c, 'r-job', { team: { id: 't-in', role: 'reviewer' }, who: 'deepseek' });
  const s = await c.cli(['status', 't-in']);
  assert.equal(s.code, 0, s.stderr);
  assert.match(s.stdout, /w-job/);
  assert.match(s.stdout, /r-job/);
  const inbox = await c.cli(['inbox']);
  assert.match(inbox.stdout, /t-in/);
  assert.match(inbox.stdout, /先停一下/);
  // 已处理的话不再收。
  await putTeam(c, sampleTeam('t-done', { state: 'running' }), [
    { id: 1, at, round: 1, from: 'owner', kind: 'say', text: '旧话', handled: at },
  ]);
  assert.doesNotMatch((await c.cli(['inbox'])).stdout, /旧话/);
});

test('team start/round/stop：参数检查给中文提示，参数交给核心', async t => {
  const c = await context(t, false);
  const missing = [
    [['team', 'start', c.task, '--reviewer', 'grok:high', '--summary', 'x'], /--writer/],
    [['team', 'start', c.task, '--writer', 'grok:high', '--summary', 'x'], /--reviewer/],
    [['team', 'start', c.task, '--writer', 'grok:high', '--reviewer', 'grok:high'], /--summary/],
    [['team', 'start', c.task, '--writer', 'grok:high', '--reviewer', 'grok:high', '--summary', 'x', '--kind', '调研'], /--kind 只允许实现或修复/],
    [['team', 'start', c.task, '--writer', 'grok:high', '--reviewer', 'grok:high', '--summary', 'x', '--rounds', '9'], /--rounds 只能填写 1–5/],
    [['team', 'start', c.task, '--writer', 'grok:high', '--reviewer', 'grok:high', '--summary', 'x', '--minutes', '5'], /--minutes 只能填写 10–240/],
  ] as const;
  for (const [args, msg] of missing) {
    const r = await c.cli(args as string[]);
    assert.equal(r.code, 1, args.join(' '));
    assert.match(r.stderr, msg);
  }
  const ok = await c.cli(['team', 'start', c.task, '--writer', 'grok:high', '--reviewer', 'deepseek:high', '--summary', 'x', '--rounds', '5', '--minutes', '240']);
  // 参数都对，交给核心；这个临时登记处没登记项目，核心拦下。
  assert.equal(ok.code, 1);
  assert.doesNotMatch(ok.stderr, /--writer|--reviewer|--summary|--rounds|--minutes/);
  await putTeam(c, sampleTeam('t-r'));
  assert.match((await c.cli(['team', 'round', 't-r', '--note', '再来'])).stderr, /小队还在推进/);
  const stopped = await c.cli(['team', 'stop', 't-r']);
  assert.equal(stopped.code, 0, stopped.stderr);
  assert.match((await c.cli(['team', 'stop'])).stderr, /参数数量不对/);
  assert.match((await c.cli(['team', 'status', 'nope'])).stderr, /找不到小队 nope/);
});
