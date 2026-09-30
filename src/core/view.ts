import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { paths } from './paths.ts';
import { interruption, listJobs } from './job.ts';
import type { Job, Batch } from './job.ts';
import { readOptional, hasCode } from './fsx.ts';
import { workerDisplay as workers, whos, spec, allowedEfforts, supportsFast } from './roster.ts';
import { checkFor } from './verify.ts';
import { readSelfcheck } from './selfcheck.ts';
import { stats, typicalFor, typicals } from './stats.ts';
import { profiles, tagKind } from './profiles.ts';
import { awakeSeconds } from './duration.ts';
import { boardQuota, readQuotaCache } from './quota.ts';
import { readSettings } from './settings.ts';
import { slimCandidates } from './slim.ts';
import { dashboard, ranges } from './dashboard.ts';
import type { View, ViewJob } from './view-types.ts';

// 只读取登记处；不修正任务、不查远程额度、不触发自检。
export async function buildView(): Promise<View> {
  const p = paths();
  const recorded = await listJobs().catch(error => { if (hasCode(error, 'ENOENT')) return []; throw error; });
  const jobs = recorded.map(job => {
    const interrupted = interruption(job);
    return interrupted ? { ...job, ...interrupted, error: interrupted.error } : job;
  });
  const typical = typicals(jobs);
  const rows = jobs.map(job => publicJob(job, typicalFor(typical, job)));
  const batches: Batch[] = [];
  const names = await readdir(p.batches).catch(error => { if (hasCode(error, 'ENOENT')) return []; throw error; });
  for (const name of names.filter(n => n.endsWith('.json'))) {
    const raw = await readOptional(join(p.batches, name));
    if (raw.trim()) {
      let batch: Batch;
      try { batch = JSON.parse(raw) as Batch; }
      catch (error) { if (error instanceof SyntaxError) continue; throw error; }
      if (!batch || typeof batch.id !== 'string' || typeof batch.started !== 'string'
        || !Array.isArray(batch.jobs) || batch.jobs.some(id => typeof id !== 'string')) continue;
      batches.push({ ...batch, summary: batch.summary || batch.title });
    }
  }
  batches.sort((a, b) => b.started.localeCompare(a.started));
  const { columns, keepAwake, notifications, storage, limits, archivedProjects, workers: policy } = await readSettings();
  const quota = await readQuotaCache();
  const registered = (await readdir(p.projects).catch(error => { if (hasCode(error, 'ENOENT')) return []; throw error; })).filter(n => n.endsWith('.json')).map(n => n.slice(0, -5));
  const labels = new Map<string, string>();
  for (const name of registered) {
    try { const raw = await readOptional(join(p.projects, `${name}.json`)); const label = raw.trim() ? (JSON.parse(raw) as { label?: unknown }).label : undefined; if (typeof label === 'string' && label.trim()) labels.set(name, label.trim()); }
    catch { /* 坏的登记文件：显示名退回项目名 */ }
  }
  const projectNames = [...new Set([...registered, ...jobs.map(job => job.project).filter(Boolean)])].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const archived = new Set(archivedProjects);
  const slimmed = jobs.filter(job => job.slimmed);
  return { settings: { keepAwake, notifications, storage, limits, workers: policy },
    dashboard: ranges.flatMap(range => ['', ...projectNames].map(project => dashboard(jobs, range, project))),
    storage: { slimmedJobs: slimmed.length, freedBytes: slimmed.reduce((sum, job) => sum + job.slimmed!.bytes, 0), due: slimCandidates(jobs, storage.days).length },
    updated: new Date().toISOString(), selfcheck: await readSelfcheck(),
    roster: whos.map(who => ({ who, name: spec(who).name, model: spec(who).shown, efforts: allowedEfforts(who), fastSupported: supportsFast(who) })),
    stats: stats(jobs), profiles: profiles(jobs), quota: boardQuota(quota), quotaAt: quota?.queriedAt ?? null, workers, projects: projectNames.map(name => ({ name, label: labels.get(name) ?? name, archived: archived.has(name) })), jobs: rows, batches,
    ...(columns ? { theme: { columns } } : {}) };
}

function publicJob(job: Job, typical: number | null): ViewJob {
  const { id, batch, project, who, model, effort, kind, title, state, base } = job;
  const { rating } = job;
  return { id, batch, project: project ?? '', who, model, effort, ...(job.fast ? { fast: true as const } : {}), kind, title, state, base,
    started: job.started || job.created, ended: job.ended ?? null, seconds: awakeSeconds(job), typical,
    check: checkFor(job.verify), decision: job.decision ? { ...job.decision, by: job.decision.by ?? 'lead' } : null,
    summary: job.summary || job.title, redo: job.redo ?? null, sleeps: job.sleeps ?? [], comments: job.comments ?? [],
    realCheck: job.realCheck ? { needed: job.realCheck.needed, steps: job.realCheck.steps,
      result: job.realCheck.result ? { ok: job.realCheck.result.ok, note: job.realCheck.result.note, at: job.realCheck.result.at, shotCount: job.realCheck.result.shots.length } : null,
      skipped: job.realCheck.skipped ?? null } : null,
    rating: rating ? { ...(rating.score === undefined ? {} : { score: rating.score }), ...(rating.good ? { good: rating.good } : {}), ...(rating.improve ? { improve: rating.improve } : {}),
      ...(rating.external ? { external: rating.external } : {}), at: rating.at, tags: rating.tags.map(tag => ({ tag, kind: tagKind(tag) })) } : null,
    activity: job.activity ?? [], timing: job.timing ?? null };
}
