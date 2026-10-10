import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, readFile, readdir, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { context, until } from './helpers.ts';
import { alive } from '../src/core/fsx.ts';
import { createChat, appendChatMessage, readChat, readMessages, sayInChat, chatDir, pendingForLead, REPORT_MAX } from '../src/core/chat.ts';
import { wakeChat, stopChat, closeChat, cleanChat, reconcileChat } from '../src/core/chat-engine.ts';
import { readJob, updateJob } from '../src/core/job.ts';
import { jobDir } from '../src/core/paths.ts';
import { setNetworkAllowed, writeSettings } from '../src/core/settings.ts';
import { clean, stop } from '../src/core/commands.ts';
import { dispatch } from '../src/core/dispatch.ts';
import { git, removeWorktree } from '../src/core/worktree.ts';
import { command, resumeCommand } from '../src/core/workers.ts';
import { sandbox } from '../src/core/sandbox.ts';

async function setup(t: TestContext, reports: Record<string, string | string[]> = {}, modes: Record<string, string> = {}) {
  let c: Awaited<ReturnType<typeof context>>;
  t.after(async () => {
    for (const id of await readdir(join(c.home, 'chats')).catch(() => [])) await stopChat(id).catch(() => {});
  });
  c = await context(t);
  const keys = ['XAGENTS_HOME', 'XAGENTS_FAKE_WORKER', 'XAGENTS_APPLICATIONS', 'XAGENTS_CAFFEINATE', 'XAGENTS_MAX_RUNNING', 'XAGENTS_TRASH', 'XAGENTS_SRT', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'XA_TEST_MODE', 'XA_TEST_REVIEW', 'XA_TEST_FREEZE', 'XA_TEST_CHAT_REPORTS', 'XA_TEST_CHAT_MODES'];
  const saved = keys.map(k => [k, process.env[k]] as const);
  for (const key of keys) { if (c.env[key] === undefined) delete process.env[key]; else process.env[key] = c.env[key]; }
  delete process.env.XA_TEST_MODE; delete process.env.XA_TEST_REVIEW; delete process.env.XA_TEST_FREEZE;
  process.env.XA_TEST_CHAT_REPORTS = JSON.stringify(reports);
  process.env.XA_TEST_CHAT_MODES = JSON.stringify(modes);
  t.after(() => { for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  assert.equal((await c.add()).code, 0);
  const open = (hopLimit = 4) => createChat({ project: '测试', title: '推进测试', members: ['grok:high', 'deepseek:high:ro'], hopLimit });
  return { ...c, open };
}
async function settled(id: string) {
  try { return await until(() => readChat(id), c => !c.pid && !c.busy && !c.queue.length, 45_000); }
  catch (error) { throw new Error(`${error}\n${await readFile(join(chatDir(id), 'engine.log'), 'utf8').catch(() => '')}`); }
}
async function busy(id: string) {
  const chat = await until(() => readChat(id), c => !!c.busy, 20_000);
  await until(() => readJob(chat.busy!.job), j => j.state === 'running' && !!j.workerPid, 20_000);
  return readChat(id);
}
async function observed(job: string) { return JSON.parse(await readFile(join(jobDir(job), 'observed.json'), 'utf8')) as { args: string[]; prompt: string; cwd: string }; }

describe('项目群聊推进', { concurrency: 1 }, () => {
  test('主人 @ 派出、汇报进群，沿报告 @ 接到只读成员，共用副本而且只 setup 一次', async t => {
    const c = await setup(t, { grok: '写完了 <script>不能执行</script>\n' + '完成事项\n'.repeat(25) + '@DeepSeek 请检查末尾的交接要求', deepseek: '检查完了 @负责人 @主人 请验收' });
    const projectFile = join(c.home, 'projects/测试.json');
    const p = JSON.parse(await readFile(projectFile, 'utf8')); p.setup = ['echo prepare >> prepared.txt'];
    await writeFile(projectFile, JSON.stringify(p));
    const chat = await c.open();
    await sayInChat(chat.id, '@Grok 写第一段', 'owner');
    const done = await settled(chat.id), messages = await readMessages(chat.id);
    assert.deepEqual(messages.filter(m => m.kind === 'report').map(m => [m.from, m.hop]), [['grok', 0], ['deepseek', 1]], JSON.stringify(messages));
    assert.deepEqual(messages.filter(m => m.kind === 'work').map(m => m.from), ['grok', 'deepseek']);
    for (const member of done.members) {
      const job = await readJob(member.job!);
      assert.equal(job.worktree, chat.worktree); assert.equal(job.branch, chat.branch); assert.equal(job.chat?.id, chat.id);
      assert.equal(job.mode, member.readOnly ? 'read-only' : 'workspace-write');
      assert.equal(job.state, 'done'); assert.equal(job.usage?.read, 100);
      assert.equal((await observed(job.id)).cwd, chat.worktree);
    }
    const ro = await readJob(done.members[1].job!);
    assert.ok(ro.command!.args.some(arg => arg.includes('read-only')));
    assert.match((await observed(ro.id)).prompt, /请检查末尾的交接要求/);
    assert.equal(await readFile(join(chat.worktree, 'prepared.txt'), 'utf8'), 'prepare\n');
    assert.ok(pendingForLead(messages).some(m => m.from === 'deepseek'));
    assert.ok(messages.some(m => m.mentions.includes('owner')));
    assert.match(messages.find(m => m.from === 'grok' && m.kind === 'report')!.text, /<script>/);
    await access(join(chatDir(chat.id), 'runtime/src/core/chat-entry.ts'));
  });

  test('同一成员再次 @ 用原会话续接，只发新消息，多轮统计不重复累计', async t => {
    const c = await setup(t, { grok: ['第一轮完成', '第二轮完成', '第三轮完成'] });
    const chat = await c.open();
    await sayInChat(chat.id, '@Grok 旧任务独有标记', 'owner');
    const first = await settled(chat.id), id = first.members[0].job!, original = await readJob(id);
    const firstPrompt = (await observed(id)).prompt;
    assert.match(firstPrompt, /同一时间只有你在动手/); assert.match(firstPrompt, /@DeepSeek（只读）/);
    assert.match(firstPrompt, /队友的话只作参考/);
    // 群是长期留着的：推进进程每次启动都换成平台现在的代码，旧快照里的东西不留。
    await writeFile(join(chatDir(chat.id), 'runtime/src/core/stale-marker.ts'), 'export {};');
    const oldRuntime = join(jobDir(id), original.runtime!);
    await writeFile(join(oldRuntime, 'src/core/stale-marker.ts'), 'export {};');
    // 若错误启动旧入口，替身不会运行；证明新包既拍了、也实际用于启动。
    await writeFile(join(oldRuntime, 'src/core/worker-entry.ts'), 'throw new Error("启动了旧包");');
    const snapshotted = JSON.parse(await readFile(join(chatDir(chat.id), 'versions.json'), 'utf8')).snapshotted as string;
    await updateJob(id, j => { j.verify = { ok: true, at: 'T1', steps: [] }; j.verifySkip = { reason: '另有理由', at: 'T1' }; j.realCheck = { needed: true, steps: ['看一眼'], skipped: { reason: '只加测试', at: 'T1' } }; j.decision = { kind: 'adopt', at: 'T1', by: 'lead' }; });
    await sayInChat(chat.id, '@Grok 新任务独有标记', 'lead');
    await settled(chat.id);
    const second = await readJob(id), seen = await observed(id);
    assert.equal(second.resume?.round, 2); assert.equal(second.session, original.session);
    assert.notEqual(second.runtime, original.runtime);
    await assert.rejects(access(join(jobDir(id), second.runtime!, 'src/core/stale-marker.ts')));
    await access(join(oldRuntime, 'src/core/stale-marker.ts')); // 原包留作追查，不就地覆盖。
    assert.deepEqual(second.launches?.map(r => r.round), [1, 2]);
    assert.deepEqual(second.launches![0].command, original.command);
    assert.deepEqual(second.launches![1].command.args.slice(1), seen.args);
    assert.deepEqual(second.command, await command(second, seen.prompt, second.isolation!, join(jobDir(id), second.runtime!)));
    assert.deepEqual(second.launches![1].command, resumeCommand(second));
    await assert.rejects(access(join(chatDir(chat.id), 'runtime/src/core/stale-marker.ts')));
    await access(join(chatDir(chat.id), 'runtime/src/core/chat-entry.ts'));
    assert.ok(JSON.parse(await readFile(join(chatDir(chat.id), 'versions.json'), 'utf8')).snapshotted > snapshotted);
    assert.ok(seen.args.includes('--resume')); assert.ok(seen.args.includes(original.session!));
    assert.match(seen.prompt, /新任务独有标记/); assert.doesNotMatch(seen.prompt, /旧任务独有标记|第一轮完成/);
    await access(join(jobDir(id), 'run-r1.log')); await access(join(jobDir(id), 'report-r1.md'));
    assert.equal(second.usage?.read, 200); assert.equal(second.rounds?.length, 2);
    // 上一轮的验收和拍板归到那一轮；任务记录回到“还没验收、还没拍板”，再拍一次才算数。
    assert.equal(second.verify, undefined); assert.equal(second.decision, undefined); assert.equal(second.verifySkip, undefined); assert.equal(second.rounds![0].verifySkip?.reason, '另有理由'); assert.deepEqual(second.realCheck, { needed: true, steps: [] });
    assert.deepEqual(second.rounds![0].verify, { ok: true, at: 'T1', steps: [] }); assert.equal(second.rounds![0].decision?.kind, 'adopt');
    assert.equal(second.rounds![0].realCheck?.skipped?.reason, '只加测试');
    assert.equal(second.rounds![1].decision, undefined);
    await sayInChat(chat.id, '@Grok 第三次安排', 'owner'); await settled(chat.id);
    const third = await readJob(id);
    assert.equal(third.usage?.read, 300); assert.equal(third.rounds?.length, 3);
    assert.deepEqual(third.launches?.map(r => r.round), [1, 2, 3]);
    assert.deepEqual(third.launches!.slice(0, 2), second.launches);
    assert.deepEqual(third.launches![2].command.args.slice(1), (await observed(id)).args);
    assert.equal(third.seconds, third.rounds!.reduce((sum, r) => sum + r.seconds, 0));
    assert.equal((await c.jobs()).length, 1);
  });

  test('续接重建两种隔离：新增禁读生效，首轮禁读删除后仍保留，只读和成员身份不变', async t => {
    const c = await setup(t, { grok: '完成', deepseek: '完成' });
    const config = join(c.home, 'config.json'), projectFile = join(c.home, 'projects/测试.json');
    const deny = async (home: string, repo: string) => {
      const settings = JSON.parse(await readFile(config, 'utf8').catch(() => '{}'));
      await writeFile(config, JSON.stringify({ ...settings, denyReadHome: [home] }));
      const project = JSON.parse(await readFile(projectFile, 'utf8'));
      await writeFile(projectFile, JSON.stringify({ ...project, denyReadExtra: [repo] }));
    };
    await deny('xa-old-secret', 'old-secret');
    const chat = await c.open();
    await sayInChat(chat.id, '@所有人 第一轮', 'owner'); const first = await settled(chat.id);
    const originals = await Promise.all(first.members.map(m => readJob(m.job!)));
    await deny('xa-new-secret', 'new-secret');
    await setNetworkAllowed(true); // 首轮关网，续接也必须关网。
    await sayInChat(chat.id, '@所有人 第二轮', 'owner'); await settled(chat.id);
    for (const old of originals) {
      const next = await readJob(old.id), seen = await observed(old.id);
      assert.equal(next.resume?.round, 2);
      for (const key of ['who', 'model', 'effort', 'fast', 'mode', 'session', 'worktree', 'branch', 'network', 'chat'] as const)
        assert.deepEqual(next[key], old[key], key);
      assert.deepEqual(next.command, await command(next, seen.prompt, next.isolation!, join(jobDir(next.id), next.runtime!)));
      assert.deepEqual(next.launches![1].command.args.slice(1), seen.args);
      const paths = ['xa-old-secret', 'xa-new-secret'].map(p => join(homedir(), p));
      for (const p of ['old-secret', 'new-secret']) paths.push(join(next.repo, p), join(next.worktree, p));
      if (next.who === 'grok') {
        const settings = JSON.parse(await readFile(join(jobDir(next.id), next.runtime!, 'sandbox.json'), 'utf8'));
        assert.deepEqual(settings, await sandbox(next, next.isolation!));
        for (const path of paths) assert.ok(settings.filesystem.denyRead.includes(path), path);
        assert.ok(settings.network); assert.ok(!seen.args.some(arg => arg.endsWith('srt-open.ts')));
      } else {
        const permissions = seen.args.find(arg => arg.startsWith('permissions.xa='))!;
        assert.match(permissions, /extends=":read-only"/);
        assert.doesNotMatch(permissions, /network=\{enabled=true\}/);
        for (const path of paths) assert.ok(permissions.includes(`${JSON.stringify(path)}="deny"`), path);
      }
    }
  });

  test('运行包中途准备失败：不叫醒、不改上一轮状态和结果、旧包与命令留存，群里写原因', async t => {
    const c = await setup(t, { grok: '第一轮完成' }); const chat = await c.open();
    await sayInChat(chat.id, '@Grok 第一轮', 'owner'); const done = await settled(chat.id), id = done.members[0].job!;
    await updateJob(id, job => { job.verify = { ok: true }; job.decision = { kind: 'adopt', at: 'T1', by: 'lead' }; });
    const old = await readJob(id), dir = jobDir(id), runtime = join(dir, old.runtime!);
    const files = ['src/core/worker-entry.ts', 'sandbox.json', 'versions.json', 'launch.json'];
    const contents = await Promise.all(files.map(file => readFile(join(runtime, file), 'utf8')));
    const observedBefore = await readFile(join(dir, 'observed.json'), 'utf8');
    // sandbox.json 写完以后，command 检查替身路径时抛错。
    process.env.XAGENTS_FAKE_WORKER = join(c.temp, 'missing-worker.ts');
    await sayInChat(chat.id, '@Grok 第二轮', 'owner'); await settled(chat.id);
    assert.deepEqual(await readJob(id), old);
    assert.equal(await readFile(join(dir, 'observed.json'), 'utf8'), observedBefore);
    assert.deepEqual(await Promise.all(files.map(file => readFile(join(runtime, file), 'utf8'))), contents);
    assert.deepEqual(await readdir(join(dir, 'runtime')), [old.runtime!.split('/').at(-1)]);
    await assert.rejects(access(join(dir, 'prompt-r2.md')));
    const events = (await readMessages(chat.id)).filter(m => m.kind === 'event' && /没能开始这一轮/.test(m.text));
    assert.equal(events.length, 1); assert.match(events[0].text, /第 2 轮运行包准备失败.*missing-worker/);
    assert.deepEqual(events[0].mentions, ['lead']);
  });

  test('成员动手前群副本自动跟上主线：干净就快进；有没提交的改动就不动，只在群里说一次', async t => {
    const c = await setup(t, { grok: ['第一轮完成', '第二轮完成', '第三轮完成', '第四轮完成'] });
    const chat = await c.open();
    const advance = async (name: string) => {
      await writeFile(join(c.repo, name), name);
      await git(c.repo, ['add', name]); await git(c.repo, ['commit', '-q', '-m', name]);
      return (await git(c.repo, ['rev-parse', 'HEAD'])).trim();
    };
    const head = async () => (await git(chat.worktree, ['rev-parse', 'HEAD'])).trim();
    const events = async () => (await readMessages(chat.id)).filter(m => m.kind === 'event' && /主线/.test(m.text));
    // 主线没动：什么都不说。
    await sayInChat(chat.id, '@Grok 第一件', 'owner'); await settled(chat.id);
    assert.deepEqual(await events(), []);
    // 主线往前走了一个提交，副本干净：快进，群里记一句（不叫负责人）。
    const one = await advance('main-one.txt');
    await sayInChat(chat.id, '@Grok 第二件', 'owner'); await settled(chat.id);
    assert.equal(await head(), one);
    await access(join(chat.worktree, 'main-one.txt'));
    assert.deepEqual((await events()).map(m => [m.text, m.mentions]), [['群副本已跟上主线（快进 1 个提交）。', []]]);
    // 副本里有成员没提交的改动：不动副本，告诉负责人；同一个主线提交只说一次。
    await writeFile(join(chat.worktree, 'README.md'), '成员改到一半');
    const two = await advance('main-two.txt');
    await sayInChat(chat.id, '@Grok 第三件', 'owner'); await settled(chat.id);
    assert.equal(await head(), one);
    assert.equal(await readFile(join(chat.worktree, 'README.md'), 'utf8'), '成员改到一半');
    await sayInChat(chat.id, '@Grok 第四件', 'owner'); const last = await settled(chat.id);
    const told = (await events()).slice(1);
    assert.equal(told.length, 1); assert.match(told[0].text, /落后 1 个提交，副本里还有没提交的改动，平台没有自动同步/); assert.deepEqual(told[0].mentions, ['lead']);
    assert.equal(last.behind, two);
  });
  test('联网总开关关掉以后，不再叫醒当初带着联网派出去的成员；关着时派的照常续接', async t => {
    const c = await setup(t, { grok: ['第一轮完成', '不该有第二轮'], deepseek: ['第一轮完成', '第二轮完成'] });
    const chat = await c.open();
    await setNetworkAllowed(true);
    await sayInChat(chat.id, '@Grok 开着联网派', 'owner'); const first = await settled(chat.id), grok = first.members[0].job!;
    assert.equal((await readJob(grok)).network, true);
    await setNetworkAllowed(false);
    await sayInChat(chat.id, '@DeepSeek 关着联网派', 'owner'); const second = await settled(chat.id), deepseek = second.members[1].job!;
    assert.notEqual((await readJob(deepseek)).network, true);
    await sayInChat(chat.id, '@Grok 再来一轮', 'owner'); await settled(chat.id);
    const refused = (await readMessages(chat.id)).filter(m => m.kind === 'event' && /联网总开关/.test(m.text));
    assert.equal(refused.length, 1); assert.match(refused[0].text, /@Grok 没能开始这一轮：这位成员是联网开着时派的，主人现在已关掉联网总开关，不能照旧续接/);
    assert.deepEqual(refused[0].mentions, ['lead']);
    const kept = await readJob(grok);
    assert.equal(kept.rounds?.length, 1); assert.equal(kept.state, 'done'); assert.equal(kept.resume, undefined);
    await sayInChat(chat.id, '@DeepSeek 再来一轮', 'owner'); await settled(chat.id);
    assert.equal((await readJob(deepseek)).rounds?.length, 2);
  });
  test('两位同时 @ FIFO 串行，重复叫醒和队内重复 @ 不重排', async t => {
    const c = await setup(t, { grok: '完成', deepseek: '完成' }, { grok: 'hold', deepseek: 'hold' });
    const chat = await c.open();
    await appendChatMessage(chat.id, { from: 'owner', kind: 'say', text: '@Grok @DeepSeek @Grok 请依次处理' });
    await Promise.all([wakeChat(chat.id), wakeChat(chat.id), wakeChat(chat.id)]);
    const first = await busy(chat.id);
    assert.equal(first.busy!.who, 'grok'); assert.deepEqual(first.queue.map(q => q.who), ['deepseek']);
    await sayInChat(chat.id, '@DeepSeek 补充参考', 'lead');
    assert.equal((await readChat(chat.id)).queue.length, 1); assert.equal((await c.jobs()).length, 1);
    await writeFile(join(jobDir(first.busy!.job), 'release'), '');
    const next = await until(() => readChat(chat.id), c => c.busy?.who === 'deepseek', 20_000);
    assert.equal((await readJob(first.busy!.job)).state, 'done');
    await writeFile(join(jobDir(next.busy!.job), 'release'), ''); await settled(chat.id);
    const flow = (await readMessages(chat.id)).filter(m => ['work', 'report'].includes(m.kind));
    assert.deepEqual(flow.map(m => [m.kind, m.from]), [['work', 'grok'], ['report', 'grok'], ['work', 'deepseek'], ['report', 'deepseek']]);
    await wakeChat(chat.id); await settled(chat.id);
    assert.equal((await readMessages(chat.id)).filter(m => m.kind === 'work').length, 2);
  });

  test('@所有人 保持成员顺序，报告不能 @ 自己，超过跳数交给负责人', async t => {
    const c = await setup(t, { grok: '@Grok 自己忽略 @DeepSeek 接手', deepseek: '@Grok 接回' });
    const chat = await c.open(1);
    await sayInChat(chat.id, '@Grok 开始', 'owner'); await settled(chat.id);
    const messages = await readMessages(chat.id);
    assert.equal(messages.filter(m => m.kind === 'work').length, 2);
    assert.ok(pendingForLead(messages).some(m => /连续交接 1 次/.test(m.text)));
    // 主人再说话归零，可以继续；这一轮所有人仍每位只排一次。
    process.env.XA_TEST_CHAT_REPORTS = JSON.stringify({ grok: '完成', deepseek: '完成' });
    await sayInChat(chat.id, '@所有人 分别汇报', 'owner'); await settled(chat.id);
    const works = (await readMessages(chat.id)).filter(m => m.kind === 'work');
    assert.deepEqual(works.slice(2).map(m => [m.from, m.hop]), [['grok', 0], ['deepseek', 0]]);
  });

  test('选手出错后写事件，继续队列', async t => {
    const c = await setup(t, { grok: '失败输出不能交接 @DeepSeek', deepseek: '检查完成' }, { grok: 'fail' });
    const chat = await c.open();
    await sayInChat(chat.id, '@Grok @DeepSeek 依次干', 'owner'); const done = await settled(chat.id);
    assert.equal((await readJob(done.members[0].job!)).state, 'failed');
    assert.equal((await readJob(done.members[1].job!)).state, 'done');
    const messages = await readMessages(chat.id);
    assert.ok(pendingForLead(messages).some(m => m.kind === 'event' && /出错/.test(m.text)));
    assert.equal(messages.filter(m => m.kind === 'report').length, 1);
  });

  test('设置拦住的成员出队并交给负责人，不挡后面的成员', async t => {
    const c = await setup(t);
    const chat = await c.open();
    await writeSettings({ workers: { grok: { enabled: false, efforts: ['high'], fast: false } } });
    await sayInChat(chat.id, '@Grok @DeepSeek 开始', 'owner'); const done = await settled(chat.id);
    assert.equal(done.members[0].job, undefined); assert.ok(done.members[1].job);
    assert.ok(pendingForLead(await readMessages(chat.id)).some(m => /没能派出/.test(m.text)));
  });

  test('stopChat 停正在动手的，清队列，之后新 @ 仍可派活', async t => {
    const c = await setup(t, { grok: '完成' }, { grok: 'hold' });
    const chat = await c.open();
    await sayInChat(chat.id, '@Grok @DeepSeek 开始', 'owner'); const running = await busy(chat.id);
    const job = await readJob(running.busy!.job);
    const stopped = await stopChat(chat.id);
    assert.equal(stopped.state, 'open'); assert.equal(stopped.busy, undefined); assert.deepEqual(stopped.queue, []);
    assert.equal((await readJob(job.id)).state, 'stopped');
    await until(async () => !alive(job.workerPid) && !alive(running.pid));
    await wakeChat(chat.id); assert.equal((await c.jobs()).length, 1);
    // 已停止、没输出的成员不能伪造会话号；让另一位接手验证群仍可用。
    await sayInChat(chat.id, '@DeepSeek 新安排', 'owner'); const done = await settled(chat.id);
    assert.ok(done.members[1].job);
    assert.ok((await readMessages(chat.id)).some(m => m.text === '停下了。'));
  });

  test('续接也执行设置与并发上限检查；现成副本不能同时启动第二位', async t => {
    const c = await setup(t, { grok: '完成' }); const chat = await c.open();
    await sayInChat(chat.id, '@Grok 第一轮', 'owner'); const done = await settled(chat.id);
    const id = done.members[0].job!;
    await writeSettings({ workers: { grok: { enabled: false, efforts: ['high'], fast: false } } });
    await sayInChat(chat.id, '@Grok 禁用后不能续接', 'owner'); await settled(chat.id);
    assert.equal((await readJob(id)).resume, undefined);
    assert.ok(pendingForLead(await readMessages(chat.id)).some(m => /没能派出/.test(m.text)));
    await writeSettings({ workers: { grok: { enabled: true, efforts: ['high'], fast: false } } });
    process.env.XAGENTS_MAX_RUNNING = '1';
    process.env.XA_TEST_CHAT_MODES = JSON.stringify({ deepseek: 'hold' });
    const other = await c.open(); await sayInChat(other.id, '@DeepSeek 占一个席位', 'owner'); const held = await busy(other.id);
    await sayInChat(chat.id, '@Grok 并发已满不能续接', 'owner'); await settled(chat.id);
    assert.equal((await readJob(id)).resume, undefined);
    assert.ok(pendingForLead(await readMessages(chat.id)).some(m => /同时最多跑 1 件/.test(m.text)));
    await assert.rejects(dispatch(c.task, { who: ['grok:high'], project: '测试', base: other.base, summary: '不能抢副本',
      chat: { id: other.id }, worktree: other.worktree, dirtyOk: true }), /还有成员在动手/);
    await writeFile(join(jobDir(held.busy!.job), 'release'), ''); await settled(other.id);
    await sayInChat(chat.id, '@Grok 空位后继续', 'owner'); await settled(chat.id);
    assert.equal((await readJob(id)).resume?.round, 2);
  });

  test('队列登记途中中断可以恢复，旧 @ 不会重放', async t => {
    const c = await setup(t); const chat = await c.open();
    const message = await appendChatMessage(chat.id, { from: 'owner', kind: 'say', text: '@Grok 开始' });
    await writeFile(join(chatDir(chat.id), 'engine.json'), JSON.stringify({ seen: 1, pending: {
      seen: message.id, queue: [{ who: 'grok', message: message.id, hop: 0 }], notices: [],
    } }));
    await wakeChat(chat.id); await settled(chat.id); await wakeChat(chat.id); await settled(chat.id);
    assert.equal((await c.jobs()).length, 1);
    assert.equal((await readMessages(chat.id)).filter(m => m.kind === 'work').length, 1);
    assert.equal((await readChat(chat.id)).busy, undefined);
  });

  test('直接停止成员写事件后队列继续', async t => {
    const c = await setup(t, { grok: '完成', deepseek: '完成' }, { grok: 'hold' });
    const chat = await c.open(); await sayInChat(chat.id, '@Grok @DeepSeek 开始', 'owner');
    const running = await busy(chat.id); await stop(running.busy!.job); await settled(chat.id);
    assert.ok(pendingForLead(await readMessages(chat.id)).some(m => /被停下/.test(m.text)));
    assert.equal((await c.jobs()).length, 2);
  });

  test('清理成员任务不删除群副本；close/clean 先存修改与新文件 patch，删除副本分支，保留记录', async t => {
    const c = await setup(t); const chat = await c.open();
    await assert.rejects(cleanChat(chat.id), /先收起群/);
    await sayInChat(chat.id, '@Grok 完成', 'owner'); const done = await settled(chat.id), job = await readJob(done.members[0].job!);
    await until(async () => !alive(job.pid));
    await removeWorktree(job); await access(chat.worktree);
    await clean(job.id); await access(chat.worktree);
    assert.equal((await readJob(job.id)).worktreeRemoved, undefined);
    assert.equal(await c.git(['branch', '--list', chat.branch, '--format=%(refname:short)']), chat.branch);
    await writeFile(join(chat.worktree, 'base.txt'), '修改后\n'); await writeFile(join(chat.worktree, 'new.txt'), '新内容\n');
    await closeChat(chat.id); await access(chat.worktree);
    await cleanChat(chat.id);
    const patch = await readFile(join(chatDir(chat.id), 'diff.patch'), 'utf8');
    assert.match(patch, /修改后/); assert.match(patch, /新内容/);
    await assert.rejects(access(chat.worktree));
    assert.equal(await c.git(['branch', '--list', chat.branch]), '');
    assert.equal((await readChat(chat.id)).state, 'closed'); assert.ok((await readMessages(chat.id)).length);
    await cleanChat(chat.id); assert.equal(await readFile(join(chatDir(chat.id), 'diff.patch'), 'utf8'), patch);
  });

  test('推进进程被杀后 reconcile 不抢仍在工作的席位，任务结束再补报告和事件，重复读取不写', async t => {
    const c = await setup(t, { grok: '完成' }, { grok: 'hold' }); const chat = await c.open();
    await sayInChat(chat.id, '@Grok 开始', 'owner'); const running = await busy(chat.id);
    process.kill(running.pid!, 'SIGKILL'); await until(async () => !alive(running.pid));
    assert.ok((await reconcileChat(await readChat(chat.id))).busy);
    await writeFile(join(jobDir(running.busy!.job), 'release'), '');
    await until(() => readJob(running.busy!.job), j => j.state === 'done');
    const fixed = await reconcileChat(await readChat(chat.id)); assert.equal(fixed.busy, undefined); assert.equal(fixed.pid, undefined);
    assert.equal((await readMessages(chat.id)).filter(m => m.kind === 'report').length, 1);
    assert.ok(pendingForLead(await readMessages(chat.id)).some(m => /后台进程不在/.test(m.text)));
    const before = await stat(join(chatDir(chat.id), 'chat.json')); await reconcileChat(fixed);
    assert.equal((await stat(join(chatDir(chat.id), 'chat.json'))).mtimeMs, before.mtimeMs);
  });

  test('看管进程被杀后先停残留选手再继续队列', async t => {
    const c = await setup(t, { deepseek: '完成' }, { grok: 'hang' }); const chat = await c.open();
    await sayInChat(chat.id, '@Grok @DeepSeek 开始', 'owner'); const running = await busy(chat.id), job = await readJob(running.busy!.job);
    process.kill(job.pid!, 'SIGKILL');
    await settled(chat.id); await until(async () => !alive(job.workerPid));
    assert.ok(pendingForLead(await readMessages(chat.id)).some(m => /失联/.test(m.text)));
    assert.equal((await readJob((await readChat(chat.id)).members[1].job!)).state, 'done');
  });

  test('报告按字截断，截断外 @ 不派活；初次提示词只带最近 30 条和报告前 20 行', async t => {
    const c = await setup(t, { grok: '字'.repeat(REPORT_MAX + 10) + '@DeepSeek 不该派' }); const chat = await c.open();
    for (let i = 0; i < 35; i++) await appendChatMessage(chat.id, { from: 'owner', kind: 'say', text: `历史独有${i}号` });
    await appendChatMessage(chat.id, { from: 'deepseek', kind: 'report', text: Array.from({ length: 25 }, (_, i) => `报告行${i}结束`).join('\n') });
    await sayInChat(chat.id, '@Grok 看新消息', 'owner'); const done = await settled(chat.id);
    const prompt = (await observed(done.members[0].job!)).prompt;
    assert.doesNotMatch(prompt, /历史独有0号|报告行20结束/); assert.match(prompt, /历史独有34号|报告行19结束/);
    const report = (await readMessages(chat.id)).findLast(m => m.kind === 'report')!;
    assert.match(report.text, /超过 12000 字/); assert.doesNotMatch(report.text, /@DeepSeek/);
    assert.equal(done.members[1].job, undefined);
  });

  test('现成副本派活不能换路径或绕过只读，也仍检查主目录未提交改动', async t => {
    const c = await setup(t); const chat = await c.open();
    const options = { who: ['deepseek:high'], project: '测试', base: chat.base, summary: '检查', chat: { id: chat.id }, worktree: chat.worktree, dirtyOk: true };
    await assert.rejects(dispatch(c.task, options), /只读/);
    await assert.rejects(dispatch(c.task, { ...options, ro: true, who: ['grok:high', 'deepseek:high'] }), /一次只能派一位/);
    await assert.rejects(dispatch(c.task, { ...options, ro: true, worktree: c.repo }), /群副本/);
    await writeFile(join(c.repo, 'base.txt'), '未提交');
    await assert.rejects(dispatch(c.task, { ...options, ro: true, dirtyOk: false }), /没提交/);
    assert.equal((await c.jobs()).length, 0);
  });
});


test('不设限通过 wake 叫醒 95% 的成员并续接，无需 force', async t => {
  const c = await setup(t, { grok: ['第一轮完成', '第二轮完成'] }), at = new Date().toISOString();
  await writeFile(join(c.home, 'config.json'), JSON.stringify({ limits: { maxRunning: 12, quotaStop: null } }));
  await mkdir(join(c.home, 'cache'), { recursive: true });
  const refreshQuota = () => writeFile(join(c.home, 'cache/quota.json'), JSON.stringify({ queriedAt: at, providers: [
    { name: 'Grok', icon: 'grok', plan: null, at, bars: [{ label: '本期额度', used: 95, reset: null }] },
    { name: 'Codex', icon: 'codex', plan: null, at, bars: [] },
    { name: 'Cursor', icon: 'cursor', plan: null, at, bars: [] },
  ] }));
  await refreshQuota();
  const chat = await c.open();
  await sayInChat(chat.id, '@Grok 第一轮', 'owner');
  const first = await settled(chat.id), id = first.members[0].job!;
  assert.ok(id, JSON.stringify(await readMessages(chat.id)));
  assert.equal((await readJob(id)).state, 'done');
  // 收尾会刷新缓存；续接前重新放入有效的 95% 快照，不能靠“查不到”放行。
  await refreshQuota();
  await sayInChat(chat.id, '@Grok 第二轮', 'owner');
  await settled(chat.id);
  const job = await readJob(id);
  assert.equal(job.state, 'done'); assert.equal(job.rounds?.length, 2);
});
