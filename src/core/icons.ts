import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hasCode, withLock, writeAtomic } from './fsx.ts';
import { paths } from './paths.ts';

export const iconSources = {
  codex: 'ChatGPT.app/Contents/Resources/icon-codex-light.png',
  grok: 'Grok Bot.app/Contents/Resources/icon.icns',
  cursor: 'Cursor.app/Contents/Resources/Cursor.icns',
  claude: 'Claude.app/Contents/Resources/electron.icns',
};
// 在锁内先复制到临时目录再改名；失败可重试，旧目录始终保留。
export async function migrateIcons(home = paths().home) {
  await withLock(join(home, 'cache', 'icons'), async () => {
    const root = await realpath(home), target = join(root, 'icons');
    try { await lstat(target); return; } catch (e) { if (!hasCode(e, 'ENOENT')) throw e; }
    const board = join(root, 'board'), old = join(board, 'icons');
    for (const dir of [board, old]) {
      try {
        if (!(await lstat(dir)).isDirectory() || await realpath(dir) !== dir) throw new Error('旧图标目录无效');
      } catch (e) { if (hasCode(e, 'ENOENT')) return; throw e; }
    }
    const temporary = await mkdtemp(join(root, '.icons-'));
    try {
      for (const name of Object.keys(iconSources)) {
        const file = join(old, `${name}.png`);
        let handle;
        try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
        catch (e) { if (hasCode(e, 'ENOENT')) continue; throw e; }
        try {
          const info = await handle.stat(), current = await lstat(file);
          if (!info.isFile() || info.size > 4 * 1024 * 1024 || await realpath(file) !== file
            || !current.isFile() || current.dev !== info.dev || current.ino !== info.ino) throw new Error('旧图标文件无效');
          const bytes = await handle.readFile();
          if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('旧图标不是 PNG');
          await writeAtomic(join(temporary, `${name}.png`), bytes);
        } finally { await handle.close(); }
      }
      await rename(temporary, target);
    } finally { await rm(temporary, { recursive: true, force: true }); }
  });
}

export async function installIcons(dir = paths().icons, apps = process.env.XAGENTS_APPLICATIONS || '/Applications', sips = process.env.XAGENTS_SIPS || 'sips') {
  await migrateIcons(dirname(dir));
  await mkdir(dir, { recursive: true });
  if (!(await lstat(dir)).isDirectory() || await realpath(dir) !== join(await realpath(dirname(dir)), 'icons')) throw new Error('图标目录无效');
  await withLock(dir, async () => {
    for (const [name, source] of Object.entries(iconSources)) {
      const target = join(dir, name + '.png'), input = join(apps, source);
      try { await access(target); continue; } catch (e) { if (!hasCode(e, 'ENOENT')) throw e; }
      try { await access(input); } catch (e) { if (hasCode(e, 'ENOENT')) continue; throw e; }
      const tmp = join(dir, `.${name}.${randomUUID()}.png`);
      try {
        await new Promise<void>((resolve, reject) => {
          const child = spawn(sips, ['-s', 'format', 'png', '-Z', '96', input, '--out', tmp], { stdio: 'ignore' });
          child.on('error', reject);
          child.on('close', code => code === 0 ? resolve() : reject(new Error(`sips 退出码 ${code}`)));
        });
        await writeAtomic(target, await readFile(tmp));
      } catch (e) { console.error(`导出 ${name} 图标失败：${(e as Error).message}，应用将显示字母。`); }
      finally { await rm(tmp, { force: true }); }
    }
  });
}
