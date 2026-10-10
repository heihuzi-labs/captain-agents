import { loadConfiguredRoster } from './settings.ts';
import { runWorker } from './runner.ts';
import { updateJob, finish } from './job.ts';
const id = process.argv[2];
try {
  await loadConfiguredRoster();
  await runWorker(id);
} catch (error) {
  // 装载失败也收尾登记，不能留下无人处理的 queued 活。
  const message = error instanceof Error ? error.message : String(error);
  await updateJob(id, job => { if (job.state === 'queued') finish(job, 'failed', `装载选手设置失败：${message}`); });
  console.error(message); process.exitCode = 1;
}
