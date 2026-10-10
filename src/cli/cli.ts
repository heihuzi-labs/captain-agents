import { recordRealCheck } from '../core/real.ts';
import { fileURLToPath } from 'node:url';
import { ensureHome } from '../core/paths.ts';
import { hasCode } from '../core/fsx.ts';
import { addProject, listProjects, loadProject, setArchived, setProjectLabel } from '../core/project.ts';
import { checkProject } from '../core/project-check.ts';
import { formatCheck } from './check.ts';
import { dispatch } from '../core/dispatch.ts';
import { runWorker, reconcileSafely } from '../core/runner.ts';
import { status, wait, collect, stop, clean } from './commands.ts';
import { table } from './format.ts';
import { megabytes } from '../core/text.ts';
import { INTRO_TEXT } from '../core/intro.ts';
import { connect, connectArgument, connectStateNames, connectStatus, disconnect } from '../core/connect.ts';
import { selfcheck } from '../core/selfcheck.ts';
import { verify, skipVerify, checkFor } from '../core/verify.ts';
import { decide, markHandled } from '../core/decide.ts';
import { decisionMessage } from './decide.ts';
import { addComment } from '../core/comments.ts';
import { inbox } from './commands.ts';
import { stats } from '../core/stats.ts';
import { statsTable } from './stats.ts';
import { rate } from '../core/rate.ts';
import { profiles } from '../core/profiles.ts';
import { dashboard, ranges } from '../core/dashboard.ts';
import { formatReport } from './report.ts';
import { profilesTable } from './profiles.ts';
import { listJobs } from '../core/job.ts';
import { queryQuota } from '../core/quota.ts';
import { formatQuota } from './quota.ts';
import { queryModels, refreshModelsWithBaseline, readModelsCache, viewModels, modelsCacheFrom } from '../core/models.ts';
import { formatModels, formatDiscoveredModels } from './models.ts';
import { whos, fastWhos, spec, keptWhos } from '../core/roster.ts';
import { readSettings, loadConfiguredRoster } from '../core/settings.ts';
import { effortNames } from '../core/policy.ts';
import { slimOld } from '../core/slim.ts';
import { chatNew, chatList, chatLog, chatSay, chatControl, chatWait } from './chat.ts';
import { teamStart, teamStatus, teamLog, teamSay, teamRound, teamStop } from './team.ts';

