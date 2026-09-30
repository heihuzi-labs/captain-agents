import { join } from 'node:path';
import { StreamParser, LogTail } from './activity.ts';
import { jobDir } from './paths.ts';
import { updateJob } from './job.ts';
import type { Job } from './job.ts';
import { changedFiles } from './worktree.ts';

// 串行调用 sample/persist，避免慢磁盘上的两次采集互相覆盖。
export class LiveProgress {
  parser: StreamParser;
  private tail = new LogTail();
  private job: Job;
  private lastCount: number;
  private lastWrite: number;
  private sampledAt: string;
  private savedRevision = 0;
  private files?: number;
  private dirty = false;

  constructor(job: Job, now = Date.now()) {
    this.job = job; this.parser = new StreamParser(job.who, job.worktree);
    this.lastCount = this.lastWrite = now;
    this.sampledAt = new Date(now).toISOString();
  }
  async sample(final = false, now = Date.now()) {
    const at = new Date(now).toISOString();
    const previous = this.parser.timing(undefined, this.sampledAt);
    await this.tail.read(join(jobDir(this.job.id), 'run.log'), this.parser, at);
    if (final) this.parser.finish(at);
    this.sampledAt = at;
    if (this.parser.timing(undefined, at).toolSeconds !== previous.toolSeconds) this.dirty = true;
    if (final || now - this.lastCount >= 30_000) {
      this.lastCount = now;
      this.files = await changedFiles(this.job);
      this.dirty = true;
    }
  }
  apply(job: Job) {
    const parsed = this.parser.result();
    job.activity = parsed.activity;
    job.lastActivityAt = parsed.lastActivityAt;
    job.usage = parsed.usage;
    job.timing = this.parser.timing(job.sleeps, this.sampledAt);
    if (this.files !== undefined) job.changedFiles = this.files;
  }
  async persist(now?: number) {
    if ((now ?? Date.now()) - this.lastWrite < 5000 || (!this.dirty && this.savedRevision === this.parser.revision)) return false;
    await updateJob(this.job.id, j => this.apply(j));
    // 等锁、落盘耗时也计入间隔，不能在上次写完后立刻再写。
    this.lastWrite = now ?? Date.now(); this.savedRevision = this.parser.revision; this.dirty = false;
    return true;
  }
}
