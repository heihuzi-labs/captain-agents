import { updateJob, active } from './job.ts';

export class SleepMonitor {
  private previous: number;
  private id: string;
  private now: () => number;

  constructor(id: string, now: () => number = Date.now) {
    this.id = id; this.now = now; this.previous = now();
  }
  async sample(): Promise<boolean> {
    const current = this.now();
    const gap = current - this.previous > 60_000;
    if (gap) {
      const period = { from: new Date(this.previous).toISOString(), to: new Date(current).toISOString() };
      await updateJob(this.id, job => { if (active(job)) (job.sleeps ??= []).push(period); });
    }
    this.previous = current;
    return gap;
  }
}
