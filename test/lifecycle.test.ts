import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, access, mkdir, symlink, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { context, until, desktopView } from './helpers.ts';
import { alive } from '../src/core/fsx.ts';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { root } from './helpers.ts';
import { ensureHome } from '../src/core/paths.ts';
import { PLATFORM_SWITCHES } from '../src/core/env.ts';
import { reserveJob } from '../src/core/ids.ts';
import { createJob } from '../src/core/job.ts';
import { codexPermissions } from '../src/core/sandbox.ts';

test('四家同批派发到完成、共同起点、收集、diff、清理与记录保留', async t => {
  const c = await context(t);
  const extra = join(c.temp, 'rules.md'); await writeFile(extra, '项目额外规则');
  assert.equal((await c.add(['--rules', extra, '--deny-read', '.data', '--setup', "printf '准备好了' > setup.txt"])).code, 0);
  const r = await c.cli(['run', c.task, '--summary', '完成本次测试任务', '--who', 'codex:xhigh', '--who', 'grok:high', '--who', 'cursor-grok:high', '--who', 'cursor-opus:xhigh', '--title', '完整流程'], { XA_TEST_MODE: 'change' });
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /Codex 仍可能读到/);
  const first = (await c.jobs())[0], waited = await c.cli(['wait', first.batch]);
  assert.equal(waited.code, 0, waited.stderr + waited.stdout);
  const jobs = await c.jobs(); assert.equal(jobs.length, 4);
  assert.ok(jobs.every(j => j.summary === '完成本次测试任务'));
  const batch = JSON.parse(await readFile(join(c.home, 'batches', first.batch + '.json'), 'utf8'));
  assert.equal(batch.summary, '完成本次测试任务');
  assert.equal(new Set(jobs.map(j => j.base)).size, 1); assert.equal(jobs[0].base, c.base);
  for (const j of jobs) {
    assert.equal(j.state, 'done'); assert.equal(j.exit, 0); assert.ok(j.seconds! >= 0);
    assert.equal(j.usage?.read, 100); assert.equal(j.usage?.cached, 60); assert.equal(j.usage?.out, 12);
    await access(j.worktree); assert.equal(await c.git(['rev-parse', j.branch]), c.base);
    const dir = join(c.home, 'jobs', j.id);
    const prompt = await readFile(join(dir, 'prompt.md'), 'utf8');
    assert.ok(prompt.indexOf('不提交') < prompt.indexOf('项目额外规则'));
    assert.ok(prompt.indexOf('项目额外规则') < prompt.indexOf('本题只运行'));
    const observed = JSON.parse(await readFile(join(dir, 'observed.json'), 'utf8'));
    assert.equal(observed.prompt, prompt); assert.equal(observed.cwd, j.worktree);
    if (j.who === 'codex') {
      // 权限里带着登记处下 DeepSeek 文件夹的禁读，要按派活时的登记处来算。
      const oldHome = process.env.XAGENTS_HOME; process.env.XAGENTS_HOME = c.home;
      try { assert.ok(observed.args.includes(codexPermissions(j, { denyReadExtra: ['.data'] }, join(dir, 'tmp')))); }
      finally { if (oldHome === undefined) delete process.env.XAGENTS_HOME; else process.env.XAGENTS_HOME = oldHome; }
      assert.ok(!observed.args.includes('-s'));
      assert.ok(!observed.args.some((arg: string) => arg.includes('sandbox_mode')));
    }
    assert.ok((await readFile(join(dir, 'report.md'), 'utf8')).includes('测试替身完成'));
    assert.ok(j.command?.args[0].endsWith('worker.ts'));
    await access(join(dir, 'run.log')); await access(join(dir, 'tmp'));
    await access(join(dir, 'runtime/src/core/runner.ts')); await access(join(dir, 'versions.json'));
    const changes = await readFile(join(dir, 'diff.patch'), 'utf8');
    assert.ok(changes.includes('+新增内容')); assert.ok(changes.includes('-起点')); assert.ok(changes.includes('new file.txt'));
  }
  await writeFile(join(c.temp, 'private.txt'), '不该被 diff 读取');
  await symlink(join(c.temp, 'private.txt'), join(jobs[0].worktree, 'link.txt'));
  const beforeStatus = await c.git(['-C', jobs[0].worktree, 'status', '--porcelain']);
  const originalDiff = await readFile(join(c.home, 'jobs', jobs[0].id, 'diff.patch'), 'utf8');
  const parallelViews = await Promise.all(Array.from({ length: 3 }, () => desktopView(c.home)));
  assert.ok(parallelViews.every(view => view.jobs.length === 4));
  assert.equal(await c.git(['-C', jobs[0].worktree, 'status', '--porcelain']), beforeStatus);
  assert.equal(await readFile(join(c.home, 'jobs', jobs[0].id, 'diff.patch'), 'utf8'), originalDiff);
  const data = await desktopView(c.home);
  assert.equal(data.jobs.length, 4); assert.equal(data.quota.length, 3); assert.equal(data.selfcheck.ok, null);
  await assert.rejects(access(join(c.home, 'board')), { code: 'ENOENT' });
  const result = await c.cli(['collect', first.batch]); assert.equal(result.code, 0, result.stderr);
  const linkDiff = await readFile(join(c.home, 'jobs', jobs[0].id, 'diff.patch'), 'utf8');
  assert.ok(linkDiff.includes('new file mode 120000')); assert.ok(!linkDiff.includes('不该被 diff 读取'));
  await writeFile(join(jobs[0].worktree, 'after-collect.txt'), '清理前新增\n');
  // 派 Cursor 活时建了短路径的状态目录（<登记处>/cursor/<摘要>），清理前在、清理后删光。
  assert.ok((await readdir(join(c.home, 'cursor'))).length > 0);
  assert.equal((await c.cli(['clean', first.batch])).code, 0);
  assert.deepEqual(await readdir(join(c.home, 'cursor')), []);
  for (const j of await c.jobs()) {
    assert.ok(j.cleaned); await assert.rejects(access(j.worktree));
    // 任务专用临时目录随副本一起删掉。
    await assert.rejects(access(join(c.home, 'jobs', j.id, 'tmp')));
    assert.equal(await c.git(['branch', '--list', j.branch]), '');
    await access(join(c.home, 'jobs', j.id, 'report.md'));
    const diff = await readFile(join(c.home, 'jobs', j.id, 'diff.patch'), 'utf8');
    assert.ok(diff.includes('+新增内容'));
    if (j.id === jobs[0].id) {
      assert.match(diff, /after-collect.txt/);
      assert.equal(j.changedFiles, 5);
    }
  }
  assert.match((await c.cli(['status'])).stdout, /没有符合条件/);
  assert.match((await c.cli(['status', '--all'])).stdout, /已清理/);
});

