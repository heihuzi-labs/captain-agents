import { useEffect, useRef, useState } from 'react';
import type { View, ViewJob } from '../../../src/core/view-types.ts';
import { errorReason } from '../lib/errors.ts';
import type { Entry, Target } from '../lib/board.ts';
import { decisionText, fmtTime, isOpen, navigation, realState, STATE } from '../lib/board.ts';
import { ActivityList, Button, CheckChip, Chip, ConfirmDialog, Elapsed, hasNestedModal, Modal, Section, TaskHead, TimingNote, WorkerRow } from '../ui/index.ts';
import type { Workers } from '../ui/index.ts';
import type { Open } from './Board.tsx';
import { Comments } from './Comments.tsx';

type Action = 'adopt' | 'drop' | 'stop' | 'redo';
export function resultText(j: ViewJob): string | null {
  if (j.decision && j.decision.by !== 'owner') return decisionText(j);
  if (j.redo && !j.redo.handled) return '你请求了重做，等负责人处理';
  if (j.decision?.by === 'owner' && !j.decision.handled) return j.decision.kind === 'adopt' ? '你选了这份，等负责人处理' : '你选了不要这份，等负责人处理';
  if (isOpen(j)) return null;
  if (j.decision?.handled || j.redo?.handled) return '负责人已处理';
  return j.state === 'done' ? '负责人还在看' : null;
}
const available = (j: ViewJob) => !j.decision && !j.redo;
const HAND = '负责人会处理；你想直接定，也可以点下面的按钮。';
// 还没拍板、并且下面真有可选的按钮时，才说明主人可以插手。
const awaitingLead = (j: ViewJob) => !j.decision && !isOpen(j) && available(j) && j.state !== 'stopped';
function useActions() {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [confirm, setConfirm] = useState<{ action: Action; jobs: ViewJob[]; batch: boolean } | null>(null);
  const locked = useRef(false);
  const run = async (action: Action, jobs: ViewJob[]) => {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError(''); setConfirm(null);
    try {
      // 逐项提交，失败后可以重试；已经成功的记录由推送移出待处理列表。
      for (const j of jobs) {
        if (action === 'stop') await window.xa.stop(j.id);
        else if (action === 'redo') await window.xa.redo(j.id);
        else await window.xa.decide(j.id, action);
      }
    } catch (e) { setError('没能办成：' + errorReason(e)); }
    finally { locked.current = false; setBusy(false); }
  };
  const choose = (action: Action, jobs: ViewJob[], batch = false) => {
    if (action === 'stop' || action === 'drop') setConfirm({ action, jobs, batch });
    else void run(action, jobs);
  };
  const feedback = <>{error && <p role="alert">{error}</p>}{confirm && <ConfirmDialog busy={busy}
    message={confirm.action === 'stop' ? '停下后，这件活做到一半的东西会保留，但不会再继续。' : confirm.batch ? '这些已结束的任务都会记为不要，等负责人处理；已有成果会保留。还在跑的活会继续。' : '这份会记为不要，等负责人处理；已有成果会保留。'}
    confirmLabel={confirm.action === 'stop' ? '确认停下' : '确认不要'} onCancel={() => setConfirm(null)} onConfirm={() => void run(confirm.action, confirm.jobs)} />}</>;
  return { busy, choose, feedback };
}
// 联网：派出时总开关开着才出现，只写一句说明，纯文字。
export function NetworkNote() {
  return <Section title="联网">
    <p>这件活派出时允许联网</p>
  </Section>;
}
// 真实验收：只在 realCheck 存在时出现。标题一行写状态；下面是负责人的说明、检查步骤、截图张数。“待做”是负责人的事，不催主人，也没有按钮。全是纯文字。
export function RealCheck({ check }: { check: NonNullable<ViewJob['realCheck']> }) {
  const state = realState(check), { result, skipped } = check;
  const note = state.label === '不需要' ? (skipped ? `不需要的理由：${skipped.reason}` : '') : result ? `负责人：${result.note}` : '';
  return <Section title={<>真实验收：<Chip tone={state.tone}>{state.label}</Chip></>}>
    {note && <p>{note}</p>}
    {check.steps.length > 0 && <><p className="faint">检查步骤</p><ol className="real-steps">{check.steps.map((step, i) => <li key={i}>{step}</li>)}</ol></>}
    {result && state.label !== '不需要' && result.shotCount > 0 && <p className="faint">附 {result.shotCount} 张截图</p>}
  </Section>;
}
function JobBody({ job: j, workers }: { job: ViewJob; workers: Workers }) {
  const live = isOpen(j) || j.state === 'lost', result = resultText(j), actions = useActions();
  return <>
    <div className="jhead"><WorkerRow job={j} workers={workers} size="lg" detail="setting" elapsed={(isOpen(j) || j.seconds != null) ? <Elapsed job={j} /> : undefined} end={<><span>{STATE[j.state]}</span>{(j.check || j.checkSkipped) && <CheckChip job={j} />}</>} /></div>
    <Section title="要做什么"><p>{j.summary || '负责人还没留下说明'}</p></Section>
    {j.network && <NetworkNote />}
    {(live || j.timing) && <Section title="进展"><TimingNote job={j} />{live && <ActivityList activity={j.activity} sleeps={j.sleeps} />}</Section>}
    {result && <Section title="结果"><p>{result}</p></Section>}
    {j.realCheck && <RealCheck check={j.realCheck} />}
    {awaitingLead(j) && <div className="faint card-note">{HAND}</div>}
    <div className="actions">
      {isOpen(j) ? <Button variant="danger" disabled={actions.busy} onClick={() => actions.choose('stop', [j])}>停下</Button> : available(j) && j.state !== 'stopped' && <>
        {(j.state === 'lost' || j.state === 'failed') && <Button variant="primary" disabled={actions.busy} onClick={() => actions.choose('redo', [j])}>重做</Button>}
        {j.state === 'done' && <Button variant="primary" disabled={actions.busy} onClick={() => actions.choose('adopt', [j])}>用这份</Button>}
        <Button variant="danger" disabled={actions.busy} onClick={() => actions.choose('drop', [j])}>不要了</Button>
      </>}
    </div>{actions.feedback}
    <Comments job={j} />
  </>;
}
function BatchBody({ entry, workers, open, summary }: { entry: Entry; workers: Workers; open: Open; summary?: string }) {
  const actions = useActions(), remaining = entry.members.filter(j => !isOpen(j) && available(j));
  return <>
    <Section title="要做什么"><p>{summary || '负责人还没留下说明'}</p></Section>
    {entry.members.some(awaitingLead) && <div className="faint card-note">{HAND}</div>}
    <div className="panel cmp">{entry.members.map(j => <div className="cmp-row" key={j.id}>
      <button className="batch-member plain" onClick={() => open({ kind: 'job', id: j.id })}><WorkerRow job={j} workers={workers} detail="full" end={(j.check || j.checkSkipped) && <CheckChip job={j} />} /></button>
      {j.state === 'done' && available(j) && <Button variant="primary" size="sm" disabled={actions.busy} onClick={() => actions.choose('adopt', [j])}>用这份</Button>}
    </div>)}</div>
    {remaining.length > 0 && <div className="actions"><Button variant="danger" disabled={actions.busy} onClick={() => actions.choose('drop', remaining, true)}>都不要</Button></div>}
    {actions.feedback}
  </>;
}
export function Detail({
  target,
  view,
  entries,
  order,
  colors,
  open,
  close
}: {
  target: Target;
  view: View;
  entries: Entry[];
  order: Target[];
  colors: Map<string, string>;
  open: Open;
  close: () => void;
}) {
  const {
      list,
      index,
      batch
    } = navigation(target, view, order),
    scrollKey = target.kind + target.id;
  const job = target.kind === 'job' ? view.jobs.find(j => j.id === target.id) : undefined;
  const entry = target.kind === 'batch' ? entries.find(e => e.target.kind === 'batch' && e.target.id === target.id) : undefined;
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (hasNestedModal() || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return;
      if (e.key === 'ArrowLeft' && index > 0) {
        e.preventDefault();
        open(list[index - 1]);
      } else if (e.key === 'ArrowRight' && index >= 0 && index < list.length - 1) {
        e.preventDefault();
        open(list[index + 1]);
      }
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [list, index, open]);
  const back = batch && <button className="back plain" onClick={() => open({ kind: 'batch', id: batch.id })}>← 这一批（{batch.jobs.length} 家）</button>;
  const title = job ? <TaskHead jobs={[job]} kind={job.kind} title={job.title} back={back} />
    : entry ? <TaskHead jobs={entry.members} kind={entry.kind} title={entry.title} /> : null;
  const hue = job ? colors.get(job.batch) : entry ? colors.get(entry.target.id) : undefined;
  return <Modal label="详情" title={title} hue={hue} scrollKey={scrollKey} onClose={close} footer={<>
    <span className="faint">{index >= 0 ? `${batch ? '这一批' : ''}第 ${index + 1} 张，共 ${list.length} 张 · ← → 切换，Esc 关闭` : 'Esc 关闭'}</span>
    <span className="step"><Button size="sm" disabled={index <= 0} onClick={() => open(list[index - 1])}>‹ 上一张</Button><Button size="sm" disabled={index < 0 || index >= list.length - 1} onClick={() => open(list[index + 1])}>下一张 ›</Button></span>
  </>}>
    <>{job ? <JobBody key={job.id} job={job} workers={view.workers} /> : entry ? <BatchBody key={entry.target.id} summary={view.batches.find(b => b.id === entry.target.id)?.summary} entry={entry} workers={view.workers} open={open} /> : <div className="panel pane faint">{target.kind === 'job' ? '没有这条任务：' : '没有这一批：'}{target.id}</div>}</>
  </Modal>;
}
