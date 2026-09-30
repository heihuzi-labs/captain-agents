import { useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { ViewJob } from '../../../src/core/view-types.ts';
import { errorReason } from '../lib/errors.ts';
import { awaitingReply, fmtTime } from '../lib/board.ts';
import { Button, Section } from '../ui/index.ts';

export const COMMENT_MAX = 500;
// 给负责人留言：往来留言按时间排列，下面是输入框；⌘ 回车也能发送。
export function Comments({ job }: { job: ViewJob }) {
  const [text, setText] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const sending = useRef(false);
  const clean = text.trim(), length = [...clean].length, tooLong = length > COMMENT_MAX;
  const send = async () => {
    if (sending.current || !clean || tooLong) return;
    sending.current = true; setBusy(true); setError('');
    try { await window.xa.comment(job.id, clean); setText(''); }
    catch (e) { setError('没能发出：' + errorReason(e)); }
    finally { sending.current = false; setBusy(false); }
  };
  const key = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); }
  };
  return <Section title="给负责人留言">
    {job.comments.length > 0 && <ol className="comments">{job.comments.map((c, i) => <li key={i} className={'comment comment-' + c.by}>
      <p>{c.by === 'lead' && <b>负责人：</b>}{c.text}</p><time>{fmtTime(c.at, true)}</time>
    </li>)}</ol>}
    {awaitingReply(job) && <p className="faint comment-wait">负责人还没回复</p>}
    <textarea className="field" aria-label="给负责人的留言" rows={3} value={text} placeholder="写给负责人的话，⌘ 回车发送" onChange={e => setText(e.target.value)} onKeyDown={key} />
    <div className="comment-bar">
      {tooLong ? <span className="over-limit">超出 {length - COMMENT_MAX} 字</span> : <span className="faint">最多 {COMMENT_MAX} 字</span>}
      <Button variant="primary" disabled={busy || !clean || tooLong} onClick={() => void send()}>发送</Button>
    </div>
    {error && <p role="alert">{error}</p>}
  </Section>;
}
