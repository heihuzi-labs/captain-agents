import { afterEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Detail } from '../../app/renderer/components/Detail.tsx';
import { Settings } from '../../app/renderer/components/Settings.tsx';
import { entries } from '../../app/renderer/lib/board.ts';
import type { ViewJob } from '../../src/core/view-types.ts';
import { fixtureView, fixtureJob, fixtureBridge } from './fixtures.tsx';

afterEach(cleanup);
function show(extra: Partial<ViewJob> = {}) {
  const view = fixtureView(); view.jobs = [fixtureJob('one', extra)];
  window.xa = fixtureBridge();
  return render(<Detail target={{ kind: 'job', id: 'one' }} view={view} entries={entries(view)} order={[]} colors={new Map()} open={() => {}} close={() => {}} />);
}
const cases: [Partial<ViewJob>, string][] = [
  [{ decision: { kind: 'adopt', by: 'lead', at: '', note: '已经解决问题' } }, '用了这份：已经解决问题'],
  [{ decision: { kind: 'drop', by: 'lead', at: '', note: '改动不合适' } }, '没用：改动不合适'],
  [{ decision: { kind: 'adopt', by: 'owner', at: '' } }, '你选了这份，等负责人处理'],
  [{ decision: { kind: 'drop', by: 'owner', at: '' } }, '你选了不要这份，等负责人处理'],
  [{ redo: { by: 'owner', at: '' } }, '你请求了重做，等负责人处理'],
  [{}, '负责人还在看'],
];
test.each(cases)('显示人话结果 %j', (extra, result) => {
  show(extra); expect(screen.getByText(result)).toBeTruthy();
  expect(screen.queryByRole('tab')).toBeNull();
  for (const text of ['报告', '改动', '验收', '题目', '过程', '技术细节']) expect(screen.queryByText(text, { exact: true })).toBeNull();
});
test('旧记录缺来源时按负责人处理', () => {
  const record = JSON.parse('{"kind":"adopt","note":"旧结论"}') as ViewJob['decision'];
  show({ decision: record }); expect(screen.getByText('用了这份：旧结论')).toBeTruthy();
});
test('进展显示时间、大类和原始动作，休眠只说事实，正在跑没有结果', () => {
  const from = new Date(2026, 8, 29, 11, 38).toISOString(), to = new Date(2026, 8, 29, 11, 49).toISOString();
  show({ state: 'running', activity: [{ at: from, kind: 'cmd', text: 'npm test -- SECRET_RAW_COMMAND' }], sleeps: [{ from, to }] });
  expect(screen.getByText('在跑测试')).toBeTruthy();
  const action = screen.getByText('npm test -- SECRET_RAW_COMMAND');
  const row = action.closest('li')!;
  expect(row.children).toHaveLength(3);
  expect(row.children[0].tagName).toBe('TIME');
  expect(row.children[0].textContent).toBe('11:38');
  expect(row.children[1].textContent).toBe('在跑测试');
  expect(action.tagName).toBe('CODE');
  expect(screen.getByText(/11:38–11:49 电脑休眠，选手暂停/)).toBeTruthy();
  expect(screen.queryByRole('heading', { name: '结果' })).toBeNull();
});
test.each(['done', 'failed', 'stopped'] as const)('结束状态 %s 不显示进展', state => {
  show({ state }); expect(screen.queryByRole('heading', { name: '进展' })).toBeNull();
});
test.each([
  ['done', ['用这份', '不要了']], ['failed', ['重做', '不要了']], ['lost', ['重做', '不要了']], ['running', ['停下']], ['queued', ['停下']],
] as const)('状态 %s 的按钮', (state, labels) => {
  show({ state });
  for (const label of ['用这份', '不要了', '重做', '停下']) expect(!!screen.queryByRole('button', { name: label })).toBe(labels.some(value => value === label));
});
test('还没拍板时，按钮上方说明负责人会处理；在跑或已经定了就不再出现', () => {
  const hint = '负责人会处理；你想直接定，也可以点下面的按钮。';
  show(); expect(screen.getByText(hint)).toBeTruthy();
  cleanup(); show({ state: 'failed' }); expect(screen.getByText(hint)).toBeTruthy();
  cleanup(); show({ state: 'running' }); expect(screen.queryByText(hint)).toBeNull();
  cleanup(); show({ decision: { kind: 'adopt', by: 'lead', at: '', note: '好' } }); expect(screen.queryByText(hint)).toBeNull();
  cleanup(); show({ decision: { kind: 'adopt', by: 'owner', at: '' } }); expect(screen.queryByText(hint)).toBeNull();
});
test('已经决定或重做后，不能继续拍板', () => {
  show({ redo: { by: 'owner', at: '' } });
  expect(screen.queryByRole('button', { name: '用这份' })).toBeNull();
});
test('停下和不要都二次确认，取消不调用，失败说明原因', async () => {
  const rendered = show({ state: 'running' });
  fireEvent.click(screen.getByRole('button', { name: '停下' }));
  expect(screen.getByRole('alertdialog').textContent).toContain('做到一半的东西会保留');
  expect(window.xa.stop).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '先不改' }));
  expect(window.xa.stop).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '停下' }));
  fireEvent.click(screen.getByRole('button', { name: '确认停下' }));
  await waitFor(() => expect(window.xa.stop).toHaveBeenCalledWith('one'));
  rendered.unmount(); show();
  window.xa.decide = vi.fn(async () => { throw new Error("Error invoking remote method 'xa:decide': Error: 任务已经变化"); });
  fireEvent.click(screen.getByRole('button', { name: '不要了' }));
  expect(window.xa.decide).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '确认不要' }));
  expect((await screen.findByRole('alert')).textContent).toBe('没能办成：任务已经变化');
  expect(window.xa.decide).toHaveBeenCalledWith('one', 'drop');
});
test('用这份与重做直接调用桥，等待期间按钮禁用', async () => {
  const component = show();
  let finish: (() => void) | undefined;
  window.xa.decide = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  fireEvent.click(screen.getByRole('button', { name: '用这份' }));
  expect(window.xa.decide).toHaveBeenCalledWith('one', 'adopt');
  expect(screen.getByRole('button', { name: '用这份' }).hasAttribute('disabled')).toBe(true);
  await act(async () => finish?.()); component.unmount(); show({ state: 'lost' });
  fireEvent.click(screen.getByRole('button', { name: '重做' }));
  await waitFor(() => expect(window.xa.redo).toHaveBeenCalledWith('one'));
});
test('批次的选择与都不要，只处理已结束且未决定的成员', async () => {
  const view = fixtureView(); view.jobs = [fixtureJob('a'), fixtureJob('b'), fixtureJob('c', { state: 'running' })];
  view.batches = [{ id: 'batch', title: '题目', summary: '批次的人话', base: '', kind: '', started: '', jobs: ['a', 'b', 'c'] }];
  window.xa = fixtureBridge(); const open = vi.fn();
  render(<Detail target={{ kind: 'batch', id: 'batch' }} view={view} entries={entries(view)} order={[]} colors={new Map()} open={open} close={() => {}} />);
  expect(screen.getByText('批次的人话')).toBeTruthy();
  expect(screen.getByText('负责人会处理；你想直接定，也可以点下面的按钮。')).toBeTruthy();
  expect(screen.getAllByRole('button', { name: '用这份' })).toHaveLength(2);
  fireEvent.click(screen.getAllByRole('button', { name: '用这份' })[0]);
  await waitFor(() => expect(window.xa.decide).toHaveBeenCalledWith('a', 'adopt'));
  expect(open).not.toHaveBeenCalled();
  // 上一件活还没提交完的时候，按钮是禁用的，点它不会有任何反应；等按钮能点了再点。
  await waitFor(() => expect(screen.getByRole('button', { name: '都不要' }).hasAttribute('disabled')).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: '都不要' }));
  expect(screen.getByRole('alertdialog').textContent).toContain('还在跑的活会继续');
  fireEvent.click(screen.getByRole('button', { name: '确认不要' }));
  await waitFor(() => expect(window.xa.decide).toHaveBeenCalledWith('b', 'drop'));
  expect(window.xa.decide).not.toHaveBeenCalledWith('c', 'drop');
});
test('说明与结论当纯文字显示', () => {
  const text = '<img src=x onerror=alert(1)><script>bad()</script>';
  const { container } = show({ summary: text, decision: { kind: 'adopt', by: 'lead', at: '', note: text } });
  expect(screen.getByText(text)).toBeTruthy();
  expect(container.querySelector('script,[onerror]')).toBeNull();
});
test('设置读取、开关、颜色、恢复默认和错误反馈', async () => {
  localStorage.clear();
  window.xa = fixtureBridge(); render(<Settings close={() => {}} />);
  const toggle = await screen.findByLabelText('系统通知');
  fireEvent.click(toggle);
  await waitFor(() => expect(window.xa.setSettings).toHaveBeenCalledWith({ notifications: false }));
  await waitFor(() => expect(screen.getByLabelText('系统通知').getAttribute('aria-checked')).toBe('false'));
  fireEvent.click(screen.getByRole('tab', { name: '看板颜色' }));
  fireEvent.change(screen.getByLabelText('进行中'), { target: { value: '#123456' } });
  await waitFor(() => expect(window.xa.setSettings).toHaveBeenCalledWith({ columns: { running: '#123456' } }));
  await waitFor(() => expect((screen.getByLabelText('进行中') as HTMLInputElement).value).toBe('#123456'));
  fireEvent.click(screen.getByRole('button', { name: '恢复默认' }));
  await waitFor(() => expect(window.xa.setSettings).toHaveBeenCalledWith({ columns: {} }));
  await waitFor(() => expect(screen.getByRole('button', { name: '恢复默认' }).closest('fieldset')?.disabled).toBe(false));
  window.xa.setSettings = vi.fn(async () => { throw new Error('无法保存'); });
  fireEvent.click(screen.getByRole('tab', { name: '通用' }));
  fireEvent.click(screen.getByLabelText('开机自动启动'));
  expect((await screen.findByRole('alert')).textContent).toContain('无法保存');
});

