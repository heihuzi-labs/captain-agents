import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App } from '../../app/renderer/App.tsx';
import { batchColors, BATCH_HUES, derive, fmtDur, fmtNum, human, loadPosition, navigation, savePosition, shareView, typicalTimes } from '../../app/renderer/lib/board.ts';
import type { View } from '../../src/core/view-types.ts';
import { fixtureJob as job, fixtureView as view, fixtureBridge } from './fixtures.tsx';
// 已完成列的项目卡默认折起；这里的测试要看卡里的行，先把用到的项目都记成“已展开”（折叠本身在“项目卡默认折起”那项测试里单独测）。
const EXPAND_ALL = () => localStorage.setItem('xa.done-expanded', JSON.stringify(['派活工作台', '画布', 'P', '空项目', '默认项目', '未归类', 'xa', '<b>画布</b>']));
beforeEach(EXPAND_ALL);
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function bridge(v: View) {
  let push: ((v: View) => void) | undefined;
  window.xa = fixtureBridge({
    getView: vi.fn(async () => v),
    onView: fn => {
      push = fn;
      return () => {};
    }
  });
  return (next: View) => act(() => push?.(next));
}
function batchView() {
  const v = view();
  v.jobs = [job('a', {
    batch: 'batch'
  }), job('b', {
    batch: 'batch',
    who: 'grok'
  })];
  v.batches = [{
    id: 'batch',
    title: '同一道题', summary: '这一批的说明',
    kind: '实现',
    base: 'base',
    started: v.jobs[0].started,
    jobs: ['a', 'b']
  }];
  return v;
}
test('推导：整批待拍板、活跃批次、失联、验收失败、已决定和 24 小时边界', () => {
  const v = batchView();
  expect(derive(v).attention.map(e => e.type)).toEqual(['decide']);
  expect(derive(v).done).toHaveLength(0);
  v.jobs[0].state = 'running';
  expect(derive(v).attention).toHaveLength(0);
  v.jobs[1].state = 'lost';
  expect(derive(v).attention.map(e => e.type)).toEqual(['lost']);
  v.jobs[0].state = 'failed';
  expect(derive(v).done).toHaveLength(0);
  expect(derive(v).attention.map(e => e.type)).toEqual(['failed', 'lost']);
  v.jobs.forEach(j => {
    j.state = 'done';
    j.decision = {
      kind: 'drop', by: 'lead', at: ''
    };
  });
  expect(derive(v).done).toHaveLength(1);
  v.jobs.forEach(j => j.ended = new Date(Date.now() - 86400e3 - 10).toISOString());
  expect(derive(v).done).toHaveLength(0);
  const lone = view();
  lone.jobs = [job('failed-check', {
    check: {
      ok: false,
      label: '没过',
      note: ''
    }
  })];
  expect(derive(lone).attention[0].type).toBe('check');
  lone.jobs[0].decision = {
    kind: 'drop', by: 'lead', at: ''
  };
  expect(derive(lone).attention).toHaveLength(0);
  expect(derive(lone).done).toHaveLength(1);
});
test('批次颜色按派出顺序轮换，单家不占用颜色', () => {
  const batches = Array.from({
    length: 8
  }, (_, i) => ({
    id: String(i),
    title: '', summary: '',
    kind: '',
    base: '',
    started: String(i),
    jobs: ['a', 'b']
  }));
  batches.push({
    ...batches[0],
    id: 'single',
    jobs: ['a']
  });
  const colors = batchColors(batches.reverse());
  expect(colors.get('0')).toBe(BATCH_HUES[0]);
  expect(colors.get('6')).toBe(BATCH_HUES[0]);
  expect(colors.has('single')).toBe(false);
});
test('人话、格式和同选手同类型的中位数及回退', () => {
  expect(human()).toBe('刚开始');
  for (const [kind, text, want] of [['say', 'hello\n world', 'hello world'], ['edit', 'a.ts', '在改代码'], ['cmd', 'npm test', '在跑测试'], ['cmd', 'git diff', '在看代码变化'], ['cmd', 'npm install', '在装依赖'], ['read', 'x', '在查资料、读代码'], ['cmd', 'other', '在执行命令']] as const) expect(human({
    at: '',
    kind,
    text
  })).toBe(want);
  expect(fmtDur(65)).toBe('1 分 05 秒');
  expect(fmtNum(12000)).toBe('1.2 万');
  // “通常多久”由核心算好随卡片传来，界面只读，不再自己算。
  expect(typicalTimes([])(job('x', { typical: 300 }))).toBe(300);
  expect(typicalTimes()(job('x', { typical: null }))).toBeNull();
});
test('弹窗批内前后顺序、返回一批、Esc 和暗处关闭', async () => {
  const v = batchView(); bridge(v); render(<App />);
  fireEvent.click(await screen.findByText('负责人在挑'));
  let dialog = screen.getByRole('dialog');
  expect(within(dialog).getByText('这一批的说明')).toBeTruthy();
  fireEvent.click(within(dialog).getByRole('img', { name: 'Codex' }));
  dialog = screen.getByRole('dialog');
  expect(dialog.querySelector('.job-title')?.textContent).toBe('a');
  expect(within(dialog).queryByRole('tab')).toBeNull();
  fireEvent.keyDown(document, { key: 'ArrowRight' });
  expect(dialog.querySelector('.job-title')?.textContent).toBe('b');
  fireEvent.keyDown(document, { key: 'ArrowLeft' });
  expect(dialog.querySelector('.job-title')?.textContent).toBe('a');
  fireEvent.click(within(dialog).getByText('← 这一批（2 家）'));
  expect(within(dialog).getByText('同一道题')).toBeTruthy();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(screen.getByText('负责人在挑'));
  fireEvent.click(document.querySelector('.scrim')!);
  expect(screen.queryByRole('dialog')).toBeNull();
});
test('批外按看板顺序，不按登记处顺序切换', () => {
  const v = view();
  v.jobs = [job('done'), job('running', {
    state: 'running'
  })];
  const order = [{
    kind: 'job' as const,
    id: 'running'
  }, {
    kind: 'job' as const,
    id: 'done'
  }];
  expect(navigation(order[0], v, order).list[1].id).toBe('done');
});
test('快捷键、筛选和视图记忆；localStorage 不可用时容错', async () => {
  const v = view();
  v.jobs = [job('a', {
    kind: '研究'
  }), job('b')];
  bridge(v);
  render(<App />);
  await screen.findByText('现在没有在跑的活');
  fireEvent.keyDown(document, {
    key: '2',
    metaKey: true
  });
  fireEvent.click(screen.getByRole('button', {
    name: '研究'
  }));
  expect(loadPosition()).toEqual({
    page: 'history',
    filter: '研究'
  });
  fireEvent.keyDown(document, {
    key: '3',
    metaKey: true
  });
  expect(screen.getByRole('heading', {
    name: '表现', level: 1
  })).toBeTruthy();
  fireEvent.keyDown(document, {
    key: 'r',
    metaKey: true
  });
  expect(window.xa.getView).toHaveBeenCalledTimes(2);
  fireEvent.keyDown(document, {
    key: '1',
    metaKey: true
  });
  expect(screen.getByText('现在没有在跑的活')).toBeTruthy();
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw Error('denied');
  });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw Error('denied');
  });
  expect(loadPosition()).toEqual({
    page: 'board',
    filter: '全部'
  });
  expect(() => savePosition('stats', '全部')).not.toThrow();
});
test('推送保留未变卡片引用；每秒只修改计时 DOM，静止卡片没有变动', async () => {
  vi.useFakeTimers();
  const v = view();
  v.jobs = [job('live', {
    state: 'running',
    seconds: null
  }), job('stable')];
  const push = bridge(v);
  await act(async () => {
    render(<App />);
  });
  expect(screen.getByText('正在')).toBeTruthy();
  const stable = screen.getByText('负责人在挑').closest('.card')!;
  const mutations: MutationRecord[] = [];
  const observer = new MutationObserver(records => mutations.push(...records));
  observer.observe(stable, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true
  });
  const elapsed = document.querySelector('.elapsed')!.textContent;
  act(() => vi.advanceTimersByTime(1000));
  expect(document.querySelector('.elapsed')!.textContent).not.toBe(elapsed);
  const next = structuredClone(v);
  next.jobs[0].title = '新标题';
  expect(shareView(v, next).jobs[1]).toBe(v.jobs[1]);
  push(next);
  await Promise.resolve();
  expect(mutations).toHaveLength(0);
  observer.disconnect();
});
test('1000 条任务初次看板渲染不超过 1 秒', async () => {
  const v = view();
  v.jobs = Array.from({
    length: 1000
  }, (_, i) => job('任务' + i, {
    state: i < 30 ? 'running' : 'done',
    decision: i < 30 ? null : {
      kind: 'adopt', by: 'lead', at: ''
    },
    seconds: i < 30 ? null : 60
  }));
  bridge(v);
  const start = performance.now();
  render(<App />);
  await waitFor(() => expect(screen.getByTestId('done').textContent).toBe('970'));
  const elapsed = performance.now() - start;
  console.info(`1000 条任务渲染：${Math.round(elapsed)} ms`);
  expect(elapsed).toBeLessThan(1000);
  // 已完成列一个项目一张卡、最多 5 行，列头的数字仍是 970。
  expect(document.querySelectorAll('.card:not(.card-batch)')).toHaveLength(30); expect(document.querySelectorAll('.done-row')).toHaveLength(5);
});
test('1000 条任务全部在跑时也在 1 秒内渲染', async () => {
  const v = view();
  v.jobs = Array.from({
    length: 1000
  }, (_, i) => job('运行' + i, {
    state: 'running',
    seconds: null
  }));
  bridge(v);
  const start = performance.now();
  render(<App />);
  await waitFor(() => expect(screen.getByTestId('running').textContent).toBe('1000'));
  const elapsed = performance.now() - start;
  console.info(`1000 条运行卡片渲染：${Math.round(elapsed)} ms`);
  expect(elapsed).toBeLessThan(1000);
});
test('空额度池可显示；80% 黄、95% 红；图标失败退回字母', async () => {
  const v = view();
  v.jobs = [job('a', {
    state: 'running'
  })];
  v.quota = [{
    name: 'Codex',
    icon: 'codex',
    plan: null,
    at: null,
    bars: []
  }, {
    name: 'Grok',
    icon: 'grok',
    plan: null,
    at: null,
    bars: [{
      label: '额度',
      used: 80,
      reset: null
    }]
  }, {
    name: 'Cursor',
    icon: 'cursor',
    plan: null,
    at: null,
    bars: [{
      label: '额度',
      used: 95,
      reset: null
    }]
  }];
  bridge(v);
  render(<App />);
  await screen.findByRole('tablist');
  const ring = (name: string) => document.querySelector<HTMLElement>(`.ring[aria-label^="${name}"]`)!;
  expect(ring('Codex').hasAttribute('data-empty')).toBe(true);
  expect(ring('Codex').getAttribute('aria-label')).toBe('Codex：查不到额度');
  expect(ring('Grok').dataset.level).toBe('warn');
  expect(ring('Cursor').dataset.level).toBe('bad');
  fireEvent.error(document.querySelector('.ring img')!);
  expect(document.querySelector('.ring .mono-mark')?.textContent).toBe('C');
});
test('十分钟安静只把进度条变琥珀并改悬停说明，不写字；超时进度也变琥珀', async () => {
  vi.useFakeTimers();
  const v = view();
  v.jobs = [job('live', {
    state: 'running',
    started: new Date(Date.now() - 599000).toISOString(),
    seconds: null,
    typical: 300
  }), job('past', {
    seconds: 300,
    ended: new Date(Date.now() - 2 * 86400e3).toISOString(),
    decision: {
      kind: 'adopt', by: 'lead', at: ''
    }
  })];
  bridge(v);
  await act(async () => {
    render(<App />);
  });
  const card = document.querySelector('[data-job="live"]')!;
  expect(card.querySelector('.prog.quiet')).toBeNull();
  expect(card.querySelector('.prog.over')).toBeTruthy();
  act(() => vi.advanceTimersByTime(1000));
  expect(card.querySelector('.prog.quiet')).toBeTruthy();
  expect(card.getAttribute('title')).toBe('最近 10 分钟没有新动作');
  expect(card.textContent).not.toContain('没有新动作');
  expect(card.textContent).toContain('比平时久 5 分钟');
});

