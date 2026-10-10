import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { externalEnvironment, nodeCommand, nodeInvocation, nodeRunner } from '../src/core/node-runtime.ts';
import { context, exec, root, until } from './helpers.ts';

test('Node 运行器：命令行与 Electron 返回正确程序、环境，不改继承环境', () => {
  const env = { PATH: '/bin', ELECTRON_RUN_AS_NODE: '0', OTHER: 'keep' };
  const node = { execPath: '/usr/bin/node', versions: { node: '24' } };
  const electron = { execPath: '/Applications/派活 工作台.app/Contents/MacOS/派活工作台', versions: { electron: '44', node: '24' } };
  assert.deepEqual(nodeRunner(env, node), { file: node.execPath, env: { PATH: '/bin', OTHER: 'keep' } });
  assert.deepEqual(nodeRunner(env, electron), { file: electron.execPath, env: { ...env, ELECTRON_RUN_AS_NODE: '1' } });
  assert.equal(env.ELECTRON_RUN_AS_NODE, '0');
  assert.equal(externalEnvironment(env).ELECTRON_RUN_AS_NODE, undefined);
  assert.deepEqual(nodeCommand(['/script.ts', '中文 空格'], env, node).args, ['/script.ts', '中文 空格']);
  const cmd = nodeCommand(['/script.ts', '中文 空格'], env, electron);
  assert.deepEqual(cmd.args, [join(root, 'src/core/node-entry.ts'), '/script.ts', '中文 空格']);
  assert.deepEqual(nodeInvocation(['/probe.mjs'], node), [node.execPath, '/probe.mjs']);
  assert.deepEqual(nodeInvocation(['/probe.mjs'], electron), ['/usr/bin/env', 'ELECTRON_RUN_AS_NODE=1', electron.execPath, join(root, 'src/core/node-entry.ts'), '/probe.mjs']);
});

