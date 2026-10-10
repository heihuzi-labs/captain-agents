import type { ReactNode } from 'react';

// 简化的 Markdown 排版（docs/ui-spec.md 第 3 节）：选手的汇报常带 `代码`、**加粗**、列表、标题和代码块，照样子排出来。
// 只认这几样，其余原样当文字；全部用 React 元素拼，**不当网页代码插入**：<b>、链接、图片写法都只是文字。
type Block =
  | { type: 'p'; lines: string[] }
  | { type: 'h'; text: string }
  | { type: 'code'; text: string }
  | { type: 'ul'; items: { text: string; depth: number }[] }
  | { type: 'ol'; items: { text: string; n: number }[] };
const HEAD = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/, BULLET = /^(\s*)[-*+•]\s+(.*)$/, ORDERED = /^\s*(\d{1,3})(?:[.)]\s+|、\s*)(.*)$/, FENCE = /^\s{0,3}(```|~~~)/;
export function parseBlocks(text: string): Block[] {
  const out: Block[] = [], lines = text.replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE.test(line)) {
      // 代码块：到下一个围栏为止；没有收尾（比如折起时被截断）就到末尾。
      const body: string[] = [];
      for (i++; i < lines.length && !FENCE.test(lines[i]); i++) body.push(lines[i]);
      out.push({ type: 'code', text: body.join('\n') });
      continue;
    }
    if (!line.trim()) continue;
    const head = HEAD.exec(line), bullet = BULLET.exec(line), ordered = ORDERED.exec(line), last = out.at(-1), follows = i > 0 && !!lines[i - 1].trim();
    if (head) out.push({ type: 'h', text: head[1] });
    else if (bullet) {
      const item = { text: bullet[2], depth: Math.min(2, Math.floor(bullet[1].replace(/\t/g, '  ').length / 2)) };
      if (last?.type === 'ul' && follows) last.items.push(item); else out.push({ type: 'ul', items: [item] });
    } else if (ordered) {
      const item = { text: ordered[2], n: Number(ordered[1]) };
      if (last?.type === 'ol' && follows) last.items.push(item); else out.push({ type: 'ol', items: [item] });
    } else if (last?.type === 'p' && follows) last.lines.push(line);
    else if ((last?.type === 'ul' || last?.type === 'ol') && follows && /^\s+\S/.test(line)) last.items[last.items.length - 1].text += '\n' + line.trim();  // 列表项的续行
    else out.push({ type: 'p', lines: [line] });
  }
  return out;
}
// 行内：`代码` 和 **加粗**（或 __加粗__）；其余文字交给 decorate（比如给 @名字 上色），没有就原样。
const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+?\*\*|__[^_\n]+?__)/g;
function inline(text: string, decorate: ((text: string) => ReactNode) | undefined, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0, n = 0;
  const plain = (s: string) => { if (s) out.push(<span key={`${key}-${n++}`}>{decorate ? decorate(s) : s}</span>); };
  for (const m of text.matchAll(INLINE)) {
    plain(text.slice(last, m.index));
    if (m[1]) out.push(<code key={`${key}-${n++}`}>{m[1].slice(1, -1)}</code>);
    else out.push(<strong key={`${key}-${n++}`}>{decorate ? decorate(m[2].slice(2, -2)) : m[2].slice(2, -2)}</strong>);
    last = m.index + m[0].length;
  }
  plain(text.slice(last));
  return out;
}
export function RichText({ text, decorate, className }: { text: string; decorate?: (text: string) => ReactNode; className?: string }) {
  return <div className={'rich' + (className ? ' ' + className : '')}>{parseBlocks(text).map((b, i) => {
    if (b.type === 'h') return <p key={i} className="rich-h">{inline(b.text, decorate, `h${i}`)}</p>;
    if (b.type === 'code') return <pre key={i}><code>{b.text}</code></pre>;
    if (b.type === 'ul') return <ul key={i}>{b.items.map((item, j) => <li key={j} data-depth={item.depth || undefined}>{inline(item.text, decorate, `u${i}-${j}`)}</li>)}</ul>;
    if (b.type === 'ol') return <ol key={i}>{b.items.map((item, j) => <li key={j} value={item.n}>{inline(item.text, decorate, `o${i}-${j}`)}</li>)}</ol>;
    return <p key={i}>{b.lines.map((line, j) => <span key={j}>{inline(line, decorate, `p${i}-${j}`)}{j < b.lines.length - 1 ? '\n' : ''}</span>)}</p>;
  })}</div>;
}
