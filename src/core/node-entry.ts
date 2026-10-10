// 只作为独立脚本执行，不能导入桌面后台（这里动态载入的目标来自平台启动参数）。
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [, , script, ...args] = process.argv;
if (!script) throw new Error('缺少平台脚本路径。');
delete process.env.ELECTRON_RUN_AS_NODE;
// 告诉被加载的脚本“这是用 Electron 程序在跑一个脚本”（Electron 自己的约定：defaultApp 为真时 argv[1] 是脚本路径）。
// 不设的话，按 Electron 惯例解析参数的库（srt 用的 commander）会把脚本路径当成第一个用户参数：
// srt 于是把它自己当成要隔离的命令，在隔离里又套一层自己（2026-10-10 真实自检抓到，Grok / Cursor 两类隔离的探针全挂）。
(process as { defaultApp?: boolean }).defaultApp = true;
process.argv = [process.execPath, resolve(script), ...args];
await import(pathToFileURL(resolve(script)).href);
