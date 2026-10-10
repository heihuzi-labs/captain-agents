import type { QuotaStop } from '../../../src/core/settings.ts';
import type { View } from '../../../src/core/view-types.ts';
import { quotaLevel, quotaTip, topBar } from '../lib/quota.ts';
import { QuotaRing } from './QuotaRing.tsx';
import { WorkerIcon } from './WorkerIdentity.tsx';

const CHECK = { true: ['隔离正常', 'done'], false: ['隔离自检没过', 'failed'], null: ['还没自检', 'queued'] } as const;
// 顶栏右边的状态块：三家各一个额度环（中心是厂家图标，旁边写百分比）+ 隔离自检小圆点。整块是一个按钮，点一下去“各家表现”；
// 悬停整块看三家详情（厂家、各池百分比、数据时间）和自检原文；圆点上单独写自检原文。
export function StatusCluster({ quota, selfcheck, onOpen, stop }: { quota: View['quota']; selfcheck: View['selfcheck']; onOpen: () => void; stop?: QuotaStop }) {
  const [text, tone] = CHECK[String(selfcheck.ok) as keyof typeof CHECK];
  const tip = [...quota.map(q => `${q.name}${q.plan ? `（${q.plan}）` : ''}\n${quotaTip(q)}`), `${text}\n${selfcheck.note}`].join('\n\n');
  return <button type="button" className="status" aria-label="各家额度和隔离自检，点开看各家表现" title={tip} onClick={onOpen}>
    {quota.map(q => {
      const top = topBar(q), used = top?.used ?? null;
      // 环旁写百分比，一眼能读；快用完时数字和环一起变色。
      return <span className="quota-item" key={q.name} data-level={quotaLevel(used, stop) || undefined}>
        <QuotaRing used={used} stop={stop} label={`${q.name}：${top && used != null ? `${top.label} ${top.approx ? '不到 ' : ''}${used}%` : '查不到额度'}`}><WorkerIcon name={q.icon} size="sm" /></QuotaRing>
        <span className="quota-pct" aria-hidden="true">{used == null ? '—' : `${top?.approx ? '<' : ''}${used}%`}</span>
      </span>;
    })}
    <span className={'dot dot-' + tone} role="img" aria-label={text} title={selfcheck.note} />
  </button>;
}
