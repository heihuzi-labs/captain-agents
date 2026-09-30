import { afterEach, expect, test } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { Detail } from '../../app/renderer/components/Detail.tsx';
import { entries, realState } from '../../app/renderer/lib/board.ts';
import type { ViewJob } from '../../src/core/view-types.ts';
import { fixtureBridge, fixtureJob, fixtureView } from './fixtures.tsx';
afterEach(cleanup);
// ---------- 弹窗“真实验收”一节 ----------
type Real = NonNullable<ViewJob['realCheck']>;
function show(realCheck: ViewJob['realCheck'] | undefined) {
  const view = fixtureView(); view.jobs = [fixtureJob('one', { realCheck: realCheck as ViewJob['realCheck'] })];
  window.xa = fixtureBridge();
  return render(<Detail target={{ kind: 'job', id: 'one' }} view={view} entries={entries(view)} order={[]} colors={new Map()} open={() => {}} close={() => {}} />);
}
const real = (extra: Partial<Real> = {}): Real => ({ needed: true, steps: [], result: null, skipped: null, ...extra });
const at = '2026-09-29T14:44:00.000Z';
test.each([
  ['待做', real({ steps: ['打开看板'] }), 'neutral'],
  ['通过', real({ result: { ok: true, note: '看到提示条', at, shotCount: 0 } }), 'ok'],
  ['没过', real({ result: { ok: false, note: '按钮点不动', at, shotCount: 0 } }), 'bad'],
  ['不需要', real({ skipped: { reason: '只改了后台', at } }), 'neutral'],
] as const)('真实验收一节：状态“%s”写在标题里，标签颜色表达语义', (label, check, tone) => {
  show(check);
  const heading = screen.getByRole('heading', { name: `真实验收：${label}` });
  expect(heading.textContent).toBe(`真实验收：${label}`);
  expect(heading.querySelector('.chip')?.className).toContain('chip-' + tone);
});
test('真实验收一节：没有 realCheck（null 或缺失）就没有这一节，别的内容照旧', () => {
  show(null); expect(screen.queryByText(/真实验收/)).toBeNull(); expect(screen.getByText('要做什么')).toBeTruthy();
  cleanup(); show(undefined); expect(screen.queryByText(/真实验收/)).toBeNull();
});
test('真实验收一节：负责人的说明、检查步骤按编号列表、附几张截图；只显示张数，不显示图', () => {
  const { container } = show(real({ steps: ['打开看板，看到三列任务', '打开任务详情', '<b>这一步</b> 当文字'], result: { ok: true, note: '三步都看到了', at, shotCount: 3 } }));
  const section = screen.getByRole('heading', { name: '真实验收：通过' }).closest('section')!;
  expect(within(section).getByText('负责人：三步都看到了')).toBeTruthy();
  const steps = section.querySelector('ol')!;
  expect([...steps.querySelectorAll('li')].map(li => li.textContent)).toEqual(['打开看板，看到三列任务', '打开任务详情', '<b>这一步</b> 当文字']);
  expect(steps.querySelector('b')).toBeNull();
  expect(within(section).getByText('附 3 张截图')).toBeTruthy();
  expect(section.querySelector('img')).toBeNull(); expect(container.querySelector('.modal img')).toBeNull();
});
test('真实验收一节：0 张截图不写“附 0 张”；“不需要”写负责人的理由；“待做”不催主人、没有按钮', () => {
  show(real({ result: { ok: false, note: '没过', at, shotCount: 0 } })); expect(screen.queryByText(/张截图/)).toBeNull();
  cleanup();
  show(real({ skipped: { reason: '只改了后台，界面没变', at }, steps: [] }));
  const skipped = screen.getByRole('heading', { name: '真实验收：不需要' }).closest('section')!;
  expect(within(skipped).getByText('不需要的理由：只改了后台，界面没变')).toBeTruthy(); expect(skipped.querySelector('ol')).toBeNull();
  cleanup();
  show(real({ steps: ['打开看板'] }));
  const pending = screen.getByRole('heading', { name: '真实验收：待做' }).closest('section')!;
  expect(pending.textContent).not.toMatch(/请|需要你|尽快|马上/); expect(pending.querySelector('button')).toBeNull();
  expect(within(pending).getByText('打开看板')).toBeTruthy(); expect(within(pending).queryByText(/张截图/)).toBeNull();
});
test('真实验收一节：放在“结果”之后、按钮之前；批次弹窗不显示', () => {
  show(real({ steps: ['看一下'] }));
  const order = [...document.querySelectorAll('.modal-body h3, .modal-body .actions')].map(node => node.tagName === 'H3' ? node.textContent : '按钮');
  expect(order.indexOf('真实验收：待做')).toBeGreaterThan(order.indexOf('要做什么')); expect(order.indexOf('真实验收：待做')).toBeLessThan(order.indexOf('按钮'));
  cleanup();
  const view = fixtureView();
  view.jobs = [fixtureJob('a', { batch: 'b', who: 'codex', realCheck: real() }), fixtureJob('b', { batch: 'b', who: 'grok', realCheck: real() })];
  view.batches = [{ id: 'b', title: '一批', summary: '', kind: '实现', base: '', started: '', jobs: ['a', 'b'] }];
  render(<Detail target={{ kind: 'batch', id: 'b' }} view={view} entries={entries(view)} order={[]} colors={new Map()} open={() => {}} close={() => {}} />);
  expect(screen.queryByText(/真实验收/)).toBeNull();
});
test('realState：结果和“不需要”都有时以后写的为准；本来就不需要且没有别的记录算“不需要”', () => {
  const late = '2026-09-30T00:00:00.000Z';
  expect(realState(real({ result: { ok: true, note: '', at, shotCount: 0 }, skipped: { reason: '', at: late } })).label).toBe('不需要');
  expect(realState(real({ result: { ok: true, note: '', at: late, shotCount: 0 }, skipped: { reason: '', at } })).label).toBe('通过');
  expect(realState(real({ needed: false })).label).toBe('不需要');
  expect(realState(real()).label).toBe('待做');
});