test('尚未到节流时间就停止，也补齐已有动作、报告和文件数', async t => {
  const c = await context(t); await c.add();
  const started = await c.cli(['run', c.task, '--summary', '完成本次测试任务', '--who', 'grok:high'], { XA_TEST_MODE: 'stream' });
  assert.equal(started.code, 0, started.stderr);
  const job = (await c.jobs())[0], dir = join(c.home, 'jobs', job.id);
  await until(() => readFile(join(dir, 'run.log'), 'utf8').catch(() => ''), raw => raw.includes('"type":"tool_call"'));
  assert.equal((await c.jobs())[0].activity, undefined);
  const stopped = await c.cli(['stop', job.id]); assert.equal(stopped.code, 0, stopped.stderr);
  const done = (await c.jobs())[0];
  assert.equal(done.state, 'stopped'); assert.equal(done.changedFiles, 1);
  assert.deepEqual(done.activity?.map(a => a.kind), ['say', 'read']);
  assert.ok(done.lastActivityAt); assert.match(await readFile(join(dir, 'report.md'), 'utf8'), /我先读/);
  assert.match(await readFile(join(dir, 'diff.patch'), 'utf8'), /改过的起点/);
  await until(async () => !alive(done.workerPid) && !alive(done.pid));
});
test('非零退出、没有报告、无效 JSON 均失败，collect 可补救正常退出时缺失的报告', async t => {
  const c = await context(t); await c.add();
  for (const [mode, who] of [['fail', 'codex:high'], ['empty', 'grok:high'], ['malformed', 'cursor-grok:high']]) {
    const before = new Set((await c.jobs()).map(j => j.id));
    await c.cli(['run', c.task, '--summary', '完成本次测试任务', '--who', who], { XA_TEST_MODE: mode });
    const j = (await c.jobs()).find(j => !before.has(j.id))!;
    assert.equal((await c.cli(['wait', j.id])).code, 1);
    const done = (await c.jobs()).find(x => x.id === j.id)!;
    assert.equal(done.state, 'failed'); assert.ok(done.error);
    assert.equal(done.exit, mode === 'fail' ? 7 : 0);
    if (mode === 'empty') {
      await writeFile(join(c.home, 'jobs', j.id, 'run.log'), '{"type":"text","data":"补回报告"}\n{"type":"end","usage":{"output_tokens":9}}\n');
      assert.equal((await c.cli(['collect', j.id])).code, 0);
      assert.equal((await c.jobs()).find(x => x.id === j.id)!.state, 'done');
    }
  }
});
test('stop 结束整组选手含孙进程，也能终止忽略 SIGTERM 的选手', async t => {
  const c = await context(t); await c.add();
  for (const mode of ['hang', 'ignore-term']) {
    const before = new Set((await c.jobs()).map(j => j.id));
    assert.equal((await c.cli(['run', c.task, '--summary', '完成本次测试任务', '--who', 'grok:high'], { XA_TEST_MODE: mode })).code, 0);
    const j = await until(async () => (await c.jobs()).find(j => !before.has(j.id)), j => Boolean(j?.workerPid));
    const file = join(c.home, 'jobs', j!.id, 'grandchild.pid');
    const grandchild = Number(await until(() => readFile(file, 'utf8').catch(() => '')));
    assert.equal((await c.cli(['clean', j!.id])).code, 1);
    assert.equal((await c.cli(['stop', j!.id])).code, 0);
    await until(async () => !alive(j!.workerPid) && !alive(grandchild));
    const stopped = (await c.jobs()).find(x => x.id === j!.id)!;
    assert.equal(stopped.state, 'stopped'); assert.ok(stopped.ended);
    assert.equal((await c.cli(['wait', j!.id])).code, 0);
    assert.equal((await c.cli(['clean', j!.id])).code, 0);
  }
});
test('看管进程被 SIGKILL 后 status 判失联，wait 失败，stop 收掉残留组', async t => {
  const c = await context(t); await c.add();
  await c.cli(['run', c.task, '--summary', '完成本次测试任务', '--who', 'codex:high'], { XA_TEST_MODE: 'hang' });
  const j = await until(async () => (await c.jobs())[0], j => Boolean(j?.workerPid));
  process.kill(j.pid!, 'SIGKILL'); await until(async () => !alive(j.pid));
  assert.equal((await c.cli(['status', j.id])).code, 0);
  assert.equal((await c.jobs())[0].state, 'lost'); assert.equal((await desktopView(c.home)).jobs[0].state, 'lost');
  assert.equal((await c.cli(['wait', j.id])).code, 1);
  assert.equal((await c.cli(['clean', j.id])).code, 1);
  assert.equal((await c.cli(['stop', j.id])).code, 0); await until(async () => !alive(j.workerPid));
  assert.equal((await c.cli(['clean', j.id])).code, 0);
});
test('快速版和 cursor-sonnet：任务记录、状态表、统计、看板数据都分得清', async t => {
  const c = await context(t); await c.add();
  const specs = ['grok:medium:fast', 'grok:medium', 'cursor-sonnet:medium', 'cursor-opus:high:fast'];
  const r = await c.cli(['run', c.task, '--summary', '完成本次测试任务', ...specs.flatMap(s => ['--who', s])], { XA_TEST_MODE: 'change' });
  assert.equal(r.code, 0, r.stderr);
  const first = (await c.jobs())[0]; assert.equal((await c.cli(['wait', first.batch])).code, 0);
  const jobs = await c.jobs(), by = (who: string, fast: boolean) => jobs.find(j => j.who === who && Boolean(j.fast) === fast)!;
  assert.deepEqual([by('grok', true).model, by('grok', true).effort, by('grok', true).fast], ['grok-4.7-build-fast', 'medium', true]);
  assert.deepEqual([by('grok', false).model, by('grok', false).fast], ['grok-4.7', undefined]);
  assert.deepEqual([by('cursor-sonnet', false).model, by('cursor-sonnet', false).effort], ['claude-sonnet-5-5-medium', 'medium']);
  assert.deepEqual([by('cursor-opus', true).model, by('cursor-opus', true).fast], ['claude-opus-5-5-high-fast', true]);
  const observed = JSON.parse(await readFile(join(c.home, 'jobs', by('grok', true).id, 'observed.json'), 'utf8')).args as string[];
  assert.equal(observed[observed.indexOf('--effort') + 1], 'medium'); assert.equal(observed[observed.indexOf('-m') + 1], 'grok-4.7-build-fast');
  const status = (await c.cli(['status'])).stdout;
  assert.match(status, /grok-4\.7-build-fast·medium·快速版/); assert.match(status, /claude-sonnet-5-5-medium·medium(?!·快速版)/);
  const stats = (await c.cli(['stats'])).stdout;
  assert.match(stats, /grok（快速版）/); assert.match(stats, /^grok\s+实现/m); assert.match(stats, /cursor-sonnet/);
  const data = await desktopView(c.home);
  assert.equal(data.workers['cursor-sonnet'].name, 'Cursor · Sonnet'); assert.equal(data.workers['cursor-sonnet'].badge, 'claude');
  assert.equal(data.jobs.find((j: { id: string }) => j.id === by('grok', true).id).fast, true);
  assert.equal(data.jobs.find((j: { id: string }) => j.id === by('grok', false).id).fast, undefined);
  assert.ok(data.stats.some((s: { who: string; fast: boolean }) => s.who === 'grok' && s.fast) && data.stats.some((s: { who: string; fast: boolean }) => s.who === 'grok' && !s.fast));
  for (const bad of ['codex:high:fast', 'cursor-sonnet:high:fast', 'grok:max', 'cursor-opus:low']) assert.equal((await c.cli(['run', c.task, '--summary', '完成本次测试任务', '--who', bad])).code, 1);
  assert.equal((await c.jobs()).length, 4);
  for (const j of jobs) await c.cli(['clean', j.id]);
});
test('跨进程同时派发不会突破上限，非法强度不登记任务', async t => {
  const c = await context(t); await c.add();
  assert.equal((await c.cli(['run', c.task, '--summary', '完成本次测试任务', '--who', 'grok:max'])).code, 1);
  assert.equal((await c.jobs()).length, 0);
  const args = ['run', c.task, '--summary', '完成本次测试任务', '--who', 'codex:high'];
  const results = await Promise.all([c.cli(args, { XAGENTS_MAX_RUNNING: '1', XA_TEST_MODE: 'hang' }), c.cli(args, { XAGENTS_MAX_RUNNING: '1', XA_TEST_MODE: 'hang' })]);
  assert.deepEqual(results.map(r => r.code).sort(), [0, 1]);
  assert.match(results.find(r => r.code === 1)!.stderr, /同时最多跑 1 件/);
  assert.equal((await c.jobs()).length, 1);
  assert.equal((await c.cli(['stop', (await c.jobs())[0].id])).code, 0);
});
test('setup 失败不启动选手，失败副本可清理，main 之外起点须明确指定', async t => {
  const c = await context(t); await c.add(['--setup', 'echo 准备失败; exit 9']);
  const r = await c.cli(['run', c.task, '--summary', '完成本次测试任务', '--who', 'codex:high']); assert.equal(r.code, 1);
  const j = (await c.jobs())[0]; assert.equal(j.state, 'failed'); assert.match(j.error!, /setup|准备副本/); assert.equal(j.workerPid, undefined);
  assert.equal((await c.cli(['clean', j.id])).code, 0);
  await c.add(); await c.git(['branch', '-m', 'main', 'develop']);
  assert.equal((await c.cli(['run', c.task, '--summary', '完成本次测试任务', '--who', 'codex:high'])).code, 1);
  const explicit = await c.cli(['run', c.task, '--summary', '完成本次测试任务', '--who', 'codex:high', '--base', c.base, '--ro']);
  assert.equal(explicit.code, 0, explicit.stderr);
  const next = (await c.jobs()).find(x => x.id !== j.id)!;
  assert.equal(next.mode, 'read-only'); assert.equal(next.base, c.base);
  assert.equal((await c.cli(['wait', next.id])).code, 0);
});
test('clean --done 保留采用任务，路径穿越和额外参数被拒绝', async t => {
  const c = await context(t); await c.add();
  await c.cli(['run', c.task, '--summary', '完成本次测试任务', '--who', 'codex:high', '--who', 'grok:high']);
  const jobs = await c.jobs(); await c.cli(['wait', jobs[0].batch]);
  const path = join(c.home, 'jobs', jobs[0].id, 'job.json');
  const j = JSON.parse(await readFile(path, 'utf8')); j.decision = { kind: 'adopt', note: '测试采用' }; await writeFile(path, JSON.stringify(j));
  assert.equal((await c.cli(['clean', '--done'])).code, 0);
  await access(j.worktree); assert.equal((await c.jobs()).filter(j => j.cleaned).length, 1);
  for (const args of [['status', '../outside'], ['clean', jobs[0].id, '--done'], ['board', 'extra'], ['run', c.task, '--summary', '完成本次测试任务', '--who'], ['project', 'add', '../outside', c.repo], ['project', 'add', 'bad', c.repo, '--worktree-root', '../bad']]) assert.equal((await c.cli(args)).code, 1, args.join(' '));
});
test('setup 尚未结束时 stop 也能终止准备进程，不启动选手', async t => {
  const c = await context(t);
  await c.add(['--setup', `${process.execPath} -e 'setInterval(() => {}, 1000)'`]);
  const child = spawn(process.execPath, [join(root, 'src/cli/cli.ts'), 'run', c.task, '--summary', '完成本次测试任务', '--who', 'codex:high'], { cwd: c.repo, env: c.env, stdio: 'ignore' });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const ended = once(child, 'close');
  const j = await until(async () => (await c.jobs())[0], j => Boolean(j?.setupPid));
  assert.equal((await c.cli(['stop', j.id])).code, 0);
  await ended;
  const stopped = (await c.jobs())[0]; assert.equal(stopped.state, 'stopped'); assert.equal(stopped.workerPid, undefined);
  assert.equal(alive(j.setupPid), false); assert.equal((await c.cli(['clean', j.id])).code, 0);
});
test('派发进程准备期间被杀后登记不永远排队，可停止残留准备进程', async t => {
  const c = await context(t);
  await c.add(['--setup', `${process.execPath} -e 'setInterval(() => {}, 1000)'`]);
  const child = spawn(process.execPath, [join(root, 'src/cli/cli.ts'), 'run', c.task, '--summary', '完成本次测试任务', '--who', 'codex:high'], { cwd: c.repo, env: c.env, stdio: 'ignore' });
  const ended = once(child, 'close');
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const j = await until(async () => (await c.jobs())[0], j => Boolean(j?.setupPid));
  child.kill('SIGKILL'); await ended;
  assert.equal((await c.cli(['status'])).code, 0); assert.equal((await c.jobs())[0].state, 'failed');
  assert.equal((await c.cli(['clean', j.id])).code, 1);
  assert.equal((await c.cli(['stop', j.id])).code, 0);
  await until(async () => !alive(j.setupPid));
  assert.equal((await c.cli(['clean', j.id])).code, 0);
});
test('从仓库子目录和现有工作副本能匹配项目，拒绝指向仓库外的副本目录', async t => {
  const c = await context(t); await c.add();
  const nested = join(c.repo, 'nested'); await mkdir(nested);
  const r = await c.cli(['run', c.task, '--summary', '完成本次测试任务', '--who', 'codex:high'], {}, nested); assert.equal(r.code, 0, r.stderr);
  const j = (await c.jobs())[0]; await c.cli(['wait', j.id]);
  const r2 = await c.cli(['run', c.task, '--summary', '完成本次测试任务', '--who', 'grok:high', '--ro'], {}, j.worktree); assert.equal(r2.code, 0, r2.stderr);
  const j2 = (await c.jobs()).find(x => x.id !== j.id)!; await c.cli(['wait', j2.id]);
  const settings = JSON.parse(await readFile(join(c.home, 'jobs', j2.id, 'sandbox.json'), 'utf8'));
  assert.ok(!settings.filesystem.allowWrite.includes(j2.worktree));
  await symlink(c.temp, join(c.repo, 'escape'));
  assert.equal((await c.cli(['project', 'add', '测试', c.repo, '--worktree-root', 'escape'])).code, 0);
  const refused = await c.cli(['run', c.task, '--summary', '完成本次测试任务', '--who', 'codex:high']);
  assert.equal(refused.code, 1); assert.match(refused.stderr, /符号链接/);
});
test('看管进程尚未安装信号处理器时 stop 仍记为 stopped', async t => {
  const c = await context(t);
  process.env.XAGENTS_HOME = c.home; await ensureHome();
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const ended = once(child, 'close');
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const id = await reserveJob('codex', c.task);
  await createJob({ id, batch: 'batch', who: 'codex', model: 'gpt-6-astra', effort: 'high', repo: c.repo, worktree: join(c.repo, 'unused'), base: c.base, branch: `xa/${id}`, project: '测试', kind: '实现', title: '启动竞态', mode: 'workspace-write', state: 'queued', created: new Date().toISOString(), pid: child.pid });
  const stopped = await c.cli(['stop', id]); assert.equal(stopped.code, 0, stopped.stderr);
  await ended;
  assert.equal((await c.jobs())[0].state, 'stopped');
});

