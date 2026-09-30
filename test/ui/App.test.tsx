import { afterEach, expect, test, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { fixtureView, fixtureJob, fixtureBridge } from './fixtures.tsx';
import { App } from '../../app/renderer/App.tsx';
import type { View, ViewJob } from '../../src/core/view-types.ts';

afterEach(() => { cleanup(); localStorage.clear(); });
const view = fixtureView;
const job = (id: string, state: ViewJob['state'], decision: ViewJob['decision'] = null) => fixtureJob(id, { state, decision });

test('读取初始数目、接收推送、按文字显示自检说明并取消订阅', async () => {
  const initial = view(); initial.jobs = [job('run', 'running'), job('wait', 'done'), job('lost', 'lost'), job('used', 'done', { kind: 'adopt', by: 'lead', at: '' })];
  let push: ((view: View) => void) | undefined;
  const unsubscribe = vi.fn();
  window.xa = fixtureBridge({ getView: async () => initial, onView: callback => { push = callback; return unsubscribe; } });
  const component = render(<App />);
  await waitFor(() => expect(screen.getByTestId('running').textContent).toBe('1'));
  expect(screen.getByTestId('attention').textContent).toBe('2');
  expect(screen.getByTestId('done').textContent).toBe('1');
  const attack = '<img src=x onerror=alert(1)>';
  const next = { ...initial, jobs: [...initial.jobs, job('new', 'running')], selfcheck: { ok: false, at: null, note: attack } };
  act(() => push?.(next));
  expect(screen.getByTestId('running').textContent).toBe('2');
  expect(screen.getByRole('img', { name: '隔离自检没过' }).getAttribute('title')).toBe(attack);
  expect(component.container.querySelector('[onerror]')).toBeNull();
  component.unmount(); expect(unsubscribe).toHaveBeenCalledOnce();
});

test('初次读取比推送晚完成时，不能覆盖新数据', async () => {
  let resolve: ((view: View) => void) | undefined;
  let push: ((view: View) => void) | undefined;
  window.xa = fixtureBridge({ getView: () => new Promise(done => { resolve = done; }), onView: callback => { push = callback; return () => {}; } });
  render(<App />);
  const next = view(); next.jobs = [job('run', 'running')];
  act(() => push?.(next));
  await act(async () => resolve?.(view()));
  expect(screen.getByTestId('running').textContent).toBe('1');
});

test('读取失败展示中文错误', async () => {
  window.xa = fixtureBridge({ getView: async () => { throw new Error('unreadable'); }, onView: () => () => {} });
  render(<App />);
  expect((await screen.findByRole('alert')).textContent).toContain('读取登记处失败');
});

test('菜单与通知的打开事件直达任务或设置，推送更新结果', async () => {
  const initial = view(); initial.jobs = [job('one', 'done')];
  let opened: Parameters<NonNullable<typeof window.xa>['onOpen']>[0] | undefined;
  let push: ((view: View) => void) | undefined;
  const unsubscribeOpen = vi.fn();
  window.xa = fixtureBridge({ getView: async () => initial, onOpen: callback => { opened = callback; return unsubscribeOpen; }, onView: callback => { push = callback; return () => {}; } });
  const component = render(<App />);
  await screen.findByText('负责人在挑');
  act(() => opened?.({ kind: 'job', id: 'one' }));
  expect(screen.getByRole('dialog').textContent).toContain('负责人还在看');
  const next = { ...initial, jobs: [fixtureJob('one', { decision: { kind: 'adopt', by: 'owner', at: '' } })] };
  act(() => push?.(next));
  expect(screen.getByRole('dialog').textContent).toContain('你选了这份，等负责人处理');
  act(() => opened?.({ kind: 'settings' }));
  await screen.findByLabelText('系统通知');
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
  expect(screen.getByRole('dialog').getAttribute('aria-label')).toBe('设置');
  component.unmount(); expect(unsubscribeOpen).toHaveBeenCalledOnce();
});
