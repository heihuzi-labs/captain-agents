import { open } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { hasCode } from './fsx.ts';
import type { Activity, Who, Usage, Timing } from './job.ts';
import { isolationOf } from './roster.ts';
import type { Isolation } from './roster.ts';
import { sleptSeconds } from './duration.ts';
import type { Sleep } from './duration.ts';

const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const text = (v: unknown): string => typeof v === 'string' ? v : '';
const count = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;

// 只去掉最外层 shell 引号，不执行或重新解释命令。
export function unwrapCommand(command: string) {
  const match = /^\/bin\/bash\s+-lc\s+([\s\S]*)$/.exec(command);
  if (!match) return command;
  const raw = match[1];
  let quote = '', result = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === quote) { quote = ''; continue; }
    if (!quote && (c === "'" || c === '"')) { quote = c; continue; }
    if (c === '\\' && quote !== "'" && i + 1 < raw.length && (!quote || /["\\$`\n]/.test(raw[i + 1]))) {
      const next = raw[++i]; if (next !== '\n') result += next;
    } else result += c;
  }
  return result;
}

export class StreamParser {
  who: Who;
  worktree: string;
  activity: Activity[] = [];
  usage?: Usage;
  revision = 0;
  private pending = '';
  private allText = '';
  private tailText = '';
  private say = '';
  private fallback = '';
  private tools = new Map<string, { from: number; to?: number }>();