test('三份样本分段写入：status、桌面视图看到两次动作变化，退出与 collect 都能完整收集', async t => {
  const c = await context(t); await c.add();
  const run = await c.cli(['run', c.task, '--summary', '完成本次测试任务', '--who', 'codex:high', '--who', 'grok:high', '--who', 'cursor-opus:high', '--who', 'cursor-grok:high'], { XA_TEST_MODE: 'stream' });
  assert.equal(run.code, 0, run.stderr);
  const jobs = await c.jobs(); assert.equal(jobs.length, 4);
  const first = await until(c.jobs, rows => rows.length === 4 && rows.every(j => (j.activity?.length ?? 0) > 0), 16000);
  await assert.rejects(access(join(c.home, 'board')), { code: 'ENOENT' });
  for (const j of first) {
    assert.equal(j.state, 'running'); assert.equal(j.title, 'task');
    assert.ok(j.lastActivityAt);
    const status = await c.cli(['status', j.id]); assert.equal(status.code, 0, status.stderr);
    assert.ok(status.stdout.includes(j.activity!.at(-1)!.text));
    await assert.rejects(access(join(c.home, 'jobs', j.id, 'result.json')));
    await assert.rejects(access(join(c.home, 'jobs', j.id, 'runtime/board/index.html')));
  }
  const firstData = await desktopView(c.home);
  assert.ok(firstData.jobs.every((j: any) => j.activity.length > 0));
  for (const j of jobs) await writeFile(join(c.home, 'jobs', j.id, 'continue-1'), '');
  const second = await until(c.jobs, rows => rows.every(j => j.activity!.length > first.find(f => f.id === j.id)!.activity!.length), 16000);
  const secondData = await desktopView(c.home);
  await assert.rejects(access(join(c.home, 'board')), { code: 'ENOENT' });
  for (const j of second) {
    assert.equal(j.state, 'running');
    assert.ok(Date.parse(j.lastActivityAt!) > Date.parse(first.find(f => f.id === j.id)!.lastActivityAt!));
    const status = await c.cli(['status', j.id]);
    assert.ok(status.stdout.includes(j.activity!.at(-1)!.text));
    assert.deepEqual(secondData.jobs.find((r: any) => r.id === j.id).activity, j.activity);
  }
  for (const j of jobs) await writeFile(join(c.home, 'jobs', j.id, 'continue-2'), '');
  const waited = await c.cli(['wait', jobs[0].batch]); assert.equal(waited.code, 0, waited.stderr + waited.stdout);
  const expectedUsage = {
    codex: { read: 2282885, cached: 2169088, out: 45095 },
    grok: { read: 87128, cached: 77056, out: 398 },
    'cursor-opus': { read: 77596, cached: 57984, cacheWrite: 0, out: 366 },
    'cursor-grok': { read: 77596, cached: 57984, cacheWrite: 0, out: 366 },
  };
  const reports = new Map<string, string>(), activities = new Map<string, unknown>(), timings = new Map<string, unknown>();
  for (const j of await c.jobs()) {
    assert.equal(j.state, 'done'); assert.equal(j.changedFiles, 2);
    assert.equal(j.timing?.steps, j.who === 'codex' ? 49 : j.who === 'grok' ? 3 : 4);
    timings.set(j.id, j.timing);
    assert.deepEqual(j.usage, expectedUsage[j.who]);
    const dir = join(c.home, 'jobs', j.id), report = await readFile(join(dir, 'report.md'), 'utf8');
    assert.match(report, j.who === 'codex' ? /流式样本完成/ : /输出 `5`/);
    if (j.who !== 'codex') assert.ok(!report.includes('我先读'));
    reports.set(j.id, report); activities.set(j.id, j.activity!.map(({ kind, text }) => ({ kind, text })));
    assert.ok(j.activity!.length <= 50);
    assert.match(await readFile(join(dir, 'diff.patch'), 'utf8'), /new file.txt/);
    await writeFile(join(dir, 'report.md'), '');
    // 模拟登记数据丢失，collect 必须依靠 run.log 从头重建。
    const damaged = { ...j, activity: [], lastActivityAt: undefined, usage: undefined };
    if (j.who === 'cursor-grok') delete damaged.timing; // 老任务没有计时，collect 也不能回填。
    await writeFile(join(dir, 'job.json'), JSON.stringify(damaged));
  }
  const collected = await c.cli(['collect', jobs[0].batch]); assert.equal(collected.code, 0, collected.stderr);
  for (const j of await c.jobs()) {
    assert.equal(await readFile(join(c.home, 'jobs', j.id, 'report.md'), 'utf8'), reports.get(j.id));
    assert.deepEqual(j.usage, expectedUsage[j.who]);
    assert.deepEqual(j.activity!.map(({ kind, text }) => ({ kind, text })), activities.get(j.id));
    assert.deepEqual(j.timing, j.who === 'cursor-grok' ? undefined : timings.get(j.id));
    if (j.who === 'cursor-grok') assert.equal(Object.hasOwn(j, 'timing'), false);
    assert.equal(j.changedFiles, 2);
  }
});

