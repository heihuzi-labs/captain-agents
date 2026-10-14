// 成员栏开关的竞态（2026-10-13，Windows 流水线上偶发）：机器慢的时候，群刚画出来、挂载后的副作用还没跑，
// 点击就到了。那时“换群回到默认”是在副作用里清的，晚到的它把刚点的那一下冲掉，成员栏又弹回去。
// 这里把慢机器摆出来：调度器的“下一拍”推迟，并且让它在按钮画出来之后把副作用留到下一拍。
// 要赶在 React 载入之前改全局，所以单独一个文件、用到的东西都在测试里现载入。
import { afterAll, expect, test, vi } from 'vitest';

const realImmediate = globalThis.setImmediate, realNow = performance.now;
globalThis.setImmediate = ((fn: (...args: unknown[]) => void, ...args: unknown[]) => setTimeout(fn, 250, ...args)) as unknown as typeof setImmediate;
performance.now = () => realNow.call(performance) + (document.querySelector('.chat-people') ? 1000 : 0);
afterAll(() => { globalThis.setImmediate = realImmediate; performance.now = realNow; });

test('群刚画出来、副作用还没跑就点成员按钮：这一下算数，成员栏收起', async () => {
  const { fireEvent, render, screen } = await import('@testing-library/react');
  const { App } = await import('../../app/renderer/App.tsx');
  const { fixtureView, fixtureBridge } = await import('./fixtures.tsx');
  const v = fixtureView();
  v.chats = [{ id: 'c1', project: 'xa', title: '派活工作台', state: 'open', created: new Date().toISOString(), closed: null, hopLimit: 4, pendingLead: 0,
    members: [{ who: 'codex', readOnly: false, job: null, state: 'idle' }], messages: [] }];
  localStorage.setItem('xa.position', JSON.stringify({ page: 'collab', filter: '全部' }));
  window.xa = fixtureBridge({ getView: vi.fn(async () => v), onView: () => () => {} });
  render(<App />);
  const people = await screen.findByRole('button', { name: '成员 2 位' }, { timeout: 5000 });
  expect(people.getAttribute('aria-expanded')).toBe('true');
  fireEvent.click(people);
  expect(people.getAttribute('aria-expanded')).toBe('false'); expect(screen.queryByRole('complementary', { name: '群信息' })).toBeNull();
});
