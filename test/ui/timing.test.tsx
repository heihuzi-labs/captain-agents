import { afterEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { App } from '../../app/renderer/App.tsx';
import { Detail } from '../../app/renderer/components/Detail.tsx';
import { entries } from '../../app/renderer/lib/board.ts';
import type { View, ViewJob } from '../../src/core/view-types.ts';
import type { Stat } from '../../src/core/stats.ts';
import type { Profile } from '../../src/core/profiles.ts';
import { fixtureBridge, fixtureJob, fixtureView } from './fixtures.tsx';

afterEach(() => { cleanup(); localStorage.clear(); vi.useRealTimers(); vi.restoreAllMocks(); });

function show(extra: Partial<ViewJob> = {}) {
  const view = fixtureView(); view.jobs = [fixtureJob('one', extra)];
  window.xa = fixtureBridge();
  return render(<Detail target={{ kind: 'job', id: 'one' }} view={view} entries={entries(view)} order={[]} colors={new Map()} open={() => {}} close={() => {}} />);
}
const progress = () => screen.queryByRole('heading', { name: '进展' });

test('详情：有每步记录的活，“进展”标题下面有一行淡色小字；在跑的活动作列表照旧在它下面', () => {
  const at = new Date().toISOString();
  show({ state: 'running', ended: null, seconds: null, started: new Date(Date.now() - 600_000).toISOString(), timing: { steps: 45, toolSeconds: 30 }, activity: [{ at, kind: 'cmd', text: 'npm test' }] });
  const note = screen.getByText('大部分时间在想，跑命令不到 1 分钟，共 45 步');
  expect(note.className).toBe('timing-note');
  const section = progress()!.closest('section')!;
  expect(section.children[0]).toBe(progress());
  expect(section.children[1]).toBe(note);
  expect(section.children[2].className).toBe('human-activities');
});
test('详情：没有每步记录（timing 为 null）时那一行不出现；在跑的活照旧有“进展”', () => {
  show({ state: 'running', ended: null, seconds: null, timing: null });
  expect(document.querySelector('.timing-note')).toBeNull();
  expect(progress()).toBeTruthy();
});
test('详情：已结束的活有记录时只出现“进展”和这一行（没有动作列表）；没有记录就没有“进展”', () => {
  show({ state: 'done', seconds: 300, timing: { steps: 12, toolSeconds: 60 } });
  expect(progress()).toBeTruthy();
  expect(screen.getByText('大部分时间在想，跑命令约 1 分钟，共 12 步')).toBeTruthy();
  expect(document.querySelector('.human-activities')).toBeNull();
  cleanup();
  show({ state: 'done', timing: null });
  expect(progress()).toBeNull(); expect(document.querySelector('.timing-note')).toBeNull();
});
test('详情：已结束的活用时已经扣过休眠，不能再扣一遍', () => {
  const t0 = Date.parse('2026-09-30T01:00:00Z'), at = (min: number) => new Date(t0 + min * 60_000).toISOString();
  // 一共 9 分钟，休眠 4 分钟，实际干了 5 分钟（界面拿到的 seconds 就是 300）；跑命令 200 秒，所以想和写 100 秒。
  show({ state: 'done', started: at(0), ended: at(9), seconds: 300, sleeps: [{ from: at(2), to: at(6) }], timing: { steps: 7, toolSeconds: 200 } });
  expect(screen.getByText('大部分时间在跑命令（约 3 分钟），想和写约 2 分钟，共 7 步')).toBeTruthy();
});
test('详情：在跑的活那句话跟着计时器变，休眠的时间不算', () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(new Date('2026-09-30T02:00:00Z'));
  // 刚开始 40 秒：跑命令 30 秒、想和写 10 秒；
  show({ state: 'running', ended: null, seconds: null, started: new Date(Date.now() - 40_000).toISOString(), sleeps: [], timing: { steps: 3, toolSeconds: 30 } });
  expect(screen.getByText('大部分时间在跑命令（不到 1 分钟），想和写不到 1 分钟，共 3 步')).toBeTruthy();
  // 5 分钟后：总共 340 秒，想和写 310 秒。
  act(() => { vi.advanceTimersByTime(300_000); });
  expect(document.querySelector('.timing-note')!.textContent).toBe('大部分时间在想，跑命令不到 1 分钟，共 3 步');
});
test('详情：在跑的活扣掉休眠再算想和写', () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(new Date('2026-09-30T02:00:00Z'));
  // 已开始 20 分钟，其中休眠 10 分钟，实际 10 分钟；跑命令 5 分钟：想和写 5 分钟，一半一半。
  const started = new Date(Date.now() - 20 * 60_000), from = new Date(Date.now() - 15 * 60_000), to = new Date(Date.now() - 5 * 60_000);
  show({ state: 'running', ended: null, seconds: null, started: started.toISOString(), sleeps: [{ from: from.toISOString(), to: to.toISOString() }], timing: { steps: 9, toolSeconds: 300 } });
  expect(screen.getByText('想和写约 5 分钟，跑命令约 5 分钟，共 9 步')).toBeTruthy();
});
test('详情：句子当纯文字显示', () => {
  // 句子来自 describeTiming，不含选手内容；这里只确认是文本节点，不是标签。
  show({ state: 'done', seconds: 300, timing: { steps: 1, toolSeconds: 0 } });
  expect(document.querySelector('.timing-note')!.children).toHaveLength(0);
});

