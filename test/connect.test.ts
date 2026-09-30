import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { join, basename } from 'node:path';
import { connect, connectArgument, connectStatus, disconnect } from '../src/core/connect.ts';
import { CONNECT_AIS, LEAD_RULE } from '../src/core/intro.ts';
import { copyToTrash } from '../src/core/trash.ts';
import { context, root } from './helpers.ts';

const begin = '<!-- xagents:begin（派活工作台写入，用 xagents connect codex --undo 撤下） -->';
const end = '<!-- xagents:end -->';
const block = `${begin}\n${LEAD_RULE}\n${end}\n`;
async function setup(t: TestContext, installed = true) {
  const c = await context(t, false), home = join(c.temp, 'user-home'), trash = c.env.XAGENTS_TRASH!;
  const old = process.env.XAGENTS_TRASH; process.env.XAGENTS_TRASH = trash;
  t.after(() => { if (old === undefined) delete process.env.XAGENTS_TRASH; else process.env.XAGENTS_TRASH = old; });
  if (installed) for (const ai of CONNECT_AIS) await fs.mkdir(join(home, `.${ai}`));
  const codex = join(home, '.codex/AGENTS.md'), claude = join(home, '.claude/rules/xagents.md');
  const options = { home };
  const state = async (ai: string) => (await connectStatus(options)).find(s => s.ai === ai)!;
  const backups = async () => (await fs.readdir(trash).catch(() => [])).sort();
  return { ...c, home, trash, codex, claude, options, state, backups };
}

test('四家状态、Claude 更新、Grok 共用，不读其他配置', async t => {
  const c = await setup(t, false);
  assert.deepEqual((await connectStatus(c.options)).map(s => s.state), ['missing', 'missing', 'missing', 'missing']);
  await assert.rejects(connect('claude', c.options), /这台电脑上没找到 Claude/);
  await assert.rejects(connect('codex', c.options), /这台电脑上没找到 Codex/);
  for (const ai of CONNECT_AIS) await fs.mkdir(join(c.home, `.${ai}`));
  assert.deepEqual((await connectStatus(c.options)).map(s => s.state), ['off', 'off', 'off', 'off']);
  assert.deepEqual((await c.state('cursor')).files, ['~/.cursor/rules/xagents.mdc']);
  assert.equal((await c.state('grok')).sharedWith, 'claude');
  assert.equal((await c.state('grok')).note, '和 Claude 共用一份规矩');
  await connect('claude', c.options);
  assert.equal(await fs.readFile(c.claude, 'utf8'), LEAD_RULE + '\n');
  assert.equal((await c.state('claude')).state, 'on'); assert.equal((await c.state('grok')).state, 'on');
  await fs.writeFile(c.claude, '旧规矩\n');
  assert.equal((await c.state('claude')).state, 'outdated'); assert.equal((await c.state('grok')).state, 'outdated');
  await connect('claude', c.options);
  assert.equal(await fs.readFile(join(c.trash, (await c.backups())[0], 'xagents.md'), 'utf8'), '旧规矩\n');
  await fs.rm(join(c.home, '.grok'), { recursive: true });
  assert.equal((await c.state('grok')).state, 'missing');
});

test('Grok 接入、撤下都报共用的原话；未知名字拒绝', async t => {
  const c = await setup(t);
  for (const action of [connect, disconnect]) {
    await assert.rejects(action('grok', c.options), { message: 'Grok 和 Claude 共用 ~/.claude/rules/xagents.md，请在 Claude 那一行接入或撤下（xagents connect claude）' });
    await assert.rejects(action('bad' as 'codex', c.options), /claude、codex、grok、cursor/);
  }
});

test('Codex 新建只含标准标记段，旧格式也认作 on；重复接入及 off 撤下不备份', async t => {
  const c = await setup(t);
  await disconnect('codex', c.options);
  await connect('codex', c.options);
  assert.equal(await fs.readFile(c.codex, 'utf8'), block);
  await connect('codex', c.options);
  assert.deepEqual(await c.backups(), []);
  await fs.writeFile(c.codex, `主人原话\n\n${block}`);
  assert.equal((await c.state('codex')).state, 'on');
  await connect('codex', c.options);
  assert.deepEqual(await c.backups(), []);
  await disconnect('codex', c.options);
  assert.equal(await fs.readFile(c.codex, 'utf8'), '主人原话\n');
});

