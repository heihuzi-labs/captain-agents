// 临时脚本：真的启动打包好的应用，确认它是什么芯片的程序、主窗口能出来，并截图。
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron } from 'playwright-core';
const [app, shot] = process.argv.slice(2);
const temp = await mkdtemp(join(tmpdir(), 'xa-x64-'));
const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === 'string'));
delete env.ELECTRON_RUN_AS_NODE;
const electron = await _electron.launch({ executablePath: join(app, 'Contents/MacOS/派活工作台'), args: [], env: { ...env, XAGENTS_HOME: join(temp, 'registry'), XAGENTS_USER_DATA: join(temp, 'electron') } });
try {
  const page = await electron.firstWindow();
  await page.waitForSelector('[data-testid="running"]', { timeout: 60_000 });
  console.log('主进程：', await electron.evaluate(() => `${process.platform}-${process.arch}，Electron ${process.versions.electron}`));
  await page.getByRole('button', { name: '设置' }).click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: shot, animations: 'disabled' });
  console.log('窗口正常打开，已截图。临时目录：' + temp);
} finally { await electron.close().catch(() => {}); }
