import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { View, ViewChat, ViewJob } from '../../../src/core/view-types.ts';
import type { ChatMessage } from '../../../src/core/chat.ts';
import type { Who } from '../../../src/core/roster.ts';
import { errorReason } from '../lib/errors.ts';
import { effortText, fmtTime, human, isOpen, STATE } from '../lib/board.ts';
import { authorName, chatStatus, handleOf, markRead, mentionOptions, mentionQuery, preview, readArchived, readMarks, readPinned, rememberArchived, rememberPinned, splitMentions, unread } from '../lib/chat.ts';
import type { MentionOption } from '../lib/chat.ts';
import { projectLabel } from '../lib/history.ts';
import { Button, CheckDot, Chip, ConfirmDialog, Elapsed, EmptyState, Modal, RichText, Select, SideNavLayout, SideNavRow, Switch, WorkerIcon } from '../ui/index.ts';
import type { ToastAction } from '../ui/index.ts';
import type { SideNavItem, Workers } from '../ui/index.ts';
import type { Open } from './Board.tsx';

// 协作页 = 项目群聊（docs/ui-spec.md 第 17 节，参考 Grok Bot 的群聊）：左边群列表，中间聊天窗口，右边成员和群里的活。
// 你、负责人（群主）、各位选手都在群里说话；@ 谁就是叫谁动手，不 @ 就交给负责人。消息一律当纯文字显示。
export const CHAT_MAX = 2000;
const KEY = 'xa.chat-selected';
export const readSelectedChat = () => { try { return localStorage.getItem(KEY) ?? ''; } catch { return ''; } };
export const rememberSelectedChat = (id: string) => { try { localStorage.setItem(KEY, id); } catch { /* 记不住就算了 */ } };
const lastAt = (c: ViewChat) => c.messages.at(-1)?.at ?? c.created;

