import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { holdAwake, koffiPath, processRows, recycleFolder } from '../src/core/native-windows.ts';
import { toolRoot } from '../src/core/paths.ts';
import { isWindows } from '../src/core/platform.ts';

const onlyWindows = isWindows ? false : '只在 Windows 上：直接调的是 Windows 的系统接口';

test('调系统接口用的模块：缺省在安装目录的 node_modules 里，推进进程用环境变量指过去', () => {
  assert.equal(koffiPath({}), join(toolRoot, 'node_modules', 'koffi'));
  assert.equal(koffiPath({ XAGENTS_KOFFI: join('some', 'where', 'koffi') }), join('some', 'where', 'koffi'));
});

test('别的系统上不加载这个模块，三件事都直接报清楚', { skip: isWindows && '只在 Windows 以外' }, () => {
  for (const run of [() => holdAwake(), () => processRows(), () => recycleFolder('x')]) assert.throws(run, /只在 64 位的 Windows 上做/);
});

// 平台自己不在后台起 PowerShell：杀毒软件会把它当可疑行为拦下来（docs/design-windows.md 第 13 节）。
// 留下的只有主人自己点的加固那一套（selfcheck-windows.ts 起 sandbox/windows 下的脚本和隔离里的探针）。
test('核心和桌面应用的后台里，只有加固那一套会启动 PowerShell', async () => {
  const hits: string[] = [];
  for (const dir of ['src/core', 'src/cli', 'app/main']) {
    for (const name of await readdir(join(toolRoot, dir))) {
      if (name.endsWith('.ts') && /powershell\.exe/i.test(await readFile(join(toolRoot, dir, name), 'utf8'))) hits.push(`${dir}/${name}`);
    }
  }
  assert.deepEqual(hits, ['src/core/selfcheck-windows.ts']);
});

test('进程快照：读得到自己和刚起的子进程，父子关系和出生时间都对', { skip: onlyWindows }, async t => {
  const since = Date.now();
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  t.after(() => { child.kill('SIGKILL'); });
  await new Promise<void>((done, fail) => { child.once('spawn', done); child.once('error', fail); });
  const rows = processRows(), me = rows.find(r => r.pid === process.pid), kid = rows.find(r => r.pid === child.pid);
  assert.ok(rows.length > 10);
  assert.equal(new Set(rows.map(r => r.pid)).size, rows.length, '一个进程号只出现一次');
  assert.ok(me && me.parent === process.ppid && me.created <= since && me.created > since - 3_600_000, JSON.stringify(me));
  assert.ok(kid && kid.parent === process.pid && kid.created >= since - 2000 && kid.created <= Date.now() + 1000, JSON.stringify(kid));
});

// 系统的“谁在申请别休眠”名单要管理员身份才读得了（流水线上是）；读不了时只核对申请和撤销都被系统接受。
test('防休眠：申请以后系统的名单里有这个进程，撤掉以后没有', { skip: onlyWindows }, () => {
  const listed = () => {
    const r = spawnSync('powercfg', ['/requests'], { encoding: 'utf8', windowsHide: true, timeout: 30_000 }), text = r.stdout || '';
    const at = text.indexOf('SYSTEM:'), end = text.indexOf('AWAYMODE:');
    return r.status !== 0 || at < 0 ? undefined : text.slice(at, end < 0 ? undefined : end).toLowerCase().includes(basename(process.execPath).toLowerCase());
  };
  const before = listed(), release = holdAwake();
  try { if (before !== undefined) assert.equal(listed(), true); }
  finally { release(); }
  if (before === false) assert.equal(listed(), false);
});

// 只在流水线上跑：每跑一次会在回收站里留一个小文件夹，不往开发的人自己的回收站里放东西。
test('回收站：文件夹整个送进去，原处没有了；不存在的路径报错', { skip: onlyWindows || (!process.env.CI && '只在流水线上：会在回收站里留一个文件夹') }, async t => {
  const base = await mkdtemp(join(tmpdir(), 'xa-recycle-')), folder = join(base, '派活工作台-测试 回收站');
  t.after(() => rm(base, { recursive: true, force: true }));
  await mkdir(join(folder, '里面'), { recursive: true });
  await writeFile(join(folder, '里面', '说明.txt'), '测试留下的，可以删。');
  recycleFolder(folder);
  assert.equal(existsSync(folder), false);
  assert.throws(() => recycleFolder(join(base, '没有这个文件夹')), /送进回收站没成功（系统返回 \d+）。东西还在 /);
});
