import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { context, until } from './helpers.ts';
import { alive } from '../src/core/fsx.ts';
import { readJob } from '../src/core/job.ts';
import { jobDir } from '../src/core/paths.ts';
import { writeSettings } from '../src/core/settings.ts';
import {
  TEXT_MAX, clipText, continueTeam, parseReplies, parseReview, readChannel, readTeam, reconcileTeam, startTeam, stopTeam, teamDir, updateTeam,
  appendMessage, createTeam, sayInTeam, type Team,
} from '../src/core/team.ts';
import { heard, syncReviewWorktree } from '../src/core/team-engine.ts';
import { SESSION_RE } from '../src/core/workers.ts';

const ENV_KEYS = ['XAGENTS_HOME', 'XAGENTS_FAKE_WORKER', 'XAGENTS_APPLICATIONS', 'XAGENTS_CAFFEINATE', 'XAGENTS_MAX_RUNNING', 'XAGENTS_TRASH', 'XAGENTS_SRT', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'] as const;
const TEST_KEYS = ['XA_TEST_MODE', 'XA_TEST_REVIEW', 'XA_TEST_FREEZE'] as const;

async function setup(t: TestContext) {
  const c = await context(t);
  const saved = new Map<string, string | undefined>([...ENV_KEYS, ...TEST_KEYS].map(key => [key, process.env[key]]));
  for (const key of ENV_KEYS) {
    const value = c.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const key of TEST_KEYS) delete process.env[key];
  t.after(async () => {
    const names = await readdir(join(c.home, 'teams')).catch(() => [] as string[]);
    for (const name of names) {
      try {
        const team = JSON.parse(await readFile(join(c.home, 'teams', name, 'team.json'), 'utf8')) as { pid?: number };
        if (team.pid) process.kill(team.pid, 'SIGKILL');
      } catch { /* 进程已经不在，或登记读不到 */ }
    }
  });
  t.after(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const added = await c.add();
  assert.equal(added.code, 0, added.stderr);
  return c;
}

function useTestEnv(env: Record<string, string>) {
  for (const key of TEST_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
}

async function open(c: Awaited<ReturnType<typeof setup>>, env: Record<string, string>, options: { rounds?: number; minutes?: number } = {}) {
  useTestEnv(env);
  return startTeam(c.task, { writer: 'grok:high', reviewer: 'deepseek:high', summary: '测搭档审改', project: '测试', ...options });
}

async function settle(home: string, id: string, timeout = 45000) {
  try {
    return await until(() => readTeam(id), team => team.state !== 'running', timeout);
  } catch (error) {
    const log = await readFile(join(home, 'teams', id, 'engine.log'), 'utf8').catch(() => '');
    throw new Error(`${error instanceof Error ? error.message : error}\n--- engine.log ---\n${log.slice(-2500)}`);
  }
}

async function assertRollup(id: string | undefined, rounds: number) {
  assert.ok(id);
  const job = await readJob(id);
  assert.equal(job.rounds?.length, rounds, JSON.stringify(job.rounds));
  for (const round of job.rounds ?? []) assert.equal(round.usage?.read, 100, JSON.stringify(round));
  assert.equal(job.usage?.read, rounds * 100, JSON.stringify(job.usage));
  assert.equal(job.usage?.cached, rounds * 60);
  assert.equal(job.usage?.out, rounds * 12);
  assert.equal(job.seconds, (job.rounds ?? []).reduce((sum, round) => sum + round.seconds, 0));
  assert.equal(job.started, job.rounds?.[0]?.started);
  return job;
}

test('parseReview 认结论和意见，容忍全角标点和空格', () => {
  const passed = parseReview('##  结论  \n   通过  \n\n## 意见\n1 . [建议]  可以\n');
  assert.equal(passed.verdict, 'pass');
  assert.equal(passed.items[0]?.level, 'suggest');
  assert.equal(passed.items[0]?.text, '可以');
  assert.equal(passed.items[0]?.reply, null);
  assert.equal(parseReview('##\u3000结论\n不通过\n').verdict, 'changes');
  assert.equal(parseReview('## 结论：\n要改\n').verdict, 'changes');
  assert.equal(parseReview('## 结论\n通过不通过\n').verdict, 'changes');
  assert.equal(parseReview('## 结论\n还没看明白\n').verdict, 'unclear');
  assert.equal(parseReview('没有结论这一节\n通过\n').verdict, 'unclear');
  const items = parseReview('## 结论\n要改\n## 意见\n1．［必须改］这里要改\n补充一行\n2、[建议] 可以更好\n1 . [疑问] 后写的不算\n');
  assert.equal(items.items.length, 2);
  assert.equal(items.items[0]?.level, 'must');
  assert.equal(items.items[0]?.text, '这里要改\n补充一行');
  assert.equal(items.items[1]?.level, 'suggest');
  assert.equal(items.items[1]?.n, 2);
  const long = parseReview(`## 结论\n要改\n## 意见\n1. [疑问] ${'问'.repeat(2001)}\n`);
  assert.equal([...(long.items[0]?.text ?? '')].length, 2000);
});

test('parseReplies 只读逐条回复，重复编号以最后一条为准', () => {
  assert.deepEqual(parseReplies('## 结论\n通过\n1. 已改：写在节外面\n'), []);
  const rows = parseReplies('## 逐条回复\n1.  已改  ：  做完了\n2、不改：先不动\n1．已改：以后一条为准\n');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { n: 1, reply: 'fixed', text: '以后一条为准' });
  assert.deepEqual(rows[1], { n: 2, reply: 'declined', text: '先不动' });
  const long = parseReplies(`## 逐条回复\n3. 不改：${'因'.repeat(2100)}\n`);
  assert.equal([...(long[0]?.text ?? '')].length, 2000);
});

test('clipText 超过上限时截断并注明', () => {
  assert.equal(clipText('短'), '短');
  const clipped = clipText('字'.repeat(TEXT_MAX + 3));
  assert.ok(clipped.startsWith('字'.repeat(TEXT_MAX)));
  assert.match(clipped, /超过 12000 字，这里截断了/);
});

function pair(id: string): Team {
  return {
    id, mode: 'pair', project: '测试', repo: '/repo', base: 'abc', kind: '实现', title: '测转交', summary: '测 heard', task: '# 题目',
    writer: { who: 'grok', effort: 'high' }, reviewer: { who: 'deepseek', effort: 'high' },
    round: 1, phase: 'write', maxRounds: 3, maxMinutes: 60, state: 'running', created: '2026-10-10T00:00:00.000Z',
  };
}
function heardOf(lines: string[]) {
  return `## 负责人与主人的话\n\n${lines.join('\n')}`;
}
async function heardHome(t: TestContext) {
  const home = await mkdtemp(join(tmpdir(), 'xagents-heard-'));
  const saved = process.env.XAGENTS_HOME;
  process.env.XAGENTS_HOME = home;
  t.after(async () => {
    if (saved === undefined) delete process.env.XAGENTS_HOME;
    else process.env.XAGENTS_HOME = saved;
    await rm(home, { recursive: true, force: true });
  });
}

describe('推进引擎', { concurrency: 1 }, () => {
  test('开队前拦住 Cursor 和相同模型', async t => {
    const c = await setup(t);
    await assert.rejects(startTeam(c.task, { writer: 'grok:high', reviewer: 'cursor-opus:high', summary: '测一下', project: '测试' }), /Cursor 还没实测续接/);
    await assert.rejects(startTeam(c.task, { writer: 'grok:high', reviewer: 'grok:medium', summary: '测一下', project: '测试' }), /不同的模型/);
  });

  test('写完审过，交给负责人，审查副本里有写手的改动', async t => {
    const c = await setup(t);
    const team = await open(c, { XA_TEST_REVIEW: 'pass' });
    const done = await settle(c.home, team.id);
    assert.equal(done.state, 'lead', `${done.reason ?? ''} ${done.note ?? ''}`);
    assert.equal(done.reason, 'passed', done.note);
    assert.match(done.note ?? '', /审查通过/);
    const channel = await readChannel(done.id);
    assert.ok(channel.some(message => message.kind === 'event' && message.text.startsWith('开队：')));
    assert.equal(channel.find(message => message.kind === 'review')?.verdict, 'pass');
    await assertRollup(done.writer.job, 1);
    const reviewer = await assertRollup(done.reviewer.job, 1);
    assert.equal(await readFile(join(reviewer.worktree, 'writer-round.txt'), 'utf8'), '第1轮\n');
    await access(join(teamDir(done.id), 'engine.log'));
    await access(join(teamDir(done.id), 'runtime/src/core/team-entry.ts'));
    const ended = await stopTeam(done.id);
    assert.equal(ended.state, 'ended');
    assert.equal(ended.reason, 'passed');
    await assert.rejects(continueTeam(done.id), /已经收场/);
  });

  test('要改后续接写手，提示词里有意见原文，再审通过后用量是各轮之和', async t => {
    const c = await setup(t);
    const team = await open(c, { XA_TEST_REVIEW: 'changes,pass' });
    const done = await settle(c.home, team.id, 90000);
    assert.equal(done.reason, 'passed', `${done.state} ${done.note ?? ''}`);
    const writer = await assertRollup(done.writer.job, 2);
    const reviewer = await assertRollup(done.reviewer.job, 2);
    assert.match(writer.session ?? '', SESSION_RE);
    assert.match(reviewer.session ?? '', SESSION_RE);
    const writerSeen = JSON.parse(await readFile(join(jobDir(writer.id), 'observed.json'), 'utf8')) as { args: string[]; prompt: string };
    assert.ok(writerSeen.args.includes('--resume'), writerSeen.args.join(' '));
    assert.ok(writerSeen.args.includes(writer.session));
    assert.match(writerSeen.prompt, /\[必须改\]/);
    assert.match(writerSeen.prompt, /逐条回复按审查意见的编号写/);
    const reviewerSeen = JSON.parse(await readFile(join(jobDir(reviewer.id), 'observed.json'), 'utf8')) as { args: string[]; prompt: string };
    assert.match(reviewerSeen.prompt, /照原编号再列/);
    assert.match(reviewerSeen.prompt, /已经解决的不再列/);
    assert.match(reviewerSeen.prompt, /从目前最大编号往后接着编/);
    assert.equal(reviewerSeen.prompt.includes('编号重新从 1 开始'), false);
    assert.ok(reviewerSeen.args.includes('resume'), reviewerSeen.args.join(' '));
    assert.ok(reviewerSeen.args.includes(reviewer.session));
    const first = (await readChannel(done.id)).find(message => message.kind === 'review' && message.round === 1);
    assert.equal(first?.items?.[0]?.reply, 'fixed');
    assert.equal(first?.items?.[1]?.reply, 'declined');
    await access(join(jobDir(writer.id), 'run-r1.log'));
    await access(join(jobDir(writer.id), 'run.log'));
    assert.equal(await readFile(join(reviewer.worktree, 'writer-round.txt'), 'utf8'), '第2轮\n');
  });

  test('轮数用完还要改，交给负责人', async t => {
    const c = await setup(t);
    const team = await open(c, { XA_TEST_REVIEW: 'changes' }, { rounds: 2 });
    const done = await settle(c.home, team.id, 90000);
    assert.equal(done.state, 'lead', done.note);
    assert.equal(done.reason, 'disagree', done.note);
    assert.match(done.note ?? '', /上限/);
    await assertRollup(done.writer.job, 2);
    await assertRollup(done.reviewer.job, 2);
  });

  test('审查报告没有结论时停下', async t => {
    const c = await setup(t);
    const team = await open(c, { XA_TEST_REVIEW: 'unclear' });
    const done = await settle(c.home, team.id);
    assert.equal(done.reason, 'unclear', done.note);
    assert.match(done.note ?? '', /找不到/);
  });

  test('写手一轮出错则失败，不再叫审查', async t => {
    const c = await setup(t);
    const team = await open(c, { XA_TEST_MODE: 'fail' });
    const done = await settle(c.home, team.id);
    assert.equal(done.reason, 'failed', done.note);
    assert.match(done.note ?? '', /写手/);
    assert.equal(done.reviewer.job, undefined);
  });

  test('写手下一轮没有新改动就刹车', async t => {
    const c = await setup(t);
    const team = await open(c, { XA_TEST_REVIEW: 'changes', XA_TEST_FREEZE: '1' });
    const done = await settle(c.home, team.id, 90000);
    assert.equal(done.reason, 'brake', done.note);
    assert.match(done.note ?? '', /没有新改动/);
  });

  test('超过设定时长，在叫醒审查前刹车', async t => {
    const c = await setup(t);
    const team = await open(c, { XA_TEST_MODE: 'hold' }, { minutes: 10 });
    const writer = await until(() => readJob(team.writer.job!), job => job.state === 'running', 20000);
    await updateTeam(team.id, current => { current.created = new Date(Date.now() - 31 * 60 * 1000).toISOString(); });
    await writeFile(join(jobDir(writer.id), 'release'), '1\n');
    const done = await settle(c.home, team.id);
    assert.equal(done.reason, 'brake', done.note);
    assert.match(done.note ?? '', /分钟/);
    assert.equal(done.reviewer.job, undefined);
  });

  test('主人关掉审查用的选手时，叫醒前被拦住', async t => {
    const c = await setup(t);
    const team = await open(c, { XA_TEST_MODE: 'hold' });
    const writer = await until(() => readJob(team.writer.job!), job => job.state === 'running', 20000);
    await writeSettings({ workers: { deepseek: { enabled: false, efforts: ['high'], fast: false } } });
    await writeFile(join(jobDir(writer.id), 'release'), '1\n');
    const done = await settle(c.home, team.id);
    assert.equal(done.reason, 'blocked', done.note);
    assert.match(done.note ?? '', /关掉了 DeepSeek/);
  });

  test('stopTeam 停下正在跑的写手和推进进程', async t => {
    const c = await setup(t);
    const team = await open(c, { XA_TEST_MODE: 'hang' });
    const writer = await until(() => readJob(team.writer.job!), job => job.state === 'running' && typeof job.workerPid === 'number', 20000);
    const running = await until(() => readTeam(team.id), current => typeof current.pid === 'number' && alive(current.pid), 20000);
    await assert.rejects(continueTeam(team.id), /还在推进/);
    const ended = await stopTeam(team.id);
    assert.equal(ended.state, 'ended');
    assert.equal((await readJob(writer.id)).state, 'stopped');
    assert.equal(alive(writer.workerPid), false);
    assert.equal(alive(running.pid), false);
  });

  test('推进进程不在时，reconcileTeam 记为失联', async t => {
    const c = await setup(t);
    const team = await open(c, { XA_TEST_MODE: 'hang' });
    await until(() => readJob(team.writer.job!), job => job.state === 'running' && typeof job.workerPid === 'number', 20000);
    const running = await until(() => readTeam(team.id), current => typeof current.pid === 'number' && alive(current.pid), 20000);
    process.kill(running.pid!, 'SIGKILL');
    await until(async () => alive(running.pid), gone => !gone, 5000);
    const lost = await reconcileTeam(await readTeam(team.id));
    assert.equal(lost.state, 'lead');
    assert.equal(lost.reason, 'lost');
    assert.match(lost.note ?? '', /engine\.log/);
    const again = await reconcileTeam(lost);
    assert.equal(again.state, 'lead');
    assert.equal(again.reason, 'lost');
    assert.equal(again.ended, lost.ended);
    const ended = await stopTeam(team.id);
    assert.equal(ended.state, 'ended');
    assert.equal((await readJob(team.writer.job!)).state, 'stopped');
  });

  test('负责人加一轮后写手续接，并带上这句话', async t => {
    const c = await setup(t);
    const team = await open(c, { XA_TEST_REVIEW: 'unclear' });
    const paused = await settle(c.home, team.id);
    assert.equal(paused.reason, 'unclear', paused.note);
    useTestEnv({ XA_TEST_REVIEW: 'pass' });
    const resumed = await continueTeam(team.id, '请再看一眼');
    assert.equal(resumed.state, 'running');
    assert.equal(resumed.round, 2);
    const done = await settle(c.home, team.id, 90000);
    assert.equal(done.reason, 'passed', `${done.state} ${done.note ?? ''}`);
    const writer = await readJob(done.writer.job!);
    const seen = JSON.parse(await readFile(join(jobDir(writer.id), 'observed.json'), 'utf8')) as { args: string[]; prompt: string };
    assert.ok(seen.args.includes('--resume'));
    assert.match(seen.prompt, /请再看一眼/);
    assert.match(seen.prompt, /负责人与主人的话/);
    await assertRollup(done.writer.job, 2);
    await assertRollup(done.reviewer.job, 2);
  });

  test('垃圾补丁同步失败时说明原因，空补丁则跳过', async t => {
    const c = await setup(t);
    const blank = join(c.temp, 'blank.patch');
    await writeFile(blank, '  \n');
    await syncReviewWorktree(c.repo, c.base, blank);
    assert.equal(await c.git(['status', '--porcelain']), '');
    const bad = join(c.temp, 'bad.patch');
    await writeFile(bad, '这不是补丁\n');
    await assert.rejects(syncReviewWorktree(c.repo, c.base, bad), /写手的改动没法同步给审查/);
    assert.equal(await c.git(['status', '--porcelain']), '');
  });

  test('heard：还没交报告时带上目前所有的话，没有话时返回空串', async t => {
    await heardHome(t);
    const id = 'heard-all';
    await createTeam(pair(id));
    assert.equal(await heard(id, 'writer'), '');
    assert.equal(await heard(id, 'reviewer'), '');
    await appendMessage(id, { round: 1, from: 'platform', kind: 'event', text: '开队：这段不是话' });
    assert.equal(await heard(id, 'writer'), '');
    assert.equal(await heard(id, 'reviewer'), '');
    await sayInTeam(id, '先说明范围', 'owner');
    await sayInTeam(id, '照题目做', 'lead');
    const all = heardOf(['- 主人：先说明范围', '- 负责人：照题目做']);
    assert.equal(await heard(id, 'writer'), all);
    assert.equal(await heard(id, 'reviewer'), all);
  });

  test('heard：交过报告后只带报告之后的话，写手和审查各算各的', async t => {
    await heardHome(t);
    const id = 'heard-cut';
    await createTeam(pair(id));
    await sayInTeam(id, '先说明范围', 'owner');
    await sayInTeam(id, '照题目做', 'lead');
    await appendMessage(id, { round: 1, from: 'writer', kind: 'report', text: '写手第 1 轮' });
    assert.equal(await heard(id, 'writer'), '');
    assert.equal(await heard(id, 'reviewer'), heardOf(['- 主人：先说明范围', '- 负责人：照题目做']));
    await sayInTeam(id, '标题改短', 'lead');
    assert.equal(await heard(id, 'writer'), heardOf(['- 负责人：标题改短']));
    assert.equal(await heard(id, 'reviewer'), heardOf(['- 主人：先说明范围', '- 负责人：照题目做', '- 负责人：标题改短']));
    await appendMessage(id, { round: 1, from: 'reviewer', kind: 'review', text: '审查第 1 轮', verdict: 'changes' });
    assert.equal(await heard(id, 'writer'), heardOf(['- 负责人：标题改短']));
    assert.equal(await heard(id, 'reviewer'), '');
    await sayInTeam(id, '再核对边界', 'owner');
    assert.equal(await heard(id, 'writer'), heardOf(['- 负责人：标题改短', '- 主人：再核对边界']));
    assert.equal(await heard(id, 'reviewer'), heardOf(['- 主人：再核对边界']));
    await appendMessage(id, { round: 2, from: 'writer', kind: 'report', text: '写手第 2 轮' });
    assert.equal(await heard(id, 'writer'), '');
    assert.equal(await heard(id, 'reviewer'), heardOf(['- 主人：再核对边界']));
    await appendMessage(id, { round: 2, from: 'reviewer', kind: 'review', text: '审查第 2 轮', verdict: 'pass' });
    assert.equal(await heard(id, 'writer'), '');
    assert.equal(await heard(id, 'reviewer'), '');
  });
});


test('不设限通过 team-engine 派出 95% 的选手，无需 force', async t => {
  const c = await setup(t), at = new Date().toISOString();
  await writeFile(join(c.home, 'config.json'), JSON.stringify({ limits: { maxRunning: 12, quotaStop: null } }));
  await mkdir(join(c.home, 'cache'), { recursive: true });
  await writeFile(join(c.home, 'cache/quota.json'), JSON.stringify({ queriedAt: at, providers: [
    { name: 'Grok', icon: 'grok', plan: null, at, bars: [{ label: '本期额度', used: 95, reset: null }] },
    { name: 'Codex', icon: 'codex', plan: null, at, bars: [] },
    { name: 'Cursor', icon: 'cursor', plan: null, at, bars: [] },
  ] }));
  const team = await open(c, { XA_TEST_REVIEW: 'pass' });
  const done = await settle(c.home, team.id);
  assert.equal((await readJob(done.writer.job!)).state, 'done');
  assert.equal((await readJob(done.reviewer.job!)).state, 'done');
});
