import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { context } from './helpers.ts';
import { dynamicChecks } from '../src/core/project-check-run.ts';
import type { Project } from '../src/core/project.ts';
import type { Execution, Executor } from '../src/core/verify.ts';
import { git } from '../src/core/worktree.ts';

const pass: Execution = { exit: 0, output: '', timedOut: false };
async function fixture(t: TestContext, repository = true) {
  const c = await context(t, repository);
  for (const key of ['XAGENTS_HOME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM']) {
    const original = process.env[key];
    process.env[key] = c.env[key];
    t.after(() => { if (original === undefined) delete process.env[key]; else process.env[key] = original; });
  }
  const project: Project & { verifyTimeoutMinutes?: number } = { name: '测试', repo: c.repo, worktreeRoot: '.worktrees', setup: ['install', 'prepare'], verify: ['check', 'test'], denyReadExtra: [] };
  const beforeTrees = repository ? await c.git(['worktree', 'list', '--porcelain']) : '';
  const beforeBranches = await c.git(repository ? ['branch', '--list'] : ['init', '-b', 'main']);
  async function clean() {
    const trees = await c.git(['worktree', 'list', '--porcelain']);
    const branches = await c.git(['branch', '--list']);
    assert.doesNotMatch(trees, /xa-check-/);
    assert.doesNotMatch(branches, /xa-check\//);
    if (repository) { assert.equal(trees, beforeTrees); assert.equal(branches, beforeBranches); }
    assert.deepEqual(await readdir(join(c.repo, '.worktrees')).catch(() => []), []);
    assert.deepEqual(await c.jobs(), []);
    await assert.rejects(access(join(c.home, 'projects')), { code: 'ENOENT' });
  }
  async function log() {
    const dir = join(c.home, 'cache/checks'), files = await readdir(dir);
    assert.equal(files.length, 1);
    assert.match(files[0], /^测试-\d+-.*\.log$/);
    return join(dir, files[0]);
  }
  return { ...c, project, clean, log };
}

test('体检从当前 HEAD 开副本，顺序跑 setup 和 verify，保留完整日志而不写登记', async t => {
  const c = await fixture(t);
  await c.git(['checkout', '-b', 'develop']);
  const head = await c.git(['commit-tree', await c.git(['write-tree']), '-p', c.base, '-m', '当前分支的新提交']);
  await c.git(['update-ref', 'refs/heads/develop', head]);
  await writeFile(join(c.repo, 'base.txt'), '未提交的内容');
  c.project.verifyTimeoutMinutes = 3;
  const calls: string[] = [];
  let worktree = '';
  const run: Executor = async (file, args, cwd, timeout, onData) => {
    assert.equal(file, '/bin/sh'); assert.equal(args[0], '-c'); assert.equal(timeout, 180000);
    if (!worktree) {
      worktree = cwd;
      assert.match(basename(cwd), /^xa-check-/);
      assert.equal(await git(cwd, ['rev-parse', 'HEAD']), `${head}\n`);
      assert.match(await git(cwd, ['branch', '--show-current']), /^xa-check\//);
      assert.equal(await readFile(join(cwd, 'base.txt'), 'utf8'), '起点\n');
      await writeFile(join(cwd, 'untracked.txt'), '清理时一起删除');
    }
    assert.equal(cwd, worktree);
    calls.push(args[1]); onData?.(`${args[1]} output\n`); onData?.('第二段输出\n');
    return { ...pass };
  };
  const result = await dynamicChecks(c.project, run);
  assert.deepEqual(calls, ['install', 'prepare', 'check', 'test']);
  assert.deepEqual(result.items.map(item => [item.id, item.status]), [['setup', 'ok'], ['verify', 'ok']]);
  assert.equal(result.baseline?.ok, true); assert.ok(Date.parse(result.baseline!.at));
  assert.deepEqual(result.baseline?.steps.map(step => step.cmd), ['check', 'test']);
  const logfile = await c.log(), text = await readFile(logfile, 'utf8');
  for (const cmd of calls) assert.ok(text.includes(`执行：${cmd}\n${cmd} output\n第二段输出`));
  assert.equal((await stat(logfile)).mode & 0o777, 0o600);
  assert.ok(result.items.every(item => item.detail.includes(logfile)));
  await assert.rejects(access(worktree), { code: 'ENOENT' });
  assert.equal(await readFile(join(c.repo, 'base.txt'), 'utf8'), '未提交的内容');
  await c.git(['checkout', 'main']); await c.git(['branch', '-D', 'develop']); await c.clean();
});

test('setup 失败后停止后续准备和验收，报告命令、退出码和日志，底子为空', async t => {
  const c = await fixture(t), calls: string[] = [];
  const result = await dynamicChecks(c.project, async (_file, args, _cwd, timeout) => {
    assert.equal(timeout, 20 * 60000); calls.push(args[1]);
    return { ...pass, exit: 7 };
  });
  assert.deepEqual(calls, ['install']); assert.equal(result.items[0].status, 'fail');
  assert.match(result.items[0].detail, /install.*退出码 7/);
  assert.ok(result.items[0].detail.includes(await c.log()));
  assert.equal(result.items[1].status, 'warn'); assert.match(result.items[1].detail, /未运行验收/);
  assert.equal(result.baseline, undefined); await c.clean();
});

test('verify 没过只警告，继续后续步骤并保留失败计数和底子', async t => {
  const c = await fixture(t), calls: string[] = [];
  const result = await dynamicChecks(c.project, async (_file, args) => {
    calls.push(args[1]);
    return args[1] === 'check' ? { ...pass, output: '# tests 3\n# pass 2\n# fail 1\n' } : { ...pass };
  });
  assert.deepEqual(calls, ['install', 'prepare', 'check', 'test']);
  assert.equal(result.items[0].status, 'ok'); assert.equal(result.items[1].status, 'warn');
  assert.match(result.items[1].detail, /全新副本里验收有 1 项没过.*check/s);
  assert.match(result.items[1].fix!, /主目录里能通过.*加进 setup/);
  assert.equal(result.baseline?.ok, false);
  assert.deepEqual(result.baseline?.steps.map(step => step.ok), [false, true]);
  assert.match(result.baseline!.steps[0].summary, /# fail 1/); await c.clean();
});

for (const [setup, verify] of [[[], []], [[], ['test']], [['install'], []]] as [string[], string[]][]) {
  test(`未登记命令：setup=${setup.length}，verify=${verify.length}`, async t => {
    const c = await fixture(t), calls: string[] = [];
    Object.assign(c.project, { setup, verify });
    const result = await dynamicChecks(c.project, async (_file, args) => { calls.push(args[1]); return { ...pass }; });
    assert.deepEqual(calls, [...setup, ...verify]);
    assert.equal(result.items[0].status, 'ok');
    if (!setup.length) assert.equal(result.items[0].detail, '没有装依赖的命令');
    if (!verify.length) {
      assert.equal(result.items[1].status, 'warn');
      assert.equal(result.items[1].detail, '没有验收命令，交回的活只能靠人看');
      assert.equal(result.baseline, undefined);
    } else assert.equal(result.baseline?.ok, true);
    await c.clean();
  });
}

for (const phase of ['install', 'check']) {
  test(`${phase} 执行器抛错仍报告失败并清理副本、分支`, async t => {
    const c = await fixture(t);
    const result = await dynamicChecks(c.project, async (_file, args, cwd) => {
      assert.match(await git(cwd, ['branch', '--show-current']), /^xa-check\//);
      if (args[1] === phase) throw new Error('执行器故障');
      return { ...pass };
    });
    const item = result.items[phase === 'install' ? 0 : 1];
    assert.equal(item.status, phase === 'install' ? 'fail' : 'warn');
    assert.match(item.detail, /执行器故障/);
    if (phase === 'install') assert.equal(result.baseline, undefined);
    else assert.equal(result.baseline?.ok, false);
    await c.clean();
  });
}

test('超时和中断沿用验收判定，不会把退出码 0 误报通过', async t => {
  const c = await fixture(t);
  let result = await dynamicChecks(c.project, async () => ({ ...pass, timedOut: true }));
  assert.equal(result.items[0].status, 'fail'); assert.match(result.items[0].detail, /超时（20 分钟）/);
  await c.clean();
  c.project.setup = [];
  result = await dynamicChecks(c.project, async () => ({ ...pass, signal: 'SIGINT' }));
  assert.equal(result.items[1].status, 'warn'); assert.equal(result.baseline?.ok, false);
  assert.equal(result.baseline?.steps.length, 1); assert.match(result.baseline!.steps[0].summary, /SIGINT/);
  await c.clean();
});

test('开副本后读取准备配置抛错，仍删除已创建的副本和分支', async t => {
  const c = await fixture(t);
  Object.defineProperty(c.project, 'setup', { get() { throw new Error('准备配置读取失败'); } });
  await assert.rejects(dynamicChecks(c.project, async () => ({ ...pass })), /准备配置读取失败/);
  await c.clean();
});

test('setup 后验收日志打不开，仍删除副本和分支', async t => {
  const c = await fixture(t); c.project.setup = ['install'];
  await assert.rejects(dynamicChecks(c.project, async () => {
    const logfile = await c.log(); await rm(logfile); await mkdir(logfile);
    return { ...pass };
  }), { code: 'EISDIR' });
  await c.clean();
});

test('无 HEAD 时开副本失败，没有残留临时分支和副本', async t => {
  const c = await fixture(t, false);
  await assert.rejects(dynamicChecks(c.project, async () => { assert.fail('不能执行命令'); }), /Git 操作失败/);
  await c.clean();
});

test('Git 建出分支后检出失败，也清理临时分支和副本', async t => {
  const c = await fixture(t);
  await writeFile(join(c.repo, '.gitattributes'), 'base.txt filter=broken\n');
  await c.git(['add', '.gitattributes']);
  const head = await c.git(['commit-tree', await c.git(['write-tree']), '-p', c.base, '-m', '检出失败的测试起点']);
  await c.git(['update-ref', 'refs/heads/main', head]);
  await c.git(['config', 'filter.broken.smudge', 'false']);
  await c.git(['config', 'filter.broken.required', 'true']);
  await assert.rejects(dynamicChecks(c.project, async () => { assert.fail('不能执行命令'); }), /smudge filter broken failed/);
  // 恢复测试仓库的 HEAD，便于逐字比较 worktree 和 branch 清单。
  await c.git(['update-ref', 'refs/heads/main', c.base]);
  await c.clean();
});

test('拒绝将临时副本开到仓库外；非法超时也不执行命令', async t => {
  const c = await fixture(t);
  c.project.verifyTimeoutMinutes = 0;
  await assert.rejects(dynamicChecks(c.project), /verifyTimeoutMinutes/); await c.clean();
  delete c.project.verifyTimeoutMinutes;
  await symlink(c.temp, join(c.repo, 'escape')); c.project.worktreeRoot = 'escape';
  await assert.rejects(dynamicChecks(c.project), /符号链接指向了仓库外/); await c.clean();
});

test('开始前清掉以前被中断的体检留下的临时副本和分支，别的分支不动', async t => {
  const c = await fixture(t);
  await c.git(['branch', 'keep-me']);
  await c.git(['branch', 'xa-check/old-branch-only']);
  await mkdir(join(c.repo, '.worktrees'), { recursive: true });
  await c.git(['worktree', 'add', '-b', 'xa-check/old-with-tree', join(c.repo, '.worktrees', 'xa-check-old'), 'HEAD']);
  const run: Executor = async () => pass;
  await dynamicChecks(c.project, run);
  const branches = await c.git(['branch', '--list']);
  assert.doesNotMatch(branches, /xa-check\//);
  assert.match(branches, /keep-me/);
  assert.doesNotMatch(await c.git(['worktree', 'list', '--porcelain']), /xa-check/);
  assert.deepEqual(await readdir(join(c.repo, '.worktrees')), []);
});
