import { externalEnvironment } from './node-runtime.ts';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hasCode, withLock, writeAtomic } from './fsx.ts';
import { paths } from './paths.ts';
import { isWindows } from './platform.ts';
import { packageFolders } from './native-windows.ts';

export const iconSources = {
  codex: 'ChatGPT.app/Contents/Resources/icon-codex-light.png',
  grok: 'Grok Bot.app/Contents/Resources/icon.icns',
  cursor: 'Cursor.app/Contents/Resources/Cursor.icns',
  claude: 'Claude.app/Contents/Resources/electron.icns',
  // DeepSeek 选手借 Codex 跑，但界面上按 DeepSeek 显示；图标取 DeepSeek 自家桌面应用的，没装就显示字母。
  deepseek: 'DeepSeek Harness.app/Contents/Resources/icon.png',
};
// Windows 上各家的桌面应用多是 MSIX 包（商店那种装法），没有 /Applications 这样的固定位置：按包家族名问系统包在哪
// （native-windows.ts 的 packageFolders），再取包里登记给开始菜单用的那张图。Codex 桌面应用的图是 OpenAI 的结形标志
// （Windows 任务栏上显示的就是它，包里没有 macOS 上那张 Codex 专用图，2026-10-14 在流水线上装真包查过）；
// 取“浅色背景用、不带底板”的那一张（黑色图形、透明底），界面上给它垫白底（docs/ui-spec.md 的 WorkerIcon）。
// 其余几家在 Windows 上没有（不派 Grok、Cursor 还没上 Windows）或不知道包名，显示字母。
export const windowsIconSources: Partial<Record<keyof typeof iconSources, { family: string; file: string }>> = {
  codex: { family: 'OpenAI.Codex_2p2nqsd0c76g0', file: join('assets', 'Square44x44Logo.targetsize-256_altform-lightunplated.png') },
};
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), MAX_ICON = 4 * 1024 * 1024;
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

export async function installIcons(dir = paths().icons, apps = process.env.XAGENTS_APPLICATIONS || '/Applications', sips = process.env.XAGENTS_SIPS || 'sips',
  windows: { on: boolean; folders(family: string): string[] } = { on: isWindows, folders: packageFolders }) {
  await migrateIcons(dirname(dir));
  await mkdir(dir, { recursive: true });
  if (!(await lstat(dir)).isDirectory() || await realpath(dir) !== join(await realpath(dirname(dir)), 'icons')) throw new Error('图标目录无效');
  if (windows.on) return withLock(dir, () => installWindowsIcons(dir, windows.folders));
  await withLock(dir, async () => {
    for (const [name, source] of Object.entries(iconSources)) {
      const target = join(dir, name + '.png'), input = join(apps, source);
      try { await access(target); continue; } catch (e) { if (!hasCode(e, 'ENOENT')) throw e; }
      try { await access(input); } catch (e) { if (hasCode(e, 'ENOENT')) continue; throw e; }
      const tmp = join(dir, `.${name}.${randomUUID()}.png`);
      try {
        await new Promise<void>((resolve, reject) => {
          const child = spawn(sips, ['-s', 'format', 'png', '-Z', '96', input, '--out', tmp], { stdio: 'ignore', env: externalEnvironment() });
          child.on('error', reject);
          child.on('close', code => code === 0 ? resolve() : reject(new Error(`sips 退出码 ${code}`)));
        });
        await writeAtomic(target, await readFile(tmp));
      } catch (e) { console.error(`导出 ${name} 图标失败：${(e as Error).message}，应用将显示字母。`); }
      finally { await rm(tmp, { force: true }); }
    }
  });
}

// 包里的图本来就是 PNG，原样复制（不缩放：界面按尺寸画，文件大小有上限）。只认普通文件、是 PNG、不超过上限；
// 不对就跳过，界面显示字母。
async function installWindowsIcons(dir: string, folders: (family: string) => string[]) {
  for (const [name, source] of Object.entries(windowsIconSources)) {
    const target = join(dir, name + '.png');
    try { await access(target); continue; } catch (e) { if (!hasCode(e, 'ENOENT')) throw e; }
    try {
      const folder = folders(source.family).at(-1);
      if (!folder) continue;
      const input = join(folder, source.file);
      const info = await lstat(input).catch(e => { if (hasCode(e, 'ENOENT')) return null; throw e; });
      if (!info) continue;
      if (!info.isFile() || info.size > MAX_ICON) throw new Error('不是普通文件或太大');
      const bytes = await readFile(input);
      if (!bytes.subarray(0, 8).equals(PNG)) throw new Error('不是 PNG');
      await writeAtomic(target, bytes);
    } catch (e) { console.error(`导出 ${name} 图标失败：${(e as Error).message}，应用将显示字母。`); }
  }
}