for (const ending of ['', '\n', '\r\n', '\n\n', '\r']) test(`Codex 追加及撤下逐字节保留（末尾 ${JSON.stringify(ending)}），权限和备份正确`, async t => {
  const c = await setup(t);
  const original = Buffer.concat([Buffer.from('# 主人的规则\n原样保留：'), Buffer.from([0xff, 0x80]), Buffer.from(ending)]);
  await fs.writeFile(c.codex, original, { mode: 0o640 });
  await connect('codex', c.options);
  const connected = await fs.readFile(c.codex);
  assert.equal((await c.state('codex')).state, 'on');
  assert.equal((await fs.stat(c.codex)).mode & 0o777, 0o640);
  assert.deepEqual(await fs.readFile(join(c.trash, (await c.backups())[0], 'AGENTS.md')), original);
  await connect('codex', c.options);
  assert.equal((await c.backups()).length, 1);
  await disconnect('codex', c.options);
  assert.deepEqual(await fs.readFile(c.codex), original);
  assert.equal((await fs.stat(c.codex)).mode & 0o777, 0o640);
  assert.deepEqual(await fs.readFile(join(c.trash, (await c.backups())[1], 'AGENTS.md')), connected);
});

test('Codex 更新只改段内，保留两侧字节，更新后仍可撤下', async t => {
  const c = await setup(t);
  const original = `头\r\n\n${begin}\n过时了\n${end}\n尾\r\n`;
  await fs.writeFile(c.codex, original);
  assert.equal((await c.state('codex')).state, 'outdated');
  await connect('codex', c.options);
  assert.equal(await fs.readFile(c.codex, 'utf8'), original.replace('过时了', LEAD_RULE));
  await disconnect('codex', c.options);
  assert.equal(await fs.readFile(c.codex, 'utf8'), '头\r\n尾\r\n');
});

test('不成对、多对、顺序反的标记与 override 一律 broken，拒绝写入及撤下', async t => {
  const c = await setup(t);
  for (const text of [`${begin}\n`, `${end}\n`, block + block, `${end}\n${begin}\n`, `${begin}\n${begin}\n${end}\n`]) {
    await fs.writeFile(c.codex, text);
    assert.equal((await c.state('codex')).state, 'broken');
    for (const action of [connect, disconnect]) await assert.rejects(action('codex', c.options), /标记/);
    assert.equal(await fs.readFile(c.codex, 'utf8'), text);
  }
  await fs.writeFile(c.codex, block);
  await fs.writeFile(join(c.home, '.codex/AGENTS.override.md'), '不能读它的内容');
  assert.equal((await c.state('codex')).state, 'broken');
  for (const action of [connect, disconnect]) await assert.rejects(action('codex', c.options), /你用了 AGENTS.override.md，Codex 不读 AGENTS.md，请手动处理/);
  assert.deepEqual(await c.backups(), []);
});

test('撤下整份 Claude、Codex 空白余文移进废纸篓；不是删除，也不另复制', async t => {
  const c = await setup(t);
  await connect('claude', c.options);
  await connect('claude', c.options);
  assert.deepEqual(await c.backups(), []);
  const inode = (await fs.stat(c.claude)).ino;
  await disconnect('claude', c.options);
  const saved = join(c.trash, (await c.backups())[0], 'xagents.md');
  assert.equal((await fs.stat(saved)).ino, inode);
  assert.equal(await fs.readFile(saved, 'utf8'), LEAD_RULE + '\n');
  await assert.rejects(fs.stat(c.claude), { code: 'ENOENT' });
  await disconnect('claude', c.options);
  assert.equal((await c.backups()).length, 1);
  await fs.writeFile(c.codex, ` \t\n\n${block}`);
  await disconnect('codex', c.options);
  await assert.rejects(fs.stat(c.codex), { code: 'ENOENT' });
  assert.equal((await c.backups()).length, 2);
});

test('目标文件和 Claude rules 目录的符号链接被拒，链接及原文件保留', async t => {
  const c = await setup(t), original = join(c.home, 'original');
  await fs.writeFile(original, '不能动');
  await fs.mkdir(join(c.home, '.claude/rules'));
  for (const [ai, file] of [['claude', c.claude], ['codex', c.codex]] as const) {
    await fs.symlink(original, file);
    assert.equal((await c.state(ai)).state, 'broken');
    for (const action of [connect, disconnect]) await assert.rejects(action(ai, c.options), /符号链接/);
    assert.ok((await fs.lstat(file)).isSymbolicLink());
    assert.equal(await fs.readFile(original, 'utf8'), '不能动');
  }
  await fs.rm(join(c.home, '.claude/rules'), { recursive: true });
  await fs.symlink(c.home, join(c.home, '.claude/rules'));
  for (const action of [connect, disconnect]) await assert.rejects(action('claude', c.options), /rules.*符号链接/);
  assert.deepEqual(await c.backups(), []);
});

