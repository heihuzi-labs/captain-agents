import type { TeamReason, TeamState } from './team.ts';

// 小队状态、原因、正在干活的人写成给人看的中文，命令行和界面共用这一份。
// reasonText：lead 时为什么停下来（wait 打印、界面卡上写“等负责人：<这句>”）。
export function reasonText(reason: TeamReason): string {
  switch (reason) {
    case 'passed': return '审查说通过了';
    case 'disagree': return '轮数用完，还有必须改的没谈拢';
    case 'unclear': return '审查报告里找不到结论';
    case 'brake': return '到了刹车线';
    case 'blocked': return '叫醒前被拦下';
    case 'failed': return '有一轮没做完';
    case 'lost': return '推进小队的后台不在了';
    // 登记文件被改坏时不写出字面的 undefined，也不冒充某种已知原因（2026-10-10 小队试跑发现）。
    default: return '原因不明';
  }
}
export const stateText = (state: TeamState) => state === 'running' ? '在进行' : state === 'lead' ? '等负责人' : state === 'ended' ? '已收场' : '状态不明';
