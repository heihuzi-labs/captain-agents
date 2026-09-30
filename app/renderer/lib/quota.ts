import type { View } from '../../../src/core/view-types.ts';
import { fmtTime } from './board.ts';

export type Quota = View['quota'][number];
export type QuotaBar = Quota['bars'][number];
// 额度提醒档：80% 起琥珀色，95% 起红色；查不到没有档。
// 到了设置里的停派线（缺省 80%）起琥珀，95% 起红；停派线以下灰色，平时安静。
export const quotaLevel = (used: number | null, stop = 80): '' | 'warn' | 'bad' => used == null ? '' : used >= 95 ? 'bad' : used >= stop ? 'warn' : '';
// 一家有多个池（Cursor 三个池、Codex 两个窗口）时，取用得最多的那个；一个都没查到时是 undefined。
export const topBar = (q: Quota) => q.bars.reduce<QuotaBar | undefined>((a, b) => (b.used ?? -1) > (a?.used ?? -1) ? b : a, undefined);
const barText = (b: QuotaBar) => b.used == null ? '查不到' : (b.approx ? '不到 ' : '') + b.used + '%';
export const dataTime = (q: Quota) => q.at ? `数据时间 ${fmtTime(q.at, true)}` : '还没有查到过';
// 悬停提示：每个池一行，再写数据时间（提示是纯文字，提醒色只用在各家表现页的卡片上）。
export const quotaTip = (q: Quota) => [...q.bars.map(b => `${b.label}：${barText(b)}`), ...(q.failed ? ['这次没查到，上面是上一次的数据'] : []), dataTime(q)].join('\n');
