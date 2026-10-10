import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, access, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { context, until, exec, root } from './helpers.ts';
import { alive } from '../src/core/fsx.ts';

async function setup(t: TestContext) {
  const c = await context(t); await c.add();
  const file = join(c.temp, 'fake-caffeinate'), marker = join(c.temp, 'awake.json'), ended = join(c.temp, 'awake-ended');
  const pids: number[] = [];
  t.after(() => { for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch {} } });
  await writeFile(file, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2), watched = Number(args[2]);
const end = why => { fs.writeFileSync(process.env.XA_AWAKE_ENDED, why); process.exit(0); };
process.on('SIGTERM', () => { if (!process.env.XA_AWAKE_IGNORE_TERM) end('SIGTERM'); });
fs.writeFileSync(process.env.XA_AWAKE_MARKER, JSON.stringify({ args, pid: process.pid, watched }));
setInterval(() => { try { process.kill(watched, 0); } catch { end('parent-ended'); } }, 25);
`, { mode: 0o700 });
  const extra = { XAGENTS_CAFFEINATE: file, XA_AWAKE_MARKER: marker, XA_AWAKE_ENDED: ended };
  const observed = async () => {
    const record = await until(async () => {
      try { return JSON.parse(await readFile(marker, 'utf8')) as { args: string[]; pid: number; watched: number }; } catch { return null; }
    });
    pids.push(record!.pid); return record!;
  };
  return { ...c, marker, ended, extra, observed };
}

test('看管启动 caffeinate -i -w 自己的进程号，任务正常结束主动关闭', async t => {
  const c = await setup(t);
  const result = await c.cli(['run', c.task, '--summary', '验证正常收尾', '--who', 'codex:high'], { ...c.extra, XA_TEST_MODE: 'stream' });
  assert.equal(result.code, 0, result.stderr);
  const job = await until(async () => (await c.jobs())[0], j => Boolean(j?.workerPid)), awake = await c.observed();
  assert.deepEqual(awake.args, ['-i', '-w', String(job.pid)]); assert.equal(alive(awake.pid), true);
  assert.equal(alive(job.workerPid), true);
  for (const stage of [1, 2]) await writeFile(join(c.home, 'jobs', job.id, `continue-${stage}`), '');
  const wait = await c.cli(['wait', job.id]); assert.equal(wait.code, 0, wait.stderr);
  await until(async () => !alive(awake.pid) && !alive(job.pid));
  assert.equal(await readFile(c.ended, 'utf8'), 'SIGTERM');
  assert.equal((await c.jobs())[0].state, 'done');
});

test('停止任务也关闭 caffeinate；不响应 SIGTERM 的替身会被收掉', async t => {
  const c = await setup(t);
  const result = await c.cli(['run', c.task, '--summary', '验证停止收尾', '--who', 'codex:high'], { ...c.extra, XA_TEST_MODE: 'hang', XA_AWAKE_IGNORE_TERM: '1' });
  assert.equal(result.code, 0, result.stderr);
  const job = await until(async () => (await c.jobs())[0], j => Boolean(j?.workerPid)), awake = await c.observed();
  assert.equal((await c.cli(['stop', job.id])).code, 0);
  await until(async () => !alive(awake.pid) && !alive(job.pid) && !alive(job.workerPid));
  assert.equal((await c.jobs())[0].state, 'stopped');
});

test('看管进程意外退出后，替身按 -w 自动关闭，残留选手由 stop 收尾', async t => {
  const c = await setup(t);
  assert.equal((await c.cli(['run', c.task, '--summary', '验证意外退出', '--who', 'codex:high'], { ...c.extra, XA_TEST_MODE: 'hang' })).code, 0);
  const job = await until(async () => (await c.jobs())[0], j => Boolean(j?.workerPid));
  const awake = await c.observed();
  process.kill(job.pid!, 'SIGKILL');
  await until(async () => !alive(awake.pid) && !alive(job.pid));
  assert.equal(await readFile(c.ended, 'utf8'), 'parent-ended');
  assert.equal((await c.cli(['stop', job.id])).code, 0);
  await until(async () => !alive(job.workerPid));
});

test('关闭设置不起 caffeinate；找不到程序只记 supervisor.log，任务照常完成', async t => {
  const c = await setup(t);
  await writeFile(join(c.home, 'config.json'), JSON.stringify({ keepAwake: false }));
  let result = await c.cli(['run', c.task, '--summary', '关闭防休眠', '--who', 'codex:high'], c.extra);
  assert.equal(result.code, 0, result.stderr);
  const disabled = (await c.jobs())[0];
  assert.equal((await c.cli(['wait', disabled.id])).code, 0);
  await assert.rejects(access(c.marker), { code: 'ENOENT' });
  assert.doesNotMatch(await readFile(join(c.home, 'jobs', disabled.id, 'supervisor.log'), 'utf8'), /caffeinate/);
  await writeFile(join(c.home, 'config.json'), '{'); // 损坏时默认开启。
  result = await c.cli(['run', c.task, '--summary', '程序缺失仍完成', '--who', 'codex:high']);
  assert.equal(result.code, 0, result.stderr); assert.doesNotMatch(result.stderr + result.stdout, /caffeinate/);
  const missing = (await c.jobs()).find(j => j.id !== disabled.id)!;
  assert.equal((await c.cli(['wait', missing.id])).code, 0);
  const log = await readFile(join(c.home, 'jobs', missing.id, 'supervisor.log'), 'utf8');
  assert.equal(log.split('无法启动 caffeinate').length - 1, 1); assert.match(log, /任务继续执行/);
  assert.equal((await c.jobs()).find(j => j.id === missing.id)!.state, 'done');
});

test('运行中读防休眠设置失败仍按开启处理，记录错误并能正常释放', async t => {
  const c = await setup(t);
  await mkdir(join(c.home, 'config.json'));
  const script = `import { access } from 'node:fs/promises';
    import { keepAwake } from './src/core/awake.ts';
    const release = await keepAwake();
    const deadline = Date.now() + 10_000;
    while (true) {
      try { await access(process.env.XA_AWAKE_MARKER); break; }
      catch { if (Date.now() >= deadline) throw new Error('防休眠替身未启动'); await new Promise(r => setTimeout(r, 25)); }
    }
    await release();`;
  const done = await exec(process.execPath, ['--input-type=module', '-e', script], root, { ...c.env, ...c.extra });
  assert.equal(done.code, 0, done.stderr);
  const awake = await c.observed();
  assert.deepEqual(awake.args, ['-i', '-w', String(awake.watched)]);
  assert.match(done.stderr, /读取防休眠设置失败：.+。按开启处理，任务继续执行。/);
  await until(async () => !alive(awake.pid));
  assert.equal(await readFile(c.ended, 'utf8'), 'SIGTERM');
});

test('副本准备后设置读不到，启动前重新装载失败就收尾，不能绕过最新主人策略', async t => {
  const c = await setup(t);
  const prepare = join(c.temp, 'break-settings.mjs');
  await writeFile(prepare, "import { mkdir } from 'node:fs/promises'; import { join } from 'node:path'; await mkdir(join(process.env.XAGENTS_HOME, 'config.json'));\n");
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  assert.equal((await c.add(['--setup', `${quote(process.execPath)} ${quote(prepare)}`])).code, 0);
  const result = await c.cli(['run', c.task, '--summary', '读设置失败拒绝启动', '--who', 'codex:high'], c.extra);
  assert.equal(result.code, 0, result.stderr);
  const done = await until(async () => (await c.jobs())[0], j => j?.state === 'failed');
  assert.equal(done.workerPid, undefined); assert.match(done.error!, /装载选手设置失败/);
  await assert.rejects(access(c.marker), { code: 'ENOENT' });
});

test('选手失败时也关闭防休眠；选手未能启动时不启动 caffeinate', async t => {
  const c = await setup(t);
  const { mkdir } = await import('node:fs/promises');
  const { writeJson } = await import('../src/core/fsx.ts');
  const dir = join(c.home, 'jobs/failure'); await mkdir(dir);
  const gate = join(c.temp, 'fail-now');
  const base = {
    id: 'failure', batch: '', project: '测试', repo: c.repo, base: c.base, worktree: c.repo, branch: 'main',
    who: 'codex', model: 'test', effort: 'high', mode: 'read-only', kind: '实现', title: '失败收尾', summary: '验证失败收尾',
    state: 'queued', created: new Date().toISOString(),
  };
  await writeJson(join(dir, 'job.json'), { ...base, command: {
    file: process.execPath, args: ['-e', 'setInterval(() => { if (require("node:fs").existsSync(process.env.XA_FAIL_GATE)) process.exit(7); }, 25)'],
    env: { XA_FAIL_GATE: gate }, stdin: 'ignore', output: 'run.log',
  } });
  const running = c.cli(['__run', 'failure'], c.extra);
  const awake = await c.observed();
  await writeFile(gate, '');
  assert.equal((await running).code, 0);
  assert.equal((await c.jobs())[0].state, 'failed'); assert.equal((await c.jobs())[0].exit, 7);
  await until(async () => !alive(awake.pid));
  assert.equal(await readFile(c.ended, 'utf8'), 'SIGTERM');
  const marker = await readFile(c.marker, 'utf8');
  await writeJson(join(dir, 'job.json'), { ...base, command: {
    file: join(c.temp, 'missing-worker'), args: [], env: {}, stdin: 'ignore', output: 'run.log',
  } });
  assert.equal((await c.cli(['__run', 'failure'], c.extra)).code, 0);
  assert.equal((await c.jobs())[0].state, 'failed');
  assert.equal(await readFile(c.marker, 'utf8'), marker);
});