const help = () => `派活工作台：登记、派发和收集本机助手的任务。
  xagents intro   # 打印给其他 AI 的对接提示词（贴进它的对话，它就知道先读手册）
  xagents connect   # 看各家 AI 的接入状态
  xagents connect <claude|codex|grok|cursor|dsh> [--undo]   # 接入；--undo 撤下（dsh 是 DeepSeek Harness）
  xagents login deepseek   # 主人自己登录 DeepSeek：按提示粘贴 API 钥匙（屏幕上不显示），由 Codex 单独保管，不影响 ChatGPT 登录
  xagents guide
    打印指挥手册全文，末尾附这台机器现在的情况（选手设置、额度、各家档案、手头的活）。来指挥的 AI 第一步先运行它
  xagents project add <名字> <仓库路径> [--label 显示名] [--worktree-root 相对路径] [--setup 命令] [--verify 命令] [--deny-read 路径] [--rules 文件]
  xagents project label <名字> <显示名>   # 只改应用里显示的项目名
  xagents project archive|unarchive <名字>   # 归档后看板已完成列和历史页“全部”不显示，记录和打分都留着；归档的项目不能派活
  xagents project list
  xagents project check <名字> [--quick] [--json]
    接入体检：看仓库、有没有没提交的改动、副本目录、疑似密钥文件、验收命令；不加 --quick 还会在临时副本里装依赖、跑一遍验收（比较久）。有不行的项退出码为 1
  xagents quota [--json]
  xagents models [refresh]
  xagents workers
    查看主人允许的选手、强度、快速版、当前派活限制和联网总开关
  xagents run <题目文件> --summary "一两句要做什么" --who 选手:强度[:fast] [--who …] [--project 名字] [--base 提交] [--kind 类型] [--title 标题] [--ro] [--force] [--dirty-ok] [--real ["一句说明"]]
  xagents chat new <项目> --member 选手:强度[:fast][:ro] [--member …] [--title 群名] [--hops N]
  xagents chat list
  xagents chat log <群号> [--all]   # 缺省最近 20 条
  xagents chat say <群号> "…@Grok …"   # 负责人说话
  xagents chat stop <群号>   # 停下选手并清空队列
  xagents chat close <群号>   # 收起群，保留副本
  xagents chat clean <群号>   # 清理收起的群，先存改动
  xagents chat wait <群号>   # 空闲时 0，主人新动作 3，群里有给负责人的话 4
  xagents team start <题目文件> --writer 选手:强度[:fast] --reviewer 选手:强度[:fast] --summary "…" [--project 名字] [--base 提交] [--kind 实现|修复] [--title 标题] [--rounds N] [--minutes M] [--force] [--dirty-ok] [--real ["…"]]
    搭档审改：一位写、一位审，写手和审查必须是不同模型；开队后打印队号
  xagents team status [队号]   # 小队一张表；给队号时再列两件活和最近 5 条频道
  xagents team log <队号> [--all]   # 频道全文，缺省最近 20 条
  xagents team say <队号> "…"   # 负责人在频道里说一句，下一轮带给双方
  xagents team round <队号> [--note "…"]   # 停下的小队再走一轮
  xagents team stop <队号>   # 收场：停下在跑的那位和后台进程
  xagents status [任务号|批号|队号] [--all]
    有计时记录的任务会显示跑命令用时和步数；工具重叠只计一次，休眠不计入
  xagents wait|collect|stop <任务号|批号>
    wait 的退出码：0 都做完了，1 有出错或失联，3 主人有新动作（留言、用这份、不要了、重做）要先处理
  xagents wait <队号>
    小队 wait 的退出码：0 已收场，3 主人有新动作要先处理，4 在等负责人
  xagents clean <任务号|批号|队号|--done>
    已拍板的任务须先打分，才可清理
  xagents slim [--dry-run] [--force]
    到期的旧日志移到废纸篓；--dry-run 只预览；--force 忽略自动清理开关，天数和条件仍按设置
  xagents selfcheck
    检查关网时的隔离，需负责人在隔离外运行
  xagents verify <任务号>
  xagents verify <任务号> --skip "为什么不用验收"
    能改文件的活，采用前要有通过的验收记录，或用 --skip 写明理由；只读的活不用
  xagents real <任务号> --pass|--fail --note "一句说明" [--shot 截图路径]…
  xagents real <任务号> --skip "为什么不需要"
  xagents adopt|drop <任务号> [--note 给主人看的结论]
  xagents adopt <任务号> --merged <合并提交号> [--note …]   # 已在副本之外合并时补记
  xagents inbox
  xagents handled <任务号>
  xagents reply <任务号> "回复主人的留言"
  xagents stats
  xagents rate <任务号> [--score 1-5] [--good "做得好的"] [--improve "要改进的"] [--tag 标签]... [--external "外部原因"]
    只给已结束的任务打分；分数和外部原因至少填一个，改分保留最近 5 版历史
  xagents report [--range today|7d|30d] [--project 名字] [--json]
    汇总已结束任务的表现、用时、token 和额度；默认近 7 天、全部项目（含已归档）
  xagents profiles [--json]
    平均步数、跑命令用时只统计做完且有计时记录的任务；没有记录显示 —
选手：${whos.join('、')}。强度：medium、high、xhigh；${fastWhos.join('、')} 可在末尾加 :fast 用快速版（按 2 倍扣额度）。类型：修复、实现、审查、调研、测量。
派活限制在“设置 → 选手与模型 → 派活限制”调整：同时最多 1–12 件（缺省 12），额度停派线 50%、60%、70%、80%、90%、不设限（缺省 80%）；--force 只跳过额度。
XAGENTS_MAX_RUNNING：正整数，仅供测试或临时收紧；取它与设置上限的较小值，不能放宽设置或超过 12。
隔离自检没过不能派活；验收须由负责人在隔离外运行。`;

