import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { alive } from '../src/core/fsx.ts';
import { context, exec, root, until } from './helpers.ts';

test('看管进程异常或未处理拒绝时先杀选手组，记录失败并移除监听器', { timeout: 30000 }, async t => {
  const c = await context(t);
  assert.equal((await c.add()).code, 0);
  const script = join(c.temp, 'fatal-runner.mjs');
  await writeFile(script, `
    import { runWorker } from ${JSON.stringify(pathToFileURL(join(root, 'src/core/runner.ts')).href)};
    import { existsSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    const [id, dir, kind] = process.argv.slice(2);
    const names = ['uncaughtException', 'unhandledRejection', 'SIGINT', 'SIGTERM'];
    const before = names.map(name => process.listenerCount(name));
    const events = [], originalKill = process.kill.bind(process);
    process.kill = (pid, signal) => { if (pid < 0 && signal === 'SIGKILL') events.push('kill'); return originalKill(pid, signal); };
    const timer = setInterval(() => {
      if (!existsSync(join(dir, 'grandchild.pid'))) return;
      clearInterval(timer); events.push('fatal');
      if (kind === 'exception') setImmediate(() => { throw new Error('测试异常'); });
      else Promise.reject(new Error('测试拒绝'));
    }, 5);
    try { await runWorker(id); } finally { clearInterval(timer); }
    writeFileSync(join(dir, 'cleanup.json'), JSON.stringify({ events, restored: names.every((name, i) => before[i] === process.listenerCount(name)) }));
  `);
  for (const on of [false, true]) for (const kind of ['exception', 'rejection']) {
    await writeFile(join(c.home, 'config.json'), JSON.stringify({ keepAwake: false, networkAllowed: on }));
    // 独立派活进程只登记命令，不启动看管；由本测试启动会抛错的看管替身。
    const dispatched = await exec(process.execPath, ['--input-type=module', '-e',
      `import { dispatch } from './src/core/dispatch.ts'; const [job] = await dispatch(process.argv[1], { project:'测试', who:['grok:high'], summary:'验证看管兜底' }, async () => {}); console.log(job.id);`, c.task], root, c.env);
    assert.equal(dispatched.code, 0, dispatched.stderr);
    const id = dispatched.stdout.trim(), dir = join(c.home, 'jobs', id);
    const run = await exec(process.execPath, [script, id, dir, kind], root, { ...c.env, XA_TEST_MODE: 'ignore-term' });
    assert.equal(run.code, 1, run.stderr);
    const job = JSON.parse(await readFile(join(dir, 'job.json'), 'utf8'));
    assert.equal(job.state, 'failed');
    assert.match(job.error, kind === 'exception' ? /看管进程未捕获异常：测试异常/ : /看管进程未处理拒绝：测试拒绝/);
    const grandchild = Number(await readFile(join(dir, 'grandchild.pid'), 'utf8'));
    await until(async () => !alive(job.workerPid) && !alive(grandchild));
    const cleanup = JSON.parse(await readFile(join(dir, 'cleanup.json'), 'utf8'));
    assert.equal(cleanup.restored, true);
    assert.ok(cleanup.events.indexOf('kill') > cleanup.events.indexOf('fatal'));
    const cleared = await exec(process.execPath, ['--input-type=module', '-e',
      `import { updateJob } from './src/core/job.ts'; await updateJob(process.argv[1], j => { delete j.pid; delete j.workerPid; });`, id], root, c.env);
    assert.equal(cleared.code, 0, cleared.stderr);
  }
});
