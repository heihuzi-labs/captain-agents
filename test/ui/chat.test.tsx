import { afterEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App } from '../../app/renderer/App.tsx';
import { derive } from '../../app/renderer/lib/board.ts';
import { mentionQuery, preview, splitMentions, unread } from '../../app/renderer/lib/chat.ts';
import type { View, ViewChat } from '../../src/core/view-types.ts';
import type { ChatMessage } from '../../src/core/chat.ts';
import { fixtureJob as job, fixtureView as view, fixtureBridge } from './fixtures.tsx';

afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });
const at = (min: number) => new Date(Date.now() - min * 60000).toISOString();
const messages: ChatMessage[] = [
  { id: 1, at: at(40), from: 'platform', kind: 'event', text: '开群：Codex、DeepSeek（只读）', mentions: [] },
  { id: 2, at: at(30), from: 'owner', kind: 'say', text: '任务记录要能改分，<b>旧分</b>留着。@负责人 安排一下', mentions: ['lead'] },
  { id: 3, at: at(29), from: 'lead', kind: 'say', text: '@Codex 写改分和历史，@DeepSeek 等它交了再审', mentions: ['codex', 'deepseek'] },
  { id: 4, at: at(28), from: 'codex', kind: 'work', text: '', mentions: [], job: 'cx', turn: 1 },
  { id: 5, at: at(20), from: 'codex', kind: 'report', text: '## 结论\n做好了，补了 3 条测试。@DeepSeek 请审。', mentions: ['deepseek'], job: 'cx', turn: 1 },
  { id: 6, at: at(19), from: 'deepseek', kind: 'work', text: '', mentions: [], job: 'ds', turn: 1 },
];
function chat(extra: Partial<ViewChat> = {}): ViewChat {
  return { id: 'c1', project: 'xa', title: '派活工作台', state: 'open', created: at(40), closed: null, hopLimit: 4, pendingLead: 0,
    members: [{ who: 'codex', readOnly: false, job: 'cx', state: 'idle' }, { who: 'deepseek', readOnly: true, job: 'ds', state: 'working' }], messages, ...extra };
}
function chatView(...chats: Partial<ViewChat>[]): View {
  const v = view();
  v.jobs = [job('cx', { who: 'codex', state: 'done', project: 'xa', title: '派活工作台' }), job('ds', { who: 'deepseek', state: 'running', project: 'xa', title: '派活工作台', activity: [{ at: at(1), kind: 'read', text: 'src/core/rate.ts' }] }), job('solo', { state: 'running', title: '别的活', project: 'xa' })];
  v.chats = (chats.length ? chats : [{}]).map((c, i) => chat({ id: `c${i + 1}`, ...c }));
  v.workers = { ...v.workers, codex: { ...v.workers.codex, model: 'GPT-6 Astra' }, deepseek: { ...v.workers.deepseek, model: 'DeepSeek V4 Pro' } };
  return v;
}
function mount(v: View, page = 'collab') {
  localStorage.setItem('xa.position', JSON.stringify({ page, filter: '全部' }));
  window.xa = fixtureBridge({ getView: vi.fn(async () => v), onView: () => () => {} });
  return render(<App />);
}

