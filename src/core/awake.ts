import { externalEnvironment } from './node-runtime.ts';
import { spawn } from 'node:child_process';
import { readSettings } from './settings.ts';

// -w 让系统在看管进程意外退出时也释放防休眠；正常收尾再主动关闭。
// 整段包住：防休眠的任何失败都不能传出去，否则看管进程会收尾并强制结束选手。
export async function keepAwake(): Promise<() => Promise<void>> {
  const noop = async () => {};
  try {
    let enabled = true;
    try { enabled = (await readSettings()).keepAwake; }
    catch (error) { console.error(`读取防休眠设置失败：${(error as Error).message}。按开启处理，任务继续执行。`); }
    if (!enabled) return noop;
    const child = spawn(process.env.XAGENTS_CAFFEINATE || 'caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore', env: externalEnvironment() });
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
    const started = await new Promise<boolean>(resolve => {
      child.once('spawn', () => resolve(true));
      child.once('error', () => {
        console.error('无法启动 caffeinate，任务继续执行，本次不阻止空闲休眠。');
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