test('两次读取之间被主人修改：停止，原文件不被覆盖，未备份', async t => {
  const c = await setup(t); await fs.writeFile(c.codex, '原文');
  const open = fs.open.bind(fs); let reads = 0;
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    if (args[0] === c.codex && ++reads === 1) {
      const readFile = handle.readFile.bind(handle);
      t.mock.method(handle, 'readFile', async () => {
        const bytes = await readFile(); await fs.writeFile(c.codex, '主人刚改的'); return bytes;
      });
    }
    return handle;
  });
  await assert.rejects(connect('codex', c.options), /文件刚被改过，请再试一次/);
  assert.equal(await fs.readFile(c.codex, 'utf8'), '主人刚改的');
  assert.deepEqual(await c.backups(), []);
});

test('备份过程中内容变化仍拒绝写入；备份失败不改原文', async t => {
  const c = await setup(t); await fs.writeFile(c.codex, '原文');
  const cp = fs.cp.bind(fs);
  const mock = t.mock.method(fs, 'cp', async (...args: Parameters<typeof fs.cp>) => {
    await cp(...args); await fs.writeFile(c.codex, '正在编辑');
  });
  await assert.rejects(connect('codex', c.options), /文件刚被改过，请再试一次/);
  assert.equal(await fs.readFile(c.codex, 'utf8'), '正在编辑');
  mock.mock.restore();
  t.mock.method(fs, 'cp', async () => { throw new Error('备份盘不可写'); });
  await assert.rejects(connect('codex', c.options), /备份盘不可写/);
  assert.equal(await fs.readFile(c.codex, 'utf8'), '正在编辑');
});

test('copyToTrash 使用同样的目录编号，保留源文件与权限，符号链接只复制链接', async t => {
  const c = await setup(t); await fs.writeFile(c.codex, '原文', { mode: 0o640 });
  const a = await copyToTrash([c.codex], '接入备份-codex');
  const b = await copyToTrash([c.codex], '接入备份-codex');
  assert.equal(basename(a), '派活工作台-接入备份-codex'); assert.equal(basename(b), '派活工作台-接入备份-codex 2');
  assert.equal(await fs.readFile(c.codex, 'utf8'), '原文');
  assert.equal((await fs.stat(join(a, 'AGENTS.md'))).mode & 0o777, 0o640);
  const link = join(c.home, 'link'); await fs.symlink(c.codex, link);
  const folder = await copyToTrash([link], '链接');
  assert.equal(await fs.readlink(join(folder, 'link')), c.codex);
  await assert.rejects(copyToTrash([c.codex], '../坏名字'), /不合法/);
});

test('CLI 列出四家、接入、撤下、备份位置、错误参数；guide 带状态且读不出仍成功', async t => {
  const c = await setup(t);
  const list = await c.cli(['connect']);
  assert.equal(list.code, 0, list.stderr);
  assert.equal(list.stdout.trim().split('\n').length, 4);
  assert.match(list.stdout, /Claude：还没接入/); assert.match(list.stdout, /Grok：还没接入；和 Claude 共用/);
  assert.match(list.stdout, /Cursor：还没接入；会写进 ~\/.cursor\/rules\/xagents.mdc（只对家目录下的项目生效）/);
  await fs.writeFile(c.codex, '原文\n');
  const connected = await c.cli(['connect', 'codex']);
  assert.equal(connected.code, 0, connected.stderr); assert.match(connected.stdout, /Codex：已接入.*AGENTS.md.*原文件在废纸篓的“派活工作台-接入备份-codex”里/);
  assert.equal(connected.stdout.trim().split('\n').length, 1);
  const undone = await c.cli(['connect', 'codex', '--undo']);
  assert.equal(undone.code, 0, undone.stderr); assert.match(undone.stdout, /Codex：还没接入.*已撤下.*原文件在废纸篓的“派活工作台-接入备份-codex 2”里/);
  assert.equal(await fs.readFile(c.codex, 'utf8'), '原文\n');
  for (const args of [['bad'], ['codex', 'claude'], ['--undo'], ['codex', '--bad']]) assert.equal((await c.cli(['connect', ...args])).code, 1);
  assert.match((await c.cli(['connect', 'bad'])).stderr, /claude、codex、grok、cursor/);
  assert.match((await c.cli(['--help'])).stdout, /xagents connect/);
  const guide = await c.cli(['guide']); assert.equal(guide.code, 0, guide.stderr); assert.match(guide.stdout, /接入的 AI：Claude 还没接入；Codex 还没接入；Grok 和 Claude 共用；Cursor 还没接入/);
  const fakeHome = join(c.temp, '不是目录'); await fs.writeFile(fakeHome, '');
  const failedRead = await c.cli(['guide'], { HOME: fakeHome });
  assert.equal(failedRead.code, 0, failedRead.stderr); assert.match(failedRead.stdout, /接入状态读不出：/);
});

