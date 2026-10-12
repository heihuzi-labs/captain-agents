import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, parse } from 'node:path';
import { holdAwake, koffiPath, parseProcessRows, processRows, recycleFolder } from '../src/core/native-windows.ts';
import { toolRoot } from '../src/core/paths.ts';
import { isWindows } from '../src/core/platform.ts';

const onlyWindows = isWindows ? false : '只在 Windows 上：直接调的是 Windows 的系统接口';

test('调系统接口用的模块：自己目录里有就只用自己的，不听环境变量；自己没有（代码快照）才用起它的一方指的位置', () => {
  const own = join('install', 'node_modules', 'koffi'), told = join('some', 'where', 'koffi');
  assert.equal(koffiPath({ XAGENTS_KOFFI: told }, () => true, 'install'), own);
  assert.equal(koffiPath({ XAGENTS_KOFFI: told }, () => false, 'snapshot'), told);
  assert.equal(koffiPath({}, () => false, 'snapshot'), join('snapshot', 'node_modules', 'koffi'));
  assert.equal(koffiPath({ XAGENTS_KOFFI: told }), join(toolRoot, 'node_modules', 'koffi'), '这个仓库自己装着这个模块');
});

// 系统给的名单：一条接一条，每条开头是“下一条在多远”。这里按同样的摆法造几条。
function records(list: { pid: number; parent: number; created: bigint; size?: number; next?: number }[]): Buffer {
  const parts = list.map((r, i) => {
    const part = Buffer.alloc(r.size ?? 0x100);
    part.writeUInt32LE(r.next ?? (i === list.length - 1 ? 0 : part.length), 0);
    part.writeBigInt64LE(r.created, 0x20); part.writeBigUInt64LE(BigInt(r.pid), 0x50); part.writeBigUInt64LE(BigInt(r.parent), 0x58);
    return part;
  });
  return Buffer.concat(parts);
}
test('进程列表的解析：进程号、父进程号、创建时间换成毫秒；没有创建时间的不要；名单对不上就报错，不拿半份去用', () => {
  const epoch = 116444736000000000n;   // 1970 年在“1601 年起的百纳秒数”里是多少
  const good = records([{ pid: 0, parent: 0, created: 0n }, { pid: 4, parent: 0, created: epoch + 12345n * 10000n + 9999n }, { pid: 812, parent: 4, created: epoch + 1791832029842n * 10000n, size: 0x180 }]);
  assert.deepEqual(parseProcessRows(good), [{ pid: 4, parent: 0, created: 12345 }, { pid: 812, parent: 4, created: 1791832029842 }]);
  // 系统实际只写了前两条：第三条在范围外。
  assert.throws(() => parseProcessRows(good, 0x200), /名单不完整/);
  assert.deepEqual(parseProcessRows(records([{ pid: 4, parent: 0, created: epoch }]), 0x100), [{ pid: 4, parent: 0, created: 0 }]);
  // 下一条指到缓冲区外面、指得比一条记录还短（会原地打转）、连一条都装不下。
  assert.throws(() => parseProcessRows(records([{ pid: 4, parent: 0, created: epoch, next: 0x100 }])), /名单不完整/);
  assert.throws(() => parseProcessRows(records([{ pid: 4, parent: 0, created: epoch, next: 8 }, { pid: 5, parent: 4, created: epoch }])), /名单不完整/);
  assert.throws(() => parseProcessRows(Buffer.alloc(0x40)), /名单不完整/);
  assert.throws(() => parseProcessRows(good, 0), /名单不完整/);
});

test('别的系统上不加载这个模块，三件事都直接报清楚', { skip: isWindows && '只在 Windows 以外' }, async () => {
  for (const run of [() => holdAwake(), () => processRows()]) assert.throws(run, /只在 64 位的 Windows 上做/);
  await assert.rejects(recycleFolder('x'), /只在 64 位的 Windows 上做/);
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
// “原处没有了”不够（直接删掉也是没有了）：还要数这个盘的回收站目录里当前账户的条目，正好多一条。
test('回收站：文件夹整个送进去，回收站里多一条，原处没有了；不存在的路径报错', { skip: onlyWindows || (!process.env.CI && '只在流水线上：会在回收站里留一个文件夹') }, async t => {
  const base = await mkdtemp(join(tmpdir(), 'xa-recycle-')), folder = join(base, '派活工作台-测试 回收站');
  t.after(() => rm(base, { recursive: true, force: true }));
  const sid = /S-1-5-21-[\d-]+/.exec(spawnSync('whoami', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true }).stdout || '')?.[0];
  assert.ok(sid, '读不到当前账户的编号');
  const entries = async () => (await readdir(join(parse(base).root, '$Recycle.Bin', sid)).catch(() => [] as string[])).filter(name => name.startsWith('$I')).length;
  await mkdir(join(folder, '里面'), { recursive: true });
  await writeFile(join(folder, '里面', '说明.txt'), '测试留下的，可以删。');
  const before = await entries();
  // 送的这一会儿主线程是空着的：定时器照常走。
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 1);
  try { await recycleFolder(folder); } finally { clearInterval(timer); }
  assert.equal(existsSync(folder), false);
  assert.equal(await entries(), before + 1);
  await assert.rejects(recycleFolder(join(base, '没有这个文件夹')), /送进回收站没做完（系统返回 \d+）。请看一下 /);
  t.diagnostic(`送进回收站期间定时器走了 ${ticks} 次`);
});
