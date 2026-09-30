import { memo, useEffect, useRef } from 'react';
import type { ViewJob } from '../../../src/core/view-types.ts';
import { timingLine } from '../lib/board.ts';
import { subscribeTick } from '../lib/ticker.ts';

// 每一步的时间那一句话（淡色小字）。没有记录（timing 为 null）时整行不出现；在跑的活跟着全窗口共用的计时器刷新，只改这一小块文字。纯文字显示。
export const TimingNote = memo(function TimingNote({ job }: { job: ViewJob }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const live = job.state === 'running' || job.state === 'queued', has = job.timing !== null;
  useEffect(() => {
    if (!live || !has) return;
    return subscribeTick(() => { if (ref.current) ref.current.textContent = timingLine(job) ?? ''; });
  }, [live, has, job]);
  const text = has ? timingLine(job) : null;
  return text === null ? null : <p ref={ref} className="timing-note">{text}</p>;
});
