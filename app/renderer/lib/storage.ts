import type { SlimDays } from '../../../src/core/settings.ts';
import type { View } from '../../../src/core/view-types.ts';
import { megabytes } from '../../../src/core/text.ts';
export { megabytes };

// 天数三选一。和核心的 slimDays 是同一组（核心那份带文件读写，窗口里不能直接引；test/desktop.test.ts 对过）。
export const SLIM_CHOICES: readonly SlimDays[] = [7, 14, 30];

// 设置页“存储”一组的文字（拼法见 docs/ui-spec.md 第 10 节）。件数和字节数都是核心算好的（View.storage），这里只换成人话。
export const SLIM_NOTE = (days: number) => `活结束 ${days} 天后，把选手的原始日志和运行文件移到废纸篓；任务记录、报告、改动和打分都留着。`;

export function storageLine({ slimmedJobs, freedBytes, due }: View['storage']): string {
  return (slimmedJobs > 0 ? `已清理 ${slimmedJobs} 件，腾出 ${megabytes(freedBytes)}；` : '还没清理过；')
    + (due > 0 ? `现在有 ${due} 件到期。` : '现在没有到期的。');
}
