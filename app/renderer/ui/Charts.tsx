import { useState } from 'react';
import type { ReactNode } from 'react';

// 仪表盘的统一部件（docs/ui-spec.md 第 15 节）。数字、名字一律当纯文字显示。

// 小趋势线：一个系列，2px 细线 + 很淡的底色，最新一点一个小圆点；纵向按这组数自己的最大值缩放（只看走势，不读刻度）。
// 悬停或键盘聚焦到某一天，上方出提示：数在前、日期在后。
export type Trend = { values: number[]; labels: string[]; format: (n: number) => string; unit: string; label: string };
export function Sparkline({ values, labels, format, unit, label }: Trend) {
  const [active, setActive] = useState<number | null>(null);
  const n = values.length, max = Math.max(0, ...values), last = n - 1;
  const x = (i: number) => n === 1 ? 50 : i / last * 100, y = (v: number) => max > 0 ? 28 - v / max * 24 : 28;
  const line = values.map((v, i) => `${i ? 'L' : 'M'}${x(i)},${y(v)}`).join(' ');
  const at = active ?? last;
  return <div className="spark" role="group" aria-label={label}>
    <svg viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true">
      <path className="spark-area" d={`${line} L${x(last)},30 L${x(0)},30 Z`} />
      <path className="spark-line" d={line} vectorEffect="non-scaling-stroke" />
    </svg>
    <span className="spark-dot" style={{ left: `${x(at)}%`, top: `${y(values[at]) / 30 * 100}%` }} aria-hidden="true" />
    <div className="spark-hits">{values.map((v, i) => <button key={i} type="button" className="spark-hit" aria-label={`${labels[i]}：${format(v)}${unit}`}
      onPointerEnter={() => setActive(i)} onPointerLeave={() => setActive(a => a === i ? null : a)} onFocus={() => setActive(i)} onBlur={() => setActive(a => a === i ? null : a)} />)}</div>
    {active !== null && <span className="chart-tip" role="tooltip" style={{ left: `${x(active)}%` }}><b className="num">{format(values[active])}{unit}</b><span>{labels[active]}</span></span>}
  </div>;
}

// 大数小卡：上面一行标签，中间是数，下面一行淡色小字说口径；可选底部一条小趋势线。数字用比例数字（不等宽），大而不松。
export function StatTile({ label, value, sub, title, trend }: { label: string; value: ReactNode; sub?: ReactNode; title?: string; trend?: Trend }) {
  // 趋势线放在大数右边、同一行，卡片不因为它变高，一排卡片高度一致。
  return <div className="stat-tile" title={title}>
    <div className="stat-label">{label}</div>
    <div className="stat-main"><div className="stat-value">{value}</div>{trend && trend.values.length > 1 && <Sparkline {...trend} />}</div>
    {sub != null && sub !== false && <div className="stat-sub">{sub}</div>}
  </div>;
}
