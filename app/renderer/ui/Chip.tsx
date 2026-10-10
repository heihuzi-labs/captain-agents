import type { ReactNode } from 'react';
import type { ViewJob } from '../../../src/core/view-types.ts';
import { STATE } from '../lib/board.ts';

export type Tone = 'neutral' | 'ok' | 'bad' | 'warn' | 'acc';
// 状态标签：颜色只表达语义，文字写人话。
export function Chip({ tone = 'neutral', title, children }: { tone?: Tone; title?: string; children: ReactNode }) {
  return <span className={'chip chip-' + tone} title={title}>{children}</span>;
}
export function CheckChip({ job }: { job: ViewJob }) {
  const c = job.check, skipped = job.checkSkipped;
  // 负责人写明不跑验收的：中性色照实写“免验”，理由放在提示里；它不是“通过”。
  if (!c && skipped) return <Chip title={'负责人：' + skipped.reason}>免验</Chip>;
  return <Chip tone={c ? c.ok ? 'ok' : 'bad' : 'neutral'} title={c?.note}>{c?.label ?? '未验收'}</Chip>;
}
export function Dot({ state }: { state: ViewJob['state'] }) {
  return <span className={'dot dot-' + state} title={STATE[state]} />;
}
