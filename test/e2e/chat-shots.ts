// 负责人截图检查协作页（项目群聊，docs/ui-spec.md 第 17 节）：假数据启动真实窗口，拍浅色、深色、几种宽度和新建群聊弹窗。
// 用法：npm run build && node test/e2e/chat-shots.ts <输出目录>。不进 verify，不碰真实登记处。
import { copyFile, mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { _electron } from 'playwright-core';
import { writeAtomic, writeJson } from '../../src/core/fsx.ts';
import type { Job } from '../../src/core/job.ts';
import type { Chat, ChatMessage } from '../../src/core/chat.ts';

const output = resolve(process.argv[2] ?? 'test/e2e/artifacts');
const temp = await mkdtemp(join(tmpdir(), 'xagents-chat-shots-'));
const home = join(temp, 'registry');
for (const dir of ['jobs', 'batches', 'cache', 'icons', 'chats', 'projects']) await mkdir(join(home, dir), { recursive: true });
for (const name of await readdir(join(homedir(), '.xagents/icons')).catch(() => [] as string[])) if (name.endsWith('.png')) await copyFile(join(homedir(), '.xagents/icons', name), join(home, 'icons', name));
await mkdir(output, { recursive: true });
const ago = (min: number) => new Date(Date.now() - min * 60000).toISOString();
const job = (id: string, extra: Partial<Job>): Job => ({ id, summary: '项目群聊', batch: id, project: 'xagents', repo: temp, base: 'test', worktree: temp, branch: 'test',
  who: 'codex', model: 'gpt-6-astra', effort: 'high', mode: 'workspace-write', kind: '实现', title: '派活工作台', state: 'done', created: ago(40), started: ago(40), ended: ago(20), seconds: 600, chat: { id: 'c1' }, ...extra });
const jobs = [
  job('cx', {}),
  job('ds', { who: 'deepseek', model: 'deepseek-v4-pro', mode: 'read-only', state: 'running', pid: process.pid, ended: undefined, seconds: undefined, started: ago(3), activity: [{ at: ago(1), kind: 'read', text: 'src/core/rate.ts' }] }),
];
// 看板上的样子（docs/ui-spec.md 第 14 节“项目群聊的活也上看板”）：一个都做完、等负责人拍板的群；一个拍完板的群；再放一件普通的活对比。
const adopted = { kind: 'adopt' as const, note: '合进主线', at: ago(4), by: 'lead' as const };
jobs.push(
  job('k1', { title: '看板颜色微调', chat: { id: 'c3' }, started: ago(25), ended: ago(12), seconds: 780 }),
  job('k2', { title: '看板颜色微调', chat: { id: 'c3' }, who: 'deepseek', model: 'deepseek-v4-pro', mode: 'read-only', kind: '审查', started: ago(11), ended: ago(8), seconds: 180 }),
  job('h1', { title: '历史页分组', chat: { id: 'c4' }, started: ago(90), ended: ago(70), seconds: 1200, decision: adopted }),
  job('solo', { title: '额度查询超时重试', chat: undefined, state: 'running', pid: process.pid, ended: undefined, seconds: undefined, started: ago(6), activity: [{ at: ago(1), kind: 'edit', text: 'src/core/quota.ts' }] }),
  job('old', { title: '清理脚本补测试', chat: undefined, started: ago(200), ended: ago(180), seconds: 900, decision: adopted }),
);
for (const j of jobs) { await mkdir(join(home, 'jobs', j.id), { recursive: true }); await writeJson(join(home, 'jobs', j.id, 'job.json'), j); }
const chat = (id: string, extra: Partial<Chat>): Chat => ({ id, project: 'xagents', repo: temp, title: '派活工作台', base: 'test', branch: `xa/chat-${id}`, worktree: temp,
  members: [{ who: 'codex', effort: 'high', job: 'cx' }, { who: 'deepseek', effort: 'high', readOnly: true, job: 'ds' }, { who: 'grok', effort: 'high' }],
  hopLimit: 4, state: 'open', created: ago(45), queue: [], ...extra });
const msgs: Omit<ChatMessage, 'id'>[] = [
  { at: ago(45), from: 'platform', kind: 'event', text: '开群：Codex、DeepSeek（只读）、Grok', mentions: [] },
  { at: ago(30), from: 'owner', kind: 'say', text: '任务记录要能改分，旧分留着，最多 5 版。@负责人 安排一下', mentions: ['lead'] },
  { at: ago(29), from: 'lead', kind: 'say', text: '@Codex 写改分和历史，补测试。写完 @DeepSeek 审，只看会不会弄坏旧记录。', mentions: ['codex', 'deepseek'] },
  { at: ago(28), from: 'codex', kind: 'work', text: '', mentions: [], job: 'cx', turn: 1 },
  { at: ago(20), from: 'codex', kind: 'report', text: '已完成，只改了 `src/core/rate.ts`，新增 `test/rate.test.ts`，未提交。\n- 改分时把上一版放进 `previous`，**最多留 5 版**。\n- 验证：`node --test test/rate.test.ts`，3 项全部通过。\n\n## 没做的\n1. 全量验收\n2. 桌面冒烟测试\n\n@DeepSeek 请审。', mentions: ['deepseek'], job: 'cx', turn: 1 },
  { at: ago(3), from: 'deepseek', kind: 'work', text: '', mentions: [], job: 'ds', turn: 1 },
  { at: ago(2), from: 'owner', kind: 'say', text: '旧记录别弄坏就行，辛苦', mentions: [] },
];
for (const [id, extra, list] of [['c1', { busy: { who: 'deepseek' as const, job: 'ds', message: 5, since: ago(3) }, queue: [{ who: 'grok' as const, message: 3, hop: 0 }] }, msgs], ['c2', { title: '额度环颜色', members: [{ who: 'grok' as const, effort: 'high' as const }], created: ago(300) }, [{ at: ago(200), from: 'grok', kind: 'report', text: '颜色按 80%、95% 两档改好了。@负责人 可以验收', mentions: ['lead'] }]]] as const) {
  await mkdir(join(home, 'chats', id), { recursive: true });
  await writeJson(join(home, 'chats', id, 'chat.json'), chat(id, extra as unknown as Partial<Chat>));
  await writeAtomic(join(home, 'chats', id, 'messages.jsonl'), (list as Omit<ChatMessage, 'id'>[]).map((m, i) => JSON.stringify({ id: i + 1, ...m })).join('\n') + '\n');
}
// c5：另一个项目里新开的群，头一回 @ 人——成员还没有活，只在群的队列里。看板上也要有它的卡，并且两个项目的卡都带项目标签。
const boardChats: [string, Partial<Chat>][] = [['c5', { project: 'other', title: '新开的群', members: [{ who: 'codex', effort: 'high' }], queue: [{ who: 'codex', message: 1, hop: 0 }], created: ago(1) }], ['c3', { title: '看板颜色微调', members: [{ who: 'codex', effort: 'high', job: 'k1' }, { who: 'deepseek', effort: 'high', readOnly: true, job: 'k2' }], created: ago(26) }],
  ['c4', { title: '历史页分组', members: [{ who: 'codex', effort: 'high', job: 'h1' }], created: ago(95) }]];
for (const [id, extra] of boardChats) {
  await mkdir(join(home, 'chats', id), { recursive: true });
  await writeJson(join(home, 'chats', id, 'chat.json'), chat(id, extra));
  await writeAtomic(join(home, 'chats', id, 'messages.jsonl'), JSON.stringify({ id: 1, at: ago(26), from: 'platform', kind: 'event', text: '开群了。', mentions: [] }) + '\n');
}
await writeJson(join(home, 'projects', 'xagents.json'), { name: 'xagents', repo: temp, label: '派活工作台' });
await writeJson(join(home, 'projects', 'other.json'), { name: 'other', repo: temp, label: '另一个项目' });
const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === 'string'));
delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
const app = await _electron.launch({ args: [resolve('out/main/index.js')], env: { ...env, XAGENTS_HOME: home, XAGENTS_USER_DATA: join(temp, 'electron'), XAGENTS_E2E: '1' } });
try {
  const page = await app.firstWindow();
  await page.waitForSelector('[data-testid="running"]');
  const settle = () => page.waitForFunction(() => !document.querySelector('.logo img[data-state="pending"]'));
  // 先拍看板：群聊的活在三列里的样子；已完成列的项目卡点开。
  await page.locator('.column.c-done .done-head').first().click();
  for (const [theme, width] of [['light', 1280], ['dark', 1280], ['light', 900]] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await app.evaluate(({ BrowserWindow }, w) => { const win = BrowserWindow.getAllWindows()[0]; win.setMinimumSize(300, 600); win.setSize(w, 760); }, width);
    await page.waitForTimeout(300); await settle();
    await page.screenshot({ animations: 'disabled', path: join(output, `board-chat-${theme}-${width}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light' });
  // 点看板上群聊的卡：回到协作页那个群。
  await page.locator('.column.c-attention .card', { hasText: '看板颜色微调' }).click();
  await page.waitForSelector('.chat-log'); await page.waitForTimeout(200);
  await page.screenshot({ animations: 'disabled', path: join(output, 'board-chat-jump.png') });
  await page.locator('.chat-layout .sidenav-item', { hasText: '派活工作台' }).first().click();
  await page.waitForSelector('.chat-log');
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    for (const width of [1440, 1000, 760]) {
      await app.evaluate(({ BrowserWindow }, w) => { const win = BrowserWindow.getAllWindows()[0]; win.setMinimumSize(300, 600); win.setSize(w, 900); }, width);
      await page.waitForTimeout(300); await settle();
      await page.screenshot({ animations: 'disabled', path: join(output, `chat-${theme}-${width}.png`) });
    }
  }
  // 主人常用的窗口宽度（成员栏默认收起）：顶栏的成员按钮看得到人数；点了成员栏从右边盖出来。
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(925, 835));
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme }); await page.waitForTimeout(300); await settle();
    await page.screenshot({ animations: 'disabled', path: join(output, `chat-${theme}-925.png`) });
    await page.getByRole('button', { name: /^成员 \d+ 位$/ }).click(); await page.waitForTimeout(200);
    await page.screenshot({ animations: 'disabled', path: join(output, `chat-${theme}-925-people.png`) });
    await page.keyboard.press('Escape');
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900));
  await page.emulateMedia({ colorScheme: 'light' });
  await page.locator('.chat-layout .sidenav-item').nth(1).hover(); await page.waitForTimeout(150);
  await page.locator('.chat-layout .sidenav-item').nth(1).locator('.more-btn').click(); await page.waitForTimeout(200);
  await page.screenshot({ animations: 'disabled', clip: { x: 0, y: 60, width: 540, height: 360 }, path: join(output, 'chat-light-row-menu.png') });
  await page.keyboard.press('Escape');
  const box = page.getByRole('textbox', { name: '发消息' });
  await box.fill('@De'); await box.press('End'); await box.dispatchEvent('input');
  await box.type('e'); await page.waitForTimeout(200); await settle();
  await page.screenshot({ animations: 'disabled', path: join(output, 'chat-light-mention.png') });
  await box.fill('');
  await page.getByRole('button', { name: '＋ 新建' }).click(); await page.waitForTimeout(200);
  await page.getByRole('checkbox', { name: '拉 Codex 进群' }).click(); await page.getByRole('checkbox', { name: '拉 DeepSeek 进群' }).click();
  await page.getByRole('switch', { name: 'DeepSeek 只读' }).click(); await settle();
  await page.screenshot({ animations: 'disabled', path: join(output, 'chat-light-new.png') });
  console.log('截图在', output);
} finally { await app.close(); await rm(temp, { recursive: true, force: true }); }