// 头像：选手用各家图标，负责人用 Claude 图标；你自己的话靠右、不画头像。
function Avatar({ from, workers }: { from: ChatMessage['from']; workers: Workers }) {
  if (from === 'lead') return <WorkerIcon name="claude" size="md" label="负责人" />;
  if (from === 'owner') return null;
  if (from === 'platform') return null;
  const w = workers[from];
  return <WorkerIcon name={w.icon} badge={w.badge} size="md" label={w.name} />;
}
// 正文：按简化的 Markdown 排版（代码、加粗、列表、标题、代码块，见 RichText），认得出的 @ 上色；太长先折起。仍不当网页代码。
function Text({ text, members }: { text: string; members: Who[] }) {
  const [open, setOpen] = useState(false);
  const lines = text.split('\n'), long = lines.length > 12 || text.length > 900;
  const shown = long && !open ? lines.slice(0, 12).join('\n').slice(0, 900) + '…' : text;
  const mentions = (part: string) => splitMentions(part, members).map((x, i) => x.at ? <span key={i} className="chat-at">{x.text}</span> : x.text);
  return <>
    <RichText className="chat-text" text={shown} decorate={mentions} />
    {long && <button type="button" className="chat-more" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? '收起' : '展开全文'}</button>}
  </>;
}
// 工作卡：选手开始干一轮。是这件活的当前这一轮就显示实时进度，否则写这一轮的结果；点开是这件活的详情。
function WorkCard({ message, job, latest, open }: { message: ChatMessage; job: ViewJob | undefined; latest: boolean; open: Open }) {
  if (!job) return <div className="work-card work-gone">这一轮的记录已经清理了</div>;
  // 只有这件活最近的那张工作卡跟着实时走；更早的几轮都已经做完了。
  const live = latest && isOpen(job);
  const done = !latest || job.state === 'done';
  const doing = [...job.activity].reverse().find(a => a.kind !== 'say');
  const word = live ? (job.state === 'queued' ? '准备开工' : '在干活') : done ? '这一轮做完了' : STATE[job.state];
  const dot = live ? 'running' : done ? 'done' : job.state;
  return <button type="button" className={'work-card' + (live ? ' live' : '')} onClick={() => open({ kind: 'job', id: job.id })} title="看这件活的详情">
    <span className="work-top"><span className={'dot dot-' + dot} aria-hidden="true" /><b>{word}</b>{message.turn && message.turn > 1 && <span className="faint">第 {message.turn} 轮</span>}{live && <Elapsed job={job} className="faint num" />}<span className="work-open">详情 ›</span></span>
    {live && <span className="work-doing ellip">{doing ? human(doing) : '看题目'}</span>}
  </button>;
}
const Message = memo(function Message({ m, prev, chat, view, latest, open }: { m: ChatMessage; prev: ChatMessage | undefined; chat: ViewChat; view: View; latest: boolean; open: Open }) {
  const members = chat.members.map(x => x.who);
  if (m.kind === 'event' || m.from === 'platform') return <li className="chat-event"><span>{m.text}</span></li>;
  const mine = m.from === 'owner';
  // 同一个人几分钟内连着说，只在第一条写头像和名字。
  const grouped = !!prev && prev.from === m.from && prev.kind !== 'event' && Date.parse(m.at) - Date.parse(prev.at) < 5 * 60_000;
  const who = m.from !== 'owner' && m.from !== 'lead' ? view.workers[m.from] : null;
  const body = m.kind === 'work'
    ? <WorkCard message={m} job={view.jobs.find(j => j.id === m.job)} latest={latest} open={open} />
    : <div className={'chat-bubble' + (mine ? ' mine' : m.from === 'lead' ? ' lead' : '')}><Text text={m.text} members={members} /></div>;
  return <li className={'chat-msg' + (mine ? ' mine' : '') + (grouped ? ' grouped' : '')}>
    {!mine && <span className="chat-avatar">{!grouped && <Avatar from={m.from} workers={view.workers} />}</span>}
    <div className="chat-body">
      {!grouped && <div className="chat-head">{!mine && <b title={who ? `${who.name} · ${who.model}` : undefined}>{authorName(m.from)}</b>}{who && <span className="faint">{who.model}</span>}<time className="faint">{fmtTime(m.at)}</time></div>}
      {body}
    </div>
  </li>;
});
// 聊天记录：新的在下面；停在底部时自动跟随，往上翻着看时不打断，底部浮出“N 条新消息 ↓”。
function Transcript({ chat, view, open }: { chat: ViewChat; view: View; open: Open }) {
  const box = useRef<HTMLOListElement>(null), atBottom = useRef(true), seen = useRef(chat.messages.length);
  const [fresh, setFresh] = useState(0), last = chat.messages.at(-1)?.id ?? 0;
  useLayoutEffect(() => {
    const el = box.current; if (!el) return;
    const added = Math.max(0, chat.messages.length - seen.current); seen.current = chat.messages.length;
    if (atBottom.current) { el.scrollTop = el.scrollHeight; setFresh(0); }
    else if (added) setFresh(n => n + added);
  }, [last, chat.messages.length]);
  useEffect(() => { if (atBottom.current && last) markRead(chat.id, last); }, [chat.id, last]);
  // 每件活最近的那张工作卡（只有它跟着实时走）。
  const latestWork = useMemo(() => { const ids = new Map<string, number>(); for (const m of chat.messages) if (m.kind === 'work' && m.job) ids.set(m.job, m.id); return new Set(ids.values()); }, [chat.messages]);
  const onScroll = () => {
    const el = box.current!; atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
    if (atBottom.current) { setFresh(0); if (last) markRead(chat.id, last); }
  };
  const down = () => { const el = box.current; if (el) { el.scrollTop = el.scrollHeight; atBottom.current = true; setFresh(0); if (last) markRead(chat.id, last); } };
  return <div className="chat-scroll">
    <ol className="chat-log" ref={box} onScroll={onScroll} aria-label="聊天记录" aria-live="polite">
      {!chat.messages.length && <li className="chat-event"><span>群建好了。@ 一位选手说要做什么，或者直接说，负责人来安排。</span></li>}
      {chat.messages.map((m, i) => <Message key={m.id} m={m} prev={chat.messages[i - 1]} chat={chat} view={view} latest={latestWork.has(m.id)} open={open} />)}
    </ol>
    {fresh > 0 && <button type="button" className="channel-fresh" onClick={down}>{fresh} 条新消息 ↓</button>}
  </div>;
}
// 输入框：Enter 发送，Shift+Enter 换行；打 @ 弹出成员候选，上下键选、Enter 或 Tab 填进去、Esc 关掉。
function Composer({ chat, view }: { chat: ViewChat; view: View }) {
  const [text, setText] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [query, setQuery] = useState<{ start: number; query: string } | null>(null), [pick, setPick] = useState(0);
  const input = useRef<HTMLTextAreaElement>(null), sending = useRef(false), listId = useId();
  const options = useMemo(() => mentionOptions(chat, view.workers), [chat, view.workers]);
  const shown: MentionOption[] = query ? options.filter(o => (o.handle + o.label).toLowerCase().includes(query.query.toLowerCase())) : [];
  const clean = text.trim(), length = [...clean].length, tooLong = length > CHAT_MAX;
  const sync = (value: string, caret: number) => { setText(value); setQuery(mentionQuery(value, caret)); setPick(0); };
  const insert = (o: MentionOption) => {
    if (!query) return;
    const next = text.slice(0, query.start) + '@' + o.handle + ' ' + text.slice(query.start + 1 + query.query.length);
    const caret = query.start + o.handle.length + 2;
    setText(next); setQuery(null);
    requestAnimationFrame(() => { input.current?.focus(); input.current?.setSelectionRange(caret, caret); });
  };
  const send = async () => {
    if (sending.current || !clean || tooLong) return;
    sending.current = true; setBusy(true); setError('');
    try { await window.xa.chatSay(chat.id, clean); setText(''); setQuery(null); }
    catch (e) { setError('没能发出：' + errorReason(e)); }
    finally { sending.current = false; setBusy(false); }
  };
  const key = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (shown.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setPick(p => (p + 1) % shown.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setPick(p => (p + shown.length - 1) % shown.length); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); insert(shown[pick]); return; }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setQuery(null); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); }
  };
  return <div className="chat-composer">
    {shown.length > 0 && <ul className="mention-list" id={listId} role="listbox" aria-label="可以 @ 的人">{shown.map((o, i) =>
      <li key={o.handle} role="option" aria-selected={i === pick} className={i === pick ? 'on' : undefined} onMouseDown={e => { e.preventDefault(); insert(o); }}>
        {o.who ? <WorkerIcon name={view.workers[o.who].icon} badge={view.workers[o.who].badge} size="sm" /> : <span className="mention-mark" aria-hidden="true">@</span>}
        <b>@{o.handle}</b><span className="faint ellip">{o.label}</span>
      </li>)}</ul>}
    <div className="chat-input">
      <textarea ref={input} className="field" aria-label="发消息" rows={1} value={text} placeholder={`发消息，用 @ 叫某一位；不 @ 就交给负责人`}
        aria-autocomplete="list" aria-controls={shown.length ? listId : undefined} aria-expanded={shown.length > 0}
        onChange={e => sync(e.target.value, e.target.selectionStart)} onKeyDown={key} onClick={e => setQuery(mentionQuery(text, e.currentTarget.selectionStart))} />
      <Button variant="primary" disabled={busy || !clean || tooLong} onClick={() => void send()}>发送</Button>
    </div>
    <div className="chat-tip">{tooLong ? <span className="over-limit">超出 {length - CHAT_MAX} 字</span> : <span>Enter 发送，Shift+Enter 换行</span>}{error && <span role="alert">{error}</span>}</div>
  </div>;
}
function Side({ id, chat, view, open }: { id: string; chat: ViewChat; view: View; open: Open }) {
  const works = chat.messages.filter(m => m.kind === 'work').slice(-8).reverse();
  return <aside className="chat-side" id={id} aria-label="群信息">
    <h3>成员</h3>
    <ul className="chat-members">
      <li><WorkerIcon name="claude" size="sm" /><span className="ellip"><b>负责人</b> <span className="faint">群主</span></span></li>
      {chat.members.map(m => {
        const w = view.workers[m.who], job = m.job ? view.jobs.find(j => j.id === m.job) : undefined;
        return <li key={m.who}>
          <WorkerIcon name={w.icon} badge={w.badge} size="sm" />
          <span className="chat-member-name"><b>{handleOf(m.who)}</b><span className="faint ellip">{w.model}{job ? ` · ${effortText(job.effort)}` : ''}</span></span>
          {m.readOnly && <Chip>只读</Chip>}
          <span className={'chat-member-state ' + m.state}>{m.state === 'working' ? '在动手' : m.state === 'queued' ? '排队' : '空闲'}</span>
        </li>;
      })}
    </ul>
    <h3>群里的活</h3>
    {works.length ? <ul className="chat-works">{works.map(m => {
      const job = view.jobs.find(j => j.id === m.job), who = m.from !== 'owner' && m.from !== 'lead' && m.from !== 'platform' ? m.from : null;
      return <li key={m.id}><button type="button" className="chat-work-row" disabled={!job} onClick={() => job && open({ kind: 'job', id: job.id })}>
        {who && <WorkerIcon name={view.workers[who].icon} badge={view.workers[who].badge} size="sm" />}
        <span className="ellip">{who ? handleOf(who) : ''}{m.turn && m.turn > 1 ? ` · 第 ${m.turn} 轮` : ''}</span>
        <span className="faint">{job ? (isOpen(job) ? '在干活' : job.state === 'done' ? '做完了' : STATE[job.state]) : '已清理'}</span>
      </button></li>;
    })}</ul> : <p className="faint chat-none">还没有人动过手</p>}
  </aside>;
}
// 顶栏的成员按钮：一小排成员小图标 + 人数（负责人算一位），任何宽度都看得到群里有谁；它也是成员栏的开关。
const PEOPLE_ICONS = 4;
function People({ chat, view, expanded, toggle, controls }: { chat: ViewChat; view: View; expanded: boolean; toggle: () => void; controls: string }) {
  const icons = [{ key: 'lead', icon: 'claude', badge: undefined as string | undefined }, ...chat.members.map(m => ({ key: m.who as string, icon: view.workers[m.who].icon, badge: view.workers[m.who].badge }))];
  const names = ['负责人', ...chat.members.map(m => handleOf(m.who) + (m.readOnly ? '（只读）' : ''))], more = icons.length - PEOPLE_ICONS;
  return <button type="button" className="chat-people" aria-label={`成员 ${icons.length} 位`} aria-expanded={expanded} aria-controls={controls} title={names.join('、')} onClick={toggle}>
    <span className="chat-people-icons" aria-hidden="true">{icons.slice(0, PEOPLE_ICONS).map(i => <WorkerIcon key={i.key} name={i.icon} badge={i.badge} size="sm" />)}{more > 0 && <span className="chat-people-more">+{more}</span>}</span>
    <span>{icons.length} 位</span>
  </button>;
}
// 窄窗口（成员栏默认收起）。没有 matchMedia 的环境按宽窗口算。
const NARROW = '(max-width: 1100px)';
function useNarrow() {
  const query = useMemo(() => typeof window.matchMedia === 'function' ? window.matchMedia(NARROW) : null, []);
  const [narrow, setNarrow] = useState(() => query?.matches ?? false);
  useEffect(() => {
    if (!query) return;
    const on = () => setNarrow(query.matches);
    query.addEventListener('change', on); on();
    return () => query.removeEventListener('change', on);
  }, [query]);
  return narrow;
}
function Room({ chat, view, open }: { chat: ViewChat; view: View; open: Open }) {
  const [confirm, setConfirm] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  // 成员栏：宽窗口默认开、窄窗口默认收；点了成员按钮就按主人选的来，换一个群回到默认。
  const narrow = useNarrow(), [side, setSide] = useState<boolean | null>(null), sideOpen = side ?? !narrow, sideId = useId();
  useEffect(() => { setSide(null); }, [chat.id]);
  useEffect(() => {
    if (!narrow || !sideOpen) return;
    const key = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') setSide(false); };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [narrow, sideOpen]);
  const active = chat.members.some(m => m.state !== 'idle');
  const stop = async () => {
    setConfirm(false); setBusy(true); setError('');
    try { await window.xa.chatStop(chat.id); }
    catch (e) { setError('没能办成：' + errorReason(e)); }
    finally { setBusy(false); }
  };
  return <div className="chat-room">
    <header className="chat-top">
      <div className="chat-title"><h1 className="ellip" title={chat.title}>{chat.title}</h1>{projectLabel(view, chat.project) !== chat.title && <Chip title={'项目：' + chat.project}>{projectLabel(view, chat.project)}</Chip>}</div>
      <span className="chat-status">{chatStatus(chat, view.workers)}</span>
      {chat.pendingLead > 0 && <span className="faint">负责人还有 {chat.pendingLead} 条没回</span>}
      {active && chat.state === 'open' && <Button variant="danger" size="sm" disabled={busy} onClick={() => setConfirm(true)}>停下</Button>}
      {/* 成员按钮固定在顶栏最右边：群名多长、有没有“停下”，它都在同一个位置，正对着下面的成员栏。 */}
      <People chat={chat} view={view} expanded={sideOpen} toggle={() => setSide(!sideOpen)} controls={sideId} />
    </header>
    {error && <p role="alert" className="chat-alert">{error}</p>}
    <div className="chat-main" data-side={sideOpen ? 'open' : 'closed'}>
      <section className="chat-center" aria-label="聊天" onClick={narrow && sideOpen ? () => setSide(false) : undefined}>
        <Transcript chat={chat} view={view} open={open} />
        {chat.state === 'open' ? <Composer chat={chat} view={view} /> : <p className="chat-closed">这个群已经结束，只能看记录。</p>}
      </section>
      {sideOpen && <Side id={sideId} chat={chat} view={view} open={open} />}
    </div>
    {confirm && <ConfirmDialog busy={busy} message="停下后，正在动手的那位会停下、排队的都取消；做到一半的东西保留，之后再 @ 照常派活。" confirmLabel="确认停下" onCancel={() => setConfirm(false)} onConfirm={() => void stop()} />}
  </div>;
}
// 新建群聊：选项目、起个名字、拉选手进群（每位选强度，可设只读）。只列主人设置里开着、能进群的选手（Cursor 暂不行）。
function NewChat({ view, close, created }: { view: View; close: () => void; created: (id: string) => void }) {
  const projects = view.projects.filter(p => !p.archived);
  const candidates = view.roster.filter(r => view.settings.workers[r.who]?.enabled && !r.who.startsWith('cursor'));
  const [project, setProject] = useState(projects[0]?.name ?? ''), [title, setTitle] = useState('');
  const [picked, setPicked] = useState<Record<string, { effort: string; readOnly: boolean }>>({});
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const count = Object.keys(picked).length;
  const toggle = (who: string, on: boolean) => setPicked(p => {
    const next = { ...p };
    if (on) next[who] = { effort: view.settings.workers[who as Who].efforts.includes('high') ? 'high' : view.settings.workers[who as Who].efforts[0], readOnly: false };
    else delete next[who];
    return next;
  });
  const create = async () => {
    setBusy(true); setError('');
    try {
      const members = Object.entries(picked).map(([who, p]) => `${who}:${p.effort}${p.readOnly ? ':ro' : ''}`);
      created(await window.xa.chatCreate({ project, title: title.trim() || undefined, members }));
    } catch (e) { setError('没能建群：' + errorReason(e)); }
    finally { setBusy(false); }
  };
  // 窄弹窗（sm）：内容就三样，拉宽了只是一长条。说明放在成员下面，底栏只留按钮。
  return <Modal label="新建群聊" title="新建群聊" size="sm" onClose={close} footer={<><span /><span className="step"><Button size="sm" onClick={close}>取消</Button><Button size="sm" variant="primary" disabled={busy || !project || !count || count > 6} onClick={() => void create()}>建群</Button></span></>}>
    <div className="new-chat">
      <label className="new-chat-row"><span>项目</span><Select label="项目" items={projects.map(p => ({ id: p.name, label: p.label }))} value={project} onChange={setProject} /></label>
      <label className="new-chat-row"><span>群名</span><input className="field" value={title} maxLength={40} placeholder={projects.find(p => p.name === project)?.label ?? '群名'} onChange={e => setTitle(e.target.value)} /></label>
      <div className="new-chat-members" role="group" aria-label="拉谁进群">{candidates.map(r => {
        const on = !!picked[r.who], w = view.workers[r.who];
        return <div key={r.who} className={'new-chat-member' + (on ? ' on' : '')}>
          <CheckDot label={`拉 ${handleOf(r.who)} 进群`} checked={on} onChange={v => toggle(r.who, v)} />
          <WorkerIcon name={w.icon} badge={w.badge} size="sm" />
          <span className="new-chat-name"><b>{handleOf(r.who)}</b><span className="faint">{r.model}</span></span>
          {on && <Select label={`${handleOf(r.who)} 的强度`} items={view.settings.workers[r.who].efforts.map(e => ({ id: e, label: effortText(e) }))} value={picked[r.who].effort} onChange={e => setPicked(p => ({ ...p, [r.who]: { ...p[r.who], effort: e } }))} />}
          {on && <span className="new-chat-ro"><span className="faint">只读</span><Switch label={`${handleOf(r.who)} 只读`} checked={picked[r.who].readOnly} onChange={v => setPicked(p => ({ ...p, [r.who]: { ...p[r.who], readOnly: v } }))} /></span>}
        </div>;
      })}</div>
      <p className="new-chat-hint">最多 6 位。只读的成员改不了文件，适合专门审查。</p>
      {error && <p role="alert">{error}</p>}
    </div>
  </Modal>;
}
// 改群名：小弹窗，一个输入框。改的是群真正的名字（负责人和命令行看到的也跟着变）。
export const TITLE_MAX = 100;
function RenameChat({ chat, close }: { chat: ViewChat; close: () => void }) {
  const [title, setTitle] = useState(chat.title), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const clean = title.trim(), ok = !!clean && [...clean].length <= TITLE_MAX && clean !== chat.title;
  const save = async () => {
    if (!ok || busy) return;
    setBusy(true); setError('');
    try { await window.xa.chatRename(chat.id, clean); close(); }
    catch (e) { setError('没能改名：' + errorReason(e)); setBusy(false); }
  };
  return <Modal label="重命名群聊" title="重命名" size="sm" onClose={close} footer={<><span /><span className="step"><Button size="sm" onClick={close}>取消</Button><Button size="sm" variant="primary" disabled={!ok || busy} onClick={() => void save()}>保存</Button></span></>}>
    <div className="new-chat">
      <input className="field" aria-label="群名" value={title} maxLength={TITLE_MAX} data-autofocus onChange={e => setTitle(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); void save(); } }} />
      {error && <p role="alert">{error}</p>}
    </div>
  </Modal>;
}
// 左栏会话列表：没归档的群都在（结束了的也在，只标“已结束”），置顶的在最前，其余按最近一条消息从新到旧。
// 每一行移上去右上角有个“…”，点开菜单是“置顶 / 重命名 / 归档”（右键这一行也行）——不放一点就生效的按钮，免得误触；
// 归档后底部提示条带“撤销”。归档的收在最下面“已归档”，那里每行的菜单是“取消归档”。置顶、归档都是你自己的整理，记在本机。
export type Notify = (text: string, action?: ToastAction) => number;
export function Chat({ view, selected, select, open, notify, dismiss }: { view: View; selected: string; select: (id: string) => void; open: Open; notify: Notify; dismiss: (id: number) => void }) {
  const [creating, setCreating] = useState(false), [renaming, setRenaming] = useState<string | null>(null);
  const [archivedIds, setArchivedIds] = useState(readArchived), [pinnedIds, setPinnedIds] = useState(readPinned);
  const marks = readMarks();
  const byRecent = (a: ViewChat, b: ViewChat) => lastAt(b).localeCompare(lastAt(a));
  const order = (a: ViewChat, b: ViewChat) => Number(pinnedIds.has(b.id)) - Number(pinnedIds.has(a.id)) || byRecent(a, b);
  const listed = view.chats.filter(c => !archivedIds.has(c.id)).sort(order), archived = view.chats.filter(c => archivedIds.has(c.id)).sort(byRecent);
  const [unfolded, setUnfolded] = useState(() => archived.some(c => c.id === selected)), foldId = useId();
  const current = view.chats.find(c => c.id === selected) ?? listed[0] ?? archived[0];
  const toggle = (set: typeof setArchivedIds, remember: (ids: Set<string>) => void) => (id: string, on: boolean) => set(prev => {
    const next = new Set(prev); if (on) next.add(id); else next.delete(id);
    remember(next); return next;
  });
  const setArchived = toggle(setArchivedIds, rememberArchived), setPinned = toggle(setPinnedIds, rememberPinned);
  const archive = (c: ViewChat) => {
    setArchived(c.id, true);
    const toast = notify(`已归档“${c.title}”，在左边最下面的“已归档”里`, { label: '撤销', onClick: () => { setArchived(c.id, false); dismiss(toast); } });
  };
  const dialog = creating && <NewChat view={view} close={() => setCreating(false)} created={id => { setCreating(false); select(id); }} />;
  if (!current) return <div className="chat-empty"><div><h1>项目群聊</h1><p>按项目建一个群，把选手拉进来。你说话不 @ 人就交给负责人安排；@ 谁就是叫谁动手，选手之间也会互相 @ 交接。</p><Button variant="primary" onClick={() => setCreating(true)}>新建群聊</Button></div>{dialog}</div>;
  const row = (c: ViewChat): SideNavItem => {
    const p = preview(c);
    const pinned = pinnedIds.has(c.id);
    return { id: c.id, label: c.title, badge: <>{pinned && <span className="chat-pin">置顶</span>}{unread(c, marks) && c.id !== current.id && <span className="chat-unread" role="img" aria-label="有新消息" />}<span>{c.state === 'closed' ? '已结束' : fmtTime(lastAt(c))}</span></>, note: p ? p.text : '还没有消息',
      menu: { label: `更多操作：${c.title}`, items: [
        pinned ? { label: '取消置顶', onSelect: () => setPinned(c.id, false) } : { label: '置顶', onSelect: () => setPinned(c.id, true) },
        { label: '重命名', onSelect: () => setRenaming(c.id) },
        { label: '归档', onSelect: () => archive(c) }] } };
  };
  const footer = <>
    {archived.length > 0 && <div className="sidenav-archived">
      <button type="button" className="sidenav-fold" aria-label={`已归档 ${archived.length} 个群`} aria-expanded={unfolded} aria-controls={foldId} onClick={() => setUnfolded(v => !v)}>
        <span className="disclosure" aria-hidden="true" /><span className="sidenav-fold-label">已归档</span><span className="sidenav-badge num">{archived.length}</span>
      </button>
      {unfolded && <div id={foldId} className="sidenav-archived-list">{archived.map(c => <SideNavRow key={c.id} menu={{ label: `更多操作：${c.title}`, items: [{ label: '取消归档', onSelect: () => setArchived(c.id, false) }] }}>
        <button type="button" className="sidenav-tab" aria-current={current.id === c.id ? 'true' : undefined} onClick={() => select(c.id)}>
          <span className="sidenav-label">{c.title}</span><span className="sidenav-note">{preview(c)?.text ?? '还没有消息'}</span>
        </button>
      </SideNavRow>)}</div>}
    </div>}
  </>;
  return <>
    <div className="chat-page">
      <SideNavLayout className="chat-layout" label="群聊" items={listed.map(row)} value={current.id} onChange={select} footer={footer}
        header={<div className="chat-list-head"><b>群聊</b><Button size="sm" onClick={() => setCreating(true)}>＋ 新建</Button></div>}>
        <Room key={current.id} chat={current} view={view} open={open} />
      </SideNavLayout>
    </div>
    {dialog}
    {renaming && view.chats.some(c => c.id === renaming) && <RenameChat key={renaming} chat={view.chats.find(c => c.id === renaming)!} close={() => setRenaming(null)} />}
  </>;
}
