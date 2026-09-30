import { useEffect, useState } from 'react';
import { INTRO_TEXT, LEAD_RULE } from '../../../src/core/intro.ts';
import type { ConnectAi, ConnectState, ConnectStatus } from '../../../src/core/intro.ts';
import { errorReason } from '../lib/errors.ts';
import { Button, Chip, ConfirmDialog, SettingGroup, SettingRow, WorkerIcon } from '../ui/index.ts';
import type { Tone } from '../ui/index.ts';

// 设置 → 接入 AI（docs/ui-spec.md 第 10 节）：上面一组“一键接入”四家，下面一组给其他 AI 的对接提示词。
// 状态全部来自桥上的 connectStatus()，窗口不自己判断文件；接入、撤下也只走桥。所有文字当纯文字显示。
const chips: Record<ConnectState, { tone: Tone; text: string }> = {
  on: { tone: 'ok', text: '已接入' }, outdated: { tone: 'warn', text: '不是最新' }, off: { tone: 'neutral', text: '还没接入' },
  missing: { tone: 'neutral', text: '没装' }, broken: { tone: 'bad', text: '要看一眼' },
};
const actionOf = (s: ConnectStatus): { label: string; kind: 'connect' | 'disconnect' } | null => {
  if (s.sharedWith) return null;
  if (s.state === 'on') return { label: '撤下', kind: 'disconnect' };
  if (s.state === 'off') return { label: '接入', kind: 'connect' };
  if (s.state === 'outdated') return { label: '更新', kind: 'connect' };
  return null;
};

export function IntroPane() {
  return <>
    <p className="intro-page-lead">接入后，这台电脑上的 AI 每次开会话、对话压缩之后，都会读到一段话：派活交给派活工作台，开工先读手册。</p>
    <ConnectGroup />
    <PromptGroup />
  </>;
}

function ConnectGroup() {
  const [list, setList] = useState<ConnectStatus[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<ConnectAi | null>(null);
  const [asking, setAsking] = useState<ConnectStatus | null>(null);
  useEffect(() => {
    let live = true;
    window.xa.connectStatus().then(value => { if (live) setList(value); }).catch(e => { if (live) setLoadError(errorReason(e)); });
    return () => { live = false; };
  }, []);
  const run = (status: ConnectStatus, kind: 'connect' | 'disconnect') => {
    setAsking(null); setBusy(status.ai); setError('');
    // 核心在这一家的 note 里写明改了哪个文件、原文件备份在哪，界面照原样显示。
    window.xa[kind](status.ai).then(setList).catch(e => setError((kind === 'connect' ? '没能接入：' : '没能撤下：') + errorReason(e))).finally(() => setBusy(null));
  };
  const click = (status: ConnectStatus, kind: 'connect' | 'disconnect') => kind === 'connect' ? setAsking(status) : run(status, kind);
  return <>
    {error && <p className="notice notice-bad" role="alert">{error}</p>}
    <SettingGroup head="一键接入">
      {loadError ? <p className="setting-row muted">读不出接入状态：{loadError}</p>
        : !list ? <p className="setting-row faint">正在读取…</p>
          : list.map(s => {
            const action = actionOf(s), chip = chips[s.state];
            return <SettingRow key={s.ai} group title={s.name} note={s.note} dim={s.state === 'missing'} icon={<WorkerIcon name={s.ai} size="md" />}>
              <span className="connect-end">
                <Chip tone={chip.tone}>{chip.text}</Chip>
                {action && <Button size="sm" variant={action.kind === 'connect' ? 'primary' : 'secondary'} disabled={busy !== null} onClick={() => click(s, action.kind)}>{action.label}</Button>}
              </span>
            </SettingRow>;
          })}
    </SettingGroup>
    {asking && <ConfirmDialog tone="primary" confirmLabel={actionOf(asking)?.label ?? '接入'}
      message={`会写入：${asking.files.join('、')}。原文件先备份到废纸篓。写进去的是下面这段：`}
      detail={<pre className="connect-rule">{LEAD_RULE}</pre>}
      onConfirm={() => run(asking, 'connect')} onCancel={() => setAsking(null)} />}
  </>;
}

// 第二组：给不在上面的 AI 的对接提示词（src/core/intro.ts 那一份），一键复制。复制走桥上的 copyIntro；窗口自己没有剪贴板权限。
function PromptGroup() {
  const [state, setState] = useState<'idle' | 'copied' | string>('idle');
  useEffect(() => {
    if (state !== 'copied') return;
    const timer = setTimeout(() => setState('idle'), 2500);
    return () => clearTimeout(timer);
  }, [state]);
  const copy = () => { window.xa.copyIntro().then(() => setState('copied')).catch(e => setState(errorReason(e))); };
  // “复制”放在说明右边，一打开就看得到；提示词原文在下面，过长时自己滚动。
  return <SettingGroup head="其他 AI">
    <div className="setting-row intro-top">
      <p className="intro-lead">不在上面的 AI，把这段贴进它的对话；它会问你要不要把那句话写进它自己的常驻规矩。命令行 <code>xagents intro</code> 打印的是同一段。</p>
      <div className="intro-actions">
        <Button variant="primary" onClick={copy}>复制</Button>
        <span className={state === 'idle' || state === 'copied' ? 'faint' : 'muted'} role="status">{state === 'copied' ? '已复制，去贴进 AI 的对话吧' : state === 'idle' ? '' : '没能复制：' + state}</span>
      </div>
    </div>
    <pre className="intro-text">{INTRO_TEXT}</pre>
  </SettingGroup>;
}
