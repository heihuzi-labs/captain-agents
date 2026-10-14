import fs from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { hasCode } from './fsx.ts';
import { paths } from './paths.ts';
import { isWindows } from './platform.ts';
import { recycleFolder } from './native-windows.ts';

// 换下来的东西放哪。XAGENTS_TRASH 指定时就是那个目录（测试用）。
// macOS：~/.Trash 下建一个“派活工作台-<名字>”文件夹，东西移进去。
// Windows：回收站不是一个能直接往里放东西的目录。先在登记处的 cache/trash-staging 下建同名文件夹、把东西移进去，
// 再让系统把这个文件夹整个送进回收站（主人在回收站里看到的就是这个名字；native-windows.ts 的 recycleFolder）。
export function trashPlan(env: NodeJS.ProcessEnv = process.env, windows = isWindows): { root: string; recycle: boolean } {
  if (env.XAGENTS_TRASH) return { root: resolve(env.XAGENTS_TRASH), recycle: false };
  return windows ? { root: join(paths().cache, 'trash-staging'), recycle: true } : { root: join(homedir(), '.Trash'), recycle: false };
}
// 只有跨磁盘且完整复制成功后才移除源文件；复制不跟随符号链接。
async function move(source: string, target: string): Promise<void> {
  try { await fs.rename(source, target); }
  catch (error) {
    if (!hasCode(error, 'EXDEV')) throw error;
    await fs.cp(source, target, { recursive: true, dereference: false, verbatimSymlinks: true, force: false, errorOnExist: true });
    await fs.rm(source, { recursive: true });
  }
}

export async function moveToTrash(paths: string[], label: string): Promise<string> {
  if (!label || /[/\\\0]/.test(label) || label === '.' || label === '..') throw new Error('废纸篓文件夹的名字不合法。');
  const sources = paths.map(path => resolve(path));
  if (new Set(sources.map(path => basename(path))).size !== sources.length) throw new Error('要移走的文件里有重名，请分开清理。');
  const plan = trashPlan(), trash = plan.root;
  await fs.mkdir(trash, { recursive: true });
  let folder = '';
  for (let n = 1; ; n++) {
    folder = join(trash, `派活工作台-${label}${n === 1 ? '' : ` ${n}`}`);
    try { await fs.mkdir(folder, { mode: 0o700 }); break; }
    catch (error) { if (!hasCode(error, 'EEXIST')) throw error; }
  }
  const moved: string[] = [];
  try {
    for (const source of sources) {
      await move(source, join(folder, basename(source)));
      moved.push(source);
    }
  } catch (error) {
    // 后面的文件失败，尽量放回前面已移动的文件；失败的副本仍留在废纸篓，绝不清空它。
    const failures: string[] = [];
    for (const source of moved.reverse()) {
      try { await move(join(folder, basename(source)), source); }
      catch { failures.push(basename(source)); }
    }
    throw new Error(`移到废纸篓失败：${error instanceof Error ? error.message : String(error)}。废纸篓位置：${folder}${failures.length ? `；未能放回：${failures.join('、')}` : ''}`, { cause: error });
  }
  if (plan.recycle) await recycleFolder(folder);
  return folder;
}

// 接入更新前保留原文件；目录命名、冲突处理和位置与 moveToTrash 一致。
export async function copyToTrash(paths: string[], label: string): Promise<string> {
  if (!label || /[/\\\0]/.test(label) || label === '.' || label === '..') throw new Error('废纸篓文件夹的名字不合法。');
  const sources = paths.map(path => resolve(path));
  if (new Set(sources.map(path => basename(path))).size !== sources.length) throw new Error('要备份的文件里有重名，请分开备份。');
  const plan = trashPlan(), trash = plan.root;
  await fs.mkdir(trash, { recursive: true });
  let folder = '';
  for (let n = 1; ; n++) {
    folder = join(trash, `派活工作台-${label}${n === 1 ? '' : ` ${n}`}`);
    try { await fs.mkdir(folder, { mode: 0o700 }); break; }
    catch (error) { if (!hasCode(error, 'EEXIST')) throw error; }
  }
  try {
    for (const source of sources) await fs.cp(source, join(folder, basename(source)), {
      recursive: true, dereference: false, verbatimSymlinks: true, force: false, errorOnExist: true, preserveTimestamps: true,
    });
  } catch (error) {
    throw new Error(`备份到废纸篓失败：${error instanceof Error ? error.message : String(error)}。已有副本保留在 ${folder}，原文件没有移动。`, { cause: error });
  }
  if (plan.recycle) await recycleFolder(folder);
  return folder;
}
