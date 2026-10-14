// 仅在一次性的 GitHub Windows runner 上运行；不用正式密钥，不发布。
// node test/e2e/update-windows.ts <报告目录>
// 打两份真实 NSIS 包，装到含中文、空格和 & 的自选目录，走真实窗口的更新按钮。
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { _electron } from 'playwright-core';
import { windowsExecutableVersion } from '../../app/main/update-exe.ts';
import { windowsInstallerArguments, windowsPackageName } from '../../app/main/update-windows.ts';

if (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true') throw new Error('只允许在一次性的 Windows 流水线机器运行。');
const output = resolve(process.argv[2] ?? 'update-windows-results');
await mkdir(output, { recursive: true });
const root = resolve(import.meta.dirname, '../..'), temp = await mkdtemp(join(tmpdir(), 'xa win update-'));
const oldVersion = '0.0.81', newVersion = '0.0.82';
const installed = join(temp, '中文 App & tools', 'captain-agents'), executable = join(installed, 'captain-agents.exe');
const store = join(temp, 'store'), site = join(temp, 'site'), privateKey = join(temp, 'test-key.pem'), cert = join(temp, 'localhost.pem'), tlsKey = join(temp, 'localhost-key.pem');
const notes = join(temp, 'notes.txt'), packageFile = join(root, 'package.json'), original = await readFile(packageFile);
const run = promisify(execFile), children: ReturnType<typeof spawn>[] = [];
let electron: Awaited<ReturnType<typeof _electron.launch>> | undefined;
const record: Record<string, unknown> = { oldVersion, newVersion, installed, temp, checks: [] };
const checked = (message: string) => { (record.checks as string[]).push(message); console.log(message); };
const until = async (test: () => Promise<boolean>, description: string, timeout = 180_000) => {
  const end = Date.now() + timeout;
  while (!await test()) { if (Date.now() > end) throw new Error('等待超时：' + description); await sleep(500); }
};
// 这些 PowerShell 只用于验收脚本查看真实窗口和收尾；生产更新器和安装器均不启动它。
const processes = async (stop = false) => {
  const script = "$p = @(Get-Process -Name captain-agents -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $env:XA_PROBE_EXE }); " +
    (stop ? '$p | Stop-Process -Force -ErrorAction SilentlyContinue' : '$p | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { $_.Id }');
  // 进程表里的路径是展开后的长路径（安装程序从开始菜单的快捷方式打开新版，装的位置也是展开后的）；临时目录可能是短路径名。
  const real = await realpath(executable).catch(() => executable);
  const result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, XA_PROBE_EXE: real }, windowsHide: true });
  return result.stdout.trim();
};
const start = (file: string, args: string[], env = process.env) => {
  const child = spawn(file, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let log = ''; child.stdout!.on('data', data => { log += data; }); child.stderr!.on('data', data => { log += data; });
  child.on('error', error => { log += String(error); }); children.push(child);
  return { child, log: () => log };
};
try {
  await mkdir(store); await mkdir(site);
  const keys = generateKeyPairSync('ed25519'), publicKey = Buffer.from(keys.publicKey.export({ format: 'jwk' }).x!, 'base64url').toString('base64');
  await writeFile(privateKey, keys.privateKey.export({ format: 'pem', type: 'pkcs8' })); await writeFile(notes, 'Windows 测试更新\n<b>纯文字</b>');
  await run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-keyout', tlsKey, '-out', cert, '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
  const bases = ['https://127.0.0.1:19443/', 'https://127.0.0.1:19444/'];
  const buildEnv: NodeJS.ProcessEnv = { ...process.env, XA_UPDATE_FEED: bases.map(base => base + 'latest-v2.json').join(','), XA_UPDATE_PUBLIC_KEY: publicKey, XA_UPDATE_HOSTS: '', CSC_IDENTITY_AUTO_DISCOVERY: 'false', ELECTRON_BUILDER_CACHE: join(temp, 'builder-cache') };
  delete buildEnv.ELECTRON_RUN_AS_NODE;
  const builds: Record<string, string> = {};
  for (const version of [oldVersion, newVersion]) {
    await writeFile(packageFile, JSON.stringify({ ...JSON.parse(original.toString()), version }, null, 2) + '\n');
    const result = await run(process.execPath, ['scripts/pack.mjs', 'win-x64'], { cwd: root, env: buildEnv, timeout: 20 * 60_000, maxBuffer: 16 * 1024 * 1024 }).catch(async error => {
      await writeFile(join(output, `build-${version}.log`), (error.stdout ?? '') + (error.stderr ?? '')); throw error;
    });
    await writeFile(join(output, `build-${version}.log`), result.stdout + result.stderr);
    const saved = join(temp, windowsPackageName(version)); await copyFile(join(root, 'dist', windowsPackageName(version)), saved); builds[version] = saved;
  }
  await writeFile(packageFile, original);
  await run(process.execPath, ['scripts/release/make-update.mjs', '--version', newVersion, '--minimum-version', '0.0.0', '--notes', notes, '--private-key', privateKey,
    '--package', 'win32-x64=' + builds[newVersion], '--base-url', bases[0], '--base-url', bases[1], '--out', join(store, 'latest-v2.json')], { cwd: root });
  await copyFile(join(store, 'latest-v2.json'), join(site, 'latest-v2.json'));
  for (const directory of [store, site]) await copyFile(builds[newVersion], join(directory, windowsPackageName(newVersion)));
  // 先装旧版，不自动打开；使用与生产相同的 /D 引用方式。
  await new Promise<void>((done, fail) => {
    const child = spawn(builds[oldVersion], windowsInstallerArguments(installed).filter(arg => arg !== '--force-run'), { argv0: `"${builds[oldVersion]}"`, windowsVerbatimArguments: true, windowsHide: true, stdio: 'inherit' });
    children.push(child);
    const timer = setTimeout(() => { child.kill(); fail(new Error('旧版安装超时')); }, 180_000);
    child.once('error', error => { clearTimeout(timer); fail(error); });
    child.once('exit', code => { clearTimeout(timer); code === 0 ? done() : fail(new Error('旧版安装失败：' + code)); });
  });
  assert.equal(await windowsExecutableVersion(executable), oldVersion + '.0'); checked('旧版静默装在指定目录，程序版本正确');
  for (const [i, directory] of [store, site].entries()) {
    const server = start(process.execPath, ['test/e2e/update-site.ts', directory, String(19443 + i), cert, tlsKey]);
    await until(async () => { if (server.child.exitCode !== null) throw new Error(server.log()); return server.log().includes('测试下载站已启动'); }, 'HTTPS 下载站启动', 30_000);
  }
  // 专用 runner 上用账户默认的数据目录，NSIS 经 Explorer 打开的新版也能读到同一份设置。
  await mkdir(join(homedir(), '.xagents'), { recursive: true });
  await writeFile(join(homedir(), '.xagents/config.json'), JSON.stringify({ autoUpdateCheck: false }));
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')), NODE_EXTRA_CA_CERTS: cert }; delete env.ELECTRON_RUN_AS_NODE; delete env.XAGENTS_USER_DATA; delete env.XAGENTS_HOME;
  electron = await _electron.launch({ executablePath: executable, args: [], env });
  const mainLog: string[] = []; electron.process().stdout?.on('data', d => mainLog.push(String(d))); electron.process().stderr?.on('data', d => mainLog.push(String(d)));
  record.mainLog = mainLog;
  let closed = false; electron.on('close', () => { closed = true; });
  const info = await electron.evaluate(({ app }) => ({ version: app.getVersion(), userData: app.getPath('userData') }));
  assert.equal(info.version, oldVersion); record.userData = info.userData;
  const page = await electron.firstWindow(); await page.waitForSelector('[data-testid="running"]', { timeout: 90_000 });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const group = page.getByRole('region', { name: '更新' }); await group.scrollIntoViewIfNeeded();
  // 验签失败时两个源都拒收。
  for (const directory of [store, site]) await writeFile(join(directory, 'badsig'), '');
  await group.getByRole('button', { name: '检查更新' }).click(); await group.getByText(/签名不对/).waitFor({ timeout: 60_000 });
  checked('两处清单签名错误时拒收');
  for (const directory of [store, site]) await rm(join(directory, 'badsig'));
  await group.getByRole('button', { name: '检查更新' }).click(); await group.getByText('有新版本 ' + newVersion).waitFor({ timeout: 60_000 });
  await group.getByRole('button', { name: '查看' }).click(); const dialog = page.getByRole('dialog', { name: '更新' });
  const downloads = join(info.userData, 'updates');
  for (const marker of ['corrupt', 'cut']) {
    for (const directory of [store, site]) await writeFile(join(directory, marker), '');
    await dialog.getByRole('button', { name: '下载并安装' }).click(); await dialog.getByRole('alert').waitFor({ timeout: 180_000 });
    assert.match(await dialog.getByRole('alert').innerText(), marker === 'corrupt' ? /内容和发布的不一致/ : /中断|连接失败/);
    assert.equal(await windowsExecutableVersion(executable), oldVersion + '.0');
    assert.deepEqual((await readdir(downloads)).filter(name => /\.(exe|part)$/.test(name)), []);
    checked(marker === 'corrupt' ? 'EXE 被改坏时两个源都拒收，旧版完整，无下载残留' : 'EXE 下载半截断开时拒收，旧版完整，无下载残留');
    for (const directory of [store, site]) await rm(join(directory, marker));
    await dialog.getByRole('button', { name: '重新检查' }).click(); await dialog.getByRole('button', { name: '下载并安装' }).waitFor({ timeout: 60_000 });
  }
  // 成功路径强制桶失败，发布页兜底；仍用完全相同的客户端与 HTTPS 核对。
  await writeFile(join(store, 'corrupt'), '');
  await writeFile(join(downloads, 'abandoned.exe.part'), '半截');
  await dialog.getByRole('button', { name: '下载并安装' }).click();
  await dialog.getByRole('button', { name: '重启以完成更新' }).or(dialog.getByRole('alert')).first().waitFor({ timeout: 300_000 });
  assert.equal(await dialog.getByRole('alert').count(), 0, '下载后成功就绪');
  assert.equal(await windowsExecutableVersion(executable), oldVersion + '.0');
  assert.ok(!(await readdir(downloads)).some(name => name.endsWith('.part')));
  await page.screenshot({ path: join(output, 'ready.png') }); checked('桶失败后从发布页下完，就绪前没有安装，旧半包已清理');
  await dialog.getByRole('button', { name: '重启以完成更新' }).click();
  await until(async () => closed && await windowsExecutableVersion(executable).catch(() => '') === newVersion + '.0', '原位置变成新版');
  electron = undefined;
  // 不另起新版来冒充自动启动：先确认安装器自己打开了有真实窗口的新版。
  await until(async () => Boolean(await processes()), '安装器自动打开新版窗口'); checked('原安装目录版本正确，安装器自动打开新版窗口');
  await until(async () => !(await readdir(downloads)).some(name => /\.(exe|part)$/.test(name)), '新版清理下载文件');
  assert.equal(JSON.parse(await readFile(join(installed, 'resources/platform/package.json'), 'utf8')).version, newVersion);
  checked('自带平台版本正确，下载文件无残留');
  await processes(true); await sleep(1000);
  electron = await _electron.launch({ executablePath: executable, args: [], env });
  assert.equal(await electron.evaluate(({ app }) => app.getVersion()), newVersion);
  const next = await electron.firstWindow(); await next.waitForSelector('[data-testid="running"]', { timeout: 90_000 });
  await next.getByRole('button', { name: '设置', exact: true }).click();
  await next.getByRole('region', { name: '更新' }).getByText(newVersion, { exact: true }).waitFor();
  await next.screenshot({ path: join(output, 'new-version.png') }); checked('新版可再次启动，设置显示新版本');
  record.passed = true;
} catch (error) {
  record.passed = false; record.error = String(error);
  // 失败时留现场：窗口截图、页面上的字、应用后台的输出（在 result.json 的 mainLog 里）。
  const page = electron?.windows()[0];
  if (page) {
    await page.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
    record.pageText = await page.evaluate(() => document.body.innerText).catch(() => '');
    record.updateInfo = await page.evaluate(() => (window as unknown as { xagents?: { appInfo?: () => Promise<unknown> } }).xagents?.appInfo?.()).catch(e => String(e));
  }
  throw error;
}
finally {
  await writeFile(packageFile, original);
  await electron?.close().catch(() => {}); await processes(true).catch(() => {});
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) continue;
    const stopped = new Promise<void>(done => child.once('close', () => done())); child.kill(); await Promise.race([stopped, sleep(5000)]);
  }
  for (const directory of [store, site]) await copyFile(join(directory, 'requests.log'), join(output, directory === store ? 'store-requests.log' : 'site-requests.log')).catch(() => {});
  await writeFile(join(output, 'result.json'), JSON.stringify(record, null, 2) + '\n');
  // 附件不带临时私钥、TLS 私钥或安装包。失败保留 runner 临时目录便于本作业内排查。
  await rm(privateKey, { force: true }); await rm(tlsKey, { force: true });
  console.log('Windows 更新验收报告：' + output);
}
