import type { CheckStatus, ProjectCheck } from '../core/project-check.ts';

const mark: Record<CheckStatus, string> = { ok: '✓', warn: '!', fail: '✗' };

// 每项一行“标记 标题”，下面缩进写说明和怎么修；最后一行给结论。
export function formatCheck(check: ProjectCheck) {
  const lines: string[] = [];
  for (const i of check.items) {
    lines.push(`${mark[i.status]} ${i.title}`, `    ${i.detail}`);
    if (i.fix) lines.push(`    怎么修：${i.fix}`);
  }
  const failed = check.items.filter(i => i.status === 'fail').length;
  lines.push(failed ? `先处理 ${failed} 个问题再派活` : '可以派活');
  return lines.join('\n');
}
