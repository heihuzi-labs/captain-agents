import type { View } from '../../../src/core/view-types.ts';
import type { Settings as Values } from '../../shared/ipc.ts';
import { effortText } from '../lib/board.ts';
import { useState } from 'react';
import { Button, CheckDot, Chip, SettingGroup, Switch, WorkerIcon } from '../ui/index.ts';
import { ModelPicker } from './ModelPicker.tsx';
import { quotaTip, topBar } from '../lib/quota.ts';
import type { Quota } from '../lib/quota.ts';

type Roster = View['roster'][number];
type Policy = Values['workers'][Roster['who']];
type Effort = Roster['efforts'][number];
type Change = Partial<Policy>;

export const LAST_WORKER = '至少要留一位选手';
export const LAST_EFFORT = '至少要留一种强度';
export const FAST_HINT = '同一个模型，跑在更快的机器上，额度按两倍扣';
const ORDER: Effort[] = ['medium', 'high', 'xhigh'];
const POOL: Record<string, string> = { 周额度: '本周', 本期额度: '本期', '5 小时额度': '近 5 小时', 自家模型池: '自家池', 其他模型池: '其他池' };

// 某位选手现在的设置；核心总会给全，缺了就按“全开”显示（和核心的缺省一致）。
export function policyOf(entry: Roster, stored: Values['workers'] | undefined): Policy {
  const saved = stored?.[entry.who];
  return { enabled: saved?.enabled ?? true, efforts: saved?.efforts ?? entry.efforts, fast: entry.fastSupported && (saved?.fast ?? true) };
}
// 组头里厂家名后面的淡色小字：套餐，加上用得最多的那个池（查不到就不写）。
const quotaLine = (q: Quota | undefined) => {
  if (!q) return '';
  const top = topBar(q);
  const used = top?.used == null ? '' : `${POOL[top.label] ?? top.label}用了${top.approx ? '不到 ' : ' '}${top.used}%`;
  return [q.plan, used].filter(Boolean).join(' · ');
};

// 设置里的“选手与模型”：按厂家分组（Codex、Grok、Cursor、DeepSeek），组内是一张对齐的表，一行一个模型：
// 模型 | 中档 | 高档 | 超高档 | 快速版 | 启用。关掉的模型整行变淡，强度和快速版点不动但保留原值。改动交给 change，由设置页统一排队保存。
export function WorkerSettings({ view, values, error, change }: {
  view: Pick<View, 'roster' | 'workers' | 'quota' | 'models'>; values: Values['workers'] | undefined; error: string;
  change: (who: Roster['who'], patch: Change) => void;
}) {
  const rows = view.roster.map(entry => ({ entry, policy: policyOf(entry, values) }));
  const enabled = rows.filter(r => r.policy.enabled).length;
  const groups: { icon: string; name: string; rows: typeof rows }[] = [];
  for (const row of rows) {
    const shown = view.workers[row.entry.who];
    let group = groups.find(g => g.icon === shown.icon);
    if (!group) groups.push(group = { icon: shown.icon, name: shown.name.split('·')[0].trim(), rows: [] });
    group.rows.push(row);
  }
  // 管理模型：每家组头右边的按钮；有新发现的模型时按钮里带“新 N”。已下线的模型在表里那一行标出来。
  const [picking, setPicking] = useState<string | null>(null);
  const channels = view.models?.channels ?? [], channelOf = (icon: string) => channels.find(c => c.icon === icon);
  const gone = new Set(channels.flatMap(c => c.models.filter(m => m.gone && m.kept).map(m => m.who)));
  const fresh = channels.reduce((n, c) => n + c.models.filter(m => m.fresh).length, 0);
  const picked = channels.find(c => c.channel === picking);
  return <div className="wk">
    {error && <p role="alert" className="notice notice-bad">{error}</p>}
    <p className="wk-hint">关掉的不会被派活；派活时只在勾选的强度里选。最高档不开放。{fresh > 0 && `发现了 ${fresh} 个新模型，在“管理模型”里选要不要保留。`}</p>
    <div className="wk-cols"><span>模型</span><span>中档</span><span>高档</span><span>超高档</span><span title={FAST_HINT}>快速版</span><span>启用</span></div>
    {groups.map(group => {
      const quota = view.quota.find(q => q.icon === group.icon);
      const channel = channelOf(group.icon), news = channel?.models.filter(m => m.fresh).length ?? 0;
      return <SettingGroup key={group.icon} label={group.name} head={<>
        <WorkerIcon name={group.icon} size="sm" /><span>{group.name}</span>
        <span className="wk-quota ellip" title={quota ? quotaTip(quota) : undefined}>{quotaLine(quota)}</span>
        {channel && <Button size="sm" className="wk-manage" onClick={() => setPicking(channel.channel)}>管理模型{news > 0 && <span className="wk-new">新 {news}</span>}</Button>}
      </>}>{group.rows.map(({ entry, policy }) => {
        const { who } = entry, shown = view.workers[who], off = !policy.enabled, last = policy.enabled && enabled === 1, chosen = policy.efforts.length;
        return <div className="wk-row" role="group" aria-label={`${shown.name} · ${shown.model}`} data-who={who} data-off={off || undefined} key={who}>
          <span className="wk-model" title={shown.model}>{shown.badge && <WorkerIcon name={shown.badge} size="sm" />}<span className="ellip">{shown.model}</span>{gone.has(who) && <Chip tone="warn" title="最近一次检查，这一家的名单里已经没有它；派活会被拦下">已下线</Chip>}</span>
          {ORDER.map(effort => {
            if (!entry.efforts.includes(effort)) return <span key={effort} />;
            const on = policy.efforts.includes(effort);
            return <CheckDot key={effort} label={effortText(effort)} checked={on} disabled={off} locked={on && chosen === 1 ? LAST_EFFORT : undefined}
              onChange={() => change(who, { efforts: ORDER.filter(e => e === effort ? !on : policy.efforts.includes(e)) })} />;
          })}
          {entry.fastSupported ? <CheckDot label="快速版" checked={policy.fast} disabled={off} onChange={next => change(who, { fast: next })} /> : <span />}
          <Switch label="启用" checked={policy.enabled} locked={last ? LAST_WORKER : undefined} onChange={next => change(who, { enabled: next })} />
        </div>;
      })}</SettingGroup>;
    })}
    {picked && <ModelPicker key={picked.channel} channel={picked} updated={view.models.at} close={() => setPicking(null)} />}
  </div>;
}