test('旧网页命令已下线，含 --open 都报不认识的命令，帮助不再列出', async t => {
  const c = await context(t, false);
  for (const args of [['board'], ['board', '--open']]) {
    const result = await c.cli(args);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /不认识的命令 board/);
  }
  const help = await c.cli(['--help']);
  assert.equal(help.code, 0); assert.doesNotMatch(help.stdout, /xagents board/);
  await assert.rejects(access(join(c.home, 'board')), { code: 'ENOENT' });
});

test('主目录有没提交的改动时派活被拦下，说明原因；加 --dirty-ok 才放行', async t => {
  const c = await context(t);
  assert.equal((await c.add()).code, 0);
  await writeFile(join(c.repo, '骨架.ts'), 'export const 约定 = 1;\n');
  const refused = await c.cli(['run', c.task, '--summary', '完成本次测试任务', '--who', 'codex:high']);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr + refused.stdout, /主目录有 1 个文件没提交（骨架\.ts）.*选手的副本看不到.*--dirty-ok/s);
  assert.deepEqual(await c.jobs(), []);
  const allowed = await c.cli(['run', c.task, '--summary', '完成本次测试任务', '--who', 'codex:high', '--dirty-ok']);
  assert.equal(allowed.code, 0, allowed.stderr);
  const [job] = await c.jobs(); await c.cli(['wait', job.batch]);
});

