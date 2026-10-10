import { join } from 'node:path';
import { toolRoot } from './paths.ts';

type NodeProcess = { execPath: string; versions: { [name: string]: string | undefined } };

// 运行时开关只属于平台。和选手的密钥过滤规则分开，不能改变 env.ts 的规则。
export function externalEnvironment(inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...inherited };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

export function nodeRunner(inherited: NodeJS.ProcessEnv = process.env, runtime: NodeProcess = process) {
  const env = externalEnvironment(inherited);
  if (runtime.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
  return { file: runtime.execPath, env };
}

// Electron 先用开关进入 Node，再由入口清掉开关、原样执行脚本；srt 的后代因此不会继承它。
export function nodeCommand(args: string[], inherited: NodeJS.ProcessEnv = process.env, runtime: NodeProcess = process) {
  return { ...nodeRunner(inherited, runtime),
    args: runtime.versions.electron ? [join(toolRoot, 'src/core/node-entry.ts'), ...args] : args };
}

// 给 Codex/srt 的探针命令使用：仅让里面的 Node 带开关，外面的选手程序不带。
export function nodeInvocation(args: string[], runtime: NodeProcess = process) {
  const cmd = nodeCommand(args, {}, runtime);
  return [...(runtime.versions.electron ? ['/usr/bin/env', 'ELECTRON_RUN_AS_NODE=1'] : []), cmd.file, ...cmd.args];
}
