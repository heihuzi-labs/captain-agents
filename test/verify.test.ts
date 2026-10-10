import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { desktopView, context, root } from './helpers.ts';
import { testCounts, checkFor, execute, verifyState } from '../src/core/verify.ts';
import { quote } from '../src/core/decide.ts';

const cmd = (source: string) => `${quote(process.execPath)} -e ${quote(source)}`;
async function seed(c: Awaited<ReturnType<typeof context>>, id = 'verify-test') {
  const dir = join(c.home, 'jobs', id); await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'job.json'), JSON.stringify({ id, batch: '', project: '测试', repo: c.repo, base: c.base, worktree: c.repo, branch: `xa/${id}`, who: 'codex', kind: '实现', state: 'done', created: new Date().toISOString(), seconds: 1 }));
  return dir;
}
async function config(c: Awaited<ReturnType<typeof context>>, commands: string[], minutes = 20) {
  const file = join(c.home, 'projects/测试.json'), p = JSON.parse(await readFile(file, 'utf8'));
  p.verify = commands; p.verifyTimeoutMinutes = minutes; await writeFile(file, JSON.stringify(p));
}
test('识别 node:test 两种汇总和 Vitest；失败计数生成卡片', async () => {
  const sample = await readFile(join(root, 'test/fixtures/node-test-summary.txt'), 'utf8');
  assert.deepEqual(testCounts(sample), { total: 237, passed: 237, failed: 0 });
  assert.deepEqual(testCounts('ℹ tests 4\nℹ pass 3\nℹ fail 1\n'), { total: 4, passed: 3, failed: 1 });
  assert.deepEqual(testCounts('\x1b[31m Tests  3 failed | 7 passed | 1 skipped (11)\x1b[0m\n'), { total: 11, passed: 7, failed: 3 });
  assert.equal(testCounts('command output'), null);
  assert.equal(checkFor({ ok: true, steps: [{ ok: true, summary: sample }] })?.label, '通过 237/237');
  assert.equal(checkFor({ ok: false, steps: [{ ok: false, summary: 'Tests 3 failed (3)' }] })?.label, '没过 3 项');
});
test('假项目顺序验收通过和失败，保存完整日志和结果，桌面视图包含验收结论', async t => {
  const c = await context(t); await c.add(); const dir = await seed(c);
  await config(c, [cmd("console.log('# tests 2\\n# pass 2\\n# fail 0')"), cmd("console.log('second marker')")]);
  const pass = await c.cli(['verify', 'verify-test']); assert.equal(pass.code, 0, pass.stderr);
  let j = JSON.parse(await readFile(join(dir, 'job.json'), 'utf8')); assert.equal(j.verify.ok, true); assert.equal(j.verify.steps.length, 2);
  assert.ok(j.verify.seconds > 0); assert.ok(Date.parse(j.verify.at));
  assert.match(await readFile(join(dir, 'verify.log'), 'utf8'), /second marker/);
  const view = await desktopView(c.home);
  assert.equal(view.jobs[0].check?.ok, true);
  assert.equal(view.stats[0].verified, 1);
  assert.match(j.verify.steps[1].cmd, /second marker/);
  assert.equal(j.verify.steps[1].summary, '命令通过');
  await config(c, [cmd("console.error('# tests 4\\n# pass 1\\n# fail 3');process.exit(1)")]);
  const fail = await c.cli(['verify', 'verify-test']); assert.equal(fail.code, 1); assert.match(fail.stdout, /没过 3 项/);
  j = JSON.parse(await readFile(join(dir, 'job.json'), 'utf8')); assert.equal(j.verify.ok, false); assert.equal(j.verify.steps[0].exit, 1);
  assert.doesNotMatch(await readFile(join(dir, 'verify.log'), 'utf8'), /second marker/);
});
test('超时记录没过并杀掉整组孙进程，不留下心跳', async t => {
  const c = await context(t); await c.add(); const dir = await seed(c);
  const heartbeat = join(c.temp, 'heartbeat');
  const grandchild = `require('node:fs').writeFileSync(${JSON.stringify(heartbeat)},'started');setInterval(()=>require('node:fs').appendFileSync(${JSON.stringify(heartbeat)},'x'),20)`;
  await config(c, [cmd(`require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'inherit'});setInterval(()=>{},1000)`) ], 0.01);
  const r = await c.cli(['verify', 'verify-test']); assert.equal(r.code, 1); assert.match(r.stdout, /超时/);
  const j = JSON.parse(await readFile(join(dir, 'job.json'), 'utf8')); assert.equal(j.verify.ok, false); assert.equal(j.verify.steps[0].exit, null);
  const before = await readFile(heartbeat, 'utf8'); await sleep(150); assert.equal(await readFile(heartbeat, 'utf8'), before);
});
test('同项目验收跨进程排队超过 10 秒仍等待，日志不会交叉', async t => {
  const c = await context(t); await c.add(); await seed(c, 'a'); await seed(c, 'b');
  const trace = join(c.temp, 'trace');
  await config(c, [cmd(`const fs=require('node:fs');const first=!fs.existsSync(${JSON.stringify(trace)});fs.appendFileSync(${JSON.stringify(trace)},'start\\n');setTimeout(()=>fs.appendFileSync(${JSON.stringify(trace)},'end\\n'),first?10500:50)`)]);
  const results = await Promise.all([c.cli(['verify', 'a']), c.cli(['verify', 'b'])]);
  for (const r of results) assert.equal(r.code, 0, r.stderr);
  assert.equal(await readFile(trace, 'utf8'), 'start\nend\nstart\nend\n');
});
test('没有验收命令、非法超时、运行中或已清理不会误报通过', async t => {
  const c = await context(t); await c.add(); const dir = await seed(c);
  assert.equal((await c.cli(['verify', 'verify-test'])).code, 1);
  await config(c, [cmd('process.exit(0)')], 0); assert.equal((await c.cli(['verify', 'verify-test'])).code, 1);
  await config(c, [cmd('process.exit(0)')]);
  const file = join(dir, 'job.json'), j = JSON.parse(await readFile(file, 'utf8'));
  await writeFile(file, JSON.stringify({ ...j, state: 'running' })); assert.equal((await c.cli(['verify', 'verify-test'])).code, 1);
  await writeFile(file, JSON.stringify({ ...j, cleaned: new Date().toISOString() })); assert.equal((await c.cli(['verify', 'verify-test'])).code, 1);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).verify, undefined);
});
test('执行器程序缺失也会结束并释放计时器', async t => {
  const c = await context(t, false);
  const r = await execute(join(c.temp, 'not-installed'), [], c.temp, 1000);
  assert.match(r.error!, /ENOENT/); assert.equal(r.timedOut, false);
});