test('副本已清理后，负责人用 --merged <提交号> 补记采用；提交必须真实存在；不绕过真实验收', async t => {
  const c = await context(t);
  assert.equal((await c.add()).code, 0);
  assert.equal((await c.cli(['run', c.task, '--summary', '完成本次测试任务', '--who', 'codex:high'])).code, 0);
  const [job] = await c.jobs(); await c.cli(['wait', job.batch]);
  assert.equal((await c.cli(['clean', job.id])).code, 0);
  const refused = await c.cli(['adopt', job.id, '--note', '结论']);
  assert.equal(refused.code, 1); assert.match(refused.stderr + refused.stdout, /--merged <合并提交号>/);
  const bogus = await c.cli(['adopt', job.id, '--merged', 'deadbeef', '--note', '结论']);
  assert.equal(bogus.code, 1); assert.match(bogus.stderr + bogus.stdout, /找不到提交 deadbeef/);
  const ok = await c.cli(['adopt', job.id, '--merged', c.base.slice(0, 10), '--note', '已在外部合并']);
  assert.equal(ok.code, 0, ok.stderr); assert.match(ok.stdout, /已记下合并提交/);
  const [after] = await c.jobs(); assert.equal(after.decision?.merged, c.base); assert.equal(after.decision?.kind, 'adopt');
  assert.equal((await c.cli(['drop', job.id, '--merged', c.base])).code, 1, '放弃不接受 --merged');
});

