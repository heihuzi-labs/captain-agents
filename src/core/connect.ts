// 接入设计见 docs/design-connect.md。只读写规矩文件，不读登录或配置内容。
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { CONNECT_AIS, LEAD_RULE, isConnectAi } from './intro.ts';
import type { ConnectAi, ConnectState, ConnectStatus } from './intro.ts';
import { hasCode, writeAtomic } from './fsx.ts';
import { copyToTrash, moveToTrash } from './trash.ts';

export type ConnectOptions = { home?: string };
export const connectStateNames: Record<ConnectState, string> = {
  on: '已接入', outdated: '内容不是最新', off: '还没接入', missing: '没装', broken: '要看一眼',
};
const names = { claude: 'Claude', codex: 'Codex', grok: 'Grok', cursor: 'Cursor', dsh: 'DeepSeek Harness' };
// 和主人的内容同在一个文件里的几家（Codex、DeepSeek Harness）：只写起止标记之间那一段。
type BlockAi = 'codex' | 'dsh';
const isBlock = (ai: ConnectAi): ai is BlockAi => ai === 'codex' || ai === 'dsh';
const beginOf = (ai: BlockAi) => `<!-- xagents:begin（派活工作台写入，用 xagents connect ${ai} --undo 撤下） -->`;
// 不另存登记文件：在开始行里记住补过末尾换行，撤下才能逐字节恢复。
const noNewlineBeginOf = (ai: BlockAi) => beginOf(ai).replace(' -->', ' 原文末尾无换行 -->');
const end = '<!-- xagents:end -->';
// 每家写哪个文件（Grok 和 Claude 共用一份）。Cursor 的规矩目录是 2026-09-30 实测的：命令行从项目目录一路往上找 .cursor/rules，
// 所以只对家目录下的项目生效；编辑器里没实测。DeepSeek Harness 的全局规矩文件名写死是 ~/.dsh/AGENTS.md（没有规矩目录），
// 每次开会话和压缩之后都会放回对话（官方源码 packages/context/agent-instructions，见 docs/research/connect-dsh-2026-10-02.md）。
const files = { claude: '.claude/rules/xagents.md', grok: '.claude/rules/xagents.md', codex: '.codex/AGENTS.md', cursor: '.cursor/rules/xagents.mdc', dsh: '.dsh/AGENTS.md' };
const shownFile = (ai: ConnectAi) => `~/${files[ai]}`;
const target = (home: string, ai: ConnectAi) => join(home, files[ai]);
// 整份文件都是我们写的那几家（Claude、Cursor）：文件内容。Cursor 的 .mdc 要带“总是生效”的头。
const whole = (ai: 'claude' | 'cursor') => ai === 'cursor' ? `---\ndescription: 派活工作台：把活交给别的 AI 时一律用 xagents\nalwaysApply: true\n---\n${LEAD_RULE}\n` : LEAD_RULE + '\n';
const changed = (file: string) => new Error(`${file}：文件刚被改过，请再试一次。`);

async function info(path: string) {
  try { return await fs.lstat(path); }
  catch (error) { if (hasCode(error, 'ENOENT')) return null; throw error; }
}
async function directory(path: string) {
  const stat = await info(path);
  if (stat?.isSymbolicLink()) throw new Error(`${path} 是符号链接，不能替换主人的设置，请手动处理。`);
  if (stat && !stat.isDirectory()) throw new Error(`${path} 不是普通目录，请手动处理。`);
  return stat;
}
async function checkPath(home: string, ai: ConnectAi) {
  await directory(join(home, `.${ai}`));
  if (ai === 'claude' || ai === 'cursor') await directory(join(home, `.${ai}/rules`));
  if (ai === 'codex' && await info(join(home, '.codex/AGENTS.override.md'))) {
    throw new Error('你用了 AGENTS.override.md，Codex 不读 AGENTS.md，请手动处理');
  }
}
type Snapshot = { bytes: Buffer; mode: number; ino: number; dev: number } | null;
async function read(file: string): Promise<Snapshot> {
  const stat = await info(file);
  if (!stat) return null;
  if (stat.isSymbolicLink()) throw new Error(`${file} 是符号链接，不能替换主人的设置，请手动处理。`);
  if (!stat.isFile()) throw new Error(`${file} 不是普通文件，请手动处理。`);
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const current = await handle.stat();
    if (current.ino !== stat.ino || current.dev !== stat.dev) throw changed(file);
    return { bytes: await handle.readFile(), mode: current.mode & 0o7777, ino: current.ino, dev: current.dev };
  } finally { await handle.close(); }
}

