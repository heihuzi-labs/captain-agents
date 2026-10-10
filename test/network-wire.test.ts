import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { codexPermissions, jobTmpDir, sandbox } from '../src/core/sandbox.ts';
import { command, selection, KEY_VARS, srtPath } from '../src/core/workers.ts';
import { workerEnv } from '../src/core/env.ts';
import { whos, isolationOf, vendorOf } from '../src/core/roster.ts';
import type { Who } from '../src/core/roster.ts';
import type { Job } from '../src/core/job.ts';
import type { Project } from '../src/core/project.ts';
import { prompt } from '../src/core/prompt.ts';
import { dispatch } from '../src/core/dispatch.ts';
import { ensureHome, jobDir } from '../src/core/paths.ts';
import { setNetworkAllowed } from '../src/core/settings.ts';
import { wrapOpenCommand } from '../src/core/srt-open.ts';
import { context, root, desktopView } from './helpers.ts';

const project = { denyReadExtra: ['private-dir'], denyReadHome: ['custom-secrets'] };
function job(who: Who = 'codex'): Job {
  return { ...selection(`${who}:high`), id: '1009-network', batch: 'batch', project: '测试', repo: '/repo', worktree: '/repo/wt',
    branch: 'xa/test', base: '123', mode: 'workspace-write', kind: '实现', title: '测试', summary: '验证联网', state: 'queued', created: new Date().toISOString() };
}
async function setup(t: TestContext, repository = false) {
  const c = await context(t, repository);
  const keys = ['XAGENTS_HOME', 'XAGENTS_FAKE_WORKER', 'XAGENTS_APPLICATIONS', 'XAGENTS_CAFFEINATE', 'XAGENTS_MAX_RUNNING', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'];
  const previous = keys.map(key => process.env[key]);
  keys.forEach(key => { process.env[key] = c.env[key]!; });
  t.after(() => keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; }));
  await ensureHome();
  if (repository) assert.equal((await c.add()).code, 0);
  return c;
}

test('关网的 Codex 权限表和 srt 设置与改动前快照逐字相同；开网仅改网络', async t => {
  const c = await setup(t);
  // 快照在本次修改前生成；只替换家目录和登记处，保留原字节次序。
  const baseline = JSON.parse(await readFile(join(root, 'test/fixtures/network-off.json'), 'utf8'));
  const normalize = (v: unknown) => JSON.stringify(v).replaceAll(c.home, '<registry>').replaceAll(homedir(), '<home>');
  for (const who of ['codex', 'grok', 'cursor-sonnet'] as const) for (const mode of ['read-only', 'workspace-write'] as const) {
    const j = { ...job(who), mode };
    if (who === 'codex') {
      const off = codexPermissions(j, project, '/task/tmp');
      assert.equal(normalize(off), baseline[`${who}/${mode}`]);
      assert.equal(codexPermissions(j, project, '/task/tmp', false), off);
      assert.equal(codexPermissions(j, project, '/task/tmp', true), off.slice(0, -1) + ',network={enabled=true}}');
    } else {
      const off = await sandbox(j, project, '/state', '/task/tmp');
      assert.equal(normalize(off), baseline[`${who}/${mode}`]);
      assert.equal(JSON.stringify(await sandbox(j, project, '/state', '/task/tmp', false)), JSON.stringify(off));
      const { network: _network, ...files } = off;
      assert.deepEqual(await sandbox(j, project, '/state', '/task/tmp', true), files);
    }
  }
});

test('所有选手开网时禁用系统 CA 并使用任务 npm 缓存；关网环境和原过滤不变', async t => {
  await setup(t);
  for (const who of whos) {
    const j = job(who), off = await command(j, '题目', project), on = await command({ ...j, network: true }, '题目', project);
    assert.deepEqual(await command({ ...j, network: false }, '题目', project), off);
    assert.equal(Object.hasOwn(off.env, 'npm_config_cache'), false);
    assert.deepEqual(off.unset ?? [], vendorOf(who) === 'deepseek' ? KEY_VARS : []);
    assert.deepEqual(on.env, { ...off.env, npm_config_cache: join(jobTmpDir(j), 'npm-cache') });
    assert.deepEqual(on.unset, [...(off.unset ?? []), 'NODE_USE_SYSTEM_CA']);
    const inherited = { HTTP_PROXY: 'inherited', https_proxy: 'inherited-lower', SECRET_TOKEN: 'secret', KEEP_ME: 'yes', NODE_USE_SYSTEM_CA: '1', npm_config_cache: '/old-cache' };
    const env = workerEnv(inherited, on.env, on.unset);
    assert.equal(env.NODE_USE_SYSTEM_CA, undefined);
    assert.equal(env.npm_config_cache, join(jobTmpDir(j), 'npm-cache'));
    const offEnv = workerEnv(inherited, off.env, off.unset);
    assert.equal(offEnv.NODE_USE_SYSTEM_CA, '1');
    assert.equal(offEnv.npm_config_cache, '/old-cache');
    assert.equal(env.HTTP_PROXY, 'inherited'); assert.equal(env.https_proxy, 'inherited-lower');
    assert.equal(env.SECRET_TOKEN, undefined); assert.equal(env.KEEP_ME, 'yes');
    assert.ok(!on.args.includes('network_proxy'));
    if (isolationOf(who) === 'codex') {
      assert.deepEqual(on.args, off.args.map(arg => arg.startsWith('permissions.xa=') ? arg.slice(0, -1) + ',network={enabled=true}}' : arg));
      assert.doesNotMatch(on.args.find(arg => arg.startsWith('permissions.xa='))!, /domains=/);
    } else {
      const wrapper = join(jobDir(j.id), 'runtime/src/core/srt-open.ts');
      assert.ok(on.args.includes(wrapper)); assert.ok(!off.args.includes(wrapper));
      assert.deepEqual(on.args.filter(arg => arg !== wrapper), off.args);
    }
  }
});

