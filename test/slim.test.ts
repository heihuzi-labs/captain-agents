import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createJob, readJob } from '../src/core/job.ts';
import type { Job } from '../src/core/job.ts';
import { ensureHome, jobDir } from '../src/core/paths.ts';
import { withLock, writeJson } from '../src/core/fsx.ts';
import { writeSettings } from '../src/core/settings.ts';
import { slimOld, SLIM_FILES } from '../src/core/slim.ts';
import { moveToTrash } from '../src/core/trash.ts';
import { collect } from '../src/core/commands.ts';
import { result } from '../src/core/workers.ts';
import { buildView } from '../src/core/view.ts';
import { exec, root } from './helpers.ts';

const day = 86400e3;
async function registry(t: TestContext) {
  const temp = await fs.mkdtemp(join(tmpdir(), 'xagents-slim-'));
  const home = join(temp, 'home'), trash = join(temp, 'trash');
  const before = { XAGENTS_HOME: process.env.XAGENTS_HOME, XAGENTS_TRASH: process.env.XAGENTS_TRASH };
  process.env.XAGENTS_HOME = home; process.env.XAGENTS_TRASH = trash;
  t.after(async () => {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await fs.rm(temp, { recursive: true, force: true });
  });
  await ensureHome();
  const now = Date.now();
  const add = async (id: string, patch: Partial<Job> = {}) => {
    const ended = new Date(now - 15 * day).toISOString();
    const job: Job = {
      id, batch: '', project: '测试', repo: temp, base: 'test', worktree: join(temp, 'gone'), branch: 'test',
      who: 'codex', model: 'test', effort: 'high', mode: 'read-only', kind: '实现', title: id, summary: '旧日志测试',
      state: 'done', created: ended, ended, cleaned: ended,
      decision: { kind: 'drop', at: ended, by: 'lead' }, rating: { score: 4, tags: [], at: ended, by: 'lead' },
      ...patch,
    };
    await createJob(job);
    await fs.writeFile(join(jobDir(id), 'run.log'), '旧日志\n');
    return job;
  };
  const cli = (args: string[]) => exec(process.execPath, [join(root, 'src/cli/cli.ts'), ...args], root, { ...process.env, XAGENTS_HOME: home, XAGENTS_TRASH: trash });
  return { temp, home, trash, now, add, cli };
}

async function absent(path: string) { await assert.rejects(fs.lstat(path), { code: 'ENOENT' }); }

// 内容字节数（包括中文）、递归目录、缺失文件、保留文件与看板账目一起验证。
test('到期日志移到同一废纸篓文件夹，预览与实清一致，报告和打分保留', async t => {
  const c = await registry(t), job = await c.add('old'), dir = jobDir(job.id);
  await fs.mkdir(join(dir, 'runtime', 'src'), { recursive: true });
  await fs.writeFile(join(dir, 'runtime', 'src', 'worker.ts'), '运行快照');
  await fs.mkdir(join(dir, 'runtime', 'empty'));
  for (const name of ['stderr.log', 'supervisor.log', 'setup.log']) await fs.writeFile(join(dir, name), name);
  const keep = ['report.md', 'diff.patch', 'prompt.md', 'verify.log', 'final.md', 'sandbox.json', 'versions.json'];
  for (const name of keep) await fs.writeFile(join(dir, name), `保留 ${name}`);
  const bytes = Buffer.byteLength('旧日志\n运行快照stderr.logsupervisor.logsetup.log');
  const original = await fs.readFile(join(dir, 'job.json'), 'utf8');
  assert.deepEqual((await buildView()).storage, { slimmedJobs: 0, freedBytes: 0, due: 1 });
  const preview = await slimOld({ now: c.now, dryRun: true });
  assert.deepEqual(preview, { jobs: ['old'], bytes });
  assert.equal(await fs.readFile(join(dir, 'job.json'), 'utf8'), original);
  await absent(c.trash);
  for (const name of SLIM_FILES) await fs.lstat(join(dir, name));
  assert.deepEqual(await slimOld({ now: c.now }), preview);
  const folder = join(c.trash, '派活工作台-old');
  assert.deepEqual((await fs.readdir(folder)).sort(), [...SLIM_FILES].sort());
  for (const name of SLIM_FILES) await absent(join(dir, name));
  assert.equal(await fs.readFile(join(folder, 'runtime/src/worker.ts'), 'utf8'), '运行快照');
  for (const name of keep) assert.equal(await fs.readFile(join(dir, name), 'utf8'), `保留 ${name}`);
  const cleaned = await readJob('old');
  assert.deepEqual(cleaned.slimmed, { at: new Date(c.now).toISOString(), bytes, files: [...SLIM_FILES] });
  const { slimmed: _slimmed, ...rest } = cleaned;
  assert.deepEqual(rest, job);
  assert.deepEqual((await buildView()).storage, { slimmedJobs: 1, freedBytes: bytes, due: 0 });
  assert.deepEqual(await slimOld({ now: c.now }), { jobs: [], bytes: 0 });
  await assert.rejects(collect('old'), /原始日志已在 .* 自动清理，报告在 report\.md，改动在 diff\.patch/);
  assert.equal(await fs.readFile(join(dir, 'report.md'), 'utf8'), '保留 report.md');
  assert.deepEqual(await readJob('old'), cleaned);
  // 其他原始日志读取走 LogTail 的缺失文件跳过逻辑，不会抛 ENOENT。
  assert.equal((await result(cleaned)).report, '保留 final.md');
});