type Block = { start: number; body: number; endStart: number; finish: number; noNewline: boolean; current: boolean; eol: string };
function parse(bytes: Buffer, ai: BlockAi): { state: 'on' | 'off' | 'outdated' | 'broken'; block?: Block; note?: string } {
  // latin1 的每个字符对应一个字节，切片不会重编码主人的其他内容。
  const lines = [...bytes.toString('latin1').matchAll(/[^\n]*(?:\n|$)/g)].filter(m => m[0]);
  const starts = lines.filter(m => m[0].startsWith('<!-- xagents:begin'));
  const ends = lines.filter(m => m[0].replace(/\r?\n$/, '') === end);
  if (!starts.length && !ends.length) return { state: 'off' };
  if (starts.length !== 1 || ends.length !== 1) return { state: 'broken', note: '派活工作台标记不成对或有多对，请手动检查开始和结束行' };
  const a = starts[0], b = ends[0];
  if (a.index! >= b.index!) return { state: 'broken', note: '派活工作台标记顺序反了，请把开始行放在结束行前面' };
  // 开始行里的名字改过（2026-09-30 派活台 → 派活工作台）：“原文末尾无换行”只看这个记号本身，
  // 开始行不是现在的写法就算“不是最新”，再接入时连开始行一起换掉，撤下照样逐字节还原。
  const line = Buffer.from(a[0], 'latin1').toString('utf8'), marker = line.replace(/\r?\n$/, '');
  const noNewline = marker.endsWith(' 原文末尾无换行 -->');
  const block = { start: a.index!, body: a.index! + a[0].length, endStart: b.index!, finish: b.index! + b[0].length,
    noNewline, current: marker === (noNewline ? noNewlineBeginOf(ai) : beginOf(ai)), eol: line.slice(marker.length) || '\n' };
  const body = bytes.subarray(block.body, block.endStart).toString('utf8').replace(/^[\r\n]+|[\r\n]+$/g, '');
  return { state: body === LEAD_RULE && block.current ? 'on' : 'outdated', block };
}
// 写在小字里的提醒：Cursor 只对家目录下的项目生效；DeepSeek Harness 默认的沙箱不让命令写项目外面，跑 xagents 要主人点批准。
const onlyHome = (ai: ConnectAi) => ai === 'cursor' ? '（只对家目录下的项目生效）' : ai === 'dsh' ? '（它跑 xagents 时要你点批准）' : '';
async function inspect(home: string, ai: Exclude<ConnectAi, 'grok'>): Promise<{ status: ConnectStatus; snapshot: Snapshot; block?: Block }> {
  const status: ConnectStatus = { ai, name: names[ai], state: 'off', note: `会写进 ${shownFile(ai)}${isBlock(ai) ? ' 末尾' : ''}${onlyHome(ai)}`, files: [shownFile(ai)] };
  try {
    if (!await directory(join(home, `.${ai}`))) return { status: { ...status, state: 'missing', note: `这台电脑上没找到 ${names[ai]}` }, snapshot: null };
    await checkPath(home, ai);
    const snapshot = await read(target(home, ai));
    const parsed = isBlock(ai) ? parse(snapshot?.bytes ?? Buffer.alloc(0), ai)
      : { state: !snapshot ? 'off' as const : snapshot.bytes.equals(Buffer.from(whole(ai))) ? 'on' as const : 'outdated' as const };
    status.state = parsed.state;
    if (parsed.state === 'on') status.note = `写在 ${shownFile(ai)}${onlyHome(ai)}`;
    if (parsed.state === 'outdated') status.note = '内容不是最新的，再接入一次就更新';
    if ('note' in parsed && parsed.note) status.note = `${shownFile(ai)}：${parsed.note}`;
    return { status, snapshot, block: 'block' in parsed ? parsed.block : undefined };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code) throw new Error(`读不了 ${shownFile(ai)}：${(error as Error).message}。请检查文件和目录权限后重试。`, { cause: error });
    return { status: { ...status, state: 'broken', note: `${shownFile(ai)}：${error instanceof Error ? error.message : String(error)}` }, snapshot: null };
  }
}

export async function connectStatus(options?: ConnectOptions): Promise<ConnectStatus[]> {
  const home = options?.home ?? homedir();
  const claude = (await inspect(home, 'claude')).status;
  const codex = (await inspect(home, 'codex')).status;
  const grok: ConnectStatus = { ai: 'grok', name: names.grok, state: await info(join(home, '.grok')) ? claude.state : 'missing',
    note: '和 Claude 共用一份规矩', files: [shownFile('grok')], sharedWith: 'claude' };
  const cursor = (await inspect(home, 'cursor')).status;
  const dsh = (await inspect(home, 'dsh')).status;
  return [claude, codex, grok, cursor, dsh];
}

