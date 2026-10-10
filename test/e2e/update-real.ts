// 负责人做在线更新的真实验收（docs/design-update.md 第 7 节、docs/release-checklist.md）：
// 真的启动一个打包好的“旧版”应用，点检查更新 → 下载并安装 → 重启以完成更新，核对它在原位置变成了“新版”，并截图。
// 不进 verify：要先按发布清单用测试密钥打好旧版、新版和签名清单，并起好本机测试下载站（test/e2e/update-site.ts）。
// 用法：node test/e2e/update-real.ts <旧版应用.app> <期望的新版本号> <下载站目录> <测试证书的 CA.pem> <输出目录>
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { _electron } from 'playwright-core';

const run = promisify(execFile);
const [appPath, wanted, site, ca, out] = process.argv.slice(2);
if (!appPath || !wanted || !site || !ca || !out) { console.error('用法：update-real.ts <旧版应用.app> <新版本号> <下载站目录> <CA.pem> <输出目录>'); process.exit(1); }
const app = resolve(appPath), output = resolve(out);
const version = async () => (await run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', join(app, 'Contents/Info.plist')])).stdout.trim();
const temp = await mkdtemp(join(tmpdir(), 'xa-update-real-'));
await mkdir(output, { recursive: true });
const before = await version();
assert.notEqual(before, wanted, '旧版和新版的版本号不能一样');
const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === 'string'));
delete env.ELECTRON_RUN_AS_NODE;
const userData = join(temp, 'electron');
const electron = await _electron.launch({ executablePath: join(app, 'Contents/MacOS/派活工作台'), args: [],
  env: { ...env, XAGENTS_HOME: join(temp, 'registry'), XAGENTS_USER_DATA: userData, NODE_EXTRA_CA_CERTS: resolve(ca) } });
let closed = false;
electron.on('close', () => { closed = true; });
try {
  const page = await electron.firstWindow();
  await page.waitForSelector('[data-testid="running"]');
  await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1100, 800));
  const shot = async (name: string) => { await page.waitForTimeout(250); await page.screenshot({ animations: 'disabled', path: join(output, `update-${name}.png`) }); };
  await page.getByRole('button', { name: '设置' }).click();
  const group = page.getByRole('region', { name: '更新' });
  await group.scrollIntoViewIfNeeded();
  assert.equal(await group.getByText(before, { exact: true }).count(), 1, '设置里写着当前版本');
  await shot('1-settings-before');
  // 包被改坏一个字节：不安装，说明原因，应用照旧。
  await writeFile(join(site, 'corrupt'), '');
  await group.getByRole('button', { name: '检查更新' }).click();
  await group.getByText(`有新版本 ${wanted}`).waitFor({ timeout: 30_000 });
  await group.getByRole('button', { name: '查看' }).click();
  const dialog = page.getByRole('dialog', { name: '更新' });
  await dialog.getByText(`派活工作台 ${wanted}`).waitFor();
  assert.equal(await dialog.locator('.update-notes b').count(), 0, '更新说明当纯文字显示');
  await shot('2-available');
  await dialog.getByRole('button', { name: '下载并安装' }).click();
  await dialog.getByRole('alert').waitFor({ timeout: 180_000 });
  const reason = await dialog.getByRole('alert').first().textContent();
  assert.match(reason ?? '', /和发布的不一致|没通过核对|没有安装/, '改坏的包被拒绝：' + reason);
  await shot('3-corrupt-rejected');
  assert.equal(await version(), before, '被拒绝后应用没有被动过');
  // 换回好的包：重新检查 → 下载（看得到进度）→ 就绪。
  await rm(join(site, 'corrupt'));
  await dialog.getByRole('button', { name: '重新检查' }).click();
  await dialog.getByRole('button', { name: '下载并安装' }).waitFor({ timeout: 30_000 });
  await dialog.getByRole('button', { name: '下载并安装' }).click();
  await dialog.getByRole('progressbar', { name: '下载进度' }).waitFor({ timeout: 30_000 });
  await page.waitForTimeout(1200);
  await shot('4-downloading');
  // 等到“就绪”或者报错，二者先到为准；报错就把原因打出来。
  const ready = dialog.getByRole('button', { name: '重启以完成更新' }), failed = dialog.getByRole('alert');
  await ready.or(failed).first().waitFor({ timeout: 300_000 });
  if (await failed.count()) { await shot('5-failed'); assert.fail('下载后没能就绪：' + await failed.first().textContent()); }
  await shot('5-ready');
  assert.equal(await version(), before, '没点重启之前应用不会自己换');
  await dialog.getByRole('button', { name: '重启以完成更新' }).click();
  // 应用退出，独立的小程序把新版换到原位置并重新打开。
  for (let i = 0; i < 300 && (!closed || await version() !== wanted); i++) await sleep(500);
  assert.ok(closed, '点了重启后旧应用退出了');
  assert.equal(await version(), wanted, '原位置已经是新版');
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  console.log(`通过：${before} → ${wanted}，原位置的应用签名核对通过。安装日志在 ${join(userData, 'updates')}`);
} finally {
  if (!closed) await electron.close().catch(() => {});
  console.log('临时目录（含安装日志）：' + temp);
}
