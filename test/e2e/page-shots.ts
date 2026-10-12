// 负责人整页整页看界面用：启动真实窗口，把四个页面、设置各分页、任务弹窗，按浅色、深色、几种屏幕缩放、窄窗口各截一张。
// 登记处是临时的，里面是几件替身活；不碰这台机器上真实的数据。不进 verify。
// 用法：node test/e2e/page-shots.ts <输出目录> [--app <打包后的可执行文件>] [--scales 1,1.25,1.5] [--as-windows]
//   不写 --app 就启动 out/main/index.js（先 npm run build）。第一个缩放截全套，其余缩放只截浅色的几张。
//   --as-windows：在别的系统上把页面标成 Windows，只为看排版（字号、滚动条）；字体渲染要在真的 Windows 上看。
// 截的是页面，系统画的窗口按钮不在图里。在 Windows 上、缩放是 1 的那一轮另外把窗口亮出来截两张屏幕（平常和开着弹窗），
// 用来看窗口按钮那一块；托盘、通知仍要在真机上看（docs/design-windows.md 第 11.2 节）。
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { _electron } from 'playwright-core';
import { writeJson } from '../../src/core/fsx.ts';
import type { Job } from '../../src/core/job.ts';

const args = process.argv.slice(2), option = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const output = resolve(args[0] ?? 'test/e2e/artifacts'), executable = option('--app');
const scales = (option('--scales') ?? '1').split(',').map(Number).filter(n => n > 0);
const asWindows = args.includes('--as-windows');
// 截整个屏幕（系统自带的 PowerShell）：页面截图里没有系统画的窗口按钮。
const screen = (file: string) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b=[System.Windows.Forms.SystemInformation]::VirtualScreen; $i=New-Object System.Drawing.Bitmap $b.Width,$b.Height; $g=[System.Drawing.Graphics]::FromImage($i); $g.CopyFromScreen($b.Left,$b.Top,0,0,$i.Size); $i.Save('${file.replaceAll("'", "''")}')`], { timeout: 30_000 });
const temp = await mkdtemp(join(tmpdir(), 'xagents-page-shots-'));
const home = join(temp, 'registry');
for (const dir of ['jobs', 'batches', 'cache', 'icons', 'projects']) await mkdir(join(home, dir), { recursive: true });
await mkdir(output, { recursive: true });

const now = new Date().toISOString(), ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const fixture = (id: string, state: Job['state'], extra: Partial<Job> = {}): Job => ({
  id, summary: '把导出的表格改成按项目分页，表头钉在最上面，数字靠右对齐', batch: '', project: '记账应用', repo: temp, base: 'main', worktree: temp, branch: 'xa/' + id, who: 'codex', model: 'gpt-6-astra',
  effort: 'high', mode: 'workspace-write', kind: '实现', title: '导出改成表格', state, created: ago(40), started: ago(40),
  ...(state === 'running' || state === 'queued' ? { pid: process.pid } : { ended: ago(5), seconds: 2100 }), ...extra,
});
const lead = { kind: 'adopt', by: 'lead', at: now, note: '改动小而准，测试补齐了，已合并' } as const;
const rating = (score: 1 | 2 | 3 | 4 | 5, tags: string[], words: { good?: string; improve?: string } = {}) => ({ score, tags, ...words, at: now, by: 'lead' as const });
const jobs: Job[] = [
  fixture('run-a', 'running', { batch: 'pair', title: '登录页加记住我', activity: [{ at: ago(2), text: '读 src/login/form.tsx' }, { at: ago(1), text: '运行 npm test -- login' }] as Job['activity'] }),
  fixture('run-b', 'running', { batch: 'pair', title: '登录页加记住我', who: 'deepseek-flash', model: 'deepseek-flash' }),
  fixture('queued', 'queued', { title: '账单页的空状态', queuedBy: process.pid }),
  fixture('check', 'done', { title: '导出改成表格', effort: 'xhigh', timing: { steps: 45, toolSeconds: 30 }, comments: [
    { by: 'owner', text: '表头能不能钉住？数据多的时候往下滚就看不到列名了', at: ago(4) }, { by: 'lead', text: '可以，我让它补上，稍后回复你', at: ago(3) }] }),
  fixture('failed', 'failed', { title: '汇率接口超时重试', kind: '修复' }),
  fixture('done-a', 'done', { title: '首页图表换配色', decision: lead, seconds: 780, rating: rating(5, ['一次做对', '报告老实'], { good: '一次做对，还指出了说明里的一处错' }) }),
  fixture('done-b', 'done', { title: '导入银行流水', project: '官网改版', decision: lead, seconds: 1500, rating: rating(4, ['考虑周到']) }),
  fixture('done-c', 'done', { title: '审查支付回调', kind: '审查', mode: 'read-only', who: 'codex-luna', model: 'gpt-6-luna', decision: { kind: 'drop', by: 'lead', at: now, note: '结论和代码对不上' }, seconds: 420, rating: rating(2, ['夸大结论'], { improve: '说全过了，其实有一项没跑' }) }),
];
for (const job of jobs) { await mkdir(join(home, 'jobs', job.id), { recursive: true }); await writeJson(join(home, 'jobs', job.id, 'job.json'), job); }
await writeJson(join(home, 'batches/pair.json'), { id: 'pair', title: '登录页加记住我', summary: '两家各做一份，挑好的用', kind: '实现', started: ago(40), base: 'main', jobs: ['run-a', 'run-b'] });
const bar = (label: string, used: number) => ({ label, used, reset: new Date(Date.now() + 3 * 86400_000).toISOString() });
await writeJson(join(home, 'cache/quota.json'), { queriedAt: now, providers: [
  { name: 'Codex', icon: 'codex', plan: 'pro', at: now, bars: [{ ...bar('周额度', 31), windowMinutes: 10080 }] },
  { name: 'Grok', icon: 'grok', plan: 'SuperGrok', at: now, bars: [bar('本期额度', 12)] },
  { name: 'Cursor', icon: 'cursor', plan: 'pro', at: now, bars: [bar('总额度', 22), bar('自家模型池', 8), bar('其他模型池', 86)] },
] });

const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === 'string'));
delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
const SETTINGS = ['通用', '选手与模型', '联网', '看板颜色', '接入 AI'];
try {
  for (const [index, scale] of scales.entries()) {
    const full = index === 0, flag = `--force-device-scale-factor=${scale}`, tag = `x${String(scale).replace('.', '_')}`;
    const app = await _electron.launch({ ...(executable ? { executablePath: executable, args: [flag] } : { args: [resolve('out/main/index.js'), flag] }),
      env: { ...env, XAGENTS_HOME: home, XAGENTS_USER_DATA: join(temp, 'electron-' + tag), XAGENTS_E2E: '1' } });
    try {
      const page = await app.firstWindow();
      await page.waitForSelector('[data-testid="running"]', { timeout: 90_000 });
      const resize = (width: number, height: number) => app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setSize(w, h), [width, height]);
      // Windows 上藏着的窗口过一会儿就不出画面了，截图会一直等：把窗口亮出来（不抢焦点）。
      if (process.platform === 'win32') await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive());
      await resize(1180, 820);
      await page.evaluate(() => localStorage.setItem('xa.done-expanded', JSON.stringify(['记账应用', '官网改版'])));
      await page.reload(); await page.waitForSelector('[data-testid="running"]');
      if (asWindows) await page.evaluate(() => { document.documentElement.dataset.platform = 'windows'; });
      const shot = async (name: string) => {
        await page.waitForTimeout(300);
        await page.waitForFunction(() => !document.querySelector('.logo img[data-state="pending"]'));
        await page.screenshot({ animations: 'disabled', path: join(output, `${tag}-${name}.png`) });
      };
      const top = (name: string) => page.locator('header').getByRole('tab', { name, exact: true }).click();
      for (const theme of full ? ['light', 'dark'] as const : ['light'] as const) {
        await page.emulateMedia({ colorScheme: theme });
        await top('看板'); await shot(`${theme}-board`);
        await page.locator('.card').filter({ hasText: '导出改成表格' }).first().click();
        await shot(`${theme}-job`); await page.keyboard.press('Escape'); await page.waitForTimeout(200);
        await top('表现'); await shot(`${theme}-stats`);
        if (full) { await top('协作'); await shot(`${theme}-chat`); await top('历史'); await shot(`${theme}-history`); }
        await page.getByRole('button', { name: '设置' }).click();
        for (const name of full ? SETTINGS : ['选手与模型']) {
          await page.getByRole('dialog').getByRole('tab', { name, exact: true }).click();
          await shot(`${theme}-settings-${SETTINGS.indexOf(name) + 1}`);
        }
        await page.keyboard.press('Escape'); await page.waitForTimeout(200);
      }
      if (full) {
        // 窄窗口：窗口允许的最小宽度。
        await page.emulateMedia({ colorScheme: 'light' });
        await resize(900, 640);
        await top('看板'); await shot('narrow-board');
        await top('表现'); await shot('narrow-stats');
        await page.getByRole('button', { name: '设置' }).click();
        await page.getByRole('dialog').getByRole('tab', { name: '选手与模型', exact: true }).click(); await shot('narrow-settings-2');
        await page.keyboard.press('Escape');
      }
      if (process.platform === 'win32' && scale === 1) {
        for (const theme of ['light', 'dark'] as const) {
          await page.emulateMedia({ colorScheme: theme });
          await app.evaluate(({ BrowserWindow, nativeTheme }, dark) => { nativeTheme.themeSource = dark ? 'dark' : 'light'; const w = BrowserWindow.getAllWindows()[0]; w.setBounds({ x: 0, y: 0, width: 980, height: 700 }); w.show(); w.focus(); }, theme === 'dark');
          await top('看板'); await page.waitForTimeout(800); screen(join(output, `window-${theme}.png`));
          await page.getByRole('button', { name: '设置' }).click(); await page.waitForTimeout(800); screen(join(output, `window-${theme}-modal.png`));
          await page.keyboard.press('Escape'); await page.waitForTimeout(200);
        }
      }
    } finally { await app.close().catch(() => {}); }
  }
  console.log('截图在', output);
} finally { await rm(temp, { recursive: true, force: true }).catch(() => {}); }
