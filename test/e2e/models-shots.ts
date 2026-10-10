// 负责人截图检查“设置 → 选手与模型”和“管理模型”（docs/ui-spec.md 第 10 节）：启动真实窗口，登记处是临时的。
// 用法：npm run build && node test/e2e/models-shots.ts <输出目录> [--real]
//   --real：把本机登记处里的设置、额度和发现的名单各拷一份进临时登记处（只读地拷，不碰真实登记处），看真实数据下的样子。
import { copyFile, mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { _electron } from 'playwright-core';
import { writeJson } from '../../src/core/fsx.ts';

const output = resolve(process.argv[2] ?? 'test/e2e/artifacts'), real = process.argv.includes('--real');
const temp = await mkdtemp(join(tmpdir(), 'xagents-models-shots-'));
const home = join(temp, 'registry'), source = join(homedir(), '.xagents');
for (const dir of ['jobs', 'batches', 'cache', 'icons', 'projects']) await mkdir(join(home, dir), { recursive: true });
for (const name of await readdir(join(source, 'icons')).catch(() => [] as string[])) if (name.endsWith('.png')) await copyFile(join(source, 'icons', name), join(home, 'icons', name));
await mkdir(output, { recursive: true });
const now = new Date().toISOString(), all = ['medium', 'high', 'xhigh'];
if (real) {
  for (const file of ['config.json', 'cache/models.json', 'cache/quota.json']) await copyFile(join(source, file), join(home, file)).catch(() => {});
} else {
  await writeJson(join(home, 'cache/models.json'), { at: now, channels: {
    codex: { at: now, models: [
      { model: 'gpt-6.1-sol', shown: 'GPT-6.1 Sol', description: 'Latest workhorse model for coding and everyday work.', efforts: all, fast: false },
      { model: 'gpt-6-astra', shown: 'GPT-6 Astra', description: 'Frontier intelligence for the most demanding work.', efforts: all, fast: false },
      { model: 'gpt-6-sol', shown: 'GPT-6 Sol', description: 'Previous generation workhorse model.', efforts: all, fast: false }] },
    grok: { at: now, models: [{ model: 'grok-4.7', shown: 'grok-4.7', efforts: all, fast: true }, { model: 'grok-4.6', shown: 'grok-4.6', efforts: all, fast: false }] },
    cursor: { at: now, error: '程序没装', models: [{ model: 'grok-4.7', shown: 'Grok 4.7', efforts: all, fast: true }, { model: 'claude-opus-5-5', shown: 'Claude Opus 5.5', efforts: all, fast: true }, { model: 'claude-sonnet-5-5', shown: 'Claude Sonnet 5.5', efforts: all, fast: false }] },
  } });
  // 基线里没有 gpt-6.1-sol：它会标“新”；Luna 不在名单里：标“已下线”。
  await writeJson(join(home, 'config.json'), { models: { extra: {}, dropped: [], seen: { codex: ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna'], grok: ['grok-4.7', 'grok-4.6'], cursor: ['grok-4.7', 'claude-opus-5-5', 'claude-sonnet-5-5'] } } });
}
const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === 'string'));
delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
const app = await _electron.launch({ args: [resolve('out/main/index.js')], env: { ...env, XAGENTS_HOME: home, XAGENTS_USER_DATA: join(temp, 'electron'), XAGENTS_E2E: '1' } });
try {
  const page = await app.firstWindow();
  await page.waitForSelector('[data-testid="running"]');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1180, 1040));
  const settle = () => page.waitForFunction(() => !document.querySelector('.logo img[data-state="pending"]'));
  const shot = async (name: string) => { await page.waitForTimeout(250); await settle(); await page.screenshot({ animations: 'disabled', path: join(output, `${name}.png`) }); };
  await page.getByRole('button', { name: '设置' }).click();
  await page.getByRole('tab', { name: '选手与模型' }).click();
  // 表：先停在这一节的开头（看得到说明那句），再往下滚一段（看列名钉住时的样子）。
  const scrollTable = (extra: number) => page.locator('.sidenav-body').evaluate((el, more) => {
    el.scrollTop += document.querySelector('.wk')!.getBoundingClientRect().top - el.getBoundingClientRect().top - 20 + more;
  }, extra);
  const group = (name: string) => page.getByRole('region', { name, exact: true }).getByRole('button', { name: /管理模型/ });
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await scrollTable(0); await shot(`models-${theme}-table`);
    await scrollTable(150); await shot(`models-${theme}-table-scrolled`);
  }
  for (const [name, label] of [['codex', 'Codex'], ['cursor', 'Cursor']] as const) {
    await page.emulateMedia({ colorScheme: 'light' });
    await group(label).click();
    await shot(`models-light-picker-${name}`);
    await page.emulateMedia({ colorScheme: 'dark' }); await shot(`models-dark-picker-${name}`);
    await page.keyboard.press('Escape'); await page.waitForTimeout(200);
  }
  // 搜索，和窄窗口。
  await page.emulateMedia({ colorScheme: 'light' });
  await group('Cursor').click();
  if (await page.getByRole('searchbox', { name: '搜索模型' }).count()) { await page.getByRole('searchbox', { name: '搜索模型' }).fill('opus'); await shot('models-light-picker-search'); }
  await page.keyboard.press('Escape'); await page.waitForTimeout(200);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(760, 720));
  await scrollTable(0); await shot('models-narrow-table');
  await group('Cursor').click(); await shot('models-narrow-picker');
  await page.keyboard.press('Escape');
  console.log('截图在', output);
} finally { await app.close(); await rm(temp, { recursive: true, force: true }); }