test('项目显示名：登记时 --label，或用 project label 单独改；只改显示名，体检记录保留；看板用显示名', async t => {
  const c = await context(t);
  assert.equal((await c.add(['--label', '测试项目'])).code, 0);
  const file = join(c.home, 'projects', '测试.json');
  assert.equal(JSON.parse(await readFile(file, 'utf8')).label, '测试项目');
  assert.ok(JSON.parse(await readFile(file, 'utf8')).check, '登记后的快速体检记录在');
  const r = await c.cli(['project', 'label', '测试', '画布创作站']); assert.equal(r.code, 0, r.stderr);
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(saved.label, '画布创作站'); assert.ok(saved.check, '改显示名不冲掉体检记录');
  assert.equal((await c.cli(['project', 'label', '测试', ''])).code, 1);
  assert.equal((await c.cli(['project', 'label', '没有这个', '名字'])).code, 1);
  process.env.XAGENTS_HOME = c.home;
  const { buildView } = await import('../src/core/view.ts');
  assert.deepEqual((await buildView()).projects.find(p => p.name === '测试'), { name: '测试', label: '画布创作站', archived: false });
});

test('清理 Grok 活时，它在 ~/.grok/sessions 下的会话文件夹一起移进废纸篓；别的会话文件夹不动', async t => {
  const c = await context(t);
  assert.equal((await c.add()).code, 0);
  assert.equal((await c.cli(['run', c.task, '--summary', '会话文件夹清理', '--who', 'grok:high', '--who', 'codex:high'])).code, 0);
  const first = (await c.jobs())[0];
  assert.equal((await c.cli(['wait', first.batch])).code, 0);
  const home = join(c.temp, 'user-home'), sessions = join(home, '.grok/sessions');
  const grok = (await c.jobs()).find(j => j.who === 'grok')!;
  const mine = join(sessions, encodeURIComponent(await (await import('node:fs/promises')).realpath(grok.worktree)));
  const other = join(sessions, encodeURIComponent('/Users/me/code/other-project'));
  await mkdir(mine, { recursive: true }); await writeFile(join(mine, 'chat_history.jsonl'), '{}\n');
  await mkdir(other, { recursive: true });
  const r = await c.cli(['clean', first.batch], { HOME: home });
  assert.equal(r.code, 0, r.stderr); assert.doesNotMatch(r.stdout, /没能/);
  await assert.rejects(access(mine)); await access(other);
  const trashed = await readdir(c.env.XAGENTS_TRASH!);
  assert.ok(trashed.some(name => name.startsWith(`派活工作台-Grok会话-${grok.id}`)), trashed.join(','));
});