test.each([['medium', '中档'], ['high', '高档'], ['xhigh', '超高档'], ['custom', 'custom']])('头部强度 %s 是独立标签', (effort, label) => {
  show({ effort, fast: true });
  const identity = screen.getByRole('dialog').querySelector('.ident')!;
  expect(within(identity as HTMLElement).getByText('模型').className).toBe('ident-model');
  expect(within(identity as HTMLElement).getByText(label).className).toContain('chip');
  expect(within(identity as HTMLElement).getByText('快速').className).toContain('chip');
  expect(identity.querySelector('.ident-elapsed')?.textContent).toBe('1 分 00 秒');
  expect(screen.getByRole('dialog').querySelector('.ident-end')?.textContent).toBe('完成');
});
test('弹窗里的图标和卡片是同一个部件：加载中只占位，成功显示图片，失败退回字母圆标', () => {
  show(); const dialog = screen.getByRole('dialog');
  expect(dialog.querySelector('.mono-mark')).toBeNull();
  const img = dialog.querySelector('img')!; expect(img.dataset.state).toBe('pending');
  fireEvent.load(img); expect(dialog.querySelector('img')!.dataset.state).toBe('ok'); expect(dialog.querySelector('.mono-mark')).toBeNull();
  fireEvent.error(dialog.querySelector('img')!);
  expect(dialog.querySelector('.mono-mark')?.textContent).toBe('C'); expect(dialog.querySelector('img')).toBeNull();
});
test('弹窗外框统一：容器不接收焦点，焦点落在可操作的控件上，详情和设置的关闭按钮一样', () => {
  const detail = show(); const sheet = screen.getByRole('dialog');
  expect(sheet.hasAttribute('tabindex')).toBe(false);
  expect(document.activeElement).not.toBe(sheet); expect(sheet.contains(document.activeElement)).toBe(true); expect(document.activeElement?.tagName).toBe('BUTTON');
  const close = screen.getByRole('button', { name: '关闭' }); expect(close.className).toBe('close-button');
  detail.unmount();
  window.xa = fixtureBridge(); render(<Settings close={() => {}} />);
  const settings = screen.getByRole('dialog', { name: '设置' });
  expect(settings.hasAttribute('tabindex')).toBe(false); expect(settings.className).toContain('sheet');
  expect(screen.getByRole('button', { name: '关闭' }).className).toBe(close.className);
});
test('二次确认：默认焦点在“先不改”，Esc 只关最上面一层，下面一层暂时不可操作，关闭后焦点回来', () => {
  show({ state: 'running' });
  const stop = screen.getByRole('button', { name: '停下' }); stop.focus();
  fireEvent.click(stop);
  expect(document.activeElement).toBe(screen.getByRole('button', { name: '先不改' }));
  const lower = document.querySelector('[data-modal-root]')!; expect(lower.hasAttribute('inert')).toBe(true);
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('alertdialog')).toBeNull(); expect(screen.getByRole('dialog')).toBeTruthy();
  expect(lower.hasAttribute('inert')).toBe(false); expect(document.activeElement).toBe(screen.getByRole('button', { name: '停下' }));
});
test('留言：往来列出且负责人写“负责人：”，发送清空输入框，⌘ 回车也能发，失败留下文字并说明原因', async () => {
  const at = new Date(2026, 8, 29, 10, 5).toISOString();
  show({ comments: [{ by: 'owner', text: '我的第一句', at }, { by: 'lead', text: '收到', at }, { by: 'owner', text: '我又补一句', at }] });
  expect(screen.getByText('我的第一句')).toBeTruthy(); expect(screen.getByText('负责人：')).toBeTruthy(); expect(screen.getByText('负责人还没回复')).toBeTruthy();
  const input = screen.getByLabelText('给负责人的留言') as HTMLTextAreaElement, send = screen.getByRole('button', { name: '发送' });
  expect(send.hasAttribute('disabled')).toBe(true);
  fireEvent.change(input, { target: { value: '  你好  ' } }); fireEvent.click(send);
  await waitFor(() => expect(window.xa.comment).toHaveBeenCalledWith('one', '你好'));
  await waitFor(() => expect(input.value).toBe(''));
  fireEvent.change(input, { target: { value: '第二句\n换行' } }); fireEvent.keyDown(input, { key: 'Enter', metaKey: true });
  await waitFor(() => expect(window.xa.comment).toHaveBeenCalledWith('one', '第二句\n换行'));
  window.xa.comment = vi.fn(async () => { throw new Error("Error invoking remote method 'xa:comment': Error: 任务已经变化"); });
  fireEvent.change(input, { target: { value: '发不出去' } });
  // 上一条留言还在发的时候，发送按钮是禁用的，点它不会有任何反应；等按钮能点了再点。
  await waitFor(() => expect(screen.getByRole('button', { name: '发送' }).hasAttribute('disabled')).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
  expect((await screen.findByRole('alert')).textContent).toBe('没能发出：任务已经变化'); expect(input.value).toBe('发不出去');
  fireEvent.change(input, { target: { value: '文'.repeat(501) } });
  expect(screen.getByText('超出 1 字')).toBeTruthy(); expect(screen.getByRole('button', { name: '发送' }).hasAttribute('disabled')).toBe(true);
});
test('已被负责人处理的留言不再显示“还没回复”；在输入框里按 ← → 不切换上一张下一张', () => {
  const view = fixtureView(); view.jobs = [fixtureJob('one', { comments: [{ by: 'owner', text: '好', at: '', handled: '2026-09-29T00:00:00.000Z' }] }), fixtureJob('two')];
  window.xa = fixtureBridge(); const open = vi.fn();
  render(<Detail target={{ kind: 'job', id: 'one' }} view={view} entries={entries(view)} order={[{ kind: 'job', id: 'one' }, { kind: 'job', id: 'two' }]} colors={new Map()} open={open} close={() => {}} />);
  expect(screen.queryByText('负责人还没回复')).toBeNull();
  fireEvent.keyDown(screen.getByLabelText('给负责人的留言'), { key: 'ArrowRight' }); expect(open).not.toHaveBeenCalled();
  fireEvent.keyDown(document.body, { key: 'ArrowRight' }); expect(open).toHaveBeenCalledWith({ kind: 'job', id: 'two' });
});

test('连续同类只在第一条写大类，说话原样占两列并打断连续类别', () => {
  const at = '2026-09-29T03:38:00.000Z';
  const speech = '我在看分支  和日志。\n下一步跑测试。';
  show({ state: 'running', activity: [
    { at, kind: 'read', text: 'old.ts' },
    { at, kind: 'say', text: speech },
    { at, kind: 'read', text: 'first.ts' },
    { at, kind: 'read', text: 'second.ts' },
    { at, kind: 'cmd', text: 'npm test' },
    { at, kind: 'cmd', text: 'node --test' },
  ] });
  const rows = within(screen.getByRole('list', { name: '最近进展' })).getAllByRole('listitem');
  expect(rows.map(row => row.querySelector('.activity-category')?.textContent)).toEqual(['在跑测试', '', '在查资料、读代码', '', undefined, '在查资料、读代码']);
  expect(rows[4].children).toHaveLength(2);
  expect(rows[4].querySelector('.activity-say')?.textContent).toBe(speech);
  expect(rows[4].querySelector('code')).toBeNull();
});
test('只显示最近 12 条，新的在上面；原始动作包含换行和网页符号也按文字显示', () => {
  const raw = '<img src=x onerror=alert(1)>\n  npm test -- ' + '长命令'.repeat(100);
  const activity: ViewJob['activity'] = Array.from({ length: 14 }, (_, i) => ({ at: new Date(2026, 8, 29, 11, i).toISOString(), kind: 'cmd', text: i === 13 ? raw : `command-${i}` }));
  const original = activity.map(a => a.text);
  show({ state: 'running', activity });
  const list = screen.getByRole('list', { name: '最近进展' });
  const rows = within(list).getAllByRole('listitem');
  expect(rows).toHaveLength(12);
  expect(rows[0].querySelector('code')?.textContent).toBe(raw);
  expect(rows[11].querySelector('code')?.textContent).toBe('command-2');
  expect(within(list).queryByText('command-0')).toBeNull();
  expect(within(list).queryByText('command-1')).toBeNull();
  expect(list.querySelector('img,script,[onerror]')).toBeNull();
  expect(activity.map(a => a.text)).toEqual(original);
});
test('空进展显示刚开始', () => {
  show({ state: 'queued', activity: [] });
  expect(within(screen.getByRole('list', { name: '最近进展' })).getByText('刚开始')).toBeTruthy();
});
test('休眠放进时间线它该在的位置：醒来后有动作的在它上面，并写明已接着干；没有新动作时如实写', () => {
  const t = (h: number, m: number) => new Date(2026, 8, 29, h, m).toISOString();
  const sleeps = [{ from: t(23, 15), to: t(23, 25) }];
  show({ state: 'running', activity: [{ at: t(23, 13), kind: 'cmd', text: 'before-sleep' }, { at: t(23, 28), kind: 'cmd', text: 'after-wake' }], sleeps });
  const rows = [...document.querySelectorAll('.human-activities > li')].map(li => li.textContent);
  expect(rows[0]).toContain('after-wake');
  expect(rows[1]).toContain('23:15–23:25 电脑休眠，选手暂停；醒来后已接着干');
  expect(rows[2]).toContain('before-sleep');
  cleanup();
  show({ state: 'running', activity: [{ at: t(23, 13), kind: 'cmd', text: 'before-sleep' }], sleeps });
  expect(screen.getByText(/醒来后还没有新动作/)).toBeTruthy();
});