test('验收现状：通过、没过、免验、没验、不用验；再跑一次验收，免验理由让位给真实结果', async t => {
  const skip = { reason: '只改了文档', at: new Date().toISOString() }, pass = { ok: true, steps: [] }, fail = { ok: false, steps: [] };
  assert.equal(verifyState({ mode: 'workspace-write', verify: pass }), 'passed');
  assert.equal(verifyState({ mode: 'workspace-write', verify: pass, verifySkip: skip }), 'passed');
  assert.equal(verifyState({ mode: 'workspace-write', verify: fail }), 'failed');
  assert.equal(verifyState({ mode: 'workspace-write', verify: fail, verifySkip: skip }), 'skipped');
  assert.equal(verifyState({ mode: 'workspace-write', verifySkip: skip }), 'skipped');
  assert.equal(verifyState({ mode: 'workspace-write' }), 'missing');
  assert.equal(verifyState({ mode: 'read-only' }), 'exempt');
  assert.equal(verifyState({ mode: 'read-only', verify: fail }), 'failed');
  const c = await context(t); await c.add(); const dir = await seed(c); await config(c, [cmd('process.exit(0)')]);
  const read = async () => JSON.parse(await readFile(join(dir, 'job.json'), 'utf8'));
  assert.equal((await c.cli(['verify', 'verify-test', '--skip', '先记一笔'])).code, 0); assert.equal((await read()).verifySkip.reason, '先记一笔');
  // 应用里照实显示“免验”和理由；之前有一次没过的记录也不再当“验收没过”，合格率不认它。
  let shown = (await desktopView(c.home)).jobs[0]; assert.equal(shown.check, null); assert.equal(shown.checkSkipped?.reason, '先记一笔');
  const record = await read(); await writeFile(join(dir, 'job.json'), JSON.stringify({ ...record, verify: { ok: false, at: record.verifySkip.at, seconds: 1, steps: [] } }));
  shown = (await desktopView(c.home)).jobs[0]; assert.equal(shown.check, null); assert.equal(shown.checkSkipped?.reason, '先记一笔');
  assert.equal((await c.cli(['verify', 'verify-test'])).code, 0);
  const after = await read(); assert.equal(after.verify.ok, true); assert.equal(after.verifySkip, undefined);
  shown = (await desktopView(c.home)).jobs[0]; assert.equal(shown.check?.ok, true); assert.equal(shown.checkSkipped, null);
  assert.equal((await c.cli(['verify', 'no-such-job', '--skip', '理由'])).code, 1);
});