test('选手一律看不到名字带密钥字样的环境变量，别的照常继承；DeepSeek 另用单独的 Codex 文件夹', async t => {
  const c = await context(t);
  assert.equal((await c.add([])).code, 0);
  const keys = { OPENAI_API_KEY: 'test-openai', CODEX_API_KEY: 'test-codex', CODEX_ACCESS_TOKEN: 'test-token', DEEPSEEK_API_KEY: 'test-deepseek',
    OTHER_SERVICE_API_KEY: 'test-other', My_Db_Password: 'test-password', GH_TOKEN: 'test-gh', SSH_AUTH_SOCK: '/test/agent.sock' };
  const r = await c.cli(['run', c.task, '--summary', '完成本次测试任务', '--who', 'deepseek:high', '--who', 'codex:high', '--who', 'grok:high', '--who', 'cursor-sonnet:high', '--ro'], { XA_TEST_MODE: 'change', XA_TEST_PLAIN: 'plain', ...keys });
  assert.equal(r.code, 0, r.stderr);
  const waited = await c.cli(['wait', (await c.jobs())[0].batch]); assert.equal(waited.code, 0, waited.stderr + waited.stdout);
  for (const j of await c.jobs()) {
    const observed = JSON.parse(await readFile(join(c.home, 'jobs', j.id, 'observed.json'), 'utf8'));
    // 平台自己设的开关（名字带密钥字样、值不是密钥，见 env.ts 的 PLATFORM_SWITCHES）除外，主人的一个都不许漏进来。
    assert.deepEqual(observed.secrets.filter((n: string) => !PLATFORM_SWITCHES.includes(n)), [], j.who); assert.equal(observed.plain, 'plain', j.who);
    if (j.who === 'deepseek') assert.equal(observed.codexHome, join(c.home, 'deepseek'));
    else assert.notEqual(observed.codexHome, join(c.home, 'deepseek'));
    // 任务记录里只记要去掉哪些变量的名字，不记值。
    const record = await readFile(join(c.home, 'jobs', j.id, 'job.json'), 'utf8');
    for (const value of Object.values(keys)) assert.ok(!record.includes(value));
  }
});

