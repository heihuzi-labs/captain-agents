// 构建流水线用：真的启动刚打好的应用，确认它是给这种系统和芯片的、主窗口能打开、自带的平台在包里。
// 用临时的登记处和应用数据目录，不碰这台机器上真实的数据。不进 verify。
// 用法：node test/e2e/packaged.ts <应用的可执行文件> <期望的系统-芯片，如 darwin-x64> [截图路径]
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { _electron } from 'playwright-core';

const [executable, expected, shot] = process.argv.slice(2);
if (!executable || !expected) { console.error('用法：packaged.ts <应用的可执行文件> <期望的系统-芯片> [截图路径]'); process.exit(1); }
const temp = await mkdtemp(join(tmpdir(), 'xa-packaged-'));
const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === 'string'));
delete env.ELECTRON_RUN_AS_NODE;
const electron = await _electron.launch({ executablePath: executable, args: [],
  env: { ...env, XAGENTS_HOME: join(temp, 'registry'), XAGENTS_USER_DATA: join(temp, 'electron') } });
try {
  const info = await electron.evaluate(({ app }) => ({ target: `${process.platform}-${process.arch}`, version: app.getVersion(), packaged: app.isPackaged, resources: process.resourcesPath }));
  assert.equal(info.target, expected, '应用是给这种系统和芯片的');
  assert.equal(info.packaged, true, '启动的是打包好的应用');
  for (const name of ['bin/xagents', 'src/cli/cli.ts', 'guide/commander.md', 'node_modules/@anthropic-ai/sandbox-runtime/dist/cli.js']) await stat(join(info.resources, 'platform', name));
  const page = await electron.firstWindow();
  await page.waitForSelector('[data-testid="running"]', { timeout: 90_000 });
  if (shot) await page.screenshot({ path: shot, animations: 'disabled' });
  console.log(`通过：${info.target}，版本 ${info.version}，主窗口正常打开，自带的平台在包里。`);
} finally {
  await electron.close().catch(() => {});
  await rm(temp, { recursive: true, force: true }).catch(() => {});
}
