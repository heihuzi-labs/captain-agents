import { isValidElement, memo, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { View, ViewJob } from '../../../src/core/view-types.ts';
import { effortText, fmtDur, isOpen } from '../lib/board.ts';
import { Chip } from './Chip.tsx';
import { Elapsed } from './Elapsed.tsx';

export type Workers = View['workers'];
type Size = 'sm' | 'md' | 'lg';
const LETTER: Record<string, string> = { codex: 'C', grok: 'G', cursor: 'Cu', claude: 'A', deepseek: 'D' };

// 一个图标：图片还在加载时只占位（不闪字母圆标）；加载成功显示图片，加载失败显示字母圆标。
// 图片由应用自己的图标通道提供，新建的图片元素要等一小会儿才知道结果，所以每个元素自己记状态。
function Glyph({ name, badge = false }: { name: string; badge?: boolean }) {
  const [state, setState] = useState<'pending' | 'ok' | 'failed'>('pending');
  const image = useRef<HTMLImageElement>(null);
  useLayoutEffect(() => {
    const img = image.current;
    if (img?.complete) setState(img.naturalWidth > 0 ? 'ok' : 'failed');
  }, []);
  return <>
    {state === 'failed' && <span className={'mono-mark' + (badge ? ' badge' : '')} data-brand={LETTER[name] ? name : 'other'}><span>{LETTER[name] ?? '?'}</span></span>}
    {state !== 'failed' && <img ref={image} className={badge ? 'badge' : undefined} data-icon={name} data-state={state} src={`xa-icon://icons/${name}.png`} alt=""
      onLoad={() => setState('ok')} onError={() => setState('failed')} />}
  </>;
}
// 全应用唯一的图标出处；额度、卡片、弹窗、历史、各家表现都用它。
// label 有值时图标是一张有名字的图（厂家名进可访问名）；没有就只是装饰。
export const WorkerIcon = memo(function WorkerIcon({ name, badge, size = 'md', title, label }: { name: string; badge?: string; size?: Size; title?: string; label?: string }) {
  return <span className={'logo logo-' + size + (badge ? ' logo-badged' : '')} title={title} {...(label ? { role: 'img', 'aria-label': label } : {})}><Glyph key={name} name={name} />{badge && <Glyph key={badge} name={badge} badge />}</span>;
});

// 文字身份只有一行：图标已经代表厂家，厂家名不写成文字；iconOnly 只画图标。
export type Detail = 'model' | 'setting' | 'full';
export function workerMeta(model: string, effort: string | undefined, seconds: number | null | undefined, detail: Detail, fast?: boolean) {
  const parts = [model];
  if (detail !== 'model' && effort) parts.push(effortText(effort));
  if (detail !== 'model' && fast) parts.push('快速');
  if (detail === 'full' && seconds != null) parts.push(fmtDur(seconds, true));
  return parts.join(' · ');
}
type Props = { workers: Workers; size?: Size; detail?: Detail; iconOnly?: boolean; elapsed?: ReactNode } & ({ job: ViewJob; who?: undefined } | { job?: undefined; who: keyof Workers });
// 全应用唯一的身份排版：一行，图标 + 加粗模型名 + 强度、快速标签 + 用时，end 在最右。只截断模型名，标签和用时始终完整。
// 厂家名只在悬停提示和图标的可访问名里出现。
export const WorkerIdentity = memo(function WorkerIdentity({ workers, job, who, size = 'md', detail = 'setting', iconOnly = false, elapsed, end }: Props & { end?: ReactNode }) {
  const key = job ? job.who : who, w = workers[key];
  const seconds = job && !isOpen(job) ? job.seconds : null;
  const meta = workerMeta(w.model, job?.effort, seconds, detail, job?.fast);
  const duration = elapsed ?? (detail === 'full' && seconds != null ? fmtDur(seconds, true) : null);
  const full = `${w.name} · ${iconOnly ? w.model : meta}`;
  return <span className={'ident ident-' + size + (iconOnly ? ' ident-icon-only' : '')} title={full}>
    <WorkerIcon name={w.icon} badge={w.badge} size={size} label={iconOnly ? full : w.name} />
    {!iconOnly && <span className="ident-body">
      <span className="ident-text">
        <span className="ident-model" title={w.model}>{w.model}</span>
        {detail !== 'model' && job?.effort && <Chip>{effortText(job.effort)}</Chip>}
        {detail !== 'model' && job?.fast && <Chip>快速</Chip>}
        {duration != null && <span className="ident-elapsed num">{duration}</span>}
      </span>
      {end != null && end !== false && <span className="ident-end">{end}</span>}
    </span>}
  </span>;
});
// 结果、验收、状态标签放在同一行最右边；挤不下只截断模型名。
// 兼容卡片原来把 Elapsed 放在 end 的调用，统一放进身份的用时位置。
export function WorkerRow({ end, ...identity }: Props & { end?: ReactNode }) {
  const elapsed = isValidElement(end) && end.type === Elapsed ? end : undefined;
  return <div className="worker-row"><WorkerIdentity {...identity} elapsed={identity.elapsed ?? elapsed} end={elapsed ? undefined : end} /></div>;
}