test('Cursor 的登录由看管进程在隔离外现取，只进选手进程的环境，不进任务记录；取不到就失败', async t => {
  const c = await context(t);
  assert.equal((await c.add([])).code, 0);
  // 假的 security：只认 Cursor 登录那一项，打印一个两个月后才过期的假令牌。
  const exp = Math.floor(Date.now() / 1000) + 60 * 86400;
  const token = `h.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.fake-cursor-signature`;
  const security = join(c.temp, 'security');
  await writeFile(security, `#!/bin/sh\n[ "$*" = "find-generic-password -a cursor-user -s cursor-access-token -w" ] && echo '${token}' && exit 0\nexit 44\n`, { mode: 0o755 });
  const r = await c.cli(['run', c.task, '--summary', '完成本次测试任务', '--who', 'cursor-grok:high', '--who', 'grok:high', '--ro'], { XAGENTS_SECURITY: security });
  assert.equal(r.code, 0, r.stderr);
  const waited = await c.cli(['wait', (await c.jobs())[0].batch]); assert.equal(waited.code, 0, waited.stderr + waited.stdout);
  for (const j of await c.jobs()) {
    const observed = JSON.parse(await readFile(join(c.home, 'jobs', j.id, 'observed.json'), 'utf8'));
    if (j.who === 'cursor-grok') { assert.equal(observed.cursorAuth, token); assert.equal(observed.credentialStore, 'memory'); }
    else { assert.equal(observed.cursorAuth, null); assert.equal(observed.credentialStore, null); }
    const record = await readFile(join(c.home, 'jobs', j.id, 'job.json'), 'utf8');
    assert.ok(!record.includes('fake-cursor-signature'));
  }
  // 钥匙串里没有 Cursor 的登录：这件失败，提示主人登录，不启动选手。
  await writeFile(security, '#!/bin/sh\nexit 44\n', { mode: 0o755 });
  const earlier = new Set((await c.jobs()).map(j => j.id));
  const again = await c.cli(['run', c.task, '--summary', '完成本次测试任务', '--who', 'cursor-grok:high', '--ro'], { XAGENTS_SECURITY: security });
  assert.equal(again.code, 0, again.stderr);
  const added = (await c.jobs()).find(j => !earlier.has(j.id))!;
  await c.cli(['wait', added.batch]);
  const failed = (await c.jobs()).find(j => j.id === added.id)!;
  assert.equal(failed.state, 'failed'); assert.match(failed.error ?? '', /cursor-agent login/);
  await assert.rejects(access(join(c.home, 'jobs', failed.id, 'observed.json')));
});