test('主进程三条处理都先 guard，接入和撤下用可测参数校验，缺参、多参、非名单都拒绝', async () => {
  for (const args of [[], ['codex', 'claude'], ['other'], [null], [1], [{}]]) assert.throws(() => connectArgument(args), /只收一个 AI 名字/);
  for (const ai of CONNECT_AIS) assert.equal(connectArgument([ai]), ai);
  const source = await fs.readFile(join(root, 'app/main/index.ts'), 'utf8');
  for (const action of ['connect', 'disconnect']) assert.match(source, new RegExp(`ipcMain.handle\\(channels.${action}, .*guard\\(event\\); return ${action}\\(connectArgument\\(args\\)\\)`));
  assert.match(source, /ipcMain.handle\(channels.connectStatus, .*guard\(event\); if \(args.length\) throw/);
});

test('Codex 已有标记前没空行时不吞主人换行，CRLF 空行也能撤下', async t => {
  const c = await setup(t);
  for (const separator of ['', '\r\n']) {
    await fs.writeFile(c.codex, `主人原文\r\n${separator}${block}`);
    await disconnect('codex', c.options);
    assert.equal(await fs.readFile(c.codex, 'utf8'), '主人原文\r\n');
  }
});

test('Cursor：整份 .mdc 带“总是生效”的头，只对家目录下的项目生效；改过的备份，撤下移进废纸篓', async t => {
  const c = await setup(t), file = join(c.home, '.cursor/rules/xagents.mdc');
  assert.match((await c.state('cursor')).note, /只对家目录下的项目生效/);
  await connect('cursor', c.options);
  const text = await fs.readFile(file, 'utf8');
  assert.ok(text.startsWith('---\n') && text.includes('\nalwaysApply: true\n---\n'), text);
  assert.ok(text.endsWith(LEAD_RULE + '\n'));
  assert.equal((await c.state('cursor')).state, 'on');
  assert.deepEqual(await c.backups(), []);
  await fs.writeFile(file, '主人改过\n');
  assert.equal((await c.state('cursor')).state, 'outdated');
  await connect('cursor', c.options);
  assert.equal(await fs.readFile(join(c.trash, (await c.backups())[0], 'xagents.mdc'), 'utf8'), '主人改过\n');
  await disconnect('cursor', c.options);
  await assert.rejects(fs.access(file));
  assert.equal((await c.state('cursor')).state, 'off');
  assert.equal((await c.backups()).length, 2);
  await fs.rm(join(c.home, '.cursor/rules'), { recursive: true });
  await fs.symlink(c.temp, join(c.home, '.cursor/rules'));
  await assert.rejects(connect('cursor', c.options), /符号链接/);
});

test('开始行还是改名前的写法：算不是最新，再接入换成新写法并保留“末尾无换行”，撤下逐字节还原', async t => {
  const c = await setup(t);
  const original = Buffer.from('主人原话，末尾没有换行');
  const legacy = '<!-- xagents:begin（派活台写入，用 xagents connect codex --undo 撤下） 原文末尾无换行 -->';
  await fs.writeFile(c.codex, Buffer.concat([original, Buffer.from(`\n\n${legacy}\n${LEAD_RULE}\n${end}\n`)]));
  assert.equal((await c.state('codex')).state, 'outdated');
  await connect('codex', c.options);
  const text = await fs.readFile(c.codex, 'utf8');
  assert.ok(text.includes(begin.replace(' -->', ' 原文末尾无换行 -->')) && !text.includes('派活台写入'));
  assert.equal((await c.state('codex')).state, 'on');
  await disconnect('codex', c.options);
  assert.deepEqual(await fs.readFile(c.codex), original);
});
