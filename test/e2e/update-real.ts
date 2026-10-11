// 负责人做在线更新的真实验收（docs/design-update.md 第 7 节、docs/release-checklist.md）：
// 真的启动一个打包好的“旧版”应用，先走一遍出毛病的情形，再点检查更新 → 下载并安装 → 重启以完成更新，
// 核对它在原位置变成了“新版”，并截图。
// 要起两个本机测试下载站（test/e2e/update-site.ts）：一个当共用下载桶，一个当发布页；旧版打包时清单地址写“桶,发布页”，
// 清单里每个包的地址也是先桶后发布页。两个站的目录里都放 latest-v2.json、新版 zip，
// 和一份版本等于旧版的 latest-v2-same.json（同一把测试密钥签的）。
// 走的情形：两处清单都签名不对 → 报错；只有桶里的清单坏 → 换发布页的；桶里的清单不比现在新 → 不再去问发布页；
// 两处的包都被改坏 → 拒绝；最后按环境变量 XA_REAL_CASE 走一条成功的路：
//   switch（缺省）：桶很慢、发布页正常 → 自动换发布页下完；
//   retry：桶很慢、发布页传到一半就断 → 回头把桶里的下完（要十来分钟）。
// 不进 verify：要先按发布清单用测试密钥打好旧版、新版和签名清单。
// 用法：node test/e2e/update-real.ts <旧版应用.app> <期望的新版本号> <桶站目录> <发布页站目录> <测试证书的 CA.pem> <输出目录>
// 发版后从公网实测：两个站目录和 CA 都写 -（旧版应用要用正式公钥和正式地址打包），这时跳过出毛病的情形，只走一遍真的检查、下载、重启。
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { _electron } from 'playwright-core';