test('srt 库实际生成不限网络的 macOS 规则，文件隔离仍在；不监听、不执行选手', { skip: process.platform !== 'darwin' }, async t => {
  const c = await setup(t);
  const srt = await srtPath();
  for (const who of ['grok', 'cursor-sonnet'] as const) for (const mode of ['workspace-write', 'read-only'] as const) {
    const j = { ...job(who), mode, repo: c.repo, worktree: c.repo };
    const settings = await sandbox(j, project, join(c.temp, 'state'), join(c.temp, 'tmp'), true);
    const wrapped = await wrapOpenCommand(srt, settings, ['echo', "带空格 ' $(false) `false`\n下一行"]);
    assert.match(wrapped.command, /sandbox-exec/);
    assert.match(wrapped.command, /\(allow network\*\)/);
    assert.doesNotMatch(wrapped.command, /HTTP_PROXY=|HTTPS_PROXY=|ALL_PROXY=|CLOUDSDK_PROXY_PASSWORD=/);
    assert.match(wrapped.command, /\(deny file-read\*/);
    assert.match(wrapped.command, /Keychains/);
    assert.match(wrapped.command, /custom-secrets/);
    assert.match(wrapped.command, /private-dir/);
    assert.doesNotMatch(wrapped.command, /\(allow file-write\*\)/);
    wrapped.cleanup();
  }
});

test('题目仅在开网时多要求的那一句', async t => {
  const c = await setup(t), p = { ...project, repo: c.repo } as Project;
  const common = (await readFile(join(root, 'rules.md'), 'utf8')).trim();
  const task = (await readFile(c.task, 'utf8')).trim();
  assert.equal(await prompt(p, c.task), `${common}\n\n---\n\n${task}\n`);
  assert.equal(await prompt(p, c.task, false), await prompt(p, c.task));
  assert.equal(await prompt(p, c.task, true), `${common}\n\n---\n\n这件活可以联网。只为完成本题联网，不要把仓库内容、报告或任何文件内容发到外面。\n\n---\n\n${task}\n`);
});

test('真实 CLI 派活替身：总开关管所有项目，快照 true，结束展示一句话，无代理文件', async t => {
  const c = await setup(t, true);
  const add = await c.cli(['project', 'add', '另一个', c.repo, '--worktree-root', '.worktrees']);
  assert.equal(add.code, 0, add.stderr);
  for (const on of [false, true]) {
    await setNetworkAllowed(on);
    const before = new Set((await c.jobs()).map(j => j.id));
    for (const name of ['测试', '另一个']) {
      const run = await c.cli(['run', c.task, '--project', name, '--summary', '验证总开关派活', '--who', 'codex:high', '--who', 'grok:high', '--who', 'cursor-sonnet:high']);
      assert.equal(run.code, 0, run.stderr);
      if (on) assert.match(run.stdout, /这件能联网/); else assert.doesNotMatch(run.stdout, /这件能联网/);
      const latest = (await c.jobs()).filter(j => !before.has(j.id) && j.project === name);
      assert.equal(latest.length, 3);
      assert.equal((await c.cli(['wait', latest[0].batch])).code, 0);
    }
    for (const j of (await c.jobs()).filter(j => !before.has(j.id))) {
      assert.equal(j.state, 'done', j.error);
      assert.equal(j.network, on ? true : undefined);
      const dir = jobDir(j.id), files = await readdir(dir);
      assert.ok(!files.includes('guard.json')); assert.ok(!files.includes('network.log'));
      assert.equal(Object.hasOwn(j, 'networkCounts'), false);
      const observed = JSON.parse(await readFile(join(dir, 'observed.json'), 'utf8'));
      assert.equal(observed.prompt.includes('这件活可以联网。'), on);
      if (on && isolationOf(j.who) !== 'codex') {
        assert.ok(j.command!.args.includes(join(dir, j.runtime!, 'src/core/srt-open.ts')));
        assert.match(await readFile(join(dir, j.runtime!, 'src/core/srt-open.ts'), 'utf8'), /wrapWithSandbox/);
      }
    }
    // 改开关不改变已经派出的任务标签。
    await setNetworkAllowed(!on);
    const view = await desktopView(c.home);
    for (const j of view.jobs.filter(j => !before.has(j.id))) assert.equal(j.network, on);
  }
});

test('派活使用一次读取的总开关，--force 也不自行联网', async t => {
  const c = await setup(t, true);
  await setNetworkAllowed(true);
  const [j] = await dispatch(c.task, { project: '测试', who: ['codex:high'], summary: '保存联网快照' }, async () => { await setNetworkAllowed(false); });
  assert.equal(j.network, true);
  const [off] = await dispatch(c.task, { project: '测试', who: ['codex:high'], summary: '关着不联网', force: true }, async () => {});
  assert.equal(Object.hasOwn(off, 'network'), false);
});