// 替身每次启动都检查开关；模拟 Electron 的 execPath/versions，并直接执行源码，不开窗口或端口。
async function fakeElectron(temp: string) {
  const file = join(temp, '派活 工作台'), bootstrap = join(temp, 'electron-bootstrap.mjs');
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  await writeFile(file, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(bootstrap)} "$@"\n`, { mode: 0o755 });
  await writeFile(bootstrap, `
    import { pathToFileURL } from 'node:url';
    if (process.env.ELECTRON_RUN_AS_NODE !== '1') throw new Error('未进入 Node 模式');
    Object.defineProperty(process.versions, 'electron', { value: '44-test' });
    process.execPath = ${JSON.stringify(file)};
    process.argv = [process.execPath, ...process.argv.slice(2)];
    await import(pathToFileURL(process.argv[1]).href);
  `);
  return file;
}

test('多级平台进程：Electron 替身派活 → 看管 → 选手替身，层层进入 Node 且不向选手泄漏开关', async t => {
  const c = await context(t), electron = await fakeElectron(c.temp);
  await c.add();
  const fixture = join(c.temp, 'worker.mjs');
  await writeFile(fixture, `if ('ELECTRON_RUN_AS_NODE' in process.env) throw new Error('运行时变量漏给选手'); const file = process.argv[process.argv.indexOf('-o') + 1]; await (await import('node:fs/promises')).writeFile(file, '选手环境干净');`);
  const result = await exec(electron, [join(root, 'src/cli/cli.ts'), 'run', c.task, '--summary', '验证应用自带平台', '--who', 'codex:high'], c.repo,
    { ...c.env, ELECTRON_RUN_AS_NODE: '1', XAGENTS_FAKE_WORKER: fixture });
  assert.equal(result.code, 0, result.stderr);
  const jobs = await until(c.jobs, jobs => jobs.length === 1 && ['done', 'failed'].includes(jobs[0].state));
  assert.equal(jobs[0].state, 'done', jobs[0].error);
  assert.equal(jobs[0].command?.env.ELECTRON_RUN_AS_NODE, undefined);
});

test('群聊推进：Electron 替身从群快照再起看管与选手，报告正常回到群里', async t => {
  const c = await context(t), electron = await fakeElectron(c.temp), fixture = join(c.temp, 'chat-worker.mjs');
  await c.add();
  await writeFile(fixture, `
    if ('ELECTRON_RUN_AS_NODE' in process.env) throw new Error('运行时变量漏给选手');
    await (await import('node:fs/promises')).writeFile(process.argv[process.argv.indexOf('-o') + 1], '群成员环境干净');
  `);
  const cli = (args: string[]) => exec(electron, [join(root, 'src/cli/cli.ts'), ...args], c.repo,
    { ...c.env, ELECTRON_RUN_AS_NODE: '1', XAGENTS_FAKE_WORKER: fixture });
  const created = await cli(['chat', 'new', '测试', '--member', 'codex:high', '--title', '应用群聊']);
  assert.equal(created.code, 0, created.stderr);
  const id = /群号：([^\n]+)/.exec(created.stdout)![1];
  try {
    const said = await cli(['chat', 'say', id, '@Codex 检查环境']);
    assert.equal(said.code, 0, said.stderr);
    const jobs = await until(c.jobs, jobs => jobs.length === 1 && ['done', 'failed'].includes(jobs[0].state));
    assert.equal(jobs[0].state, 'done', jobs[0].error);
    const log = await until(() => cli(['chat', 'log', id, '--all']), log => log.stdout.includes('群成员环境干净'));
    assert.equal(log.code, 0, log.stderr);
  } finally { await cli(['chat', 'close', id]); }
});

test('srt 与 Codex 命令环境：启动 srt 前清开关，不改变选手参数和密钥过滤', async t => {
  const c = await context(t, false), electron = await fakeElectron(c.temp), script = join(c.temp, 'check.mjs');
  const srt = join(c.temp, 'fake-srt.mjs');
  await writeFile(srt, `console.log(JSON.stringify({ args: process.argv.slice(2), electron: process.env.ELECTRON_RUN_AS_NODE ?? null, key: process.env.TEST_API_KEY ?? null }));`);
  const module = (path: string) => JSON.stringify(pathToFileURL(join(root, path)).href);
  await writeFile(script, `
    import assert from 'node:assert/strict';
    import { spawnSync } from 'node:child_process';
    import { command, selection } from ${module('src/core/workers.ts')};
    import { workerEnv } from ${module('src/core/env.ts')};
    import { nodeCommand, externalEnvironment } from ${module('src/core/node-runtime.ts')};
    delete process.env.XAGENTS_FAKE_WORKER;
    const job = { id: 'test-job', repo: ${JSON.stringify(c.repo)}, worktree: ${JSON.stringify(c.repo)}, mode: 'workspace-write' };
    for (const who of ['grok', 'codex']) {
      const cmd = await command({ ...job, ...selection(who + ':high') }, '题目', { denyReadExtra: [] });
      assert.equal(cmd.env.ELECTRON_RUN_AS_NODE, undefined);
      const env = externalEnvironment(workerEnv({ ...process.env, TEST_API_KEY: 'dummy' }, cmd.env, cmd.unset));
      assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
      if (who === 'grok') {
        const launch = nodeCommand(cmd.args, env);
        const result = spawnSync(launch.file, launch.args, { env: launch.env, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        const actual = JSON.parse(result.stdout);
        assert.equal(actual.electron, null); assert.equal(actual.key, null);
        assert.deepEqual(actual.args, cmd.args.slice(1));
      }
    }
  `);
  const result = await exec(electron, [script], c.temp, { ...c.env, ELECTRON_RUN_AS_NODE: '1', XAGENTS_SRT: srt });
  assert.equal(result.code, 0, result.stderr);
});

// 2026-10-10 真实自检抓到：不声明“在跑脚本”，srt 用的参数解析库会把脚本路径当成用户参数，在隔离里又套一层 srt。
test('入口脚本：清掉运行时开关、声明“在跑脚本”，再原样执行目标脚本并带上参数', async t => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const { execFile } = await import('node:child_process'); const { promisify } = await import('node:util');
  const dir = await mkdtemp(join(tmpdir(), 'xa-node-entry-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const script = join(dir, 'target.mjs');
  await writeFile(script, 'console.log(JSON.stringify({ defaultApp: process.defaultApp, flag: process.env.ELECTRON_RUN_AS_NODE ?? null, script: process.argv[1], args: process.argv.slice(2) }));');
  const entry = new URL('../src/core/node-entry.ts', import.meta.url).pathname;
  const { stdout } = await promisify(execFile)(process.execPath, [entry, script, '--settings', 'a b'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  assert.deepEqual(JSON.parse(stdout), { defaultApp: true, flag: null, script, args: ['--settings', 'a b'] });
});
