import { memo, useEffect, useRef } from 'react';
import type { ViewJob } from '../../../src/core/view-types.ts';
import { fmtDur, secondsSince } from '../lib/board.ts';
import { subscribeTick } from '../lib/ticker.ts';

// 用时：在跑的活每秒只改这一小块文字，不触发整块重画。
export const Elapsed = memo(function Elapsed({ job, className = 'num' }: { job: ViewJob; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const live = job.state === 'running' || job.state === 'queued';
  useEffect(() => {
    if (!live) return;
    return subscribeTick(() => { if (ref.current) ref.current.textContent = fmtDur(secondsSince(job.started)); });
  }, [live, job.started]);
  return <span ref={ref} className={className}>{live ? fmtDur(secondsSince(job.started)) : job.seconds == null ? '—' : fmtDur(job.seconds)}</span>;
});