function parse(args: string[], values: string[] = [], flags: string[] = [], repeated: string[] = [], optional: string[] = []) {
  const positional: string[] = [], options: Record<string, string[]> = {}, switches = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const word = args[i];
    if (word === '--') { positional.push(...args.slice(i + 1)); break; }
    if (!word.startsWith('--')) { positional.push(word); continue; }
    const name = word.slice(2);
    if (optional.includes(name)) {
      if (switches.has(name)) throw new Error(`${word} 只能写一次，请删除重复参数。`);
      switches.add(name);
      if (args[i + 1] && !args[i + 1].startsWith('--')) options[name] = [args[++i]];
      continue;
    }
    if (flags.includes(name)) { switches.add(name); continue; }
    if (!values.includes(name)) throw new Error(`不认识参数 ${word}，请运行 xagents --help 查看用法。`);
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`${word} 后面缺少值，请补上后重试。`);
    if (options[name] && !repeated.includes(name)) throw new Error(`${word} 只能写一次，请删除重复参数。`);
    (options[name] ??= []).push(value);
  }
  return { positional, options, switches, one: (key: string) => options[key]?.[0] };
}
// 在终端里读一行而不回显（粘贴钥匙用）；不是终端时（比如从管道传进来）直接读完标准输入。
async function readSecret(question: string): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY) { let text = ''; for await (const chunk of input) text += chunk; return text; }
  process.stderr.write(question);
  input.setRawMode(true); input.resume(); input.setEncoding('utf8');
  try {
    return await new Promise<string>((done, fail) => {
      let text = '';
      const onData = (chunk: string) => {
        for (const ch of chunk) {
          if (ch === '\r' || ch === '\n') { input.off('data', onData); done(text); return; }
          if (ch === '\u0003') { input.off('data', onData); fail(new Error('已取消，没有保存。')); return; }
          if (ch === '\u007f' || ch === '\b') text = text.slice(0, -1); else text += ch;
        }
      };
      input.on('data', onData);
    });
  } finally { input.setRawMode(false); input.pause(); process.stderr.write('\n'); }
}
function arity(values: string[], min: number, max = min) {
  if (values.length < min || values.length > max) throw new Error('参数数量不对，请运行 xagents --help 查看用法。');
}
export async function main(args = process.argv.slice(2)): Promise<number> {
  try {
    await loadConfiguredRoster();
    const [cmd, ...rest] = args;
    if (!cmd || cmd === '--help' || cmd === 'help') { console.log(help()); return 0; }
    await ensureHome();
    if (cmd === 'intro') { arity(rest, 0); process.stdout.write(INTRO_TEXT); return 0; }
    if (cmd === 'connect') {
      const p = parse(rest, [], ['undo']);
      arity(p.positional, p.switches.has('undo') ? 1 : 0, 1);
      const ai = p.positional.length ? connectArgument(p.positional) : undefined;
      const statuses = ai ? await (p.switches.has('undo') ? disconnect(ai) : connect(ai)) : await connectStatus();
      for (const status of statuses.filter(s => !ai || s.ai === ai)) console.log(`${status.name}：${connectStateNames[status.state]}；${status.note}`);
      return 0;
    }
    if (cmd === 'login') {
      arity(rest, 1);
      if (rest[0] !== 'deepseek') throw new Error('目前只有 DeepSeek 需要这样登录：xagents login deepseek。其他几家用它们自己的程序登录。');
      const { loginDeepseek } = await import('../core/workers.ts');
      await loginDeepseek(await readSecret('请粘贴 DeepSeek 的 API 钥匙（屏幕上不显示），然后按回车：'));
      console.log('DeepSeek 已登录。钥匙由 Codex 存在派活工作台单独的文件夹里，你自己的 ChatGPT 登录不受影响。');
      return 0;
    }
    if (cmd === 'guide') {
      arity(rest, 0);
      // 只有这条命令用到手册和档案，用到时再加载，别的命令启动时不背这些模块。
      const { readGuide, guideAppendix } = await import('../core/guide.ts');
      const manual = await readGuide();
      await reconcileSafely(); // 和 status 一样先修正失联的任务，手头的活才数得准
      console.log(`${manual.trimEnd()}\n\n${await guideAppendix()}`);
      return 0;
    }
    // 02b：自检、验收、决定、统计的命令接入。
    if (cmd === 'selfcheck') {
      arity(rest, 0);
      const result = await selfcheck(); await reconcileSafely();
      console.log(`${result.ok ? '自检通过' : '自检没过'}：${result.note}`); return result.ok ? 0 : 1;
    }
    if (cmd === 'verify') {
      const p = parse(rest, ['skip']); arity(p.positional, 1);
      const skip = p.one('skip');
      if (skip !== undefined) { await skipVerify(p.positional[0], skip); await reconcileSafely(); console.log(`已记下不验收的理由：${p.positional[0]}`); return 0; }
      const result = await verify(p.positional[0]); await reconcileSafely();
      console.log(checkFor(result)?.label); for (const step of result.steps) console.log(`${step.cmd}：${step.summary}`); return result.ok ? 0 : 1;
    }
    if (cmd === 'real') {
      const p = parse(rest, ['note', 'shot', 'skip'], ['pass', 'fail'], ['shot']); arity(p.positional, 1);
      const skip = p.one('skip');
      if (Number(p.switches.has('pass')) + Number(p.switches.has('fail')) + Number(skip !== undefined) !== 1) throw new Error('请只选 --pass、--fail、--skip 其中一种。');
      if (skip !== undefined && (p.one('note') !== undefined || p.options.shot)) throw new Error('--skip 不能同时带 --note 或 --shot。');
      if (skip === undefined && p.one('note') === undefined) throw new Error('请用 --note 写明真实验收结果。');
      await recordRealCheck(p.positional[0], skip !== undefined ? { skip } : { ok: p.switches.has('pass'), note: p.one('note')!, shots: p.options.shot });
      console.log(`已记下真实验收：${p.positional[0]}（${skip !== undefined ? '不需要' : p.switches.has('pass') ? '通过' : '没过'}）`); return 0;
    }
    if (cmd === 'adopt' || cmd === 'drop') {
      const p = parse(rest, cmd === 'adopt' ? ['note', 'merged'] : ['note']); arity(p.positional, 1); console.log(await decisionMessage(await decide(p.positional[0], cmd, p.one('note'), 'lead', cmd === 'adopt' ? p.one('merged') : undefined))); await reconcileSafely(); return 0;
    }
    if (cmd === 'inbox') { arity(rest, 0); await inbox(); return 0; }
    if (cmd === 'handled') {
      const p = parse(rest); arity(p.positional, 1); await markHandled(p.positional[0]);
      await reconcileSafely(); console.log(`已记下照办完成：${p.positional[0]}`); return 0;
    }
    if (cmd === 'reply') {
      const p = parse(rest); arity(p.positional, 2); await addComment(p.positional[0], p.positional[1], 'lead');
      await reconcileSafely(); console.log(`已回复：${p.positional[0]}`); return 0;
    }
    if (cmd === 'stats') { arity(rest, 0); console.log(statsTable(stats(await listJobs(true)))); return 0; }
    if (cmd === 'rate') {
      const p = parse(rest, ['score', 'good', 'improve', 'tag', 'external'], [], ['tag']); arity(p.positional, 1);
      const score = p.one('score');
      if (score !== undefined && !/^[1-5]$/.test(score)) throw new Error('--score 只能填写 1–5 的整数。');
      await rate(p.positional[0], { score: score === undefined ? undefined : Number(score), good: p.one('good'), improve: p.one('improve'), tags: p.options.tag, external: p.one('external') });
      console.log(`已记下评价：${p.positional[0]}`); return 0;
    }
    if (cmd === 'report') {
      if (rest.length === 1 && rest[0] === '--help') { console.log(help()); return 0; }
      const p = parse(rest, ['range', 'project'], ['json']); arity(p.positional, 0);
      const value = p.one('range') ?? '7d', range = ranges.find(r => r === value);
      if (!range) throw new Error('--range 只能填写 today（今天）、7d（近 7 天）或 30d（近 30 天）。');
      const report = dashboard(await listJobs(), range, p.one('project') ?? '');
      console.log(p.switches.has('json') ? JSON.stringify(report, null, 2) : formatReport(report)); return 0;
    }
    if (cmd === 'profiles') {
      const p = parse(rest, [], ['json']); arity(p.positional, 0);
      const rows = profiles(await listJobs());
      console.log(p.switches.has('json') ? JSON.stringify(rows, null, 2) : profilesTable(rows)); return 0;
    }
    if (cmd === 'quota') {
      const p = parse(rest, [], ['json']); arity(p.positional, 0);
      const quota = await queryQuota();
      console.log(p.switches.has('json') ? JSON.stringify(quota, null, 2) : formatQuota(quota)); return 0;
    }
    if (cmd === 'models') {
      if (rest.length && (rest.length !== 1 || rest[0] !== 'refresh')) throw new Error('模型命令只支持 xagents models 或 xagents models refresh。');
      let cache = await readModelsCache();
      if (rest[0] === 'refresh') cache = await refreshModelsWithBaseline();
      else { const results = await queryModels(); console.log(formatModels(results)); cache = modelsCacheFrom(results, cache); }
      const { models } = await readSettings();
      console.log(formatDiscoveredModels(viewModels(models, cache)));
      return 0;
    }
    if (cmd === 'workers') {
      arity(rest, 0);
      const { workers, limits, networkAllowed } = await readSettings();
      console.log(table(['选手', '模型', '允许的强度', '快速版', '开关'], keptWhos.map(who => {
        const worker = workers[who], s = spec(who);
        return [`${s.name}（${who}）`, s.shown, worker.efforts.map(e => `${e}（${effortNames[e]}）`).join('、'), worker.fast ? '允许' : '未开放', worker.enabled ? '开启' : '关闭'];
      })));
      console.log(`派活限制：同时最多 ${limits.maxRunning} 件；${limits.quotaStop === null ? '额度不设停派线（主人在设置里关掉了）' : `额度用到 ${limits.quotaStop}% 停派`}（设置 → 选手与模型）`);
      console.log(`选手联网：${networkAllowed ? '开（打开后网络完全不限）' : '关'}（设置 → 联网）`);
      return 0;
    }
    if (cmd === 'project') {
      if (rest[0] === 'list') {
        arity(rest, 1);
        const { archivedProjects } = await readSettings();
        console.log(table(['名字', '仓库', '副本目录'], (await listProjects()).map(p => [`${p.name}${archivedProjects.includes(p.name) ? '（已归档）' : ''}`, p.repo, p.worktreeRoot]))); return 0;
      }
      if (rest[0] === 'check') {
        const p = parse(rest.slice(1), [], ['quick', 'json']); arity(p.positional, 1);
        const result = await checkProject(p.positional[0], { quick: p.switches.has('quick') });
        if (p.switches.has('json')) console.log(JSON.stringify({ ...result, baseline: (await loadProject(p.positional[0])).baseline }, null, 2));
        else console.log(formatCheck(result));
        return result.ok ? 0 : 1;
      }
      if (rest[0] === 'archive' || rest[0] === 'unarchive') {
        arity(rest, 2); const archived = await setArchived(rest[1], rest[0] === 'archive');
        console.log(archived ? `已归档 ${rest[1]}：看板已完成列和历史页“全部”不再显示它，记录和打分都留着；要再派活先 xagents project unarchive ${rest[1]}。` : `已取消归档 ${rest[1]}。`); return 0;
      }
      if (rest[0] === 'label') {
        arity(rest, 3); console.log(`已把 ${rest[1]} 的显示名改成：${await setProjectLabel(rest[1], rest[2])}`); return 0;
      }
      if (rest[0] !== 'add') throw new Error('项目命令只支持 add、list、check、label、archive 和 unarchive，请运行 xagents --help。');
      const p = parse(rest.slice(1), ['label', 'worktree-root', 'setup', 'verify', 'deny-read', 'rules'], [], ['setup', 'verify', 'deny-read']);
      arity(p.positional, 2);
      const project = await addProject(p.positional[0], p.positional[1], { worktreeRoot: p.one('worktree-root'), setup: p.options.setup, verify: p.options.verify, denyReadExtra: p.options['deny-read'], rules: p.one('rules'), label: p.one('label') });
      console.log(`已登记项目 ${project.name}：${project.repo}`);
      // 登记成功后顺手做一次快速体检；完整体检要装依赖、跑测试，另外运行。
      try { console.log(`\n接入体检（快速）：\n${formatCheck(await checkProject(project.name, { quick: true }))}\n完整体检会装依赖、跑验收，比较久，需要时另外运行：xagents project check ${project.name}`); }
      catch (e) { console.log(`\n接入体检没跑成：${(e as Error).message}\n可以稍后运行：xagents project check ${project.name} --quick`); }
      return 0;
    }
    if (cmd === 'chat') {
      if (rest.length === 1 && rest[0] === '--help') { console.log(help()); return 0; }
      if (rest[0] === 'new') {
        const p = parse(rest.slice(1), ['member', 'title', 'hops'], [], ['member']); arity(p.positional, 1);
        const hops = p.one('hops');
        if (hops !== undefined && !/^[1-9][0-9]*$/.test(hops)) throw new Error('--hops 必须是正整数。');
        await chatNew({ project: p.positional[0], members: p.options.member ?? [], title: p.one('title'), hopLimit: hops === undefined ? undefined : Number(hops) }); return 0;
      }
      if (rest[0] === 'list') { arity(rest, 1); await chatList(); return 0; }
      if (rest[0] === 'log') {
        const p = parse(rest.slice(1), [], ['all']); arity(p.positional, 1);
        await chatLog(p.positional[0], p.switches.has('all')); return 0;
      }
      if (rest[0] === 'say') { arity(rest, 3); await chatSay(rest[1], rest[2]); return 0; }
      if (rest[0] === 'stop' || rest[0] === 'close' || rest[0] === 'clean') { arity(rest, 2); await chatControl(rest[0], rest[1]); return 0; }
      if (rest[0] === 'wait') { arity(rest, 2); return chatWait(rest[1]); }
      throw new Error('chat 命令只支持 new、list、log、say、stop、close、clean 和 wait，请运行 xagents --help。');
    }
    if (cmd === 'team') {
      if (rest.length === 1 && rest[0] === '--help') { console.log(help()); return 0; }
      if (!rest.length) throw new Error('team 命令只支持 start、status、log、say、round 和 stop，请运行 xagents --help。');
      if (rest[0] === 'start') {
        const p = parse(rest.slice(1), ['writer', 'reviewer', 'summary', 'project', 'base', 'kind', 'title', 'rounds', 'minutes'], ['force', 'dirty-ok'], [], ['real']);
        arity(p.positional, 1);
        if (!p.one('writer')) throw new Error('请用 --writer 写清写手：选手:强度[:fast]。');
        if (!p.one('reviewer')) throw new Error('请用 --reviewer 写清审查：选手:强度[:fast]。');
        if (!p.one('summary')) throw new Error('请用 --summary 写一两句给主人看的“要做什么”。');
        const kind = p.one('kind');
        if (kind !== undefined && kind !== '实现' && kind !== '修复') throw new Error('--kind 只允许实现或修复。');
        const rounds = p.one('rounds');
        if (rounds !== undefined && !/^[1-5]$/.test(rounds)) throw new Error('--rounds 只能填写 1–5 的整数。');
        const minutes = p.one('minutes');
        if (minutes !== undefined && !/^(10|1[1-9]|[2-9][0-9]|1[0-9][0-9]|2[0-3][0-9]|240)$/.test(minutes)) throw new Error('--minutes 只能填写 10–240 的整数。');
        await teamStart(p.positional[0], {
          writer: p.one('writer')!, reviewer: p.one('reviewer')!, summary: p.one('summary')!,
          project: p.one('project'), base: p.one('base'), kind, title: p.one('title'),
          rounds: rounds === undefined ? undefined : Number(rounds),
          minutes: minutes === undefined ? undefined : Number(minutes),
          force: p.switches.has('force'), dirtyOk: p.switches.has('dirty-ok'),
          real: p.one('real') ?? (p.switches.has('real') ? true : undefined),
        });
        return 0;
      }
      if (rest[0] === 'status') { arity(rest, 1, 2); await teamStatus(rest[1]); return 0; }
      if (rest[0] === 'log') {
        const p = parse(rest.slice(1), [], ['all']); arity(p.positional, 1);
        await teamLog(p.positional[0], p.switches.has('all')); return 0;
      }
      if (rest[0] === 'say') { arity(rest, 3); await teamSay(rest[1], rest[2]); return 0; }
      if (rest[0] === 'round') {
        const p = parse(rest.slice(1), ['note']); arity(p.positional, 1);
        await teamRound(p.positional[0], p.one('note')); return 0;
      }
      if (rest[0] === 'stop') { arity(rest, 2); await teamStop(rest[1]); return 0; }
      throw new Error('team 命令只支持 start、status、log、say、round 和 stop，请运行 xagents --help。');
    }
    if (cmd === 'run') {
      const p = parse(rest, ['who', 'kind', 'title', 'summary', 'project', 'base'], ['ro', 'force', 'dirty-ok'], ['who'], ['real']); arity(p.positional, 1);
      const jobs = await dispatch(p.positional[0], { who: p.options.who || [], summary: p.one('summary'), kind: p.one('kind'), title: p.one('title'), project: p.one('project'), base: p.one('base'), ro: p.switches.has('ro'), force: p.switches.has('force'), dirtyOk: p.switches.has('dirty-ok'), real: p.one('real') ?? (p.switches.has('real') ? true : undefined) });
      console.log(table(['任务号', '选手', '副本位置'], jobs.map(j => [j.id, j.who, j.worktree])));
      for (const j of jobs) if (j.network === true && j.state !== 'failed') {
        console.log(`${j.id}：这件能联网`);
      }
      console.log(`批号：${jobs[0].batch}\n用 xagents status 或 xagents wait ${jobs[0].batch} 查看进度。`);
      for (const j of jobs) if (j.error) console.error(`${j.id}：${j.error}`);
      return jobs.some(j => j.state === 'failed') ? 1 : 0;
    }
    if (cmd === '__run') { arity(rest, 1); await runWorker(rest[0]); return 0; }
    if (cmd === 'status') { const p = parse(rest, [], ['all']); arity(p.positional, 0, 1); await status(p.positional[0], p.switches.has('all')); return 0; }
    if (['wait', 'collect', 'stop'].includes(cmd)) {
      const p = parse(rest); arity(p.positional, 1);
      if (cmd === 'wait') return await wait(p.positional[0]);
      if (cmd === 'collect') await collect(p.positional[0]); else await stop(p.positional[0]); return 0;
    }
    if (cmd === 'clean') {
      const p = parse(rest, [], ['done']); arity(p.positional, p.switches.has('done') ? 0 : 1);
      await clean(p.positional[0], p.switches.has('done')); return 0;
    }
    if (cmd === 'slim') {
      if (rest.length === 1 && rest[0] === '--help') { console.log(help()); return 0; }
      const p = parse(rest, [], ['dry-run', 'force']); arity(p.positional, 0);
      const dryRun = p.switches.has('dry-run');
      const result = await slimOld({ dryRun, force: p.switches.has('force') });
      console.log(`${dryRun ? '会清理' : '已清理'} ${result.jobs.length} 件任务的旧日志，${dryRun ? '可腾出' : '腾出'} ${megabytes(result.bytes)}${dryRun ? '（仅预览，文件未移动）' : '（已移到废纸篓）'}。`);
      return 0;
    }
    throw new Error(`不认识的命令 ${cmd}，请运行 xagents --help 查看用法。`);
  } catch (e) {
    console.error(`出错：${hasCode(e, 'ENOENT') ? `文件或程序不存在：${(e as Error).message}。请检查路径和项目登记。` : (e as Error).message}`);
    return 1;
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await main();
