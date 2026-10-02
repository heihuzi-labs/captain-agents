import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { _electron } from 'playwright-core';
import { writeJson } from '../../src/core/fsx.ts';
import { addComment } from '../../src/core/comments.ts';
import type { Job } from '../../src/core/job.ts';
import type { Notice } from '../../app/main/notifications.ts';

type Probe = { notices: Notice[]; tray(): { exists: boolean; title: string; running: number; attention: number; menu: string[]; template: boolean } };

// 一张带透明边的小图标：只用来验证“图标能显示、缺图标时退回字母圆标”，不是任何一家的素材。
function icon(size: number) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const o = y * (size * 4 + 1) + 1 + x * 4, dx = x - size / 2 + .5, dy = y - size / 2 + .5;
    if (Math.hypot(dx, dy) < size * .32) { raw[o] = 30 + x * 3; raw[o + 1] = 160; raw[o + 2] = 120 + y * 2; raw[o + 3] = 255; }
  }
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4), crc = Buffer.alloc(4), body = Buffer.concat([Buffer.from(type), data]);
    length.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const head = Buffer.alloc(13); head.writeUInt32BE(size, 0); head.writeUInt32BE(size, 4); head[8] = 8; head[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

test('真实应用：主人决定和留言落盘、菜单栏、通知、安全隔离和各处截图', { timeout: 90_000 }, async () => {
  const temp = await mkdtemp(join(tmpdir(), 'xagents-desktop-e2e-'));
  const previousHome = process.env.XAGENTS_HOME;
  let application: Awaited<ReturnType<typeof _electron.launch>> | undefined;
  try {
    const home = join(temp, 'registry');
    for (const dir of ['jobs', 'batches', 'cache', 'icons']) await mkdir(join(home, dir), { recursive: true });
    // 平时只有 Codex 有（假）图标，其余走字母圆标，测试不依赖这台电脑。给 README 截图时设 XAGENTS_E2E_ICONS=~/.xagents/icons，
    // 换成安装时从本机应用导出的真实图标（只拷进这次的临时登记处，不进仓库）。
    const realIcons = process.env.XAGENTS_E2E_ICONS;
    if (realIcons) for (const name of await readdir(realIcons)) { if (name.endsWith('.png')) await copyFile(join(realIcons, name), join(home, 'icons', name)); }
    else await writeFile(join(home, 'icons/codex.png'), icon(64));
    await mkdir(join(temp, 'electron'), { recursive: true }); await mkdir(resolve('test/e2e/artifacts'), { recursive: true });
    process.env.XAGENTS_HOME = home;
    const now = new Date().toISOString();
    const fixture = (id: string, state: Job['state'], extra: Partial<Job> = {}): Job => ({
      id, summary: '用测试替身检查派活工作台的显示与操作', batch: '', project: '派活工作台', repo: temp, base: 'test', worktree: temp, branch: 'test', who: 'codex', model: '测试替身',
      effort: 'high', mode: 'read-only', kind: '实现', title: '冒烟测试', state, created: now, started: now,
      ...(state === 'running' ? { pid: process.pid } : { ended: now, seconds: 1 }), ...extra,
    });
    const save = async (job: Job) => { await mkdir(join(home, 'jobs', job.id), { recursive: true }); await writeJson(join(home, 'jobs', job.id, 'job.json'), job); };
    const lead = { kind: 'adopt', by: 'lead', at: now } as const;
    // 各家表现的格子读核心算好的档案。Codex 的“实现”打了 3 件，不算样本少。
    const rating = (score: 1 | 2 | 3 | 4 | 5, tags: string[], words: { good?: string; improve?: string } = {}) => ({ score, tags, ...words, at: now, by: 'lead' as const });
    // 真实验收记录按 docs/design.md 的约定。
    const realCheck = { realCheck: { needed: true, steps: ['打开看板，看到进行中、验收中、已完成三列', '打开任务详情，看到真实验收记录'],
      result: { ok: true, note: '两步都看到了，深浅色都清楚', shots: ['1.png', '2.png'], at: now, by: 'lead' as const } } };
    const jobs = [
      fixture('running', 'running', { batch: 'parallel' }),
      { ...fixture('undecided', 'done', { title: '待挑选的成果', who: 'codex', effort: 'xhigh', seconds: 900, batch: 'solo', timing: { steps: 45, toolSeconds: 30 }, comments: [
        { by: 'owner', text: '先别急着合并，我想再看看', at: now }, { by: 'lead', text: '好的，我先核对，稍后回复你', at: now }, { by: 'owner', text: '另外这份要不要保留副本？', at: now }],
        rating: rating(3, ['需要返工'], { improve: '漏了一种情况，负责人补了测试' }) }), ...realCheck },
      fixture('lost', 'lost'),
      fixture('waiting-line', 'queued', { title: '排队中的活', ended: undefined, seconds: undefined, pid: process.pid, queuedBy: process.pid }), // 排队的活并进“进行中”列顶部；看 900 宽时三列放不放得下
      fixture('adopted', 'done', { decision: lead, seconds: 95, rating: rating(5, ['一次做对', '报告老实'], { good: '一次做对，还指出了说明里的一处错' }) }),
      fixture('duel-a', 'done', { batch: 'duel', who: 'cursor-opus', effort: 'xhigh', seconds: 1200, decision: lead, rating: rating(5, ['考虑周到'], { good: '把边界情况都想到了' }) }),
      fixture('duel-b', 'done', { batch: 'duel', who: 'cursor-grok', effort: 'high', seconds: 840, decision: { kind: 'drop', by: 'lead', at: now }, rating: rating(2, ['需要返工', '夸大结论'], { improve: '说全过了，其实有一项没跑' }) }),
      fixture('pair-a', 'done', { batch: 'pair', who: 'codex', seconds: 300, rating: rating(4, ['一次做对']) }),
      fixture('pair-b', 'done', { batch: 'pair', who: 'grok', seconds: 600 }),
    ];
    for (const job of jobs) await save(job);
    for (const shotName of ['1.png', '2.png']) { await mkdir(join(home, 'jobs/undecided/shots'), { recursive: true }); await writeFile(join(home, 'jobs/undecided/shots', shotName), icon(64)); }
    const batch = (id: string, title: string, ids: string[]) => writeJson(join(home, 'batches', id + '.json'), { id, title, summary: `${title}的说明`, kind: '实现', started: now, base: 'test', jobs: ids });
    await batch('parallel', '两家对比测试', ['running', 'new-running']);
    await batch('solo', '只派一家的活', ['undecided']);
    await batch('duel', '两家对比：修复题', ['duel-a', 'duel-b']);
    await batch('pair', '两家都做完的活', ['pair-a', 'pair-b']);
    // 三家额度（设置里“选手与模型”每组右边的套餐和用量、顶栏、各家表现都读它）。
    const bar = (label: string, used: number) => ({ label, used, reset: new Date(Date.now() + 3 * 86400_000).toISOString() });
    await writeJson(join(home, 'cache/quota.json'), { queriedAt: now, providers: [
      { name: 'Codex', icon: 'codex', plan: 'pro', at: now, bars: [{ ...bar('周额度', 31), windowMinutes: 10080 }] },
      { name: 'Grok', icon: 'grok', plan: 'SuperGrok', at: now, bars: [bar('本期额度', 12)] },
      { name: 'Cursor', icon: 'cursor', plan: 'pro', at: now, bars: [bar('总额度', 22), bar('自家模型池', 8), bar('其他模型池', 86)] },
    ] });
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
    application = await _electron.launch({ args: [resolve('out/main/index.js')],
      env: { ...env, XAGENTS_HOME: home, XAGENTS_USER_DATA: join(temp, 'electron'), XAGENTS_E2E: '1' } });
    const page = await application.firstWindow();
    await page.waitForFunction(() => document.querySelector('[data-testid="running"]')?.textContent === '1');
    // 已完成列的项目卡默认折起（只有项目名和件数）；后面的检查要看卡里的行，先把用到的项目记成“已展开”再刷新。
    assert.ok(await page.locator('.column.c-done .done-head').count() > 0);
    assert.equal(await page.locator('.column.c-done .done-head[aria-expanded="true"]').count(), 0, '默认全部折起');
    assert.equal(await page.locator('.column.c-done .done-row').count(), 0);
    await page.evaluate(() => localStorage.setItem('xa.done-expanded', JSON.stringify(['派活工作台', '画布'])));
    await page.reload();
    await page.waitForFunction(() => document.querySelector('[data-testid="running"]')?.textContent === '1');
    assert.equal(await page.getByTestId('attention').textContent(), '3');
    assert.equal(await page.getByTestId('done').textContent(), '2');
    assert.equal(await page.locator('.reply-dot').count(), 1, '只有最后一条是主人留言的任务有小圆点');
    const preferences = await application.evaluate(({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents as Electron.WebContents & { getLastWebPreferences(): Electron.WebPreferences };
      return contents.getLastWebPreferences();
    });
    assert.equal(preferences.contextIsolation, true); assert.equal(preferences.sandbox, true);
    assert.equal(preferences.nodeIntegration, false); assert.equal(preferences.webSecurity, true);
    assert.deepEqual(await page.evaluate(() => [typeof Reflect.get(window, 'require'), typeof Reflect.get(window, 'process'), typeof Reflect.get(window, '__xaE2E')]), ['undefined', 'undefined', 'undefined']);
    assert.deepEqual(await page.evaluate(() => Object.keys(window.xa).sort()), ['comment', 'connect', 'connectStatus', 'copyIntro', 'decide', 'disconnect', 'getSettings', 'getView', 'onOpen', 'onView', 'redo', 'refreshQuota', 'setSettings', 'stop']);
    // 接入 AI：后台只认四个名字，别的一律拒绝，不碰任何文件。
    for (const bad of ['../../etc', 'CLAUDE', '']) assert.match(await page.evaluate(async ai => { try { await window.xa.connect(ai as never); return 'ok'; } catch (e) { return String(e); } }, bad), /只收一个 AI 名字/);
    assert.match(await page.evaluate(async () => { try { await window.xa.disconnect('x' as never); return 'ok'; } catch (e) { return String(e); } }), /只收一个 AI 名字/);
    // 复制对接提示词：后台写的是固定那一份，窗口塞不进别的内容。测试前后保存并还原剪贴板，不留痕迹。
    const savedClipboard = await application.evaluate(({ clipboard }) => clipboard.readText());
    try {
      await page.evaluate(() => window.xa.copyIntro());
      assert.match(await application.evaluate(({ clipboard }) => clipboard.readText()), /^# 派活工作台对接说明/);
      // 桥根本不把参数往后台传：塞别的内容进去，剪贴板里也只会是那段提示词。
      await page.evaluate(() => (window.xa.copyIntro as (...a: unknown[]) => Promise<void>)('别的内容'));
      assert.match(await application.evaluate(({ clipboard }) => clipboard.readText()), /^# 派活工作台对接说明/);
    } finally { await application.evaluate(({ clipboard }, text) => clipboard.writeText(text), savedClipboard); }
    await page.evaluate(() => Reflect.set(window, 'refreshMarker', 'same-document'));
    await page.keyboard.press('Meta+r');
    assert.equal(await page.evaluate(() => Reflect.get(window, 'refreshMarker')), 'same-document');
    await assert.rejects(page.evaluate(() => window.xa.decide('../outside', 'adopt')));
    await assert.rejects(page.evaluate(() => window.xa.redo('missing')));
    await assert.rejects(page.evaluate(() => window.xa.setSettings({ columns: { running: 'red' } })));
    for (const [id, text] of [['../outside', '你好'], ['missing', '你好'], ['undecided', '   '], ['undecided', 'a\u0000b'], ['undecided', '文'.repeat(501)]]) {
      await assert.rejects(page.evaluate(([i, t]) => window.xa.comment(i, t), [id, text]), id + text.slice(0, 3));
    }
    assert.equal(JSON.parse(await readFile(join(home, 'jobs/undecided/job.json'), 'utf8')).comments.length, 3, '被拒绝的留言不落盘');
    const inspect = () => application!.evaluate(() => {
      const probe = Reflect.get(globalThis, '__xaE2E') as Probe;
      return { notices: probe.notices, tray: probe.tray() };
    });
    let probe = await inspect();
    assert.equal(probe.notices.length, 0, '启动时不补发通知（包括已有的负责人回复）');
    assert.equal(probe.tray.exists, true); assert.equal(probe.tray.template, true); assert.equal(probe.tray.title, '1');
    // 只有一家的批次（还在验收中）：卡片上没有“一批”的写法，卡片写着模型、推理强度和用时。
    const solo = page.locator('.card').filter({ hasText: '待挑选的成果' });
    assert.equal(await solo.count(), 1);
    // 身份按段检查：模型、强度标签、用时。
    const metas = (card: typeof solo) => card.locator('.ident-text').evaluateAll(ms => ms.map(m => [...m.children].map(c => c.textContent)));
    assert.deepEqual(await metas(solo), [['GPT-6 Astra', '超高档', '15 分钟']]);
    // 已完成列按项目聚合：一件活一行（小图标、题目、用时、结果）。两家对比：两个小图标，没采用的调淡；采用了不挂标签，只标例外（没用、等负责人处理、已停）。只有一家的：用了这份 / 没用。
    const duel = page.locator('.column.c-done .done-row').filter({ hasText: '两家对比：修复题' });
    assert.equal(await duel.locator('.done-icons .logo').count(), 2);
    assert.equal(await duel.locator('.done-time').textContent(), '20 分钟', '一批的用时写最久的那家');
    // 正常的不写、只标例外：采用了不挂结果标签，用了哪家靠图标（没采用的那家调淡）。
    assert.equal(await duel.locator('.done-end').count(), 0);
    assert.equal(await duel.locator('.done-icons .icon-dim').count(), 1, '没采用的那家图标调淡');
    assert.equal(await page.locator('.column.c-done .done-row').filter({ hasText: '冒烟测试' }).locator('.done-end').count(), 0, '采用了不写“用了这份”');
    // 有未回复留言的卡片带小圆点（浅色、深色各一张）。
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await page.screenshot({ animations: 'disabled', path: join(resolve('test/e2e/artifacts'), `desktop-${theme}-board-marked.png`) });
    }
    assert.deepEqual(await page.locator('#v-board > .column h2').allTextContents(), ['进行中', '验收中', '已完成'], '看板固定三列');
    assert.equal(probe.tray.menu[0], '在跑的活');
    // 排队的活在“进行中”列最上面，带灰色“排队”标签；列头写“在跑几件 · N 排队”。
    const runningCards = page.locator('.column.c-running .cbody > .card, .column.c-running .cbody > .card-batch');
    assert.equal(await runningCards.first().getAttribute('data-job'), 'waiting-line', '排队的活在进行中列的最上面');
    assert.equal(await runningCards.first().locator('.chip', { hasText: '排队' }).count(), 1, '卡上有“排队”标签');
    assert.equal(await page.locator('.column.c-running .chead').textContent(), '进行中1· 1 排队');
    assert.equal(await page.locator('.column.c-running .card[data-queued]').count(), 1, '只有排队的那张带排队标签');
    // 弹窗里的“真实验收”一节（浅色、深色各一张）：状态、步骤、几张截图；这时还没有拍板，单家弹窗。
    await page.locator('button.card, .done-row').filter({ hasText: '待挑选的成果' }).click();
    await page.getByRole('dialog').waitFor();
    await page.getByRole('heading', { name: /真实验收：\s*通过/ }).waitFor();
    // 每一步的时间：“进展”标题下面一行小字（这件活带 timing，其余的没有）。
    assert.equal(await page.locator('.timing-note').count(), 1);
    assert.equal(await page.locator('.timing-note').textContent(), '大部分时间在想，跑命令不到 1 分钟，共 45 步');
    assert.equal(await page.locator('section', { has: page.getByRole('heading', { name: '进展', exact: true }) }).locator('.timing-note').count(), 1);
    const realSection = page.locator('section', { has: page.getByRole('heading', { name: /真实验收：\s*通过/ }) });
    assert.deepEqual(await realSection.locator('ol > li').allTextContents(), ['打开看板，看到进行中、验收中、已完成三列', '打开任务详情，看到真实验收记录']);
    assert.equal(await realSection.getByText('附 2 张截图').count(), 1); assert.equal(await realSection.getByText('负责人：两步都看到了，深浅色都清楚').count(), 1);
    assert.equal(await realSection.locator('img').count(), 0, '这一版只显示张数，不显示图');
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await page.screenshot({ animations: 'disabled', path: join(resolve('test/e2e/artifacts'), `desktop-${theme}-real-check.png`) });
    }
    await page.keyboard.press('Escape'); await page.getByRole('dialog').waitFor({ state: 'detached' });
    const started = Date.now();
    await save({ ...fixture('new-running', 'running', { batch: 'parallel' }), who: 'grok' });
    await page.waitForFunction(() => document.querySelector('[data-testid="running"]')?.textContent === '2', undefined, { timeout: 1000 });
    assert.ok(Date.now() - started < 1000, '变更必须在 1 秒内显示');
    assert.equal((await inspect()).tray.title, '2');
    await solo.click();
    await page.getByRole('dialog').waitFor();
    assert.equal(await page.getByRole('button', { name: /这一批/ }).count(), 0, '单家任务没有“← 这一批”');
    assert.equal(await page.evaluate(() => { const a = document.activeElement; return `${a?.tagName}:${a?.closest('[role=dialog]') ? 'in' : 'out'}:${a?.getAttribute('role') ?? ''}`; }), 'BUTTON:in:', '打开弹窗后焦点在弹窗里的按钮上，不在外框上');
    await page.getByRole('button', { name: '用这份', exact: true }).click();
    await page.getByText('你选了这份，等负责人处理', { exact: true }).waitFor();
    const saved = JSON.parse(await readFile(join(home, 'jobs/undecided/job.json'), 'utf8')) as Job;
    assert.equal(saved.decision?.by, 'owner'); assert.equal(saved.decision?.kind, 'adopt');
    assert.equal(saved.decision?.note, '主人在应用里选的'); assert.equal(saved.state, 'done');
    // 留言：在详情里发送（⌘ 回车），临时登记处里对应任务出现主人的留言，输入框清空。
    const box = page.getByLabel('给负责人的留言');
    await box.fill('收到，请合并前先跑一遍验收');
    await box.press('Meta+Enter');
    await page.getByText('收到，请合并前先跑一遍验收', { exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('textarea')?.value === '', undefined, { timeout: 2000 });
    const commented = JSON.parse(await readFile(join(home, 'jobs/undecided/job.json'), 'utf8')) as Job;
    assert.equal(commented.comments?.length, 4); assert.equal(commented.comments?.at(-1)?.by, 'owner');
    assert.equal(commented.comments?.at(-1)?.text, '收到，请合并前先跑一遍验收');
    assert.equal(commented.decision?.by, 'owner');
    assert.equal((await inspect()).notices.length, 0, '主人自己点的“用这份”不发通知');
    await page.keyboard.press('Escape');
    await save({ ...fixture('new-attention', 'done'), title: '新完成的任务' });
    await page.locator('.card').filter({ hasText: '新完成的任务' }).waitFor();
    await save({ ...fixture('new-failed', 'failed'), title: '出错的任务' });
    await page.locator('.card').filter({ hasText: '出错的任务' }).waitFor();
    assert.equal((await inspect()).notices.length, 0, '做完或出错不发通知');
    // 落盘去重记录后才发通知，轮询主进程，不固定睡眠。
    const waitForNotices = (count: number) => application!.evaluate(async (_electron, wanted) => {
      const probe = Reflect.get(globalThis, '__xaE2E') as Probe;
      const deadline = Date.now() + 3000;
      while (probe.notices.length < wanted && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    }, count);
    await save({ ...fixture('new-attention', 'done'), title: '新完成的任务', decision: { kind: 'adopt', by: 'lead', at: new Date().toISOString(), note: '这份能用' } });
    await waitForNotices(1);
    probe = await inspect(); assert.equal(probe.notices.length, 1, '负责人拍板后发一条结论通知');
    assert.deepEqual(probe.notices[0].target, { kind: 'job', id: 'new-attention' });
    assert.equal(probe.notices[0].body, '新完成的任务：用了 Codex/GPT-6 Astra 那份——这份能用');
    // 负责人回复：通知一次，小圆点消失。
    await addComment('undecided', '已看到，验收后我来处理', 'lead');
    await waitForNotices(2);
    probe = await inspect(); assert.equal(probe.notices.length, 2);
    assert.match(probe.notices[1].key, /^job:undecided:reply:/); assert.deepEqual(probe.notices[1].target, { kind: 'job', id: 'undecided' });
    assert.match(probe.notices[1].body, /负责人回复了你的留言：已看到/);
    await page.waitForFunction(() => document.querySelectorAll('.reply-dot').length === 0);
    const output = resolve('test/e2e/artifacts'); await mkdir(output, { recursive: true });
    // 图标经应用自己的通道加载，新出现的图标要等一小会儿；等全部有了结果（图片或字母圆标）再截图。
    const shot = async (theme: string, name: string) => {
      await page.waitForFunction(() => !document.querySelector('.logo img[data-state="pending"]'));
      await page.screenshot({ animations: 'disabled', path: join(output, `desktop-${theme}-${name}.png`) });
    };
    // 顶栏单独截一条（按设备像素放大），方便看清分段和额度环。
    const topbar = async (theme: string, width: number, name: string) => {
      await page.waitForFunction(() => !document.querySelector('.logo img[data-state="pending"]'));
      await page.screenshot({ animations: 'disabled', clip: { x: 0, y: 0, width, height: 48 }, path: join(output, `desktop-${theme}-topbar-${name}.png`) });
    };
    assert.equal(await application.evaluate(({ nativeTheme }) => nativeTheme.themeSource), 'system');
    // 顶栏：分段“看板 历史 表现”，没有品牌字和“在跑”文字；看板不带件数角标（件数在“验收中”列头）；三家额度环，Cursor 用得最多的池 86% 是琥珀色。
    const header = page.locator('header.top');
    assert.deepEqual(await header.getByRole('tab').allTextContents(), ['看板', '历史', '表现']);
    assert.equal(await page.getByRole('heading', { name: '验收中' }).count(), 1);
    const boardText = await page.locator('#v-board').textContent();
    for (const word of ['等你处理', '件等你', '等你挑', '要你处理']) assert.ok(!boardText!.includes(word), `看板上不该有“${word}”`);
    assert.ok(boardText!.includes('负责人在挑'));
    const headerText = await header.textContent();
    for (const word of ['派活工作台', '在跑', '件等你', '等你处理']) assert.ok(!headerText!.includes(word), `顶栏里不该有“${word}”`);
    assert.deepEqual(await header.locator('.ring').evaluateAll(rings => rings.map(r => [r.getAttribute('data-used'), r.getAttribute('data-level')])), [['31', null], ['12', null], ['86', 'warn']]);
    assert.match(await header.getByRole('button', { name: /各家额度/ }).getAttribute('title') ?? '', /Cursor（pro）\n总额度：22%\n自家模型池：8%\n其他模型池：86%/);
    // 顶栏和红黄绿按钮：顶栏高 48，控件在这一条里垂直居中（按钮位置由主进程按同样的高度摆，见 docs/ui-spec.md 第 11 节）。
    const place = async (selector: string) => header.locator(selector).first().evaluate(el => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height }; });
    assert.equal(await header.evaluate(el => el.getBoundingClientRect().height), 48, '顶栏高 48px');
    for (const selector of ['.seg', '.status', '.top-icon']) { const b = await place(selector); assert.ok(Math.abs((b.top + b.bottom) / 2 - 24) <= 1, `${selector} 垂直居中`); }
    for (const variant of [
      { name: 'light', theme: 'light', width: 1280 },
      { name: 'dark', theme: 'dark', width: 1280 },
      { name: 'narrow', theme: 'light', width: 900 },
    ] as const) {
      await application.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 820), variant.width);
      await page.emulateMedia({ colorScheme: variant.theme });
      await shot(variant.name, 'board');
      // 三列带排队的活，900 宽时整页和列内都不能横向溢出，列头不折行。
      const fit = await page.evaluate(() => ({
        page: document.documentElement.scrollWidth - window.innerWidth,
        clipped: [...document.querySelectorAll('#v-board .column, #v-board .cbody')].filter(c => c.scrollWidth > c.clientWidth + 1).length,
        narrowest: Math.min(...[...document.querySelectorAll('#v-board > .column')].map(c => c.getBoundingClientRect().width)),
      }));
      assert.ok(fit.page <= 0, `${variant.name}：页面不许横向溢出`); assert.equal(fit.clipped, 0, `${variant.name}：列里不许横向溢出`); assert.ok(fit.narrowest >= 200, `${variant.name}：三列每列至少 200 宽（实际 ${fit.narrowest}）`);
      const heads = await page.evaluate(() => [...document.querySelectorAll('#v-board .chead')].map(h => ({ title: h.querySelector('h2')!.textContent, height: h.getBoundingClientRect().height, wrapped: [...h.children].some(c => c.getBoundingClientRect().height > 24), text: h.textContent })));
      for (const h of heads) { assert.ok(!h.wrapped, `${variant.name}：列头“${h.title}”不许折行（${h.text}）`); assert.equal(h.height, heads[0].height, `${variant.name}：各列列头一样高`); }
      await topbar(variant.name, variant.width, 'board');
      await page.locator('[data-job="running"]').click();
      await page.getByRole('dialog').waitFor();
      assert.equal(await page.getByRole('dialog').getByRole('tab').count(), 0);
      await page.getByText('用测试替身检查派活工作台的显示与操作', { exact: true }).waitFor();
      await shot(variant.name, 'single');
      // 二次确认叠在详情上面：Esc 只关确认，详情还在。
      await page.getByRole('button', { name: '停下', exact: true }).click();
      await page.getByRole('alertdialog').waitFor();
      assert.equal(await page.evaluate(() => document.activeElement?.textContent), '先不改');
      await shot(variant.name, 'confirm');
      await page.keyboard.press('Escape');
      await page.getByRole('alertdialog').waitFor({ state: 'detached' });
      assert.equal(await page.getByRole('dialog').count(), 1);
      const before = await page.locator('.modal-foot').textContent();
      await page.keyboard.press('ArrowRight');
      await page.waitForFunction(previous => document.querySelector('.modal-foot')?.textContent !== previous, before);
      await page.getByRole('button', { name: '← 这一批（2 家）' }).click();
      await page.getByText('两家对比测试的说明', { exact: true }).waitFor();
      await shot(variant.name, 'batch');
      await page.keyboard.press('Escape');
      // 带留言往来的单家详情。
      await page.locator('button.card, .done-row').filter({ hasText: '待挑选的成果' }).click();
      await page.getByRole('dialog').waitFor();
      await page.getByText('负责人：好的，我先核对，稍后回复你').waitFor();
      assert.equal(await page.getByRole('button', { name: /这一批/ }).count(), 0);
      await shot(variant.name, 'comments');
      await page.getByLabel('给负责人的留言').scrollIntoViewIfNeeded();
      await shot(variant.name, 'comments-input');
      await page.keyboard.press('Escape');
      // 两家都做完、等拍板的一批。
      await page.locator('.card').filter({ hasText: '两家都做完的活' }).click();
      await page.getByRole('dialog').waitFor();
      await shot(variant.name, 'decide-batch');
      // 用鼠标关掉上一个弹窗、再从菜单打开设置：截图是鼠标用户看到的样子，第一个开关不该有焦点框。
      await page.getByRole('button', { name: '关闭' }).click();
      // 通过真正的应用菜单打开设置，而非测试专用写入口。
      await application.evaluate(({ Menu }) => {
        const item = Menu.getApplicationMenu()!.items[0].submenu!.items[0]; item.click();
      });
      await page.getByRole('dialog', { name: '设置', exact: true }).waitFor();
      const tab = (name: string) => page.getByRole('tab', { name, exact: true });
      await tab('通用').waitFor();
      // 焦点落在左栏当前分页上；鼠标打开时没有焦点框。第一次打开是“通用”，之后记得上次停在哪一页（下面最后停在“看板颜色”）。
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('role')), 'tab');
      assert.equal(await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle), 'none', '用鼠标打开设置时左栏没有焦点框');
      assert.equal(await page.locator('input[type="checkbox"]').count(), 0, '全应用不再有浏览器自带的方形勾选框');
      if (variant.name === 'light') assert.equal(await tab('通用').getAttribute('aria-selected'), 'true');
      else assert.equal(await tab('看板颜色').getAttribute('aria-selected'), 'true', '记得上次停在哪一页');
      const pane = (name: string, id: string, ready: () => Promise<unknown>) => async () => { await tab(name).click(); await ready(); await shot(variant.name, 'settings-' + id); };
      await pane('通用', 'general', () => page.getByRole('switch', { name: '开机自动启动' }).waitFor())();
      assert.equal(await page.getByRole('switch').count(), 4, '通用页三个开关加存储的一个');
      // 存储一组：在外观和开关之后，三行；账目的数字和看板数据（View.storage）对得上；截图带上这一组（浅色、深色、窄窗口都截）。
      const storage = page.locator('.setting-group').filter({ has: page.locator('.setting-group-head', { hasText: '存储' }) });
      await storage.waitFor();
      assert.equal(await page.locator('.setting-group').evaluateAll(groups => groups.findIndex(g => g.querySelector('.setting-group-head')?.textContent === '存储')), 1, '存储在外观和三个开关之后');
      assert.equal(await storage.locator('.setting-row').count(), 3);
      await storage.getByRole('switch', { name: '自动清理旧日志' }).waitFor();
      await storage.getByText('把选手的原始日志和运行文件移到废纸篓；任务记录、报告、改动和打分都留着。').waitFor({ state: 'attached' });
      assert.deepEqual(await storage.getByRole('tab').allTextContents(), ['7 天', '14 天', '30 天']);
      assert.equal(await storage.getByRole('tab', { name: '14 天' }).getAttribute('aria-selected'), 'true', '缺省 14 天');
      const account = await storage.locator('.setting-foot').textContent();
      const stored = await page.evaluate(async () => (await window.xa.getView()).storage);
      assert.match(account!, /^(已清理 \d+ 件，腾出 .+ MB；|还没清理过；)(现在有 \d+ 件到期。|现在没有到期的。)$/);
      assert.equal(account!.includes('已清理 ' + stored.slimmedJobs + ' 件') || stored.slimmedJobs === 0, true, '账目的件数来自 View.storage');
      assert.equal(stored.due > 0 ? account!.includes('现在有 ' + stored.due + ' 件到期') : account!.includes('现在没有到期的'), true, '到期数来自 View.storage');
      await storage.scrollIntoViewIfNeeded();
      await shot(variant.name, 'settings-general-storage');
      if (variant.name === 'light') {
        // 关掉开关：主进程存下，天数一行变灰点不动（冒烟环境不跑定时清理）；截图后再打开。
        await storage.getByRole('switch', { name: '自动清理旧日志' }).click();
        await page.waitForFunction(async () => (await window.xa.getSettings()).storage.slim === false);
        assert.equal(await storage.getByRole('tab', { name: '30 天' }).isDisabled(), true);
        assert.equal(await storage.getByRole('tab', { name: '14 天' }).getAttribute('aria-selected'), 'true', '关掉后天数保留');
        await shot(variant.name, 'settings-general-storage-off');
        await storage.getByRole('switch', { name: '自动清理旧日志' }).click();
        await page.waitForFunction(async () => (await window.xa.getSettings()).storage.slim === true);
        assert.equal(await storage.getByRole('tab', { name: '30 天' }).isDisabled(), false);
      }
      await pane('选手与模型', 'workers', () => page.getByRole('group', { name: 'Cursor · Grok · Grok 4.7' }).waitFor())();
      assert.deepEqual(await page.locator('[data-who]').evaluateAll(rows => rows.map(r => r.getAttribute('data-who'))), ['codex', 'codex-luna', 'grok', 'cursor-grok', 'cursor-opus', 'cursor-sonnet', 'deepseek', 'deepseek-flash']);
      assert.equal(await page.getByRole('switch', { name: '启用' }).count(), 8);
      // DeepSeek 组在最下面：只开高档，没有快速版，组头不写用量（按用量扣它自己的余额）。
      await page.getByRole('group', { name: 'DeepSeek · Flash · DeepSeek V4.1 Flash' }).scrollIntoViewIfNeeded();
      await shot(variant.name, 'settings-workers-deepseek');
      await pane('接入 AI', 'intro', () => page.locator('.intro-text').waitFor())();
      // 一键接入五家，最后一行是 DeepSeek Harness（用 DeepSeek 的图标）。
      await page.getByRole('group', { name: 'DeepSeek Harness' }).scrollIntoViewIfNeeded();
      await shot(variant.name, 'settings-intro-connect');
      await pane('看板颜色', 'colors', () => page.getByLabel('进行中').waitFor())();
      if (variant.name === 'light') {
        // 键盘：上下键在左栏切换分页（不用鼠标）；选手页里用空格改“快速版”，主进程真的存下，再改回去。
        await tab('看板颜色').focus();
        await page.keyboard.press('ArrowUp');
        assert.equal(await tab('选手与模型').getAttribute('aria-selected'), 'true');
        assert.equal(await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle), 'solid', '键盘操作时左栏有焦点框');
        await shot(variant.name, 'settings-keyboard');
        const fast = page.getByRole('group', { name: 'Cursor · Grok · Grok 4.7' }).getByRole('checkbox', { name: '快速版' });
        await fast.focus();
        await page.keyboard.press('Space');
        await page.waitForFunction(async () => (await window.xa.getSettings()).workers['cursor-grok'].fast === false);
        assert.equal(await fast.getAttribute('aria-checked'), 'false');
        await page.keyboard.press('Space');
        await page.waitForFunction(async () => (await window.xa.getSettings()).workers['cursor-grok'].fast === true);
        assert.equal(await fast.getAttribute('aria-checked'), 'true');
        // 关掉一个模型：整行变淡、强度和快速版点不动，截图后再打开。
        const opus = page.getByRole('group', { name: 'Cursor · Claude · Claude Opus 5.5' });
        await opus.getByRole('switch', { name: '启用' }).click();
        await page.waitForFunction(async () => (await window.xa.getSettings()).workers['cursor-opus'].enabled === false);
        assert.equal(await opus.getByRole('checkbox', { name: '高档', exact: true }).isDisabled(), true);
        assert.equal(await opus.getByRole('checkbox', { name: '高档', exact: true }).getAttribute('aria-checked'), 'true', '关掉后勾选保留');
        await shot(variant.name, 'settings-workers-off');
        await opus.getByRole('switch', { name: '启用' }).click();
        await page.waitForFunction(async () => (await window.xa.getSettings()).workers['cursor-opus'].enabled === true);
        await page.keyboard.press('Escape');
        await page.getByRole('dialog', { name: '设置', exact: true }).waitFor({ state: 'detached' });
        await application.evaluate(({ Menu }) => Menu.getApplicationMenu()!.items[0].submenu!.items[0].click());
        await page.getByRole('dialog', { name: '设置', exact: true }).waitFor();
        assert.equal(await tab('选手与模型').getAttribute('aria-selected'), 'true', '关掉再打开，还在上次的分页');
        await tab('看板颜色').click();
      }
      await page.keyboard.press('Escape');
      // 历史（展开一批看各家）和各家表现。
      await page.keyboard.press('Meta+2');
      // 点一行只展开（不再弹窗）：每家一行，看得到打的分、优点毛病标签和评语。
      await page.locator('.hsum').filter({ hasText: '两家对比：修复题' }).click();
      assert.equal(await page.getByRole('dialog').count(), 0, '点历史里的一行只展开，不弹窗');
      const members = page.locator('.hmember');
      assert.equal(await members.count(), 2);
      assert.match(await members.first().textContent() ?? '', /5 分/); assert.match(await members.nth(1).textContent() ?? '', /2 分/);
      assert.equal(await members.nth(1).locator('.hrate .chip-bad').count(), 2, '毛病标签：需要返工、夸大结论');
      await members.nth(1).getByText('说全过了，其实有一项没跑').waitFor();
      await shot(variant.name, 'history');
      await page.keyboard.press('Meta+3');
      await page.getByRole('heading', { name: '表现', level: 1 }).waitFor();
      // 每格：平均分、返工比例、优点（绿）毛病（红）标签；打了分不到 3 件的淡显；点一格在这一行下面展开最近的评语。
      const codexCell = page.locator('.pcell').filter({ hasText: '4.0 分' });
      assert.equal(await codexCell.count(), 1);
      assert.match(await codexCell.textContent() ?? '', /返工 33%/);
      assert.equal(await codexCell.evaluate(el => el.classList.contains('thin')), false, 'Codex 打了 3 件，不淡显');
      assert.deepEqual(await codexCell.locator('.chip-ok').allTextContents(), ['一次做对', '报告老实']);
      assert.deepEqual(await codexCell.locator('.chip-bad').allTextContents(), ['需要返工']);
      const grokCell = page.locator('.pcell').filter({ hasText: '2.0 分' });
      assert.match(await grokCell.textContent() ?? '', /返工 100%/);
      assert.equal(await grokCell.evaluate(el => el.classList.contains('thin')), true, '只打了 1 件，淡显');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) <= 0, `${variant.name}：表现页不许横向溢出`);
      // 表现页上半部分是仪表盘：筛选一行、五块大数、额度花费、各家对比。
      assert.equal(await page.getByRole('tablist', { name: '时间范围' }).count(), 1);
      assert.equal(await page.locator('.stat-tile').count(), 5);
      assert.ok(await page.locator('.dash-table').count() >= 1);
      await shot(variant.name, 'stats');
      await codexCell.click();
      const reviews = page.getByRole('region', { name: '最近的评语' });
      await reviews.waitFor();
      assert.equal(await codexCell.getAttribute('aria-expanded'), 'true');
      assert.equal(await reviews.getByRole('listitem').count(), 2, '只有写了评语的两件进“最近的评语”');
      await reviews.getByText('做得好：一次做对，还指出了说明里的一处错').waitFor();
      await reviews.getByText('要改进：漏了一种情况，负责人补了测试').waitFor();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) <= 0, `${variant.name}：展开评语后表现页不许横向溢出`);
      await shot(variant.name, 'stats-reviews');
      await codexCell.click();
      await reviews.waitFor({ state: 'detached' });
      await page.keyboard.press('Meta+1');
      await page.getByTestId('running').waitFor();
    }
    // 更窄的窗口（760，比窗口最小宽度还窄，先放开最小宽度）：状态块和设置按钮都在，分段不换行不被挤掉。
    await application.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.setMinimumSize(300, 600); win.setSize(760, 820); });
    await page.waitForFunction(() => window.innerWidth <= 760);
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await topbar(theme, 760, 'narrow760');
      for (const selector of ['.seg', '.status', '.top-icon']) assert.ok(await header.locator(selector).isVisible(), `760 宽时 ${selector} 仍在`);
      const fits = await header.evaluate(el => { const w = el.getBoundingClientRect().width; return [...el.querySelectorAll('.seg, .status, .top-icon')].every(c => c.getBoundingClientRect().right <= w) && el.scrollWidth <= el.clientWidth; });
      assert.equal(fits, true, '760 宽时顶栏没有横向溢出');
      assert.equal(await header.locator('.seg-tab').evaluateAll(tabs => tabs.every(t => t.getBoundingClientRect().height <= 24)), true, '分段文字不换行');
    }
    await application.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.setSize(1280, 820); win.setMinimumSize(900, 600); });
    await page.waitForFunction(() => window.innerWidth >= 1280);
    // 键盘：焦点在当前分段上才显示焦点框；← → 切页，焦点跟着走。
    await page.keyboard.press('Shift'); // 记为键盘操作
    await header.locator('.seg-tab[aria-selected="true"]').focus();
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-selected')), 'true');
    assert.equal(await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle), 'solid', '键盘操作时分段有焦点框');
    await page.emulateMedia({ colorScheme: 'light' });
    await topbar('light', 1280, 'focus');
    await page.keyboard.press('ArrowRight');
    await page.getByRole('heading', { name: '历史' }).waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), '历史');
    await page.keyboard.press('ArrowLeft');
    await page.getByTestId('running').waitFor();
    await page.locator('body').click({ position: { x: 5, y: 300 } });
    // 验收中的活拿掉之后，列头归零，空列写“没有在验收的活”。
    for (const id of ['undecided', 'lost', 'pair-a', 'pair-b', 'new-attention', 'new-failed']) await rm(join(home, 'jobs', id), { recursive: true, force: true });
    for (const id of ['solo', 'pair']) await rm(join(home, 'batches', id + '.json'), { force: true });
    await page.waitForFunction(() => document.querySelector('[data-testid="attention"]')?.textContent === '0');
    await page.getByText('没有在验收的活').waitFor();
    for (const theme of ['light', 'dark'] as const) { await page.emulateMedia({ colorScheme: theme }); await topbar(theme, 1280, 'calm'); }
    // ---- 两个项目：看板已完成列按项目分组、卡片带项目小标签；历史页左栏按项目归档、右栏按天分组 ----
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3600e3).toISOString();
    const dayAt = (daysBack: number, hour: number) => { const d = new Date(); d.setDate(d.getDate() - daysBack); d.setHours(hour, 0, 0, 0); return d.toISOString(); };
    const finished = (id: string, project: string, title: string, ended: string, extra: Partial<Job> = {}) => fixture(id, 'done', { project, title, kind: '实现', seconds: 600 + ended.length,
      created: new Date(Date.parse(ended) - 900e3).toISOString(), started: new Date(Date.parse(ended) - 800e3).toISOString(), ended, decision: { kind: 'adopt', by: 'lead', at: ended }, ...extra });
    const shipped = [
      finished('p1', '派活工作台', '把历史页按项目归档', hoursAgo(2), { rating: rating(5, ['一次做对', '速度快'], { good: '一次做对，还顺手补了测试' }) }),
      finished('p2', '派活工作台', '看板已完成列分组', hoursAgo(5), { who: 'grok', kind: '优化', rating: rating(4, ['考虑周到', '偏慢'], { good: '连折叠的边界都想到了', improve: '文案有一处含糊' }) }),
      finished('p3', '派活工作台', '额度环颜色', hoursAgo(9), { kind: '修复' }),
      finished('p4', '派活工作台', '修通知重复发送', hoursAgo(14), { kind: '修复', decision: { kind: 'drop', by: 'lead', at: now }, rating: rating(2, ['需要返工'], { improve: '只改了症状，没找到重复的原因' }) }),
      finished('c1', '画布', '画笔粗细可调', hoursAgo(1), { rating: rating(4, ['一次做对', '需要返工'], { good: '手感很顺', improve: '第一版漏了触控板' }) }),
      finished('c2', '画布', '撤销与重做', hoursAgo(3), { who: 'cursor-opus', rating: rating(5, ['主动发现问题'], { good: '发现历史栈会无限增长并顺手限了上限' }) }),
      finished('c3', '画布', '导出 PNG', hoursAgo(6), { kind: '优化' }),
      finished('c4', '画布', '图层面板', hoursAgo(10)),
      finished('c5', '画布', '橡皮擦', hoursAgo(15), { kind: '修复', rating: rating(3, [], { improve: '没测缩放后的位置' }) }),
      finished('c6', '画布', '快捷键', hoursAgo(20)),
      finished('old-p1', '派活工作台', '通知去重', dayAt(1, 12), { kind: '修复', rating: rating(5, ['一次做对']) }),
      finished('old-p2', '派活工作台', '设置页分页记忆', dayAt(4, 10)),
      finished('old-c1', '画布', '缩放和平移', dayAt(1, 9), { rating: rating(4, ['代码规整'], { good: '结构清楚' }) }),
      finished('old-c2', '画布', '选区工具', dayAt(4, 15), { kind: '修复' }),
    ];
    const canvasRunning = fixture('c-run', 'running', { project: '画布', title: '文字工具', pid: process.pid });
    const canvasFailed = fixture('c-fail', 'failed', { project: '画布', title: '协同光标', kind: '实现' });
    const before = (await inspect()).notices.length;
    for (const job of [...shipped, canvasRunning, canvasFailed]) await save(job);
    await waitForNotices(before + shipped.length);
    await page.waitForFunction(() => document.querySelectorAll('.column.c-done section').length === 2, undefined, { timeout: 3000 });
    // 几件活是一件件写进去的，最后写的“进行中的画布活”也要等它推到界面上，再往下检查（以前偶尔差这一拍）。
    await page.locator('.column.c-running .ctitle > .chip', { hasText: '画布' }).first().waitFor();
    await page.locator('.column.c-attention .ctitle > .chip', { hasText: '画布' }).first().waitFor();
    const within = (project: string) => shipped.filter(j => j.project === project && Date.parse(j.ended!) >= Date.now() - 86400e3 + 60e3).length;
    for (const variant of [
      { name: 'light', theme: 'light', width: 1280 },
      { name: 'dark', theme: 'dark', width: 1280 },
      { name: 'narrow', theme: 'light', width: 900 },
    ] as const) {
      await application.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 820), variant.width);
      await page.emulateMedia({ colorScheme: variant.theme });
      await page.keyboard.press('Meta+1');
      await page.locator('#v-board').waitFor();
      // 已完成列按项目聚合：一个项目一张卡，标题栏是项目名和件数，项目按最近完成排；每张卡最多 5 行，卡底“这个项目的全部 →”。
      const groups = page.locator('.column.c-done section');
      assert.deepEqual(await groups.locator('.bhead .t').allTextContents(), ['派活工作台', '画布'], '项目按最近完成排：派活工作台的“已采用”是刚刚完成的');
      assert.deepEqual(await groups.locator('.bhead .n').allTextContents(), [String(within('派活工作台') + 2), String(within('画布'))]);
      for (const n of [0, 1]) assert.ok(await groups.nth(n).locator('.done-row').count() <= 5, '每个项目最多 5 行');
      assert.equal(await groups.nth(0).getByRole('button', { name: '更多操作：派活工作台', exact: true }).locator('svg circle').count(), 3, '“…”是三个居中的点');
      assert.equal(await groups.nth(0).getByRole('button', { name: '这个项目的全部 →' }).textContent(), '这个项目的全部 →');
      assert.equal(await page.locator('.column.c-done .chip', { hasText: /^(派活工作台|画布)$/ }).count(), 0, '行里不再写项目名，卡的标题栏已经说明');
      // 折叠：点“画布”卡的标题栏，只剩项目名和件数；截图后再展开。
      const canvasHead = groups.nth(1).locator('.done-head');
      await canvasHead.click();
      assert.equal(await canvasHead.getAttribute('aria-expanded'), 'false'); assert.equal(await groups.nth(1).locator('.done-row').count(), 0);
      await shot(variant.name, 'board-collapsed');
      await canvasHead.click();
      assert.equal(await groups.nth(1).locator('.done-row').count() > 0, true);
      // 进行中、验收中：同时有两个项目时，卡片题目旁带项目小标签。
      assert.ok(await page.locator('.column.c-running .ctitle > .chip', { hasText: '画布' }).count() >= 1, '进行中的画布卡片带项目标签');
      assert.ok(await page.locator('.column.c-running .ctitle > .chip', { hasText: '派活工作台' }).count() >= 1, '排队的活也带项目标签');
      assert.equal(await page.locator('.column.c-attention .ctitle > .chip', { hasText: '画布' }).count(), 1, '验收中的画布卡片带项目标签');
      assert.ok(await page.locator('.column.c-running .bhead .chip', { hasText: '派活工作台' }).count() >= 1, '一批同时在跑的大卡也带项目标签');
      const fit = await page.evaluate(() => ({ page: document.documentElement.scrollWidth - window.innerWidth, clipped: [...document.querySelectorAll('#v-board .column, #v-board .cbody')].filter(c => c.scrollWidth > c.clientWidth + 1).length }));
      assert.ok(fit.page <= 0 && fit.clipped === 0, `${variant.name}：分组后看板不许横向溢出`);
      await shot(variant.name, 'board-projects');
      // 历史页：左栏“全部”加每个项目（件数、最近一次），右栏按天分组。
      await page.keyboard.press('Meta+2');
      const rail = page.getByRole('tab', { name: /^全部/ }); await rail.click();
      const tabs = await page.locator('.history-layout .sidenav-tab').evaluateAll(list => list.map(t => [t.querySelector('.sidenav-label')!.textContent, t.querySelector('.sidenav-badge')!.textContent]));
      assert.deepEqual(tabs, [['全部', '17'], ['画布', '9'], ['派活工作台', '8']], '左栏：全部，再按最近活动排项目，件数是一批算一件');
      const dayTitles = await page.locator('.day').allTextContents();
      assert.equal(dayTitles[0], '今天'); assert.ok(dayTitles.includes('昨天')); assert.match(dayTitles.at(-1)!, /^\d+ 月 \d+ 日（星期[日一二三四五六]）$/);
      assert.ok(await page.locator('.hsum > .right > .chip', { hasText: /^画布$/ }).count() >= 1, '“全部”里每行带项目小标签');
      await shot(variant.name, 'history-all');
      await page.getByRole('tab', { name: /^画布/ }).click();
      assert.equal(await page.locator('.hsum > .right > .chip', { hasText: /^(画布|派活工作台)$/ }).count(), 0, '选了具体项目就不再写项目小标签');
      assert.equal(await page.locator('.hrow').count(), 9);
      assert.equal(await page.evaluate(() => localStorage.getItem('xa.history-project')), '画布', '选中的项目记在本机');
      await shot(variant.name, 'history-project');
      // 展开一行：每家一行，打分、优点毛病标签和评语。
      await page.locator('.hsum').filter({ hasText: '画笔粗细可调' }).click();
      const open = page.locator('.hmember').first();
      assert.match(await open.textContent() ?? '', /4 分/);
      assert.deepEqual(await open.locator('.hrate .chip-ok').allTextContents(), ['一次做对']); assert.deepEqual(await open.locator('.hrate .chip-bad').allTextContents(), ['需要返工']);
      await open.getByText('手感很顺').waitFor(); await open.getByText('第一版漏了触控板').waitFor();
      await page.locator('.hsum').filter({ hasText: '图层面板' }).click();
      await page.getByText('还没打分').first().waitFor();
      await shot(variant.name, 'history-open');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) <= 0, `${variant.name}：历史页不许横向溢出`);
      // 从看板卡底跳过来：回到看板，点“派活工作台”卡底的“这个项目的全部 →”，历史页选中它。
      await page.keyboard.press('Meta+1');
      await page.locator('.column.c-done section', { hasText: '派活工作台' }).getByRole('button', { name: '这个项目的全部 →' }).click();
      await page.getByRole('heading', { name: '历史' }).waitFor();
      assert.equal(await page.getByRole('tab', { name: /^派活工作台/ }).getAttribute('aria-selected'), 'true');
    }
    // ---- 菜单归档 → 底部撤销 → 卡回来；各主题截图后再次归档，保留历史页取消流程。 ----
    await page.keyboard.press('Meta+1');
    await page.locator('#v-board').waitFor();
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 820));
    await page.waitForFunction(() => window.innerWidth >= 1280);
    await page.emulateMedia({ colorScheme: 'light' });
    const kept = within('派活工作台') + 2;
    const canvasCard = page.getByRole('region', { name: '画布', exact: true });
    const more = page.getByRole('button', { name: '更多操作：画布', exact: true });
    const archiveItem = page.getByRole('menuitem', { name: '归档' });
    const toast = page.getByRole('status').filter({ hasText: '已归档 画布，可在历史页“已归档”里找回' });
    const config = () => readFile(join(home, 'config.json'), 'utf8').then(text => JSON.parse(text) as { archivedProjects?: string[] });
    for (const variant of [
      { name: 'light', theme: 'light', width: 1280 },
      { name: 'dark', theme: 'dark', width: 1280 },
      { name: 'narrow', theme: 'light', width: 840 },
    ] as const) {
      await application.evaluate(({ BrowserWindow }, width) => {
        const win = BrowserWindow.getAllWindows()[0]; win.setMinimumSize(300, 600); win.setSize(width, 820);
      }, variant.width);
      await page.waitForFunction(width => window.innerWidth === width, variant.width);
      await page.emulateMedia({ colorScheme: variant.theme });
      const head = canvasCard.locator('.done-head');
      const expanded = await head.getAttribute('aria-expanded');
      await more.click(); await archiveItem.waitFor();
      assert.equal(await head.getAttribute('aria-expanded'), expanded, '点更多操作不改变折叠状态');
      assert.deepEqual((await config()).archivedProjects ?? [], [], '只打开菜单不归档');
      await shot(variant.name, 'archive-menu');
      await page.keyboard.press('Escape');
      assert.equal(await more.evaluate(el => el === document.activeElement), true, 'Esc 焦点回按钮');
      // 标题栏右键和按钮是同一个菜单，打开后检查菜单四边都在窗口内。
      await head.click({ button: 'right' }); await archiveItem.waitFor();
      const bounds = await page.getByRole('menu').boundingBox();
      assert.ok(bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= variant.width && bounds.y + bounds.height <= await page.evaluate(() => window.innerHeight), '右键菜单在窗口内');
      assert.equal(await head.getAttribute('aria-expanded'), expanded, '右键不改变折叠状态');
      await page.keyboard.press('Escape');
      await page.keyboard.press('ArrowDown');
      for (const key of ['ArrowUp', 'ArrowDown', 'Home', 'End']) await page.keyboard.press(key);
      assert.equal(await archiveItem.evaluate(el => el === document.activeElement), true, '单项菜单上下循环和 Home/End 都选中归档');
      await page.keyboard.press('Escape');
      await more.click(); await archiveItem.click();
      await toast.waitFor(); await toast.hover();
      await canvasCard.waitFor({ state: 'detached' });
      assert.deepEqual((await config()).archivedProjects, ['画布']);
      await shot(variant.name, 'archive-toast');
      const toastBounds = await toast.boundingBox();
      assert.ok(toastBounds && toastBounds.x >= 0 && toastBounds.x + toastBounds.width <= variant.width, '提示条窄窗口不溢出');
      await toast.getByRole('button', { name: '撤销', exact: true }).click();
      await toast.waitFor({ state: 'detached' }); await canvasCard.waitFor();
      assert.deepEqual((await config()).archivedProjects, [], '底部撤销从名单移除画布');
    }
    await application.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.setSize(1280, 820); win.setMinimumSize(900, 600); });
    await page.waitForFunction(() => window.innerWidth >= 1280);
    await page.emulateMedia({ colorScheme: 'light' });
    await more.click(); await archiveItem.click(); await toast.waitFor();
    for (let i = 0; i < 80 && !(await config()).archivedProjects?.includes('画布'); i++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual((await config()).archivedProjects, ['画布'], 'config.json 记下画布');
    await page.waitForFunction(() => document.querySelectorAll('.column.c-done section').length === 1 && !document.querySelector('.column.c-done section[aria-label="画布"]'));
    assert.equal(await page.getByTestId('done').textContent(), String(kept), '列头件数不含已归档的画布');
    assert.equal(await page.locator('.column.c-done .bhead .t').textContent(), '派活工作台');
    assert.ok((await page.locator('.column.c-running').textContent())!.includes('文字工具'), '进行中的画布活还在');
    assert.ok(await page.locator('.column.c-running .ctitle > .chip', { hasText: '画布' }).count() >= 1);
    assert.ok((await page.locator('.column.c-attention').textContent())!.includes('协同光标'), '验收中的画布活还在');
    assert.equal(await page.locator('.column.c-attention .ctitle > .chip', { hasText: '画布' }).count(), 1);
    await page.keyboard.press('Meta+2');
    const archivedFold = page.getByRole('button', { name: '已归档 1 个项目', exact: true });
    await archivedFold.waitFor();
    assert.equal(await archivedFold.getAttribute('aria-expanded'), 'false', '已归档默认折起');
    assert.equal(await page.getByRole('button', { name: '取消归档', exact: true }).count(), 0);
    assert.deepEqual(await page.locator('.history-layout .sidenav-tab').evaluateAll(list => list.map(t => [t.querySelector('.sidenav-label')!.textContent, t.querySelector('.sidenav-badge')!.textContent])), [['全部', '8'], ['派活工作台', '8']]);
    await page.getByRole('tab', { name: /^全部/ }).click();
    assert.equal(await page.locator('.hrow').count(), 8);
    assert.equal(await page.locator('.hsum > .right > .chip', { hasText: /^画布$/ }).count(), 0, '全部不含已归档项目');
    await archivedFold.click();
    assert.equal(await archivedFold.getAttribute('aria-expanded'), 'true');
    const archivedCanvas = page.locator('.sidenav-archived-list > .sidenav-tab').filter({ hasText: '画布' });
    assert.equal(await archivedCanvas.locator('.sidenav-badge').textContent(), '9');
    await archivedCanvas.click();
    assert.equal(await archivedCanvas.getAttribute('aria-current'), 'true');
    assert.match((await page.locator('.arch-note').textContent())!, /^这个项目已归档/, '选中已归档项目，右栏顶上写明并给“取消归档”');
    assert.equal(await page.locator('.hrow').count(), 9);
    for (const variant of [
      { name: 'light', theme: 'light', width: 1280, narrow: false },
      { name: 'dark', theme: 'dark', width: 1280, narrow: false },
      { name: 'narrow', theme: 'light', width: 840, narrow: true },
    ] as const) {
      if (variant.narrow) {
        await application.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.setMinimumSize(300, 600); win.setSize(840, 820); });
        await page.waitForFunction(() => window.innerWidth <= 860);
      } else {
        await application.evaluate(({ BrowserWindow }, width) => { const win = BrowserWindow.getAllWindows()[0]; win.setMinimumSize(900, 600); win.setSize(width, 820); }, variant.width);
        await page.waitForFunction(() => window.innerWidth >= 1200);
      }
      await page.emulateMedia({ colorScheme: variant.theme });
      await page.keyboard.press('Meta+1');
      await page.locator('#v-board').waitFor();
      await page.locator('.column.c-done section', { hasText: '派活工作台' }).waitFor();
      assert.equal(await page.locator('.column.c-done section', { hasText: '画布' }).count(), 0);
      await shot(variant.name, 'archive-board');
      await page.keyboard.press('Meta+2');
      const fold = page.getByRole('button', { name: '已归档 1 个项目', exact: true });
      await fold.waitFor();
      if (await fold.getAttribute('aria-expanded') !== 'true') await fold.click();
      await page.locator('.sidenav-archived-list .sidenav-badge', { hasText: '9' }).waitFor();
      await shot(variant.name, 'archive-history');
    }
    await application.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.setSize(1280, 820); win.setMinimumSize(900, 600); });
    await page.waitForFunction(() => window.innerWidth >= 1280);
    await page.getByRole('button', { name: '取消归档', exact: true }).click();
    await archivedFold.waitFor({ state: 'detached' });
    for (let i = 0; i < 80 && ((await config()).archivedProjects ?? ['画布']).length !== 0; i++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual((await config()).archivedProjects, [], '取消归档后名单清空');
    await page.getByRole('tab', { name: /^画布/ }).waitFor();
    await page.keyboard.press('Meta+1');
    await page.locator('.column.c-done section', { hasText: '画布' }).waitFor();
    assert.equal(await page.locator('.column.c-done section').count(), 2, '取消归档后画布的卡回到已完成列');
    // ---- 外观：设置里通用页最上面三选一；不靠 emulateMedia，看真的切了 nativeTheme 和窗口底色 ----
    await page.emulateMedia({ colorScheme: null });
    await page.keyboard.press('Meta+1');
    await page.locator('#v-board').waitFor();
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 820));
    await application.evaluate(({ Menu }) => Menu.getApplicationMenu()!.items[0].submenu!.items[0].click());
    const settingsDialog = page.getByRole('dialog', { name: '设置', exact: true }); await settingsDialog.waitFor();
    await settingsDialog.getByRole('tab', { name: '通用', exact: true }).click();
    const appearance = settingsDialog.getByRole('tablist', { name: '外观' });
    assert.deepEqual(await appearance.getByRole('tab').allTextContents(), ['跟随系统', '浅色', '深色']);
    assert.equal(await appearance.getByRole('tab', { name: '跟随系统' }).getAttribute('aria-selected'), 'true', '缺省是跟随系统');
    const paint = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const winColor = () => application!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBackgroundColor().toLowerCase());
    const theme = () => application!.evaluate(({ nativeTheme }) => nativeTheme.themeSource);
    const pick = async (label: string, value: string) => {
      await appearance.getByRole('tab', { name: label }).click();
      await page.waitForFunction(async v => (await window.xa.getSettings()).appearance === v, value);
      // 主进程保存成功后才赋值，轮询等它。
      for (let i = 0; i < 100 && await theme() !== value; i++) await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(await theme(), value); assert.equal(await appearance.getByRole('tab', { name: label }).getAttribute('aria-selected'), 'true');
    };
    await pick('深色', 'dark');
    assert.equal(await paint(), 'rgb(19, 19, 18)', '选了深色：页面立刻是深色底'); assert.equal(await winColor(), '#131312', '窗口底色跟着换');
    assert.equal(JSON.parse(await readFile(join(home, 'config.json'), 'utf8')).appearance, 'dark', '存进 config.json');
    await page.keyboard.press('Escape'); await settingsDialog.waitFor({ state: 'detached' });
    await page.waitForFunction(() => !document.querySelector('.logo img[data-state="pending"]'));
    await page.screenshot({ animations: 'disabled', path: join(output, 'desktop-appearance-dark-board.png') });
    await application.evaluate(({ Menu }) => Menu.getApplicationMenu()!.items[0].submenu!.items[0].click()); await settingsDialog.waitFor();
    assert.equal(await appearance.getByRole('tab', { name: '深色' }).getAttribute('aria-selected'), 'true', '重开设置还记得');
    await pick('浅色', 'light');
    assert.equal(await paint(), 'rgb(245, 245, 242)'); assert.equal(await winColor(), '#f5f5f2');
    await page.screenshot({ animations: 'disabled', path: join(output, 'desktop-appearance-settings-light.png') });
    await pick('跟随系统', 'system');
    assert.equal(JSON.parse(await readFile(join(home, 'config.json'), 'utf8')).appearance, 'system');
    await page.keyboard.press('Escape'); await settingsDialog.waitFor({ state: 'detached' });
    await page.keyboard.press('Meta+1');
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false);
    assert.equal((await inspect()).tray.exists, true, '关闭窗口后菜单栏仍在');
    assert.equal((await inspect()).notices.length, before + shipped.length, '重复读取不重复发通知');
  } finally {
    if (previousHome === undefined) delete process.env.XAGENTS_HOME; else process.env.XAGENTS_HOME = previousHome;
    try { await application?.close(); } finally { await rm(temp, { recursive: true, force: true, maxRetries: 5 }); }
  }
});
