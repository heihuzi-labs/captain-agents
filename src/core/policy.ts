import { allowedEfforts, isWho, spec, supportsFast, whos, isKept, modelGone, vendorOf, channelNames } from './roster.ts';
import type { Effort, Who } from './roster.ts';

export type WorkerPolicy = { enabled: boolean; efforts: Effort[]; fast: boolean };
export type WorkersPolicy = Record<Who, WorkerPolicy>;
export const effortNames: Record<Effort, string> = { medium: '中档', high: '高档', xhigh: '超高档' };
const order: Effort[] = ['medium', 'high', 'xhigh'];
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object'
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const defaults = (who: Who): WorkerPolicy => ({ enabled: true, efforts: allowedEfforts(who), fast: supportsFast(who) });

function workerPolicy(who: Who, value: unknown): WorkerPolicy {
  const name = spec(who).name;
  if (!object(value) || Object.keys(value).some(key => !['enabled', 'efforts', 'fast'].includes(key))) {
    throw new Error(`${name} 的设置只能包含 enabled、efforts、fast，请提交完整的选手设置。`);
  }
  if (typeof value.enabled !== 'boolean' || typeof value.fast !== 'boolean') throw new Error(`${name} 的选手和快速版开关只能是开或关。`);
  const allowed = allowedEfforts(who);
  if (!Array.isArray(value.efforts) || !value.efforts.length || !Array.from(value.efforts).every(e => allowed.includes(e))) {
    throw new Error(`${name} 至少要留一个推理强度，只能选${allowed.map(e => effortNames[e]).join('、')}。`);
  }
  if (value.fast && !supportsFast(who)) throw new Error(`${name} 不支持快速版，请关闭快速版。`);
  const efforts = value.efforts;
  return { enabled: value.enabled, efforts: order.filter(e => efforts.includes(e)), fast: value.fast };
}

// 旧配置、缺项或坏项按选手回退；读配置不写回磁盘。
export function effectiveWorkers(stored: unknown): WorkersPolicy {
  const workers = Object.fromEntries(whos.map(who => {
    try { return [who, workerPolicy(who, object(stored) && Object.hasOwn(stored, who) ? stored[who] : undefined)]; }
    catch { return [who, defaults(who)]; }
  })) as WorkersPolicy;
  // 手动改坏成全关也要返回合法策略；正常写入会在合并后拒绝全关。
  return whos.some(who => workers[who].enabled) ? workers : Object.fromEntries(whos.map(who => [who, defaults(who)])) as WorkersPolicy;
}

export function validateWorkersPatch(patch: unknown): WorkersPolicy {
  if (!object(patch)) throw new Error('选手设置格式不对，请按选手提交设置。');
  const workers: WorkersPolicy = {};
  for (const [who, value] of Object.entries(patch)) {
    if (!isWho(who)) throw new Error(`不认识选手 ${who}，请从选手清单中选择。`);
    workers[who] = workerPolicy(who, value);
  }
  return workers;
}

export function checkChoice(policy: WorkersPolicy, choice: { who: Who; effort: Effort; fast?: boolean }): void {
  const { who, effort, fast } = choice;
  if (!isWho(who)) throw new Error(`不认识选手 ${who}，请换一位。`);
  const worker = policy[who], name = spec(who).name;
  if (!isKept(who)) throw new Error(`主人没有保留 ${name}，请换一位。`);
  if (modelGone(who)) throw new Error(`${name} 的模型 ${spec(who).model} 已经不在 ${channelNames[vendorOf(who)]} 的名单里，请主人在设置里换一个。`);
  if (!worker?.enabled) throw new Error(`主人在设置里关掉了 ${name}，请换一位选手。`);
  if (!allowedEfforts(who).includes(effort) || !worker.efforts.includes(effort)) {
    throw new Error(`主人只允许 ${name} 用${worker.efforts.map(e => effortNames[e]).join('、')}，请把强度改成其中之一。`);
  }
  if (fast && (!supportsFast(who) || !worker.fast)) throw new Error(`主人没有打开 ${name} 的快速版，请去掉 :fast。`);
}