// 主进程只收一个白名单名字；放在可独立测试的核心里，避免测试启动 Electron。
export function connectArgument(args: unknown[]): ConnectAi {
  if (args.length !== 1 || !isConnectAi(args[0])) throw new Error(`接入或撤下只收一个 AI 名字，可选：${CONNECT_AIS.join('、')}。`);
  return args[0];
}
async function assertUnchanged(home: string, ai: ConnectAi, before: Snapshot) {
  await checkPath(home, ai);
  if (!await directory(join(home, `.${ai}`))) throw changed(target(home, ai));
  const current = await read(target(home, ai));
  if (before === null ? current !== null : !current || !current.bytes.equals(before.bytes) || current.mode !== before.mode || current.ino !== before.ino || current.dev !== before.dev) throw changed(target(home, ai));
}
function removeBlock(bytes: Buffer, block: Block) {
  let start = block.start;
  // 旧格式（负责人已写入）只加一个空行；新格式无末尾换行时另补一个 LF。
  if (block.noNewline && bytes.subarray(Math.max(0, start - 2), start).equals(Buffer.from('\n\n'))) start -= 2;
  else if (start >= 2 && bytes[start - 1] === 10 && bytes[start - 2] === 10) start--;
  else if (start >= 3 && bytes[start - 1] === 10 && bytes[start - 2] === 13 && bytes[start - 3] === 10) start -= 2;
  return Buffer.concat([bytes.subarray(0, start), bytes.subarray(block.finish)]);
}
async function change(ai: ConnectAi, undo: boolean, options?: ConnectOptions): Promise<ConnectStatus[]> {
  if (!isConnectAi(ai)) throw new Error(`不认识 AI 名字，可选：${CONNECT_AIS.join('、')}。`);
  if (ai === 'grok') throw new Error('Grok 和 Claude 共用 ~/.claude/rules/xagents.md，请在 Claude 那一行接入或撤下（xagents connect claude）');
  const home = options?.home ?? homedir(), file = target(home, ai);
  const { status, snapshot, block } = await inspect(home, ai);
  if (status.state === 'broken' || status.state === 'missing') throw new Error(status.note);
  if ((!undo && status.state === 'on') || (undo && status.state === 'off')) return connectStatus(options);
  const bytes = snapshot?.bytes ?? Buffer.alloc(0);
  let next: Buffer;
  if (!isBlock(ai)) next = Buffer.from(undo ? '' : whole(ai));
  else if (undo) next = removeBlock(bytes, block!);
  else if (block) next = Buffer.concat([bytes.subarray(0, block.start), Buffer.from(`${block.noNewline ? noNewlineBeginOf(ai) : beginOf(ai)}${block.eol}${LEAD_RULE}\n`), bytes.subarray(block.endStart)]);
  else {
    const missingNewline = bytes.length > 0 && bytes[bytes.length - 1] !== 10;
    const separator = bytes.length ? missingNewline ? '\n\n' : '\n' : '';
    next = Buffer.concat([bytes, Buffer.from(`${separator}${missingNewline ? noNewlineBeginOf(ai) : beginOf(ai)}\n${LEAD_RULE}\n${end}\n`)]);
  }
  let backup: string | undefined;
  try {
    await assertUnchanged(home, ai, snapshot);
    const remove = undo && (!isBlock(ai) || !next.toString('utf8').trim());
    if (snapshot && !remove) backup = await copyToTrash([file], `接入备份-${ai}`);
    if (!isBlock(ai) && !undo) await fs.mkdir(dirname(file), { recursive: true });
    await assertUnchanged(home, ai, snapshot);
    if (remove) backup = await moveToTrash([file], `接入备份-${ai}`);
    else {
      await writeAtomic(file, next);
      if (snapshot) await fs.chmod(file, snapshot.mode);
    }
  } catch (error) {
    throw new Error(`${shownFile(ai)}：${error instanceof Error ? error.message : String(error)}${backup ? `；原文件备份在 ${backup}` : ''}。请检查文件后重试。`, { cause: error });
  }
  const statuses = await connectStatus(options);
  const result = statuses.find(s => s.ai === ai)!;
  // 界面这一行放不下完整路径：只写废纸篓里的文件夹名，够主人找到。
  result.note = `${undo ? '已撤下' : '已写入'} ${shownFile(ai)}${backup ? `；原文件在废纸篓的“${basename(backup)}”里` : ''}`;
  return statuses;
}
export async function connect(ai: ConnectAi, options?: ConnectOptions): Promise<ConnectStatus[]> { return change(ai, false, options); }
export async function disconnect(ai: ConnectAi, options?: ConnectOptions): Promise<ConnectStatus[]> { return change(ai, true, options); }
