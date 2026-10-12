import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join, posix, win32 } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { backgroundSpawn, expandHomePath, findSh, isWindows, killTree, parseSnapshot, relativeInside, samePath, shell, stillRunning, treeOf, treeSpawn } from '../src/core/platform.ts';
import { alive } from '../src/core/fsx.ts';
import { until, killLeftover } from './helpers.ts';

for (const implementation of [posix, win32]) {
  test(`路径包含关系（${implementation.sep}）：自身、子目录、父目录、相邻目录与规范化`, () => {
    const root = implementation.resolve(implementation === win32 ? 'C:\\work\\repo' : '/work/repo');
    assert.equal(relativeInside(root, root, implementation), '');
    assert.equal(relativeInside(root, implementation.join(root, 'src', 'a.ts'), implementation), implementation.join('src', 'a.ts'));
    assert.equal(relativeInside(root, implementation.join(root, '..inside'), implementation), '..inside');
    for (const candidate of [implementation.dirname(root), `${root}-other`, implementation.join(root, '..', 'outside')]) {
      assert.equal(relativeInside(root, candidate, implementation), undefined, candidate);
    }
    assert.equal(relativeInside(root, implementation.join(root, 'src', '..', 'a.ts'), implementation), 'a.ts');
    assert.ok(samePath(root, `${root}${implementation.sep}.`, implementation));
    assert.equal(samePath(root, `${root}-other`, implementation), false);
    assert.equal(expandHomePath('~/bin/tool', root, implementation), implementation.join(root, 'bin', 'tool'));
    assert.equal(expandHomePath('~other/bin', root, implementation), '~other/bin');
  });
}

test('Git 副本路径比较：Windows 斜杠和大小写等价，POSIX 大小写不同不等价', () => {
  for (const saved of ['C:\\a\\b', 'c:\\A\\b', 'C:\\a\\b\\']) assert.ok(samePath('C:/a/b', saved, win32));
  assert.equal(samePath('/a/b', '/A/b', posix), false);
  assert.equal(samePath('/a/b', '/a\\b', posix), false);
  assert.equal(samePath('C:/a/b', 'D:/a/b', win32), false);
  assert.equal(relativeInside('C:\\a', 'D:\\a\\b', win32), undefined);
  assert.equal(relativeInside('C:\\a', 'c:/A/b', win32), 'b');
  assert.equal(relativeInside('/a', '/A/b', posix), undefined);
  assert.equal(relativeInside('\\\\server\\share\\repo', '//SERVER/share/repo/a', win32), 'a');
  assert.equal(relativeInside('\\\\server\\share', '\\\\server\\other\\a', win32), undefined);
  assert.equal(expandHomePath('~\\bin\\tool', 'C:\\Users\\owner', win32), 'C:\\Users\\owner\\bin\\tool');
});

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

test('进程树：root 已经退了、号还没人用，只收它生前留下的子孙', () => {
  const rows = [{ pid: 11, parent: 10, created: 10_500 }, { pid: 12, parent: 11, created: 10_600 }, { pid: 13, parent: 10, created: 5000 }];
  assert.deepEqual(treeOf(rows, 10, 10_000), [11, 12], '比起始时间早出生好几秒的不是它的孩子');
  assert.deepEqual(treeOf(rows, 10, 10_000, 20_000), [11, 12]);
  assert.deepEqual(treeOf(rows, 10), [], '不知道起始时间就没法认，什么都不碰');
});

test('进程树：root 退了以后进程号被无关进程重用，不碰那个进程和它后来生的孩子', () => {
  const rows = [
    { pid: 10, parent: 1, created: 90_000 },   // 重用者：比我们起 root 的时间晚了 5 秒以上
    { pid: 11, parent: 10, created: 2000 },    // 我们的 root 生前留下的
    { pid: 12, parent: 10, created: 95_000 },  // 重用者的孩子
  ];
  assert.deepEqual(treeOf(rows, 10, 1000), [11]);
});