test('不到期、未拍板、未打分、未清副本、运行中、排队中、已清过和没有结束时间均不动', async t => {
  const c = await registry(t);
  const patches: Partial<Job>[] = [
    { ended: new Date(c.now - 14 * day + 1).toISOString() }, { decision: undefined }, { rating: undefined },
    { cleaned: undefined }, { state: 'running' }, { state: 'queued' },
    { slimmed: { at: new Date(c.now).toISOString(), bytes: 12, files: ['stderr.log'] } },
    { ended: undefined }, { ended: 'invalid' },
  ];
  for (const [i, patch] of patches.entries()) await c.add(`skip-${i}`, patch);
  const before = await Promise.all(patches.map((_, i) => fs.readFile(join(jobDir(`skip-${i}`), 'job.json'), 'utf8')));
  assert.deepEqual(await slimOld({ now: c.now, force: true }), { jobs: [], bytes: 0 });
  for (const i of patches.keys()) {
    assert.equal(await fs.readFile(join(jobDir(`skip-${i}`), 'job.json'), 'utf8'), before[i]);
    assert.equal(await fs.readFile(join(jobDir(`skip-${i}`), 'run.log'), 'utf8'), '旧日志\n');
  }
  await absent(c.trash);
});

test('开关关闭无操作，force 只绕开开关，7/14/30 天均使用设置和精确到期边界', async t => {
  const c = await registry(t);
  for (const days of [7, 14, 30] as const) {
    await writeSettings({ storage: { slim: false, days } });
    const job = await c.add(`days-${days}`, { ended: new Date(c.now - days * day).toISOString() });
    const before = await fs.readFile(join(jobDir(job.id), 'job.json'), 'utf8');
    assert.deepEqual(await slimOld({ now: c.now }), { jobs: [], bytes: 0 });
    assert.deepEqual(await slimOld({ now: c.now - 1, force: true }), { jobs: [], bytes: 0 });
    assert.equal(await fs.readFile(join(jobDir(job.id), 'job.json'), 'utf8'), before);
    const preview = await slimOld({ now: c.now, dryRun: true, force: true });
    assert.deepEqual(preview, { jobs: [job.id], bytes: Buffer.byteLength('旧日志\n') });
    assert.deepEqual(await slimOld({ now: c.now, force: true }), preview);
    assert.deepEqual((await readJob(job.id)).slimmed?.files, ['run.log']);
  }
});

