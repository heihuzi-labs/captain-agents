import type { QuotaStop } from '../../../src/core/settings.ts';

// 派活限制的选项。和核心 settings.ts 的 LIMIT_CAPS、quotaStops 是同一组（核心那份带文件读写，窗口里不直接引；test/desktop.test.ts 对过）。
export const RUN_CHOICES: readonly number[] = [1, 2, 3, 4, 5, 6];
export const STOP_CHOICES: readonly QuotaStop[] = [50, 60, 70, 80];