test('进程树：已经看到 root 退出时，哪怕重用者紧跟着出生，也绝不碰它，只收 root 退出之前生的孩子', () => {
  const rows = [
    { pid: 10, parent: 1, created: 2500 },   // 重用者：我们的 root 退出后不到一秒就拿走了这个号（在“起 root 后 5 秒内”）
    { pid: 11, parent: 10, created: 1500 },  // 我们的 root 生前留下的
    { pid: 12, parent: 10, created: 2600 },  // 重用者的孩子
  ];
  assert.deepEqual(treeOf(rows, 10, 1000, 2000), [11]);
  // 没说它退出了：这个时间范围内只能认它是我们的 root（所以调用方看到退出后一定要说）。
  assert.deepEqual(treeOf(rows, 10, 1000), [10, 12]);
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
  } finally { for (const pid of pids) killLeftover(pid); }
});

test('killTree：父进程先退了，留下的子孙照样收走', async () => {
  const { child, since, pids } = await tree();
  try {
    process.kill(child.pid!, 'SIGKILL');
    await until(async () => alive(child.pid), gone => !gone);
    const exitedAt = Date.now();
    await sleep(100);
    // Windows 上没脱离父进程的子进程会被系统跟着父进程一起收走（实测），所以那里不要求它们还在；之后一样要求一个不剩。
    if (!isWindows) assert.ok(alive(pids[1]) && alive(pids[2]), '子孙应当还在');
    killTree(child.pid, 'SIGKILL', since, exitedAt);
    await until(async () => pids.filter(alive), left => left.length === 0);
  } finally { for (const pid of pids) killLeftover(pid); }
});

test('killTree：进程号无效或树已经不在，不报错', () => {
  killTree(undefined, 'SIGKILL'); killTree(0, 'SIGKILL'); killTree(-5, 'SIGKILL');
  killTree(2 ** 30, 'SIGKILL', Date.now());
});

test('Windows 的 PowerShell 脚本只用 ASCII 字符：系统自带的 PowerShell 按本机代码页读没有 BOM 的脚本，别的字符会被读坏', async () => {
  const { readdir, readFile } = await import('node:fs/promises');
  const dir = join(import.meta.dirname, '..', 'sandbox', 'windows');
  const names = (await readdir(dir)).filter(name => name.endsWith('.ps1'));
  assert.ok(names.includes('setup.ps1') && names.includes('loopback-fence.ps1'));
  for (const name of names) {
    const bytes = await readFile(join(dir, name));
    assert.equal(bytes.findIndex(b => b > 127), -1, name);
    assert.ok(!bytes.includes(13), `${name} 里不该有回车符`);
  }
});

test('被占用时重试：只在 Windows 上、只对“没权限 / 被占用”这几个错误码重试，次数有上限', async () => {
  const { retryBusy } = await import('../src/core/fsx.ts');
  const failing = (codes: string[]) => { let n = 0; return { fn: async () => { const code = codes[n++]; if (code) throw Object.assign(new Error(code), { code }); return n; }, calls: () => n }; };
  const busy = failing(['EPERM', 'EBUSY', 'EACCES']);
  assert.equal(await retryBusy(busy.fn, true), 4);
  const posix = failing(['EPERM']);
  await assert.rejects(retryBusy(posix.fn, false), { code: 'EPERM' }); assert.equal(posix.calls(), 1);
  const other = failing(['ENOENT']);
  await assert.rejects(retryBusy(other.fn, true), { code: 'ENOENT' }); assert.equal(other.calls(), 1);
  const stuck = failing(['EPERM', 'EPERM', 'EPERM', 'EPERM']);
  await assert.rejects(retryBusy(stuck.fn, true, 3), { code: 'EPERM' }); assert.equal(stuck.calls(), 3);
});

test('还在不在：进程在才算在；Windows 上还要创建时间对得上（号被别的进程重用不算）', async () => {
  assert.equal(stillRunning(undefined), false); assert.equal(stillRunning(0), false); assert.equal(stillRunning(2 ** 30, Date.now()), false);
  const since = Date.now();
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { ...treeSpawn(), stdio: 'ignore' });
  try {
    await until(async () => alive(child.pid));
    assert.equal(stillRunning(child.pid, since), true);
    assert.equal(stillRunning(child.pid), true, '不知道起始时间就只看在不在');
    // 同一个号，但“当初起它的时间”是一小时前：Windows 上认定不是那个进程了；macOS 上只看在不在。
    assert.equal(stillRunning(child.pid, since - 3_600_000), !isWindows);
  } finally { child.kill('SIGKILL'); }
  await until(async () => !alive(child.pid));
  assert.equal(stillRunning(child.pid, since), false);
});