test('空登记处和没有剩余日志的到期任务可安全处理', async t => {
  const c = await registry(t);
  assert.deepEqual(await slimOld(), { jobs: [], bytes: 0 });
  await fs.rmdir(join(c.home, 'jobs'));
  assert.deepEqual(await slimOld(), { jobs: [], bytes: 0 });
  await c.add('empty');
  // 预先把原始日志移走，模拟旧任务没有日志。
  await fs.rename(join(jobDir('empty'), 'run.log'), join(c.temp, 'saved.log'));
  assert.deepEqual(await slimOld({ now: c.now }), { jobs: ['empty'], bytes: 0 });
  assert.deepEqual((await readJob('empty')).slimmed?.files, []);
  // 没有文件可移：废纸篓里不留空文件夹。
  assert.deepEqual(await fs.readdir(c.trash).catch(() => []), []);
});

test('同时清理同一任务只移动、记账一次', async t => {
  const c = await registry(t); await c.add('race');
  const results = await Promise.all([slimOld({ now: c.now }), slimOld({ now: c.now })]);
  assert.equal(results.reduce((n, r) => n + r.jobs.length, 0), 1);
  assert.equal(results.reduce((n, r) => n + r.bytes, 0), Buffer.byteLength('旧日志\n'));
  assert.deepEqual(await fs.readdir(c.trash), ['派活工作台-race']);
});

test('等待任务锁后重新读记录，不清理已变为运行中的任务', async t => {
  const c = await registry(t); await c.add('changed');
  let scanned!: () => void;
  const scan = new Promise<void>(resolve => { scanned = resolve; });
  const parse = JSON.parse;
  t.mock.method(JSON, 'parse', (text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
    const value = parse(text, reviver);
    if (value?.id === 'changed') scanned();
    return value;
  });
  let clearing!: ReturnType<typeof slimOld>;
  await withLock(jobDir('changed'), async () => {
    clearing = slimOld({ now: c.now });
    await scan;
    const current = await readJob('changed');
    current.state = 'running';
    await writeJson(join(jobDir('changed'), 'job.json'), current);
  });
  assert.deepEqual(await clearing, { jobs: [], bytes: 0 });
  assert.equal((await readJob('changed')).slimmed, undefined);
  await fs.lstat(join(jobDir('changed'), 'run.log'));
  await absent(c.trash);
});

test('废纸篓同名加编号，不覆盖已有内容', async t => {
  const c = await registry(t), source = join(c.temp, 'run.log');
  for (let n = 1; n <= 3; n++) {
    await fs.writeFile(source, `日志 ${n}`);
    assert.equal(await moveToTrash([source], '同名'), join(c.trash, `派活工作台-同名${n === 1 ? '' : ` ${n}`}`));
    await absent(source);
  }
  for (let n = 1; n <= 3; n++) assert.equal(await fs.readFile(join(c.trash, `派活工作台-同名${n === 1 ? '' : ` ${n}`}`, 'run.log'), 'utf8'), `日志 ${n}`);
});

test('跨磁盘复制文件、目录及符号链接后才移除原件', async t => {
  const c = await registry(t), source = join(c.temp, 'runtime');
  await fs.mkdir(join(source, 'src'), { recursive: true });
  await fs.writeFile(join(source, 'src', 'test.ts'), '完整内容');
  await fs.symlink('src/test.ts', join(source, 'link'));
  const log = join(c.temp, 'run.log'); await fs.writeFile(log, '原始日志');
  t.mock.method(fs, 'rename', async () => { throw Object.assign(new Error('跨磁盘'), { code: 'EXDEV' }); });
  const folder = await moveToTrash([source, log], '跨盘');
  await absent(source); await absent(log);
  assert.equal(await fs.readFile(join(folder, 'runtime/src/test.ts'), 'utf8'), '完整内容');
  assert.equal(await fs.readlink(join(folder, 'runtime/link')), 'src/test.ts');
  assert.equal(await fs.readFile(join(folder, 'run.log'), 'utf8'), '原始日志');
});

test('跨磁盘复制中途失败，原件完整保留且不调用删除', async t => {
  const c = await registry(t), source = join(c.temp, 'run.log');
  await fs.writeFile(source, '完整原始日志');
  t.mock.method(fs, 'rename', async () => { throw Object.assign(new Error('跨磁盘'), { code: 'EXDEV' }); });
  t.mock.method(fs, 'cp', async (_source: string, target: string) => {
    await fs.writeFile(target, '半份');
    throw new Error('复制中断');
  });
  const remove = t.mock.method(fs, 'rm', async () => { throw new Error('不应删除'); });
  try {
    await assert.rejects(moveToTrash([source], '失败'), /复制中断/);
    assert.equal(await fs.readFile(source, 'utf8'), '完整原始日志');
    assert.equal(remove.mock.callCount(), 0);
  } finally { t.mock.restoreAll(); }
});

