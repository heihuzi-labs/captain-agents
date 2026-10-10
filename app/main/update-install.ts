import { execFile, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { checkUpdateZip } from './update-zip.ts';

const execute = promisify(execFile);
// 查看和清理“解开的新版应用”用的文件函数，可以换。原因（2026-10-10 真实验收抓到）：在 Electron 的后台进程里，
// Node 的文件函数会把路径里的 .asar 当成虚拟目录——解开的新版里正好有一个 app.asar，逐个文件检查会走进去出错，
// 清理时删到一半又报错，留下半截目录。应用后台要传 Electron 提供的 original-fs（不带这层处理）；普通 Node 下用缺省的就行。
export type UpdateFiles = { lstat: typeof lstat; readdir(path: string): Promise<string[]>; realpath(path: string): Promise<string>; rm: typeof rm; mkdir: typeof mkdir };
const nodeFiles: UpdateFiles = { lstat, readdir: path => readdir(path), realpath: path => realpath(path), rm, mkdir };
export type UpdateCommand = (file: string, args: string[]) => Promise<string>;
export const updateCommand: UpdateCommand = async (file, args) => (await execute(file, args, { timeout: 120_000, maxBuffer: 1024 * 1024, encoding: 'utf8' })).stdout.trim();
export const UPDATE_APP_ID = 'app.xagents.desk';
export async function installationTarget(executable: string, packaged: boolean, platform: string): Promise<{ path?: string; reason?: string }> {
  if (!packaged) return { reason: '这个版本不带在线更新' };
  if (platform !== 'darwin') return { reason: '这个平台暂不支持在线更新' };
  const app = dirname(dirname(dirname(executable)));
  if (!isAbsolute(executable) || !app.endsWith('.app') || dirname(executable) !== join(app, 'Contents/MacOS') || app.includes('/AppTranslocation/')) return { reason: '应用没有装在正常的 .app 目录里，请手动安装。' };
  try {
    if ((await lstat(app)).isSymbolicLink() || await realpath(app) !== app) return { reason: '应用路径含有符号链接，请手动安装。' };
    await access(dirname(app), constants.W_OK | constants.X_OK);
    await access(app, constants.W_OK | constants.X_OK);
    return { path: app };
  } catch { return { reason: '应用所在目录没有写权限，请手动下载安装。' }; }
}
export async function verifyUpdateApp(app: string, version: string, run: UpdateCommand = updateCommand): Promise<void> {
  if (!(await lstat(app)).isDirectory() || (await lstat(join(app, 'Contents/Info.plist'))).isSymbolicLink()) throw new Error('更新包不是正常的应用。');
  const plist = join(app, 'Contents/Info.plist');
  if (await run('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', plist]) !== UPDATE_APP_ID) throw new Error('更新包的应用标识不符，没有安装。');
  if (await run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plist]) !== version) throw new Error('更新包的版本与清单不符，没有安装。');
  try { await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]); }
  catch { throw new Error('更新包的应用签名没通过核对，没有安装。'); }
}
export async function prepareUpdate(zip: string, directory: string, version: string, run: UpdateCommand = updateCommand, files: UpdateFiles = nodeFiles): Promise<string> {
  const stage = join(directory, 'unpacked');
  try {
    await files.rm(stage, { recursive: true, force: true });
    await checkUpdateZip(zip);
    await files.mkdir(stage, { mode: 0o700 });
    await run('/usr/bin/ditto', ['-x', '-k', zip, stage]);
    const names = (await files.readdir(stage)).filter(n => n !== '__MACOSX');
    if (names.length !== 1 || !names[0].endsWith('.app')) throw new Error('更新包必须只包含一个 .app 应用。');
    const app = join(stage, names[0]);
    // 解压后再检查链接；Frameworks 的内部相对链接可用，指向包外的不可用。
    // 比的是“解析后的真实路径”：数据目录本身可能在符号链接后面（比如 /var → /private/var），应用的根也要先解析（2026-10-10 真实验收抓到）。
    const root = await files.realpath(app);
    async function checkTree(path: string): Promise<void> {
      const stat = await files.lstat(path);
      if (stat.isSymbolicLink()) {
        if (!(await files.realpath(path)).startsWith(root + sep)) throw new Error('更新包含有指向应用外的链接。');
      } else if (stat.isDirectory()) for (const name of await files.readdir(path)) await checkTree(join(path, name));
      else if (!stat.isFile()) throw new Error('更新包含有不支持的文件。');
    }
    await checkTree(app);
    await verifyUpdateApp(app, version, run);
    return app;
  } catch (error) {
    // 清理失败不能盖住真正的原因；清不掉的残留下次准备时会再清一遍。
    await files.rm(stage, { recursive: true, force: true }).catch(() => {});
    throw new Error(error instanceof Error && /^[\u3400-\u9fff]/u.test(error.message) ? error.message : '更新包没能解开或没通过核对，没有安装。');
  } finally { await rm(zip, { force: true }); }
}
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
// 生产只用绝对系统命令；替身仅通过测试中的函数参数注入，不读环境变量或桥参数。
export function installerScript(commands: Partial<Record<'codesign' | 'open' | 'ditto' | 'mv' | 'plutil', string>> = {}): string {
  return `#!/bin/bash
set -euo pipefail
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
codesign=${quote(commands.codesign ?? '/usr/bin/codesign')}
open_app=${quote(commands.open ?? '/usr/bin/open')}
ditto=${quote(commands.ditto ?? '/usr/bin/ditto')}
move=${quote(commands.mv ?? '/bin/mv')}
plutil=${quote(commands.plutil ?? '/usr/bin/plutil')}
installed="$1"
staged="$2"
trash="$3"
pid="$4"
version="$5"
backup=''
candidate=''
base="$(/usr/bin/basename "$installed")"
verify_app() {
  [[ "$("$plutil" -extract CFBundleIdentifier raw -o - "$1/Contents/Info.plist")" == 'app.xagents.desk' ]]
  [[ "$("$plutil" -extract CFBundleShortVersionString raw -o - "$1/Contents/Info.plist")" == "$version" ]]
  "$codesign" --verify --deep --strict "$1"
}
rollback() {
  local status="$?"
  trap - EXIT HUP INT TERM
  if [[ "$status" != 0 ]]; then
    printf '更新失败，正在恢复旧应用。\\n' >&2
    if [[ -n "$candidate" && -d "$candidate/old.app" ]]; then
      if [[ -e "$installed" ]]; then "$move" "$installed" "$candidate/failed.app" || { printf '无法移开失败版本；旧版保存在：%s\\n' "$candidate/old.app" >&2; exit 1; }; fi
      "$move" "$candidate/old.app" "$installed" || { printf '回退失败，旧版保存在：%s\\n' "$candidate/old.app" >&2; exit 1; }
    fi
    "$open_app" "$installed" || true
  fi
  if [[ -n "$candidate" && "$candidate" == "$(/usr/bin/dirname "$installed")"/.xagents-update-* ]]; then /bin/rm -rf "$candidate"; fi
  exit "$status"
}
trap rollback EXIT
trap 'exit 1' HUP INT TERM
[[ "$pid" =~ ^[1-9][0-9]*$ && "$installed" == /*.app && "$staged" == /*.app && "$installed" != "$staged" && -d "$installed" && -d "$staged" ]]
for ((attempt=0; attempt<300; attempt++)); do
  if ! kill -0 "$pid" 2>/dev/null; then break; fi
  /bin/sleep 0.2
done
if kill -0 "$pid" 2>/dev/null; then printf '应用没有退出，未替换。\\n' >&2; exit 1; fi
# 先在安装目录同一文件系统准备完整新副本，复制失败时旧应用还在原位。
candidate="$(/usr/bin/mktemp -d "$(/usr/bin/dirname "$installed")/.xagents-update-XXXXXXXX")"
"$ditto" "$staged" "$candidate/new.app"
verify_app "$candidate/new.app"
/bin/mkdir -p "$trash"
backup="$(/usr/bin/mktemp -d "$trash/派活工作台-更新-XXXXXXXX")"
# 废纸篓可能在另一块卷：先完整复制并验签，再在原卷原子改名，回退不依赖跨卷搬运。
"$ditto" "$installed" "$backup/$base"
"$codesign" --verify --deep --strict "$backup/$base"
"$move" "$installed" "$candidate/old.app"
"$move" "$candidate/new.app" "$installed"
verify_app "$installed"
"$open_app" "$installed"
printf '更新完成；旧版保存在：%s\\n' "$backup"
`;
}
export async function launchUpdateInstaller(options: { directory: string; installed: string; staged: string; trash: string; pid: number; version: string }): Promise<void> {
  if (resolve(options.installed) === resolve(options.staged)) throw new Error('更新应用与当前应用不能是同一个目录。');
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  // 每次重启有独立脚本与日志；脱离应用本身，不依赖即将被移动的 Electron 运行时。
  const job = await mkdtemp(join(options.directory, 'install-'));
  const script = join(job, 'restart.sh');
  await writeFile(script + '.part', installerScript(), { mode: 0o700, flag: 'wx' });
  await rename(script + '.part', script);
  const log = await open(join(job, 'result.log'), 'a', 0o600);
  try {
    const child = spawn('/bin/bash', [script, options.installed, options.staged, options.trash, String(options.pid), options.version], {
      detached: true, cwd: job, stdio: ['ignore', log.fd, log.fd], env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
    });
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
  } finally { await log.close(); }
}
