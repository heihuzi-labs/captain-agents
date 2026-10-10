import { externalEnvironment } from './node-runtime.ts';
// 只用于主人打开联网总开关的任务。关着时仍走原来的 srt CLI。
// srt 0.0.77 的 CLI 强制要求 allowedDomains；库的 wrapWithSandbox 则以它是否存在
// 决定网络限制（sandbox-manager.js:1331）。不调用 initialize：它会另起代理。
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function wrapOpenCommand(srt: string, settings: unknown, args: string[]) {
  // srt 可以由 XAGENTS_SRT 指定；从同一 dist 目录加载库。运行时快照无需复制 node_modules。
  const runtime: typeof import('@anthropic-ai/sandbox-runtime') = await import(pathToFileURL(join(dirname(srt), 'index.js')).href);
  // 文件配置沿用 CLI 的校验和默认值；删掉仅为通过 schema 校验填的网络部分。
  const { network: _network, ...config } = runtime.SandboxRuntimeConfigSchema.parse({
    ...(settings as object), network: { allowedDomains: [], deniedDomains: [] },
  });
  if (!args.length) throw new Error('缺少选手命令。');
  const quoted = args.map(arg => "'" + arg.replaceAll("'", "'\\''") + "'").join(' ');
  return { command: await runtime.SandboxManager.wrapWithSandbox(quoted, undefined, config),
    cleanup: () => runtime.SandboxManager.cleanupAfterCommand() };
}

async function main() {
  const [srt, flag, file, ...args] = process.argv.slice(2);
  if (!srt || flag !== '--settings' || !file) throw new Error('联网隔离启动参数不对。');
  const settings = JSON.parse(await readFile(file, 'utf8'));
  const wrapped = await wrapOpenCommand(srt, settings, args);
  // 保持在看管进程创建的选手进程组中，停止和异常兜底会连同后代一起收尾。
  const child = spawn('/bin/sh', ['-c', wrapped.command], { stdio: 'inherit', env: externalEnvironment() });
  const stop = () => child.kill('SIGTERM');
  const interrupt = () => child.kill('SIGINT');
  process.on('SIGTERM', stop); process.on('SIGINT', interrupt);
  try {
    process.exitCode = await new Promise<number>((done, fail) => {
      child.once('error', fail);
      child.once('close', code => done(code ?? 1));
    });
  } finally {
    process.off('SIGTERM', stop); process.off('SIGINT', interrupt);
    wrapped.cleanup();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(`联网隔离启动失败：${(error as Error).message}`); process.exitCode = 1; });
}