const run = promisify(execFile);
const [appPath, wanted, store, site, ca, out] = process.argv.slice(2);
if (!appPath || !wanted || !store || !site || !ca || !out) { console.error('用法：update-real.ts <旧版应用.app> <新版本号> <桶站目录> <发布页站目录> <CA.pem> <输出目录>'); process.exit(1); }
const app = resolve(appPath), output = resolve(out), live = site === '-', retry = process.env.XA_REAL_CASE === 'retry';
// 两个站各自的 requests.log：看某个文件在这个站被要过几次、传完过几次。
const requests = async (dir: string, line: string) => (await readFile(join(dir, 'requests.log'), 'utf8').catch(() => '')).split('\n').filter(l => l === line).length;
const mark = async (dir: string, name: string) => writeFile(join(dir, name), '');
const version = async () => (await run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', join(app, 'Contents/Info.plist')])).stdout.trim();
const temp = await mkdtemp(join(tmpdir(), 'xa-update-real-'));
let zipFile = '';
const zipName = () => zipFile;
if (!live) { const zips = (await readdir(site)).filter(name => name.endsWith('.zip')); assert.equal(zips.length, 1, '发布页站目录里要有且只有一个 zip'); zipFile = zips[0]; }
await mkdir(output, { recursive: true });
const before = await version();
assert.notEqual(before, wanted, '旧版和新版的版本号不能一样');
const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === 'string'));
delete env.ELECTRON_RUN_AS_NODE;
const userData = join(temp, 'electron');
const electron = await _electron.launch({ executablePath: join(app, 'Contents/MacOS/派活工作台'), args: [],
  env: { ...env, XAGENTS_HOME: join(temp, 'registry'), XAGENTS_USER_DATA: userData, ...(ca === '-' ? {} : { NODE_EXTRA_CA_CERTS: resolve(ca) }) } });
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
  if (!live) {
    for (const dir of [store, site]) for (const name of ['badsig', 'same', 'corrupt', 'cut', 'slow', 'requests.log']) await rm(join(dir, name), { force: true });
    // 两处的清单正文都被改过（签名对不上）：报原因，不当成有新版本。
    await mark(store, 'badsig'); await mark(site, 'badsig');
    await group.getByRole('button', { name: '检查更新' }).click();
    await group.getByText(/签名不对/).waitFor({ timeout: 30_000 });
    assert.equal(await group.getByText(`有新版本 ${wanted}`).count(), 0, '签名对不上的清单不算新版本');
    assert.equal(await requests(site, '开始 latest-v2.json'), 1, '桶里的清单不能用时去问了发布页');
    await shot('1a-bad-signature');
    // 清单里的版本不比现在新：写“已是最新版本”，不动；桶里的清单核对通过了，就不再去问发布页。
    await rm(join(store, 'badsig')); await mark(store, 'same');
    await group.getByRole('button', { name: '检查更新' }).click();
    await group.getByText(/已是最新版本/).waitFor({ timeout: 30_000 });
    assert.equal(await requests(site, '开始 latest-v2.json'), 1, '桶里的清单能用时没有再去问发布页');
    await shot('1b-not-newer');
    // 只有桶里的清单是坏的：换发布页的那一份，照常看到新版本（下面接着用这个状态）。
    await rm(join(store, 'same')); await mark(store, 'badsig'); await rm(join(site, 'badsig'));
  }
  // 两处的包都被改坏一个字节：不安装，说明原因，应用照旧。
  if (!live) { await mark(store, 'corrupt'); await mark(site, 'corrupt'); }
  await group.getByRole('button', { name: '检查更新' }).click();
  await group.getByText(`有新版本 ${wanted}`).waitFor({ timeout: 30_000 });
  await group.getByRole('button', { name: '查看' }).click();
  const dialog = page.getByRole('dialog', { name: '更新' });
  await dialog.getByText(`派活工作台 ${wanted}`).waitFor();
  assert.equal(await dialog.locator('.update-notes b').count(), 0, '更新说明当纯文字显示');
  await shot('2-available');
  if (!live) {
    await dialog.getByRole('button', { name: '下载并安装' }).click();
    await dialog.getByRole('alert').waitFor({ timeout: 180_000 });
    const reason = await dialog.getByRole('alert').first().textContent();
    assert.match(reason ?? '', /和发布的不一致|没通过核对|没有安装/, '改坏的包被拒绝：' + reason);
    await shot('3-corrupt-rejected');
    assert.equal(await version(), before, '被拒绝后应用没有被动过');
    const leftovers = async () => (await readdir(join(userData, 'updates')).catch(() => [])).filter(name => /\.part$|\.zip$|^unpacked$/.test(name));
    assert.deepEqual(await leftovers(), [], '被拒绝的包没有留下半成品');
    assert.ok(await requests(store, '开始 ' + zipName()) >= 1 && await requests(site, '开始 ' + zipName()) >= 1, '桶里的包不对时去发布页试过');
    // 两处的包都传到一半断开：说明原因，不留半个包，应用照旧。
    for (const dir of [store, site]) { await rm(join(dir, 'corrupt')); await mark(dir, 'cut'); }
    await dialog.getByRole('button', { name: '重新检查' }).click();
    await dialog.getByRole('button', { name: '下载并安装' }).waitFor({ timeout: 30_000 });
    await dialog.getByRole('button', { name: '下载并安装' }).click();
    await dialog.getByRole('alert').filter({ hasText: /中断|连接失败/ }).waitFor({ timeout: 180_000 });
    await shot('3a-download-cut');
    assert.equal(await version(), before, '下载断开后应用没有被动过'); assert.deepEqual(await leftovers(), [], '下载断开没有留下半个包');
    // 最后走一条成功的路：桶很慢；发布页正常（switch），或者发布页传到一半就断（retry，回头把桶里的下完）。
    await rm(join(store, 'cut')); await mark(store, 'slow');
    if (!retry) await rm(join(site, 'cut'));
    await rm(join(store, 'requests.log'), { force: true }); await rm(join(site, 'requests.log'), { force: true });
  }
  if (!live) {
    await dialog.getByRole('button', { name: '重新检查' }).click();
    await dialog.getByRole('button', { name: '下载并安装' }).waitFor({ timeout: 30_000 });
  }
  await dialog.getByRole('button', { name: '下载并安装' }).click();
  await dialog.getByRole('progressbar', { name: '下载进度' }).waitFor({ timeout: 30_000 });
  await page.waitForTimeout(1200);
  await shot('4-downloading');
  // 等到“就绪”或者报错，二者先到为准；报错就把原因打出来。
  const ready = dialog.getByRole('button', { name: '重启以完成更新' }), failed = dialog.getByRole('alert');
  await ready.or(failed).first().waitFor({ timeout: live || retry ? 1_500_000 : 300_000 });
  if (await failed.count()) { await shot('5-failed'); assert.fail('下载后没能就绪：' + await failed.first().textContent()); }
  await shot('5-ready');
  if (!live) {
    // 包是从哪个站下完的：switch 是发布页（桶太慢被放下），retry 是桶（发布页断了以后回头再试）。
    const zip = zipName(), fromStore = await requests(store, '传完 ' + zip), fromSite = await requests(site, '传完 ' + zip);
    assert.ok(await requests(store, '开始 ' + zip) >= 1 && await requests(site, '开始 ' + zip) >= 1, '两个站都被试过');
    if (retry) { assert.equal(await requests(store, '开始 ' + zip), 2, '回头又试了一次桶'); assert.equal(fromStore, 1, '包是从桶里下完的'); assert.equal(fromSite, 0); }
    else { assert.equal(fromSite, 1, '包是从发布页下完的'); assert.equal(fromStore, 0, '桶太慢，没等它下完'); }
  }
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
