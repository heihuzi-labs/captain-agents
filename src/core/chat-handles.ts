import { workerHandles } from './roster.ts';
import type { Who } from './roster.ts';

// 群聊里 @ 的写法（docs/design-team.md 第 16.2 节）：选手用名单表里的短名字（roster.ts 的 handle），不分大小写。
// 负责人写“@负责人”，主人写“@主人”，所有选手写“@所有人”。不引入任何 node 模块，界面和核心共用这一份。
export const HANDLES: Record<Who, string> = workerHandles;
export const LEAD_HANDLE = '负责人', OWNER_HANDLE = '主人', ALL_HANDLE = '所有人';

export { loadWorkerHandles } from './roster.ts';