// ---- 表现页 ----
const stat = (extra: Partial<Stat> = {}): Stat => ({ who: 'codex', fast: false, kind: '实现', count: 8, small: false, doneRate: 1, verified: 4, passed: 3, verifyRate: .75, adopted: 2, adoptRate: .25,
  secondsSamples: 8, averageSeconds: 300, quotaSamples: 0, averageQuotaDelta: null, ...extra });
const profile = (extra: Partial<Profile> = {}): Profile => ({ who: 'codex', fast: false, kind: '实现', count: 8, rated: 6, avgScore: 4.33, reworkRate: 1 / 3, avgSeconds: 300, avgToolSeconds: null, avgSteps: null,
  good: [], bad: [], recent: [], small: false, ...extra });
async function showStats(v: View) {
  window.xa = fixtureBridge({ getView: vi.fn(async () => v) });
  render(<App />);
  await screen.findByRole('tablist'); fireEvent.keyDown(document, { key: '4', metaKey: true });
  await screen.findByRole('heading', { name: '表现', level: 1 });
}
const cells = () => [...document.querySelectorAll('.pcell')] as HTMLElement[];

test('表现页：有样本时格子多一行“平均：……”，位置在原有内容和分数之间', async () => {
  const v = fixtureView(); v.stats = [stat()]; v.profiles = [profile({ avgSeconds: 900, avgToolSeconds: 120, avgSteps: 44.6 })];
  await showStats(v);
  const line = screen.getByText('平均：大部分时间在想，跑命令约 2 分钟，共 45 步');
  expect(line.className).toBe('muted');
  const cell = cells()[0], lines = [...cell.children].map(c => c.textContent);
  expect(lines.indexOf(line.textContent!)).toBe(lines.findIndex(t => t!.startsWith('被采用 ')) + 1);
  expect(lines.findIndex(t => t!.includes('4.3 分'))).toBeGreaterThan(lines.indexOf(line.textContent!));
});
test('表现页：想和写的时间不会算成负数（平均跑命令比平均用时还长时按 0）', async () => {
  const v = fixtureView(); v.stats = [stat()]; v.profiles = [profile({ avgSeconds: 100, avgToolSeconds: 400, avgSteps: 10 })];
  await showStats(v);
  expect(screen.getByText('平均：大部分时间在跑命令（约 7 分钟），想和写不到 1 分钟，共 10 步')).toBeTruthy();
});
test('表现页：没有样本（平均步数为空）或没有平均用时，不出现这一行，也不写“—”', async () => {
  const v = fixtureView(); v.stats = [stat(), stat({ kind: '修复' })];
  v.profiles = [profile(), profile({ kind: '修复', avgSeconds: null, avgToolSeconds: 60, avgSteps: 5 })];
  await showStats(v);
  expect(document.body.textContent).not.toContain('平均：');
  expect(cells()).toHaveLength(2);
  expect(cells()[0].textContent).toContain('平均 5 分钟');
});