test('小工具：@ 只给认得出的上色；光标前的 @ 查询；预览跳过工作卡；没看过的才算新消息', () => {
  expect(splitMentions('@Codex 写，@grok 不在群里，＠负责人 看', ['codex'])).toEqual([{ text: '@Codex', at: true }, { text: ' 写，@grok 不在群里，' }, { text: '＠负责人', at: true }, { text: ' 看' }]);
  expect(mentionQuery('请 @Dee', 6)).toEqual({ start: 2, query: 'Dee' });
  expect(mentionQuery('请 @Dee 看', 8)).toBeNull();
  expect(preview(chat())).toEqual({ text: 'Codex：做好了，补了 3 条测试。@DeepSeek 请审。', at: messages[4].at });
  expect(unread(chat(), { c1: 6 })).toBe(false);
  expect(unread(chat(), { c1: 3 })).toBe(true);
});
test('看板的归类：一个群算一件，跟着成员的活走进行中、验收中、已完成；每位都要拍板，拍板后又做一轮回到验收中', () => {
  // 有人在动手：进行中，去处是这个群；这时不进验收中。
  const working = derive(chatView());
  expect(working.running.map(j => j.id)).toEqual(['ds', 'solo']);
  expect(working.runningGroups.map(e => [e.target.kind, e.target.id, e.members.map(m => m.id).join()])).toEqual([['chat', 'c1', 'ds'], ['job', 'solo', 'solo']]);
  expect(working.attention).toEqual([]);
  // 都停了、还没拍板：一张“负责人在挑”，列出两位。
  const idle = (extra: Record<string, Partial<View['jobs'][number]>> = {}) => {
    const v = chatView({ members: [{ who: 'codex', readOnly: false, job: 'cx', state: 'idle' }, { who: 'deepseek', readOnly: true, job: 'ds', state: 'idle' }] });
    v.jobs = v.jobs.filter(j => j.id !== 'solo').map(j => ({ ...j, state: 'done' as const, ended: at(10), seconds: 60, ...extra[j.id] }));
    return derive(v);
  };
  const adopt = (min: number) => ({ kind: 'adopt' as const, note: '', at: at(min), by: 'lead' as const });
  const waiting = idle();
  expect(waiting.attention.map(e => [e.type, e.target.kind, e.target.id, e.title, e.kind, e.members.length])).toEqual([['decide', 'chat', 'c1', '派活工作台', '群聊', 2]]);
  expect(waiting.done).toEqual([]);
  // 只拍了一位：还在验收中（群里不是几选一）。
  expect(idle({ cx: { decision: adopt(5) } }).attention.map(e => e.target.kind)).toEqual(['chat']);
  // 都拍了：已完成，也进历史。
  const finished = idle({ cx: { decision: adopt(5) }, ds: { decision: adopt(5) } });
  expect(finished.attention).toEqual([]);
  expect(finished.done.map(e => [e.target.kind, e.target.id])).toEqual([['chat', 'c1']]);
  expect(finished.history.map(e => e.target.kind)).toEqual(['chat']);
  // 拍过板的成员又被叫醒：核心在开始新一轮时已把上一轮的结果归档，这件活没有拍板记录，自然回到验收中（这里不靠比时间去猜）。
  expect(idle({ cx: { decision: adopt(5), ended: at(1) }, ds: { decision: adopt(5) } }).attention).toEqual([]);
  expect(idle({ cx: { decision: null }, ds: { decision: adopt(5) } }).attention.map(e => [e.type, e.target.kind])).toEqual([['decide', 'chat']]);
  // 排队记在群上：有人排着（哪怕这一刻没人在跑、排队的那位还没有活），这个群就在进行中，不进验收中、已完成、历史。
  const handoff = chatView({ members: [{ who: 'codex', readOnly: false, job: 'cx', state: 'idle' }, { who: 'deepseek', readOnly: true, job: null, state: 'queued' }] });
  handoff.jobs = handoff.jobs.filter(j => j.id === 'cx').map(j => ({ ...j, decision: adopt(5) }));
  const between = derive(handoff);
  expect(between.runningGroups.map(e => [e.target.kind, e.members.length, e.chat?.queued])).toEqual([['chat', 0, ['deepseek']]]);
  expect([between.chatQueued, between.queued.length, between.attention.length, between.done.length, between.history.length]).toEqual([1, 0, 0, 0, 0]);
  // 出错的成员照旧单独一张卡，打开的是那件活。
  expect(idle({ ds: { state: 'failed' } }).attention.map(e => [e.type, e.target.kind, e.target.id])).toEqual([['failed', 'job', 'ds'], ['decide', 'chat', 'c1']]);
  // 还没人干过活、也没人排队的群不出现；头一回被 @ 的成员还没有活但已在排队：这个群就在进行中了，算一位排队。
  const empty = chatView({ members: [{ who: 'codex', readOnly: false, job: null, state: 'idle' }] });
  empty.jobs = [];
  expect([derive(empty).runningGroups.length, derive(empty).history.length]).toEqual([0, 0]);
  const first = chatView({ members: [{ who: 'codex', readOnly: false, job: null, state: 'queued' }] });
  first.jobs = [];
  const fresh = derive(first);
  expect(fresh.runningGroups.map(e => [e.target.kind, e.members.length, e.chat?.queued, e.chat?.project])).toEqual([['chat', 0, ['codex'], 'xa']]);
  expect([fresh.chatQueued, fresh.attention.length, fresh.done.length, fresh.history.length]).toEqual([1, 0, 0, 0]);
});
test('看板上群的卡取自群记录：用群的现名、带“群聊”标签、排队的人写在卡上并算进件数；点了去协作页那个群，不开弹窗', async () => {
  // c1：DeepSeek 在动手，Codex 被 @ 了在排队（它的活是上一轮做完的）。成员的活上抄着旧群名，看板要显示现名。
  const v = chatView({ title: '改过名的群', members: [{ who: 'codex', readOnly: false, job: 'cx', state: 'queued' }, { who: 'deepseek', readOnly: true, job: 'ds', state: 'working' }] },
    { id: 'c2', title: '另一个群', members: [{ who: 'codex', readOnly: false, job: null, state: 'queued' }, { who: 'deepseek', readOnly: true, job: 'd2', state: 'idle' }], messages: [] });
  v.jobs.push(job('d2', { who: 'deepseek', state: 'done', project: 'xa', title: '另一个群', decision: { kind: 'adopt', note: '', at: at(3), by: 'lead' } }));
  mount(v, 'board');
  const running = (await screen.findByTestId('running')).closest('.column') as HTMLElement;
  expect(within(running).getByTestId('running').textContent).toBe('2');
  expect(within(running).getByTestId('queued').textContent).toBe('· 2 排队');
  const card = running.querySelector('[data-job="ds"]') as HTMLElement, plain = running.querySelector('[data-job="solo"]') as HTMLElement;
  expect(within(card).getByText('改过名的群')).toBeTruthy(); expect(within(card).queryByText('派活工作台')).toBeNull();
  expect(within(card).getByText('群聊')).toBeTruthy();
  expect(within(card).getByText('排队').nextSibling?.textContent).toBe('GPT-6 Astra');
  expect(within(plain).queryByText('群聊')).toBeNull();
  // 群里排队的成员不单独成卡（也就不会混进弹窗的“上一件 / 下一件”）。
  expect(running.querySelector('[data-queued]')).toBeNull();
  // c2：这一刻没人在跑、只有人排着：一张只写群名和排队的人的卡。
  const waiting = running.querySelector('[data-chat="c2"]') as HTMLElement;
  expect(within(waiting).getByText('另一个群')).toBeTruthy(); expect(within(waiting).getByText('群聊')).toBeTruthy();
  expect(within(waiting).getByText('排队').nextSibling?.textContent).toBe('GPT-6 Astra');
  fireEvent.click(waiting);
  const tabs = () => within(screen.getByRole('tablist', { name: '群聊' })).getAllByRole('tab');
  await waitFor(() => expect(tabs().find(t => t.getAttribute('aria-selected') === 'true')?.textContent).toContain('另一个群'));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(localStorage.getItem('xa.chat-selected')).toContain('c2');
});
test('只有群在排队的项目也算一个项目：另一个项目有普通的活时，两边的卡都带项目标签', async () => {
  const v = chatView({ project: 'other', title: '新开的群', members: [{ who: 'codex', readOnly: false, job: null, state: 'queued' }], messages: [] });
  v.jobs = v.jobs.filter(j => j.id === 'solo');
  v.projects = [{ name: 'xa', label: '派活工作台', archived: false }, { name: 'other', label: '另一个项目', archived: false }];
  mount(v, 'board');
  const running = (await screen.findByTestId('running')).closest('.column') as HTMLElement;
  expect(within(running.querySelector('[data-chat="c1"]') as HTMLElement).getByText('另一个项目')).toBeTruthy();
  expect(within(running.querySelector('[data-job="solo"]') as HTMLElement).getByText('派活工作台')).toBeTruthy();
  expect(within(running).getByTestId('queued').textContent).toBe('· 1 排队');
});
test('在跑的卡“正在…”只看这一轮开始之后的动作', async () => {
  const v = chatView();
  v.jobs = v.jobs.map(j => j.id === 'ds' ? { ...j, started: at(1), activity: [{ at: at(9), kind: 'cmd' as const, text: 'npm test' }] } : j);
  mount(v, 'board');
  const card = (await screen.findByTestId('running')).closest('.column')!.querySelector('[data-job="ds"]') as HTMLElement;
  expect(within(card).getByText('正在').nextSibling?.textContent).toBe('看题目');
});
test('验收中的群聊卡：标“群聊”，小结说“位”；已完成的行也标“群聊”', async () => {
  const v = chatView({ members: [{ who: 'codex', readOnly: false, job: 'cx', state: 'idle' }, { who: 'deepseek', readOnly: true, job: 'ds', state: 'idle' }] },
    { id: 'c2', title: '拍完板的群', members: [{ who: 'codex', readOnly: false, job: 'fin', state: 'idle' }], messages: [] });
  v.jobs = [...v.jobs.filter(j => j.id !== 'solo').map(j => ({ ...j, state: 'done' as const, ended: at(10), seconds: 60 })),
    job('fin', { who: 'codex', state: 'done', project: 'xa', title: '拍完板的群', ended: at(30), seconds: 60, decision: { kind: 'adopt', note: '', at: at(20), by: 'lead' } })];
  mount(v, 'board');
  const attention = (await screen.findByTestId('attention')).closest('.column') as HTMLElement;
  expect(within(attention).getByText('负责人在挑')).toBeTruthy();
  expect(within(attention).getByText('群聊')).toBeTruthy();
  expect(within(attention).getByText('2 位做完了')).toBeTruthy();
  const done = screen.getByTestId('done').closest('.column') as HTMLElement;
  fireEvent.click(done.querySelector('.done-head')!);
  const row = within(done).getByText('拍完板的群').closest('.done-row') as HTMLElement;
  expect(within(row).getByText('群聊')).toBeTruthy();
  fireEvent.click(row);
  await waitFor(() => expect(within(screen.getByRole('tablist', { name: '群聊' })).getAllByRole('tab').find(t => t.getAttribute('aria-selected') === 'true')?.textContent).toContain('拍完板的群'));
});
test('协作页是聊天窗：群列表、你的话靠右、@ 上色、工作卡跟着实时走、成员栏写只读和状态', async () => {
  mount(chatView({}, { title: '另一个项目的修复', project: 'sub', messages: [] }));
  const log = await screen.findByRole('list', { name: '聊天记录' });
  const tabs = within(screen.getByRole('tablist', { name: '群聊' })).getAllByRole('tab');
  expect(tabs.map(t => t.querySelector('.sidenav-label')?.textContent)).toEqual(['派活工作台', '另一个项目的修复']);
  const mine = within(log).getByText(/任务记录要能改分/).closest('.chat-msg')!;
  expect(mine.classList.contains('mine')).toBe(true);
  expect(within(log).getByText('任务记录要能改分，<b>旧分</b>留着。', { exact: false })).toBeTruthy();
  expect(log.querySelector('.chat-bubble b')).toBeNull();
  expect([...log.querySelectorAll('.chat-at')].map(e => e.textContent)).toContain('@DeepSeek');
  const cards = log.querySelectorAll('.work-card');
  expect(cards[0].textContent).toContain('这一轮做完了');
  expect(cards[1].textContent).toContain('在干活');
  expect(cards[1].textContent).toContain('查资料');
  expect(screen.getByText('DeepSeek V4 Pro 在动手')).toBeTruthy();
  const side = screen.getByRole('complementary', { name: '群信息' });
  expect(within(side).getByText('只读')).toBeTruthy();
  expect(within(side).getByText('在动手')).toBeTruthy();
  fireEvent.click(cards[0]);
  expect(await screen.findByRole('dialog')).toBeTruthy();
});
test('顶栏的成员按钮：任何宽度都写着群里有几位（负责人算一位）、是谁；它是成员栏的开关，窄窗口默认收起、点了盖出来、Esc 收回', async () => {
  mount(chatView());
  const people = await screen.findByRole('button', { name: '成员 3 位' });
  expect(people.textContent).toBe('3 位'); expect(people.getAttribute('title')).toBe('负责人、Codex、DeepSeek（只读）');
  expect(people.querySelectorAll('.logo').length).toBe(3);
  // 宽窗口（测试环境没有 matchMedia，按宽窗口算）：成员栏默认开着，点按钮收起、再点打开。
  expect(people.getAttribute('aria-expanded')).toBe('true'); expect(screen.getByRole('complementary', { name: '群信息' })).toBeTruthy();
  fireEvent.click(people);
  expect(people.getAttribute('aria-expanded')).toBe('false'); expect(screen.queryByRole('complementary', { name: '群信息' })).toBeNull();
  fireEvent.click(people);
  expect(screen.getByRole('complementary', { name: '群信息' }).id).toBe(people.getAttribute('aria-controls'));
  cleanup();
  // 窄窗口：默认收起，按钮和人数还在；点了盖出来，按 Esc 或点聊天区收回去。
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: true, media: query, addEventListener: () => {}, removeEventListener: () => {} }));
  try {
    mount(chatView({ members: [...chat().members, { who: 'grok', readOnly: false, job: null, state: 'idle' }, { who: 'codex-luna', readOnly: false, job: null, state: 'idle' }] }));
    const narrow = await screen.findByRole('button', { name: '成员 5 位' });
    expect(narrow.textContent).toBe('+15 位');   // 最多画 4 个图标，再多写“+N”
    expect(narrow.getAttribute('aria-expanded')).toBe('false'); expect(screen.queryByRole('complementary', { name: '群信息' })).toBeNull();
    fireEvent.click(narrow);
    expect(screen.getByRole('complementary', { name: '群信息' })).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('complementary', { name: '群信息' })).toBeNull();
    fireEvent.click(narrow); fireEvent.click(screen.getByRole('list', { name: '聊天记录' }));
    expect(screen.queryByRole('complementary', { name: '群信息' })).toBeNull();
  } finally { vi.unstubAllGlobals(); }
});
test('输入框：打 @ 弹出成员候选，回车填进去；Enter 发送走 chatSay，Shift+Enter 不发', async () => {
  mount(chatView());
  const box = await screen.findByRole('textbox', { name: '发消息' }) as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value: '请 @Dee', selectionStart: 6 } });
  const list = screen.getByRole('listbox', { name: '可以 @ 的人' });
  expect(within(list).getAllByRole('option').map(o => o.querySelector('b')?.textContent)).toEqual(['@DeepSeek']);
  fireEvent.keyDown(box, { key: 'Enter' });
  expect(box.value).toBe('请 @DeepSeek ');
  expect(screen.queryByRole('listbox')).toBeNull();
  fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
  expect(window.xa.chatSay).not.toHaveBeenCalled();
  fireEvent.change(box, { target: { value: '请 @DeepSeek 审一下  ', selectionStart: 15 } });
  fireEvent.keyDown(box, { key: 'Enter' });
  await waitFor(() => expect(window.xa.chatSay).toHaveBeenCalledWith('c1', '请 @DeepSeek 审一下'));
});
test('停下要二次确认；收起的群只能看记录；没有群时一句话加“新建群聊”', async () => {
  mount(chatView());
  fireEvent.click(await screen.findByRole('button', { name: '停下' }));
  await act(async () => { fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '确认停下' })); });
  expect(window.xa.chatStop).toHaveBeenCalledWith('c1');
  cleanup();
  mount(chatView({ state: 'closed', closed: at(1) }));
  expect(await screen.findByText('这个群已经结束，只能看记录。')).toBeTruthy();
  expect(screen.queryByRole('textbox', { name: '发消息' })).toBeNull();
  // 结束了的群不自动折起：还在列表里，只标“已结束”
  const tab = within(screen.getByRole('tablist', { name: '群聊' })).getByRole('tab');
  expect(tab.textContent).toContain('已结束');
  expect(screen.queryByRole('button', { name: /已归档/ })).toBeNull();
  cleanup();
  const none = view(); none.chats = [];
  mount(none);
  fireEvent.click(await screen.findByRole('button', { name: '新建群聊' }));
  expect(await screen.findByRole('dialog', { name: '新建群聊' })).toBeTruthy();
});
test('新建群聊：选项目、拉人、设只读，交给 chatCreate；建好后打开新群', async () => {
  const v = view(); v.chats = []; v.projects = [{ name: 'xa', label: '派活工作台', archived: false }];
  mount(v);
  fireEvent.click(await screen.findByRole('button', { name: '新建群聊' }));
  const dialog = await screen.findByRole('dialog', { name: '新建群聊' });
  expect(within(dialog).queryByRole('checkbox', { name: /CursorClaude/ })).toBeNull();
  fireEvent.click(within(dialog).getByRole('checkbox', { name: '拉 Codex 进群' }));
  fireEvent.click(within(dialog).getByRole('checkbox', { name: '拉 DeepSeek 进群' }));
  fireEvent.click(within(dialog).getByRole('switch', { name: 'DeepSeek 只读' }));
  fireEvent.click(within(dialog).getByRole('button', { name: '建群' }));
  await waitFor(() => expect(window.xa.chatCreate).toHaveBeenCalledWith({ project: 'xa', title: undefined, members: ['codex:high', 'deepseek:high:ro'] }));
  expect(localStorage.getItem('xa.chat-selected')).toBe('test-chat');
});
const menuOf = async (title: string) => { fireEvent.click(screen.getByRole('button', { name: `更多操作：${title}` })); return screen.findByRole('menu', { name: `更多操作：${title}` }); };
test('会话列表每行的“…”菜单：置顶、重命名、归档三项；没有一点就生效的归档按钮', async () => {
  mount(chatView({}, { title: '另一个项目的修复', project: 'sub', messages: [] }));
  await screen.findByRole('list', { name: '聊天记录' });
  expect(screen.queryByRole('button', { name: /^归档/ })).toBeNull();
  const menu = await menuOf('另一个项目的修复');
  expect(within(menu).getAllByRole('menuitem').map(i => i.textContent)).toEqual(['置顶', '重命名', '归档']);
  // 置顶：排到最前，带“置顶”小字，记在本机；菜单变成“取消置顶”
  fireEvent.click(within(menu).getByRole('menuitem', { name: '置顶' }));
  const tabs = () => within(screen.getByRole('tablist', { name: '群聊' })).getAllByRole('tab');
  expect(tabs().map(t => t.querySelector('.sidenav-label')?.textContent)).toEqual(['另一个项目的修复', '派活工作台']);
  expect(tabs()[0].textContent).toContain('置顶');
  expect(JSON.parse(localStorage.getItem('xa.chat-pinned')!)).toEqual(['c2']);
  fireEvent.click(within(await menuOf('另一个项目的修复')).getByRole('menuitem', { name: '取消置顶' }));
  expect(tabs().map(t => t.querySelector('.sidenav-label')?.textContent)).toEqual(['派活工作台', '另一个项目的修复']);
  // 右键这一行也打开同一个菜单
  fireEvent.contextMenu(tabs()[1]);
  expect(within(await screen.findByRole('menu', { name: '更多操作：另一个项目的修复' })).getByRole('menuitem', { name: '归档' })).toBeTruthy();
});
test('重命名：小弹窗改群名，交给 chatRename；没改或空着不能保存', async () => {
  mount(chatView());
  await screen.findByRole('list', { name: '聊天记录' });
  fireEvent.click(within(await menuOf('派活工作台')).getByRole('menuitem', { name: '重命名' }));
  const dialog = await screen.findByRole('dialog', { name: '重命名群聊' });
  const box = within(dialog).getByRole('textbox', { name: '群名' }) as HTMLInputElement, save = within(dialog).getByRole('button', { name: '保存' }) as HTMLButtonElement;
  expect(box.value).toBe('派活工作台'); expect(save.disabled).toBe(true);
  fireEvent.change(box, { target: { value: '   ' } }); expect(save.disabled).toBe(true);
  fireEvent.change(box, { target: { value: '  评分历史  ' } });
  fireEvent.click(save);
  await waitFor(() => expect(window.xa.chatRename).toHaveBeenCalledWith('c1', '评分历史'));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '重命名群聊' })).toBeNull());
});
test('归档：菜单里点了才收进“已归档”，底部提示条能撤销；“已归档”里每行的菜单是取消归档', async () => {
  mount(chatView({}, { title: '另一个项目的修复', project: 'sub', messages: [] }));
  await screen.findByRole('list', { name: '聊天记录' });
  fireEvent.click(within(await menuOf('派活工作台')).getByRole('menuitem', { name: '归档' }));
  expect(JSON.parse(localStorage.getItem('xa.chat-archived')!)).toEqual(['c1']);
  expect(screen.getByRole('button', { name: '已归档 1 个群' })).toBeTruthy();
  // 撤销
  const toast = await screen.findByRole('status');
  expect(toast.textContent).toContain('已归档“派活工作台”');
  fireEvent.click(within(toast).getByRole('button', { name: '撤销' }));
  expect(JSON.parse(localStorage.getItem('xa.chat-archived')!)).toEqual([]);
  expect(screen.queryByRole('button', { name: /已归档 \d/ })).toBeNull();
  // 再归档一次，从“已归档”里取消
  fireEvent.click(within(await menuOf('派活工作台')).getByRole('menuitem', { name: '归档' }));
  fireEvent.click(screen.getByRole('button', { name: '已归档 1 个群' }));
  fireEvent.click(within(await menuOf('派活工作台')).getByRole('menuitem', { name: '取消归档' }));
  expect(JSON.parse(localStorage.getItem('xa.chat-archived')!)).toEqual([]);
});
