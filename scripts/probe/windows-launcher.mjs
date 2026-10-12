// 探针：应用装出来的命令行启动脚本（app/main/cli-launcher.ts 写的那两个文件）在 Windows 的几种终端里起不起得来。
// 起因：程序文件名是中文，而命令提示符按系统代码页读 .cmd 文件（docs/design-windows.md 第 11.1 节）。
// 用法：node scripts/probe/windows-launcher.mjs <打包后应用的可执行文件> <结果文件>
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { launcherFiles } from '../../app/main/cli-launcher.ts';

const [exe, resultFile] = process.argv.slice(2);
if (!exe || !resultFile) { console.error('用法：windows-launcher.mjs <可执行文件> <结果文件>'); process.exit(1); }
const executable = path.resolve(exe), platform = path.join(path.dirname(executable), 'resources', 'platform');
const bin = await fs.mkdtemp(path.join(os.tmpdir(), 'xa-launcher-'));
const files = launcherFiles({ home: os.homedir(), executable, platform, windows: true, binDir: bin });
for (const file of files) await fs.writeFile(file.path, file.content);

const env = { ...process.env, XAGENTS_HOME: path.join(bin, 'registry') };
delete env.ELECTRON_RUN_AS_NODE;
const run = (file, args) => {
  const r = spawnSync(file, args, { env, encoding: 'utf8', timeout: 60_000, windowsHide: true });
  return { exit: r.status, error: r.error?.message ?? null, stdout: (r.stdout ?? '').slice(0, 300), stderr: (r.stderr ?? '').slice(0, 300) };
};
const cmd = path.join(bin, 'xagents.cmd'), sh = path.join(bin, 'xagents').replaceAll('\\', '/');
const result = { executable, nonAscii: /[^\x00-\x7f]/.test(executable), cases: {
  '当前代码页': run('cmd.exe', ['/d', '/c', 'chcp']),
  '命令提示符（当前代码页）': run('cmd.exe', ['/d', '/c', cmd, '--help']),
  '命令提示符（简体中文代码页 936）': run('cmd.exe', ['/d', '/c', `chcp 936 >nul & "${cmd}" --help`]),
  '命令提示符（代码页 65001）': run('cmd.exe', ['/d', '/c', `chcp 65001 >nul & "${cmd}" --help`]),
  'PowerShell': run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `& '${cmd}' --help; exit $LASTEXITCODE`]),
  'Git 的终端': run('bash.exe', ['-lc', `'${sh}' --help`]),
} };
for (const [name, r] of Object.entries(result.cases)) console.log(`[${name}] 退出码 ${r.exit}${r.error ? `（${r.error}）` : ''}：${(r.stdout || r.stderr).split(/\r?\n/)[0]}`);
await fs.mkdir(path.dirname(path.resolve(resultFile)), { recursive: true });
await fs.writeFile(resultFile, JSON.stringify(result, null, 2));
await fs.rm(bin, { recursive: true, force: true }).catch(() => {});