  // 输出格式跟着隔离走（同一家命令行的几位选手格式一样），不按选手名写死。
  format: Isolation;
  constructor(who: Who, worktree = '') { this.who = who; this.format = isolationOf(who); this.worktree = worktree ? resolve(worktree) : ''; }
  private path(value: unknown) {
    const s = text(value);
    return s && this.worktree && isAbsolute(s) ? relative(this.worktree, s) || '.' : s;
  }
  private input(value: unknown) {
    const args = object(value);
    const paths = ['file_path', 'path', 'target_file', 'directory', 'search_path', 'absolutePath'].map(k => this.path(args[k])).filter(Boolean);
    const searches = ['pattern', 'query', 'search_term', 'searchTerm', 'globPattern', 'searchPattern', 'regex', 'url'].map(k => text(args[k])).filter(Boolean);
    return [...new Set([...paths, ...searches])].join('、');
  }
  private add(kind: Activity['kind'], value: string, at: string) {
    let s = value;
    if (this.worktree) {
      s = s.replaceAll(this.worktree + '/', '');
      const root = this.worktree.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      s = s.replace(new RegExp(root + '(?=$|[\\s\'"`,;:)\\]])', 'g'), '.');
    }
    s = Array.from(s.replace(/\s+/gu, ' ').trim()).slice(0, 200).join('');
    if (!s) return;
    this.activity.push({ at, kind, text: s });
    this.activity = this.activity.slice(-50);
    this.revision++;
  }
  private flushSay(at: string) { this.add('say', this.say, at); this.say = ''; }
  private tool(id: unknown, ended: boolean, at: string, completedOnly = false) {
    const key = text(id), now = Date.parse(at);
    if (!key || !Number.isFinite(now)) return;
    const span = this.tools.get(key);
    if (!span) {
      if (ended && !completedOnly) return;
      this.tools.set(key, { from: now, ...(ended ? { to: now } : {}) });
      this.revision++;
    } else if (ended && span.to === undefined) {
      span.to = Math.max(span.from, now); this.revision++;
    }
  }
  timing(sleeps: Sleep[] | undefined, at: string): Timing {
    const now = Date.parse(at);
    const spans = [...this.tools.values()].map(s => [s.from, s.to ?? now] as const)
      .filter(([from, to]) => Number.isFinite(to) && to > from).sort((a, b) => a[0] - b[0]);
    let seconds = 0, edge = -Infinity;
    for (const [start, end] of spans) {
      const from = Math.max(start, edge);
      if (end > from) seconds += (end - from) / 1000 - sleptSeconds(sleeps, from, end);
      edge = Math.max(edge, end);
    }
    return { steps: this.tools.size, toolSeconds: Math.max(0, Math.round(seconds)) };
  }
  private row(value: unknown, at: string) {
    const row = object(value), item = object(row.item);
    if (this.format === 'codex') {
      if ((item.type === 'command_execution' || item.type === 'file_change') && (row.type === 'item.started' || row.type === 'item.completed')) {
        this.tool(item.id, row.type === 'item.completed', at, true);
      }
      if (row.type === 'item.started' && item.type === 'command_execution') this.add('cmd', unwrapCommand(text(item.command)), at);
      if (row.type === 'item.completed' && item.type === 'file_change' && Array.isArray(item.changes)) this.add('edit', item.changes.map((c: unknown) => this.path(object(c).path)).filter(Boolean).join('、'), at);
      if (row.type === 'item.completed' && item.type === 'agent_message') this.add('say', text(item.text), at);
      if (row.type === 'turn.completed' && row.usage) {
        const u = object(row.usage);
        this.usage = { read: count(u.input_tokens), cached: count(u.cached_input_tokens), out: count(u.output_tokens) }; this.revision++;
      }
    } else if (this.format === 'grok') {
      if (row.type === 'tool_call') this.tool(row.toolCallId, false, at);
      if (row.type === 'tool_call_update' && (row.status === 'completed' || row.status === 'failed')) this.tool(row.toolCallId, true, at);
      if (row.type === 'text') { const s = text(row.data); this.say += s; this.allText += s; this.tailText += s; }
      if (row.type === 'tool_call') {
        this.flushSay(at); this.tailText = '';
        const args = object(row.rawInput);
        if (row.kind === 'execute') this.add('cmd', text(args.command), at);
        else if (row.kind === 'edit') this.add('edit', this.path(args.file_path) || this.path(args.path) || this.path(args.target_file), at);
        else this.add('read', this.input(args) || text(row.title), at);
      }
      if (row.type === 'end') {
        this.flushSay(at);
        if (row.usage) {
          const u = object(row.usage);
          this.usage = { read: count(u.input_tokens) + count(u.cache_read_input_tokens), cached: count(u.cache_read_input_tokens), out: count(u.output_tokens) }; this.revision++;
        }
      }
    } else {
      if (row.type === 'tool_call') {
        if (row.subtype === 'started' || row.subtype === 'completed') this.tool(row.call_id, row.subtype === 'completed', at);
        this.tailText = '';
        if (row.subtype === 'started') {
          const entry = Object.entries(object(row.tool_call)).find(([k]) => k.endsWith('ToolCall'));
          if (entry) {
            const [name, call] = entry, args = object(object(call).args);
            if (name === 'shellToolCall') this.add('cmd', text(args.command), at);
            else if (name === 'editToolCall') this.add('edit', this.path(args.path), at);
            else this.add('read', this.input(args) || text(object(call).description) || name, at);
          }
        }
      }
      if (row.type === 'assistant') {
        const content = object(row.message).content;
        const s = Array.isArray(content) ? content.map(c => text(object(c).text)).join('') : '';
        this.tailText += s; this.add('say', s, at);
      }
      if (row.type === 'result') {
        this.fallback = text(row.result);
        if (row.usage) {
          const u = object(row.usage);
          this.usage = { read: count(u.inputTokens) + count(u.cacheReadTokens) + count(u.cacheWriteTokens), cached: count(u.cacheReadTokens), cacheWrite: count(u.cacheWriteTokens), out: count(u.outputTokens) }; this.revision++;
        }
      }
    }
  }
  private line(line: string, at: string) {
    let value;
    try { value = JSON.parse(line); } catch { return; }
    this.row(value, at);
  }
  feed(chunk: string, at = new Date().toISOString()) {
    this.pending += chunk;
    let end: number;
    while ((end = this.pending.indexOf('\n')) >= 0) {
      this.line(this.pending.slice(0, end), at);
      this.pending = this.pending.slice(end + 1);
    }
  }
  finish(at = new Date().toISOString()) {
    // EOF 可以没有换行；只有完整 JSON 才会解析，截断的半行继续保留。
    if (this.pending.trim()) {
      try { const value = JSON.parse(this.pending); this.pending = ''; this.row(value, at); } catch { /* 尚未写完。 */ }
    }
    if (this.format === 'grok') this.flushSay(at);
    for (const [id, span] of this.tools) if (span.to === undefined) this.tool(id, true, at);
  }
  result(final = '') {
    const report = this.format === 'codex' ? final : this.format === 'grok' ? (this.tailText.trim() ? this.tailText : this.allText) : (this.tailText.trim() ? this.tailText : this.fallback);
    return { report: report.trim(), usage: this.usage, activity: this.activity.slice(), lastActivityAt: this.activity.at(-1)?.at };
  }
}

// 按字节偏移读新内容，UTF-8 字符也允许跨两次文件写入。
export class LogTail {
  offset = 0;
  private decoder = new StringDecoder('utf8');
  async read(file: string, parser: StreamParser, at = new Date().toISOString()) {
    let fd;
    try { fd = await open(file, 'r'); } catch (e) { if (hasCode(e, 'ENOENT')) return; throw e; }
    try {
      const size = (await fd.stat()).size;
      const buffer = Buffer.alloc(64 * 1024);
      while (this.offset < size) {
        const { bytesRead } = await fd.read(buffer, 0, Math.min(buffer.length, size - this.offset), this.offset);
        if (!bytesRead) break;
        this.offset += bytesRead;
        parser.feed(this.decoder.write(buffer.subarray(0, bytesRead)), at);
      }
    } finally { await fd.close(); }
  }
}
