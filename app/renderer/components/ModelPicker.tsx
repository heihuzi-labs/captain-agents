import { useMemo, useState } from 'react';
import type { View } from '../../../src/core/view-types.ts';
import { errorReason } from '../lib/errors.ts';
import { effortText, fmtTime } from '../lib/board.ts';
import { Button, CheckDot, Chip, Modal, WorkerIcon } from '../ui/index.ts';

type Channel = View['models']['channels'][number];
type Model = Channel['models'][number];
// 模型多于这个数才出搜索框。
export const SEARCH_FROM = 8;
// 右边只写例外：三档齐全、没有快速版就什么都不写，免得每行重复同一串字。
export function modelNote(m: Pick<Model, 'efforts' | 'fast'>): string {
  const parts: string[] = [];
  if (m.efforts.length < 3) parts.push('只有' + m.efforts.map(effortText).join('、'));
  if (m.fast) parts.push('有快速版');
  return parts.join(' · ');
}
// Cursor 里各家的模型都有：名字前带厂家小图标，一眼分得出是谁家的。别的通道只有自家模型，不画。
const FAMILY: Record<string, string> = { claude: 'claude', gpt: 'codex', grok: 'grok' };
const familyIcon = (channel: Channel['channel'], model: string) => channel === 'cursor' ? FAMILY[model.split('-')[0]] : undefined;
// Cursor 的名单是乱序的：按厂家排到一起，同一家里新的在前。别的通道照各家自己给的顺序。
const FAMILIES = Object.keys(FAMILY);
function ordered(channel: Channel['channel'], models: Model[]): Model[] {
  if (channel !== 'cursor') return models;
  const family = (m: Model) => FAMILIES.indexOf(m.model.split('-')[0]);
  return [...models].sort((a, b) => family(a) - family(b) || b.shown.localeCompare(a.shown, 'en', { numeric: true }));
}

function Row({ m, channel, on, toggle }: { m: Model; channel: Channel['channel']; on: boolean; toggle: (on: boolean) => void }) {
  const icon = familyIcon(channel, m.model), note = modelNote(m);
  return <label className={'mp-row' + (on ? ' mp-on' : '')}>
    <CheckDot label={`保留 ${m.shown}`} checked={on} onChange={toggle} />
    {icon && <WorkerIcon name={icon} size="sm" />}
    <span className="mp-name">
      <span className="mp-title"><span className="ellip">{m.shown}</span>{m.fresh && <Chip tone="acc">新</Chip>}{m.gone && <Chip tone="warn" title="最近一次检查，这一家的名单里已经没有它">已下线</Chip>}</span>
      {m.description && <span className="mp-desc ellip" title={m.description}>{m.description}</span>}
    </span>
    {note && <span className="mp-meta">{note}</span>}
  </label>;
}
// 管理模型（docs/ui-spec.md 第 10 节、docs/design-models.md）：一家发现了哪些模型、保留哪些。
// 窄弹窗。顶上一行概况和“刷新”，模型多时一个搜索框；清单分“已保留”“未保留”两段（按打开时的状态分，勾选时行不乱跳），
// 模型多时清单定高、自己滚动（搜索时弹窗不忽大忽小）；底栏“取消 / 保存”，没改动时“保存”点不了。
export function ModelPicker({ channel, updated, close }: { channel: Channel; updated: string | null; close: () => void }) {
  const initial = useMemo(() => new Set(channel.models.filter(m => m.kept).map(m => m.model)), [channel.channel]);
  const [kept, setKept] = useState(() => new Set(initial)), [query, setQuery] = useState('');
  const [busy, setBusy] = useState<'' | 'refresh' | 'save'>(''), [error, setError] = useState('');
  const toggle = (model: string, on: boolean) => setKept(prev => { const next = new Set(prev); if (on) next.add(model); else next.delete(model); return next; });
  const changed = channel.models.some(m => m.kept !== kept.has(m.model));
  const run = async (what: 'refresh' | 'save') => {
    setBusy(what); setError('');
    try {
      if (what === 'refresh') await window.xa.modelsRefresh();
      else { await window.xa.modelsKeep(channel.channel, channel.models.filter(m => kept.has(m.model)).map(m => m.model)); close(); }
    } catch (e) { setError((what === 'refresh' ? '没能刷新：' : '没能保存：') + errorReason(e)); }
    finally { setBusy(''); }
  };
  const word = query.trim().toLowerCase();
  const match = (m: Model) => !word || (m.shown + ' ' + m.model).toLowerCase().includes(word);
  const all = useMemo(() => ordered(channel.channel, channel.models), [channel]);
  const mine = all.filter(m => initial.has(m.model) && match(m));
  // 没保留的：新冒出来的排在前面。
  const rest = all.filter(m => !initial.has(m.model) && match(m)).sort((a, b) => Number(b.fresh) - Number(a.fresh));
  const long = channel.models.length > SEARCH_FROM;
  const when = channel.at ?? updated;
  return <Modal label={`管理模型：${channel.name}`} title={<span className="mp-head"><WorkerIcon name={channel.icon} size="sm" /><span>管理模型 · {channel.name}</span></span>} size="sm" flush onClose={close} footer={<>
    <span className="faint">不保留的不能派活，历史记录照常看得到</span>
    <span className="step"><Button size="sm" onClick={close}>取消</Button><Button size="sm" variant="primary" disabled={!!busy || !changed} onClick={() => void run('save')}>保存</Button></span>
  </>}>
    <div className={'mp' + (long ? ' mp-long' : '')}>
      <div className="mp-top">
        <div className="mp-summary">
          <b>已保留 {kept.size} 个</b><span className="faint">共 {channel.models.length} 个</span>
          <span className="mp-when faint">{!channel.discoverable ? '这一家的模型是固定的，不会自动发现' : when ? `上次检查 ${fmtTime(when, true)}` : '还没检查过'}</span>
          {channel.discoverable && <Button size="sm" disabled={!!busy} onClick={() => void run('refresh')}>{busy === 'refresh' ? '在检查…' : '刷新'}</Button>}
        </div>
        {long && <input className="field mp-search" type="search" aria-label="搜索模型" placeholder="搜索模型" value={query} onChange={e => setQuery(e.target.value)} />}
        {channel.error && <p className="notice notice-warn" role="status">这次没问到（{channel.error}），下面是上一次的名单。</p>}
        {error && <p role="alert" className="notice notice-bad">{error}</p>}
      </div>
      <div className="mp-scroll">
        {mine.length > 0 && <section aria-label="已保留"><h3 className="mp-label">已保留</h3>
          <div className="mp-list">{mine.map(m => <Row key={m.model} m={m} channel={channel.channel} on={kept.has(m.model)} toggle={on => toggle(m.model, on)} />)}</div></section>}
        {rest.length > 0 && <section aria-label="未保留"><h3 className="mp-label">未保留</h3>
          <div className="mp-list">{rest.map(m => <Row key={m.model} m={m} channel={channel.channel} on={kept.has(m.model)} toggle={on => toggle(m.model, on)} />)}</div></section>}
        {!mine.length && !rest.length && <p className="mp-empty faint">{word ? '没有名字里带这几个字的模型' : '还没有发现模型，点“刷新”检查一次'}</p>}
      </div>
    </div>
  </Modal>;
}
