import type { ReactElement } from 'react';
import { act, cleanup, render } from '@testing-library/react';
// 渲染性能的量法。不看墙上时钟：这台机器常常同时跑很多任务，测试进程排不上处理器的那段时间也会被算进去，
// 机器一忙就误报（2026-10-10 实测：同一份代码，空闲时约 300 毫秒，别的会话在跑测试时 2000 到 4800 毫秒，单独跑这一个文件也一样）。
// 这里量两样东西，再相除：
// 1. 只算本线程真正用掉的处理器时间（process.threadCpuUsage），排队等处理器的时间不算；
// 2. 同一轮里紧接着用同样的 React 和 jsdom 画 1000 张最朴素的卡片当基准。机器变慢（被挤到小核、缓存被别人冲掉）时两边一起变慢，倍数不变。
// 每样取几轮里最小的一次（干扰只会让数字变大，最小的最接近真实开销）；一旦落在预算内就不再多跑。
const ROUNDS = 5;
// 预算：不超过基准的 10 倍。基准在这台机器上约 0.1 秒（头一次约 130 毫秒，热了以后 60 到 90 毫秒），10 倍大致就是设计文档里说的“不超过 1 秒”。
// 2026-10-10 实测 1000 张在跑卡片是基准的 2 到 4 倍（空闲、负载 100 以上都一样），余量和原来“约 300 毫秒对 1 秒”相当：
// 每张卡多花约 0.3 毫秒（约 6 倍）仍通过，多花约 0.6 毫秒（8 到 14 倍）在线上下，多花约 1.7 毫秒（22 到 34 倍）必定失败。
export const RENDER_BUDGET = 10;
const cpuMs = () => {
  const used = process.threadCpuUsage();
  return (used.user + used.system) / 1000;
};
async function cost(ui: ReactElement) {
  const start = cpuMs();
  // 异步的 act 会把取数据和随后的重画一起做完，不用靠超时去等。
  await act(async () => {
    render(ui);
  });
  return cpuMs() - start;
}
function Baseline() {
  return <main>{Array.from({ length: 1000 }, (_, i) => <article key={i} className="card"><header><span>选手</span><b>任务{i}</b></header><p>给主人看的任务说明</p><footer><span>{i} 秒</span><button type="button">看</button></footer></article>)}</main>;
}
// 画一次 ui 的开销是基准的多少倍。shown 在每次画完后检查该出现的内容确实都出现了（没画完的不能算数）。
export async function renderCost(ui: () => ReactElement, shown: () => void) {
  let app = Infinity, base = Infinity;
  for (let round = 0; round < ROUNDS; round++) {
    if (round) cleanup();
    base = Math.min(base, await cost(<Baseline />));
    cleanup();
    app = Math.min(app, await cost(ui()));
    shown();
    if (app <= RENDER_BUDGET * base) break;
  }
  return { ratio: app / base, note: `${Math.round(app)} 毫秒处理器时间，基准 ${Math.round(base)} 毫秒，${(app / base).toFixed(1)} 倍` };
}
