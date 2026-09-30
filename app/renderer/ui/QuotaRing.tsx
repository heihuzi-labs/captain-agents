import type { ReactNode } from 'react';
import { quotaLevel } from '../lib/quota.ts';

// 额度圆环：从 12 点钟方向顺时针填到已用的百分比；颜色按 quotaLevel（停派线以下灰色、到停派线起琥珀、95% 起红；平时安静，快用完才显眼）；
// 查不到（used 为 null）是一圈虚线空环。children 放在环中心（顶栏放厂家图标）。百分比数字由外面（StatusCluster）写在环旁边，label 给读屏用。
export function QuotaRing({ used, label, stop, children }: { used: number | null; label: string; stop?: number; children?: ReactNode }) {
  const known = used != null, pct = known ? Math.max(0, Math.min(100, used)) : 0;
  return <span className="ring" role="img" aria-label={label} data-level={quotaLevel(used, stop) || undefined} data-used={known ? used : undefined} data-empty={known ? undefined : ''}>
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle className="ring-track" cx="12" cy="12" r="10.5" pathLength="100" strokeDasharray={known ? undefined : '4 4'} />
      {known && pct > 0 && <circle className="ring-arc" cx="12" cy="12" r="10.5" pathLength="100" strokeDasharray={`${Math.max(pct, 3)} 100`} />}
    </svg>
    {children}
  </span>;
}
