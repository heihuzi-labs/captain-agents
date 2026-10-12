import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { backgroundSpawn, findSh, isWindows, killTree, parseSnapshot, shell, treeOf, treeSpawn } from '../src/core/platform.ts';
import { alive } from '../src/core/fsx.ts';
import { until } from './helpers.ts';

test('进程快照只收“进程号 父进程号 创建时间”三段数字的行，认两种换行', () => {
  assert.deepEqual(parseSnapshot('4 0 100\r\n812 4 250\n\n乱码 1 2\n12 x 3\n 900 812 300 \n'), [
    { pid: 4, parent: 0, created: 100 }, { pid: 812, parent: 4, created: 250 }, { pid: 900, parent: 812, created: 300 },
  ]);
});

test('进程树：root 还在时连它带子孙一起，父在前子在后；别人的进程不碰', () => {
  const rows = [
    { pid: 10, parent: 1, created: 1000 }, { pid: 11, parent: 10, created: 1100 }, { pid: 12, parent: 11, created: 1200 },
    { pid: 13, parent: 10, created: 1300 }, { pid: 20, parent: 1, created: 900 }, { pid: 21, parent: 20, created: 950 },
  ];
  assert.deepEqual(treeOf(rows, 10, 1000), [10, 11, 12, 13]);
  assert.deepEqual(treeOf(rows, 10), [10, 11, 12, 13], '不给起始时间时只按进程号认');
  assert.deepEqual(treeOf(rows, 99, 1000), [], '没有这个进程、也没有它的孩子');
});

test('进程树：比父进程早出生的“孩子”是进程号被重用后撞上的无关进程，不算', () => {
  const rows = [{ pid: 10, parent: 1, created: 5000 }, { pid: 11, parent: 10, created: 4000 }, { pid: 12, parent: 10, created: 5001 }, { pid: 13, parent: 11, created: 6000 }];
  assert.deepEqual(treeOf(rows, 10, 5000), [10, 12]);
});

test('进程树：root 已经退了，只收它生前留下的子孙', () => {
  const rows = [{ pid: 11, parent: 10, created: 10_500 }, { pid: 12, parent: 11, created: 10_600 }, { pid: 13, parent: 10, created: 5000 }];
  assert.deepEqual(treeOf(rows, 10, 10_000), [11, 12], '比起始时间早出生好几秒的不是它的孩子');
  assert.deepEqual(treeOf(rows, 10), [], '不知道起始时间就没法认，什么都不碰');
});

test('进程树：root 退了以后进程号被无关进程重用，不碰那个进程和它后来生的孩子', () => {
  const rows = [
    { pid: 10, parent: 1, created: 90_000 },   // 重用者：比我们起 root 的时间晚了 30 秒以上
    { pid: 11, parent: 10, created: 2000 },    // 我们的 root 生前留下的
    { pid: 12, parent: 10, created: 95_000 },  // 重用者的孩子
  ];
  assert.deepEqual(treeOf(rows, 10, 1000), [11]);
});

test('进程树：叫这个号的进程比起始时间早得多，说明时间给错了，什么都不碰', () => {
  const rows = [{ pid: 10, parent: 1, created: 1000 }, { pid: 11, parent: 10, created: 60_000 }];
  assert.deepEqual(treeOf(rows, 10, 50_000), []);
});

test('找 sh：XAGENTS_SH 优先；否则从 git.exe 的位置往上找 Git 自带的；找不到给出能照办的提示', () => {
  const git = ['C:', 'Program Files', 'Git'].join('\\');
  const at = (...parts: string[]) => join(...parts);
  assert.equal(findSh({ XAGENTS_SH: 'D:\\tools\\sh.exe' }, () => false, () => []), 'D:\\tools\\sh.exe');
  for (const where of [at(git, 'cmd', 'git.exe'), at(git, 'bin', 'git.exe'), at(git, 'mingw64', 'bin', 'git.exe')]) {
    assert.equal(findSh({}, path => path === at(git, 'bin', 'sh.exe'), () => [where]), at(git, 'bin', 'sh.exe'), where);
  }
  assert.equal(findSh({}, path => path === at(git, 'usr', 'bin', 'sh.exe'), () => [at(git, 'cmd', 'git.exe')]), at(git, 'usr', 'bin', 'sh.exe'));
  assert.throws(() => findSh({}, () => false, () => [at(git, 'cmd', 'git.exe')]), /找不到 Git 自带的 sh。请先安装 Git for Windows/);
  assert.throws(() => findSh({}, () => true, () => []), /找不到 Git 自带的 sh/);
});

test('起进程的选项：进程树在 macOS 上独立成组，在 Windows 上不脱离父进程、不弹窗；后台进程两边都脱离', () => {
  assert.deepEqual(treeSpawn(), isWindows ? { windowsHide: true } : { detached: true });
  assert.deepEqual(backgroundSpawn(), isWindows ? { detached: true, windowsHide: true } : { detached: true });
});

test('外壳命令两种系统都交给 sh -c', () => {
  const sh = shell('echo 1');
  assert.deepEqual(sh.args, ['-c', 'echo 1']);
  assert.match(sh.file, isWindows ? /sh\.exe$/i : /^\/bin\/sh$/);
});

// 真的起一棵三层的进程树再停掉：父进程起子进程，子进程再起孙进程，三个都只会一直等。
const nest = (depth: number): string => depth === 0 ? 'setInterval(() => {}, 1000)'
  : `const c = require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(nest(depth - 1))}], { stdio: 'inherit' }); console.log(c.pid); setInterval(() => {}, 1000)`;
async function tree() {
  const since = Date.now();
  const child = spawn(process.execPath, ['-e', nest(2)], { ...treeSpawn(), stdio: ['ignore', 'pipe', 'inherit'] });
  let out = ''; child.stdout.on('data', b => { out += b; });
  const pids = await until(async () => out.split(/\r?\n/).filter(Boolean).map(Number), list => list.length === 2);
  return { child, since, pids: [child.pid!, ...pids] };
}

test('killTree 停掉整棵树，一个不剩', async () => {
  const { child, since, pids } = await tree();
  try {
    for (const pid of pids) assert.ok(alive(pid), `进程 ${pid} 应当在跑`);
    killTree(child.pid, 'SIGKILL', since);
    await until(async () => pids.filter(alive), left => left.length === 0);
  } finally { for (const pid of pids) try { process.kill(pid, 'SIGKILL'); } catch { /* 已经没了 */ } }
});

test('killTree：父进程先退了，留下的子孙照样收走', async () => {
  const { child, since, pids } = await tree();
  try {
    process.kill(child.pid!, 'SIGKILL');
    await until(async () => alive(child.pid), gone => !gone);
    await sleep(100);
    assert.ok(alive(pids[1]) && alive(pids[2]), '子孙应当还在');
    killTree(child.pid, 'SIGKILL', since);
    await until(async () => pids.filter(alive), left => left.length === 0);
  } finally { for (const pid of pids) try { process.kill(pid, 'SIGKILL'); } catch { /* 已经没了 */ } }
});

test('killTree：进程号无效或树已经不在，不报错', () => {
  killTree(undefined, 'SIGKILL'); killTree(0, 'SIGKILL'); killTree(-5, 'SIGKILL');
  killTree(2 ** 30, 'SIGKILL', Date.now());
});
