import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, stat, mkdir, access, rm, readdir, symlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { context } from './helpers.ts';
import { iconSources, installIcons, migrateIcons } from '../src/core/icons.ts';

test('图标用替身应用和 sips 按需导出；缺失跳过，失败不留半份，下次能重试', async t => {
  const c = await context(t), apps = join(c.temp, 'Applications'), icons = join(c.home, 'icons');
  for (const key of ['codex', 'grok', 'cursor'] as const) {
    const source = join(apps, iconSources[key]); await mkdir(dirname(source), { recursive: true }); await writeFile(source, key);
  }
  const sips = join(c.temp, 'fake-sips');
  const capture = join(c.temp, 'sips-calls');
  await writeFile(sips, `#!${process.execPath}\nconst fs = require('node:fs'); const args = process.argv.slice(2); fs.appendFileSync(${JSON.stringify(capture)}, JSON.stringify(args)+'\\n'); if(args[5].includes('Cursor.app')) { fs.writeFileSync(args[7], 'partial'); process.exit(1); } fs.copyFileSync(args[5], args[7]);\n`, { mode: 0o700 });
  await installIcons(icons, apps, sips);
  assert.equal(await readFile(join(icons, 'codex.png'), 'utf8'), 'codex');
  assert.equal(await readFile(join(icons, 'grok.png'), 'utf8'), 'grok');
  await assert.rejects(access(join(icons, 'claude.png')));
  await assert.rejects(access(join(icons, 'cursor.png')));
  const stamp = await stat(join(icons, 'codex.png'));
  await installIcons(icons, apps, sips);
  assert.equal((await stat(join(icons, 'codex.png'))).ino, stamp.ino);
  const calls = (await readFile(capture, 'utf8')).trim().split('\n').map(s => JSON.parse(s));
  assert.equal(calls.length, 4);
  assert.deepEqual(calls[0].slice(0, 5), ['-s', 'format', 'png', '-Z', '96']);
  assert.equal(calls[0][6], '--out');
  await writeFile(sips, `#!${process.execPath}\nconst fs = require('node:fs'); const a = process.argv.slice(2); fs.copyFileSync(a[5],a[7]);\n`, { mode: 0o700 });
  await installIcons(icons, apps, sips); assert.equal(await readFile(join(icons, 'cursor.png'), 'utf8'), 'cursor');
  await rm(join(icons, 'codex.png'));
  await c.add();
  const extra = { XAGENTS_APPLICATIONS: apps, XAGENTS_SIPS: sips };
  const started = await c.cli(['run', c.task, '--summary', '完成本次测试任务', '--who', 'codex:high'], extra);
  assert.equal(started.code, 0, started.stderr);
  assert.equal(await readFile(join(icons, 'codex.png'), 'utf8'), 'codex');
  assert.equal((await c.cli(['wait', (await c.jobs())[0].id])).code, 0);
});

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
test('旧图标在新目录缺失时复制，CLI 初始化不挡迁移，旧文件保留且重复迁移不覆盖', async t => {
  const c = await context(t, false), old = join(c.home, 'board/icons'), icons = join(c.home, 'icons');
  await mkdir(old, { recursive: true });
  await writeFile(join(old, 'codex.png'), png);
  assert.equal((await c.cli(['status'])).code, 0);
  await assert.rejects(access(icons), { code: 'ENOENT' });
  await Promise.all([migrateIcons(c.home), migrateIcons(c.home)]);
  assert.deepEqual(await readFile(join(icons, 'codex.png')), png);
  assert.deepEqual(await readFile(join(old, 'codex.png')), png);
  assert.notEqual((await stat(join(icons, 'codex.png'))).ino, (await stat(join(old, 'codex.png'))).ino);
  const before = await stat(join(icons, 'codex.png'));
  await writeFile(join(old, 'codex.png'), Buffer.concat([png, Buffer.from('changed')]));
  await migrateIcons(c.home);
  assert.deepEqual(await readFile(join(icons, 'codex.png')), png);
  assert.equal((await stat(join(icons, 'codex.png'))).ino, before.ino);
  assert.deepEqual((await readdir(c.home)).filter(name => name.startsWith('.icons-')), []);
});
test('新目录已存在时即便为空，也不从旧目录补入或覆盖', async t => {
  const c = await context(t, false), old = join(c.home, 'board/icons'), icons = join(c.home, 'icons');
  await mkdir(old, { recursive: true }); await mkdir(icons);
  await writeFile(join(old, 'codex.png'), png);
  const before = await stat(icons);
  await migrateIcons(c.home);
  assert.deepEqual(await readdir(icons), []);
  assert.equal((await stat(icons)).ino, before.ino);
  assert.deepEqual(await readFile(join(old, 'codex.png')), png);
});
test('迁移拒绝旧目录、文件软链和假 PNG，失败不留下新目录，修复后可重试', async t => {
  const c = await context(t, false), board = join(c.home, 'board'), old = join(board, 'icons'), icons = join(c.home, 'icons');
  const outside = join(c.temp, 'outside'); await mkdir(outside);
  await symlink(outside, board);
  await assert.rejects(migrateIcons(c.home), /旧图标目录无效/);
  await rm(board); await mkdir(board); await symlink(outside, old);
  await assert.rejects(migrateIcons(c.home), /旧图标目录无效/);
  await rm(old); await mkdir(old);
  await writeFile(join(outside, 'codex.png'), png); await symlink(join(outside, 'codex.png'), join(old, 'codex.png'));
  await assert.rejects(migrateIcons(c.home));
  await rm(join(old, 'codex.png')); await writeFile(join(old, 'codex.png'), 'not PNG');
  await assert.rejects(migrateIcons(c.home), /不是 PNG/);
  await assert.rejects(access(icons), { code: 'ENOENT' });
  assert.deepEqual((await readdir(c.home)).filter(name => name.startsWith('.icons-')), []);
  await writeFile(join(old, 'codex.png'), png);
  await migrateIcons(c.home);
  assert.deepEqual(await readFile(join(icons, 'codex.png')), png);
});