test('一件移动中途失败会放回已移动文件、说明错误，其余任务继续清理', async t => {
  const c = await registry(t);
  await c.add('bad'); await c.add('good');
  await fs.writeFile(join(jobDir('bad'), 'stderr.log'), '错误日志');
  const rename = fs.rename;
  t.mock.method(fs, 'rename', async (source: string, target: string) => {
    if (source === join(jobDir('bad'), 'stderr.log')) throw Object.assign(new Error('无权移动'), { code: 'EACCES' });
    return rename(source, target);
  });
  const errors = t.mock.method(console, 'error', () => {});
  assert.deepEqual(await slimOld({ now: c.now }), { jobs: ['good'], bytes: Buffer.byteLength('旧日志\n') });
  assert.equal((await readJob('bad')).slimmed, undefined);
  assert.equal(await fs.readFile(join(jobDir('bad'), 'run.log'), 'utf8'), '旧日志\n');
  assert.equal(await fs.readFile(join(jobDir('bad'), 'stderr.log'), 'utf8'), '错误日志');
  assert.match(errors.mock.calls.map(call => call.arguments.join(' ')).join('\n'), /任务 bad 的旧日志清理失败.*无权移动.*其余任务继续处理/);
});

test('大小统计与跨盘移动都不跟随任务目录里的符号链接', async t => {
  const c = await registry(t); await c.add('links');
  await fs.mkdir(join(jobDir('links'), 'runtime'));
  const outside = join(c.temp, 'outside.txt'); await fs.writeFile(outside, '不可移动');
  const link = join(jobDir('links'), 'runtime', 'link'); await fs.symlink(outside, link);
  const bytes = Buffer.byteLength('旧日志\n') + (await fs.lstat(link)).size;
  assert.deepEqual(await slimOld({ now: c.now }), { jobs: ['links'], bytes });
  assert.equal(await fs.readFile(outside, 'utf8'), '不可移动');
  assert.equal(await fs.readlink(join(c.trash, '派活工作台-links/runtime/link')), outside);
});

test('CLI 输出清理件数与 MB，支持预览、force、帮助和已清日志的人话错误', async t => {
  const c = await registry(t); await c.add('cli');
  await fs.writeFile(join(jobDir('cli'), 'run.log'), Buffer.alloc(1024 * 1024));
  await writeSettings({ storage: { slim: false, days: 14 } });
  const disabled = await c.cli(['slim']);
  assert.equal(disabled.code, 0, disabled.stderr); assert.match(disabled.stdout, /已清理 0 件.*，腾出 0 MB/);
  const preview = await c.cli(['slim', '--dry-run', '--force']);
  assert.equal(preview.code, 0, preview.stderr); assert.match(preview.stdout, /会清理 1 件.*可腾出 1 MB.*仅预览/);
  assert.equal((await readJob('cli')).slimmed, undefined); await absent(c.trash);
  const cleared = await c.cli(['slim', '--force']);
  assert.equal(cleared.code, 0, cleared.stderr); assert.match(cleared.stdout, /已清理 1 件.*腾出 1 MB.*废纸篓/);
  const collected = await c.cli(['collect', 'cli']);
  assert.equal(collected.code, 1); assert.match(collected.stderr, /原始日志已在 .* 自动清理，报告在 report\.md，改动在 diff\.patch/);
  for (const args of [['--help'], ['slim', '--help']]) {
    const help = await c.cli(args); assert.equal(help.code, 0, help.stderr);
    assert.match(help.stdout, /xagents slim \[--dry-run\] \[--force\]/);
  }
  for (const args of [['slim', '--unknown'], ['slim', 'unexpected']]) assert.equal((await c.cli(args)).code, 1);
});
