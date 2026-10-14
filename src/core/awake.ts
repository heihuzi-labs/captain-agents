import { externalEnvironment, nodeCommand } from './node-runtime.ts';
import { spawn } from 'node:child_process';
import { readSettings } from './settings.ts';
import { isWindows } from './platform.ts';
import { holdAwake } from './native-windows.ts';

// 防休眠。两种系统都做到“看管进程一退，防休眠就放开”，看管进程意外退出时也一样。
// macOS：起一个帮手 caffeinate -i -w <进程号>，它盯着看管进程，看管进程一退它就退。
// Windows：看管进程自己向系统申请“别因空闲休眠”（native-windows.ts 的 holdAwake），不起帮手；申请挂在看管进程的主线程上，进程一没申请就没了。
// XAGENTS_CAFFEINATE 换成别的程序（测试用，两种系统都认）；给的是 .cjs / .mjs 脚本时用平台的 Node 来跑，参数同 caffeinate。
export function awakeCommand(pid: number, env: NodeJS.ProcessEnv = process.env): { file: string; args: string[]; env: NodeJS.ProcessEnv } {
  const args = ['-i', '-w', String(pid)], override = env.XAGENTS_CAFFEINATE;
  if (override) return /\.[cm]js$/.test(override) ? nodeCommand([override, ...args], externalEnvironment(env)) : { file: override, args, env: externalEnvironment(env) };
  return { file: 'caffeinate', args, env: externalEnvironment(env) };
}

// 正常收尾时主动关闭帮手。
// 整段包住：防休眠的任何失败都不能传出去，否则看管进程会收尾并强制结束选手。
export async function keepAwake(): Promise<() => Promise<void>> {
  const noop = async () => {};
  try {
    let enabled = true;
    try { enabled = (await readSettings()).keepAwake; }
    catch (error) { console.error(`读取防休眠设置失败：${(error as Error).message}。按开启处理，任务继续执行。`); }
    if (!enabled) return noop;
    if (isWindows && !process.env.XAGENTS_CAFFEINATE) {
      const release = holdAwake();
      return async () => {
        try { release(); }
        catch (error) { console.error(`关闭防休眠失败：${(error as Error).message}。任务继续执行。`); }
      };
    }
    const command = awakeCommand(process.pid);
    const child = spawn(command.file, command.args, { stdio: 'ignore', env: command.env, windowsHide: true });
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
    const started = await new Promise<boolean>(resolve => {
      child.once('spawn', () => resolve(true));
      child.once('error', () => {
        console.error('无法启动防休眠程序，任务继续执行，本次不阻止空闲休眠。');
        resolve(false);
      });
    });
    if (!started) { await closed; return noop; }
    return async () => {
      try {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill('SIGTERM');
        const timer = setTimeout(() => child.kill('SIGKILL'), 1000);
        try { await closed; } finally { clearTimeout(timer); }
      } catch (error) { console.error(`关闭防休眠失败：${(error as Error).message}。任务继续执行。`); }
    };
  } catch (error) {
    console.error(`防休眠出错：${(error as Error).message}。任务继续执行，本次不阻止空闲休眠。`);
    return noop;
  }
}