test('只有一家的批次直接打开单家弹窗', async () => {
  const v = view(); v.jobs = [job('one')];
  v.batches = [{ id: 'batch', title: '单家批次', summary: '', base: '', kind: '', started: '', jobs: ['one'] }];
  bridge(v); render(<App />);
  fireEvent.click(await screen.findByText('负责人在挑'));
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByRole('heading', { name: '要做什么' })).toBeTruthy();
  expect(within(dialog).queryByText('← 这一批（1 家）')).toBeNull();
});

function workersView() {
  const v = view();
  v.workers = { codex: { name: 'Codex', model: 'GPT-6 Astra', icon: 'codex' }, 'codex-luna': { name: 'Codex · Luna', model: 'GPT-6 Luna', icon: 'codex' }, grok: { name: 'Grok', model: 'Grok 4.7', icon: 'grok' },
    'cursor-grok': { name: 'Cursor · Grok', model: 'Grok 4.7', icon: 'cursor', badge: 'grok' }, 'cursor-opus': { name: 'Cursor · Claude', model: 'Claude Opus 5.5', icon: 'cursor', badge: 'claude' },
    'cursor-sonnet': { name: 'Cursor · Sonnet', model: 'Claude Sonnet 5.5', icon: 'cursor', badge: 'claude' } };
  return v;
}
const lead = (kind: 'adopt' | 'drop') => ({ kind, by: 'lead' as const, at: '' });
test('进行中的卡片写“模型 · 推理强度”；已完成列一件一行：小图标、题目、用时，一批两个图标、用时写最久的', async () => {
  const v = workersView();
  v.jobs = [job('live', { state: 'running', seconds: null, effort: 'xhigh' }), job('solo', { seconds: 900, decision: lead('adopt') }),
    job('d1', { batch: 'duel', who: 'cursor-opus', effort: 'xhigh', seconds: 1200, decision: lead('adopt') }), job('d2', { batch: 'duel', who: 'cursor-grok', seconds: 840, decision: lead('drop') })];
  v.batches = [{ id: 'duel', title: '两家对比', summary: '', kind: '实现', base: '', started: v.jobs[0].started, jobs: ['d1', 'd2'] }];
  bridge(v); render(<App />);
  await screen.findAllByRole('button', { name: /GPT-6 Astra|Claude Opus/ });
  // 身份拆成几段：模型、强度标签、（快速标签）、用时；在跑的活也是同一个写法，用时是走着的。
  const rows = [...document.querySelectorAll('.ident-text')].map(m => [...m.children].map(c => c.textContent));
  expect([...document.querySelector('[data-job="live"] .ident-text')!.children].map(c => c.textContent).slice(0, 2)).toEqual(['GPT-6 Astra', '超高档']);
  expect(rows).toHaveLength(1);
  const done = [...document.querySelectorAll('.done-row')].map(r => [r.querySelector('.done-title')!.textContent, r.querySelector('.done-time')!.textContent, r.querySelectorAll('.ident').length]);
  expect(done).toContainEqual(['两家对比', '20 分钟', 2]); expect(done).toHaveLength(2);
  expect(done.find(d => d[0] !== '两家对比')![1]).toBe('15 分钟');
  // 图标的可访问名带厂家名和模型名，悬停也能看全。
  expect(document.querySelector('.done-row .ident')!.getAttribute('title')).toMatch(/·/);
});
test('卡片区分快速版和普通版，也认得 Sonnet 和中档', async () => {
  const v = workersView();
  v.jobs = [job('fast', { who: 'grok', effort: 'medium', fast: true, seconds: 600 }), job('plain', { who: 'grok', effort: 'medium', seconds: 900 }),
    job('son', { who: 'cursor-sonnet', effort: 'medium', seconds: 300 })];
  bridge(v); render(<App />);
  await screen.findAllByRole('button', { name: /Grok 4.7|Sonnet/ });
  const rows = [...document.querySelectorAll('.ident-text')].map(m => [...m.children].map(c => c.textContent));
  expect(rows).toContainEqual(['Grok 4.7', '中档', '快速', '10 分钟']); expect(rows).toContainEqual(['Grok 4.7', '中档', '15 分钟']);
  expect(document.body.textContent).not.toContain('Cursor · Sonnet'); expect(screen.getAllByRole('img', { name: 'Cursor · Sonnet' }).length).toBeGreaterThan(0); expect(rows).toContainEqual(['Claude Sonnet 5.5', '中档', '5 分钟']);
});
test('全应用不再出现已经不存在的功能的字样：看板、历史、各家表现、各种弹窗、设置', async () => {
  const v = workersView();
  v.jobs = [job('live', { state: 'running', seconds: null, activity: [{ at: new Date().toISOString(), kind: 'cmd', text: 'git diff' }] }), job('lost', { state: 'lost' }), job('failed', { state: 'failed' }),
    job('wait-a', { batch: 'b' }), job('wait-b', { batch: 'b', who: 'grok' }), job('used', { decision: lead('adopt') })];
  v.batches = [{ id: 'b', title: '一批', summary: '说明', kind: '实现', base: '', started: v.jobs[0].started, jobs: ['wait-a', 'wait-b'] }];
  let opened: Parameters<NonNullable<typeof window.xa>['onOpen']>[0] | undefined;
  window.xa = fixtureBridge({ getView: async () => v, onOpen: callback => { opened = callback; return () => {}; } }); render(<App />);
  const stale = /报告|改动|跟我说|任何一家|验收详情/;
  // 设置里“存储”的说明按约定要写“任务记录、报告、改动和打分都留着”，这一句是讲留下什么，不是旧功能，先去掉再查。
  const check = (label: string) => expect(document.body.textContent!.replace('任务记录、报告、改动和打分都留着', ''), label).not.toMatch(stale);
  await screen.findAllByText('负责人在挑'); check('看板');
  expect(document.body.textContent).toContain('负责人会处理，你也可以点开插手');
  for (const text of ['点开可以拍板', '点开可以重做或不要', '等你处理', '件等你', '等你挑', '要你处理']) expect(document.body.textContent).not.toContain(text);
  expect(screen.getByRole('tab', { name: '看板' }).textContent).toBe('看板');
  expect(screen.getByRole('heading', { name: '验收中' })).toBeTruthy();
  for (const id of ['live', 'lost', 'failed', 'wait-a', 'used']) {
    act(() => opened?.({ kind: 'job', id })); expect(screen.getByRole('dialog').querySelector('.job-title')?.textContent, id).toBe(id); check('详情 ' + id);
    if (id === 'live') expect(document.body.textContent).toContain('在看代码变化');
    fireEvent.keyDown(document, { key: 'Escape' });
  }
  act(() => opened?.({ kind: 'batch', id: 'b' })); expect(screen.getByRole('dialog').textContent).toContain('说明'); check('一批的弹窗'); fireEvent.keyDown(document, { key: 'Escape' });
  fireEvent.keyDown(document, { key: '2', metaKey: true }); check('历史');
  fireEvent.keyDown(document, { key: '3', metaKey: true }); check('各家表现');
  fireEvent.keyDown(document, { key: ',', metaKey: true }); await screen.findByLabelText('系统通知'); check('设置');
});
test('有未回复留言的卡片带小圆点；负责人回复或标记处理后消失，不写字', async () => {
  const v = view(); const owner = { by: 'owner' as const, text: '问一句', at: '' };
  v.jobs = [job('asked'), job('answered'), job('handled')];
  v.jobs[0] = { ...v.jobs[0], comments: [owner] }; v.jobs[1] = { ...v.jobs[1], comments: [owner, { by: 'lead', text: '好', at: '' }] };
  v.jobs[2] = { ...v.jobs[2], comments: [{ ...owner, handled: '2026-09-29T00:00:00.000Z' }] };
  bridge(v); render(<App />);
  await screen.findAllByText('负责人在挑');
  const dots = document.querySelectorAll('.reply-dot'); expect(dots).toHaveLength(1);
  expect(dots[0].closest('button')!.textContent).toContain('asked'); expect(dots[0].textContent).toBe('');
});
test('只有一家的批次（或只剩一家）从任何入口点开都是那一家自己的详情，没有“一批”', async () => {
  const v = view(); v.jobs = [job('one'), job('lone', { batch: 'pair' })];
  v.batches = [{ id: 'solo', title: '单家', summary: '', kind: '实现', base: '', started: v.jobs[0].started, jobs: ['one'] },
    { id: 'pair', title: '本来两家', summary: '', kind: '实现', base: '', started: v.jobs[0].started, jobs: ['lone', 'gone'] }];
  let opened: Parameters<NonNullable<typeof window.xa>['onOpen']>[0] | undefined;
  window.xa = fixtureBridge({ getView: async () => v, onOpen: callback => { opened = callback; return () => {}; } }); render(<App />);
  await screen.findAllByText('负责人在挑');
  for (const [id, title] of [['solo', 'one'], ['pair', 'lone']]) {
    act(() => opened?.({ kind: 'batch', id }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: '要做什么' })).toBeTruthy(); expect(dialog.querySelector('.job-title')?.textContent).toBe(title);
    expect(dialog.textContent).not.toContain('这一批'); expect(dialog.textContent).not.toContain('没有这一批');
    fireEvent.keyDown(document, { key: 'Escape' });
  }
  const colors = batchColors(v.batches, new Set(v.jobs.map(j => j.id))); expect(colors.size).toBe(0);
});
test('顶栏最右有“设置”按钮，点一下打开设置窗口', async () => {
  bridge(view()); render(<App />);
  const gear = await screen.findByRole('button', { name: '设置' });
  expect(gear.closest('header')).toBeTruthy();
  fireEvent.click(gear);
  expect(await screen.findByRole('dialog', { name: '设置' })).toBeTruthy();
});
