import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { View } from '../../src/core/view-types.ts';
import { batchColors, columnColor, derive, entries, loadPosition, normalizeTarget, savePosition, shareView, typicalTimes } from './lib/board.ts';
import type { Entry, Page, Target } from './lib/board.ts';
import { AttentionCard, BoardColumn, ChatWaitingCard, DoneList, ProjectTag, QueuedCard, RunningCard } from './components/Board.tsx';
import { Chat, readSelectedChat, rememberSelectedChat } from './components/Chat.tsx';
import { PAGE_KEYS } from './components/TopBar.tsx';
import { loadWorkerHandles } from '../../src/core/chat-handles.ts';
import { entryProject, projectLabel, projectOf, readHistoryProject, rememberHistoryProject } from './lib/history.ts';
import { errorReason } from './lib/errors.ts';
import { BatchGroup, EmptyState, Toast } from './ui/index.ts';
import type { ToastAction, ToastMessage } from './ui/index.ts';
import { Settings } from './components/Settings.tsx';
import { UpdateDialog } from './components/Update.tsx';
import { Detail } from './components/Detail.tsx';
import { History, Stats } from './components/Pages.tsx';
import { TopBar } from './components/TopBar.tsx';
export function App() {
  const [view, setView] = useState<View | null>(null),
    [error, setError] = useState(false),
    [position, setPosition] = useState(loadPosition),
    [target, setTarget] = useState<Target | null>(null),
    [chatId, setChatId] = useState(readSelectedChat),
    [historyProject, setHistoryProject] = useState(readHistoryProject),
    [settings, setSettings] = useState(false),
    [now, setNow] = useState(Date.now),
    [notice, setNotice] = useState(''),
    [toast, setToast] = useState<ToastMessage | null>(null);
  const generation = useRef(0),
    alive = useRef(false),
    latestView = useRef<View | null>(null),
    toastId = useRef(0),
    savingArchive = useRef(false);
  const showToast = useCallback((text: string, action?: ToastAction) => {
    const id = ++toastId.current;
    setToast({ id, text, action });
    return id;
  }, []);
  const dismissToast = useCallback((id: number) => setToast(current => current?.id === id ? null : current), []);
  const accept = useCallback((next: View) => {
    // 选手清单会变（主人保留了新模型）：先把群聊 @ 的短名同步成最新的，再画界面。
    loadWorkerHandles(next.workers);
    latestView.current = next;
    setView(old => shareView(old, next));
    setError(false);
    setNow(Date.now());
  }, []);
  const refresh = useCallback(() => {
    const version = ++generation.current;
    void window.xa.getView().then(next => {
      if (alive.current && generation.current === version) accept(next);
    }).catch(() => {
      if (alive.current && generation.current === version) setError(true);
    });
  }, [accept]);
  const selectChat = useCallback((id: string) => { setChatId(id); rememberSelectedChat(id); }, []),
    // 群聊的卡（看板、历史、菜单栏、通知）：去协作页并选中那个群，不开弹窗。
    showChat = useCallback((id: string) => { setSettings(false); setTarget(null); selectChat(id); setPosition(p => ({ ...p, page: 'collab' })); }, [selectChat]);
  useEffect(() => {
    alive.current = true;
    const unsubscribeOpen = window.xa.onOpen(destination => {
      if (destination.kind === 'settings') { setTarget(null); setSettings(true); }
      // 群聊的通知：去协作页并打开那个群。
      else if (destination.kind === 'chat') showChat(destination.id);
      else if (destination.kind === 'team') { setSettings(false); setTarget(null); }
      else { setSettings(false); setTarget(destination); }
    });
    const unsubscribe = window.xa.onView(next => {
      ++generation.current;
      if (alive.current) accept(next);
    });
    refresh();
    return () => {
      alive.current = false;
      ++generation.current;
      unsubscribe();
      unsubscribeOpen();
    };
  }, [accept, refresh, showChat]);
  // 收场的小队只在历史页展开看，不再单独打开。
  const open = useCallback((next: Target) => {
      if (next.kind === 'chat') return showChat(next.id);
      setSettings(false);
      if (next.kind !== 'team') setTarget(next);
    }, [showChat]),
    close = useCallback(() => setTarget(null), []),
    closeSettings = useCallback(() => setSettings(false), []);
  const go = useCallback((page: Page) => {
    setPosition(p => ({
      ...p,
      page
    }));
    setTarget(null);
  }, []);
  useEffect(() => savePosition(position.page, position.filter), [position]);
  const chooseProject = useCallback((name: string) => { setHistoryProject(name); rememberHistoryProject(name); }, []);
  // 归档名单整份替换。同一时间只发一次；失败时卡还在，按设置保存失败的写法提示。
  const saveArchived = useCallback(async (names: string[]) => {
    if (savingArchive.current) return false;
    savingArchive.current = true;
    setNotice('');
    try { await window.xa.setSettings({ archivedProjects: names }); return alive.current; }
    catch (e) { if (alive.current) setNotice('保存失败：' + errorReason(e)); return false; }
    finally { savingArchive.current = false; }
  }, []);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!e.metaKey) return;
      if (e.key === ',') { e.preventDefault(); setTarget(null); setSettings(true); }
      else if (['1', '2', '3', '4'].includes(e.key)) {
        e.preventDefault();
        go(PAGE_KEYS[Number(e.key) - 1]);
      } else if (e.key.toLowerCase() === 'r') {
        e.preventDefault();
        refresh();
      }
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [go, refresh]);
  const columns = useMemo(() => view ? derive(view, now) : null, [view, now]),
    colors = useMemo(() => batchColors(view?.batches ?? [], new Set(view?.jobs.map(j => j.id))), [view?.batches, view?.jobs]),
    typical = useMemo(() => typicalTimes(view?.jobs ?? []), [view?.jobs]);
  // 已完成卡片到 24 小时边界再更新，不让全看板参与每秒计时。
  useEffect(() => {
    const expiry = columns?.done.map(e => e.at + 86400e3 + 1).filter(at => at > Date.now()).sort((a, b) => a - b)[0];
    if (!expiry) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(expiry - Date.now(), 2147483647));
    return () => clearTimeout(timer);
  }, [columns]);
  const groups = useMemo(() => view ? entries(view) : [], [view]);
  if (!view || !columns) return <div className="app"><header className="top" /><div className="page">{error ? <p role="alert">读取登记处失败，请检查登记处后重新打开窗口。</p> : <p role="status">正在读取登记处…</p>}</div></div>;
  const hue = (id: string) => colors.get(id),
    jobHue = (batch: string) => hue(batch);
  // 已归档的项目不进已完成列，列头件数也不算它们。进行中、验收中照常。名单从 View.projects[].archived 算。
  const archivedNames = view.projects.filter(p => p.archived).map(p => p.name),
    archivedSet = new Set(archivedNames),
    done = columns.done.filter(e => !archivedSet.has(entryProject(e))),
    archiveProject = async (name: string) => {
      if (!await saveArchived(archivedNames.includes(name) ? archivedNames : [...archivedNames, name])) return;
      const id = showToast(`已归档 ${projectLabel(view, name)}，可在历史页“已归档”里找回`, {
        label: '撤销', onClick: async () => {
          const names = (latestView.current?.projects ?? []).filter(p => p.archived && p.name !== name).map(p => p.name);
          if (await saveArchived(names)) dismissToast(id);
        }
      });
    },
    unarchiveProject = (name: string) => { void saveArchived(archivedNames.filter(n => n !== name)); };
  const order: Target[] = [...columns.queued.map(j => ({
    kind: 'job' as const,
    id: j.id
  })), ...columns.runningGroups.map(e => e.target), ...columns.attention.map(e => e.target), ...done.map(e => e.target)];
  // 弹窗里的“上一件 / 下一件”跳过群聊（群聊不开弹窗）。
  const unique = order.filter((t, i) => t.kind !== 'chat' && order.findIndex(x => x.kind === t.kind && x.id === t.id) === i);
  // 群的卡：群名、排队的人都从群记录来。
  const chatCard = (e: Entry) => e.chat && { id: e.target.id, title: e.title, waiting: e.chat.queued.map(who => view.workers[who]?.model ?? who) };
  // 看板上同时有不止一个项目的活：进行中、验收中的卡片题目旁写项目小标签，已完成列按项目分组；只有一个项目时都不写。
  // 已归档且只出现在已完成里的项目，卡已经藏起来，不算进这个数。
  const boardProjects = new Set([...[...columns.queued, ...columns.running, ...columns.attention.flatMap(e => e.members), ...done.flatMap(e => e.members)].map(projectOf), ...columns.runningGroups.map(entryProject)]),
    several = boardProjects.size > 1,
    tag = (job: { project: string }) => several ? projectLabel(view, projectOf(job)) : undefined;
  const entryHue = (e: Entry) => hue(e.target.kind === 'job' ? e.members[0].batch : e.target.id);
  const shown = target ? normalizeTarget(view, target) : null;
  return <><div className="app" inert={target || settings ? true : undefined}><TopBar view={view} page={position.page} go={go} openSettings={() => { setTarget(null); setSettings(true); }} />{error && <div role="alert">读取登记处失败，显示上次读取的内容。</div>}<main className="main">{notice && <p role="alert" className="notice notice-bad">{notice}</p>}
    {position.page === 'board' ? <div id="v-board">
      <BoardColumn name="running" title="进行中" count={columns.running.length} queued={columns.queued.length + columns.chatQueued} color={columnColor(view, 'running')}>{columns.queued.map(j => <QueuedCard key={j.id} job={j} workers={view.workers} hue={jobHue(j.batch)} project={tag(j)} open={open} />)}{columns.runningGroups.length ? columns.runningGroups.map(e => e.chat && !e.members.length
        ? <ChatWaitingCard key={e.target.kind + e.target.id} {...chatCard(e)!} project={several ? projectLabel(view, entryProject(e)) : undefined} open={open} />
        : e.members.length > 1
        ? <BatchGroup key={e.target.kind + e.target.id} hue={hue(e.target.id)} head={<button className="bhead" onClick={() => open(e.target)}><span className="t">{e.title}</span><ProjectTag name={tag(e.members[0])} /><span className="faint">{e.members.length} 家同时在做</span></button>}>{e.members.map(j => <RunningCard key={j.id} job={j} workers={view.workers} typical={typical(j)} group open={open} />)}</BatchGroup>
        : <RunningCard key={e.target.kind + e.target.id} job={e.members[0]} workers={view.workers} typical={typical(e.members[0])} hue={jobHue(e.members[0].batch)} project={tag(e.members[0])} chat={chatCard(e) || undefined} open={open} />) : columns.queued.length ? null : <EmptyState>现在没有在跑的活</EmptyState>}</BoardColumn>
      <BoardColumn name="attention" title="验收中" count={columns.attention.length} color={columnColor(view, 'attention')}>{columns.attention.length ? columns.attention.map(e => <AttentionCard key={e.type + e.target.kind + e.target.id} entry={e} workers={view.workers} hue={entryHue(e)} project={tag(e.members[0])} open={open} />) : <EmptyState>没有在验收的活</EmptyState>}</BoardColumn>
      <BoardColumn name="done" title="已完成" count={done.length} color={columnColor(view, 'done')} history={() => go('history')}>{done.length ? <DoneList entries={done} workers={view.workers} label={name => projectLabel(view, name)} open={open} showProject={name => { chooseProject(name); go('history'); }} onArchive={archiveProject} /> : <EmptyState>最近 24 小时没有完成的活</EmptyState>}</BoardColumn>
    </div> : position.page === 'collab' ? <Chat view={view} selected={chatId} select={selectChat} open={open} notify={showToast} dismiss={dismissToast} /> : position.page === 'history' ? <History view={view} rows={columns.history} filter={position.filter} setFilter={filter => setPosition(p => ({
          ...p,
          filter
        }))} project={historyProject} setProject={chooseProject} now={now} open={open} onUnarchive={unarchiveProject} /> : <Stats view={view} />}
  </main>{toast && <Toast message={toast} onClose={() => dismissToast(toast.id)} />}</div>{shown && <Detail target={shown} view={view} entries={groups} order={unique} colors={colors} open={open} close={close} />}{settings && <Settings close={closeSettings} view={view} />}<UpdateDialog /></>;
}
