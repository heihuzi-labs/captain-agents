import { useEffect, useState } from 'react';
import type { AppInfo, CliStatus } from '../../shared/ipc.ts';
import { errorReason } from '../lib/errors.ts';
import { fmtTime } from '../lib/board.ts';
import { checkUpdate, closeUpdateDialog, downloadUpdate, megabytes, openUpdateDialog, percent, pillText, restartForUpdate, setAutoCheck, useUpdate } from '../lib/update.ts';
import { Button, ConfirmDialog, cssVars, Modal, SettingGroup, SettingRow, Switch } from '../ui/index.ts';

// 顶栏的更新提示：有新版本、正在下载、已就绪时才出现，点了打开更新弹窗（docs/ui-spec.md 第 18 节）。
export function UpdatePill() {
  const text = pillText(useUpdate().info?.update);
  return text ? <button type="button" className="update-pill" title="查看更新" onClick={openUpdateDialog}>{text}</button> : null;
}

// 更新弹窗。应用从不自己下载、自己重启：每一步都要人点。更新说明当纯文字显示。
export function UpdateDialog() {
  const { info, dialog } = useUpdate();
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  if (!dialog || !info) return null;
  const state = info.update;
  const run = async (action: () => Promise<unknown>, what: string) => {
    setBusy(true); setError('');
    try { await action(); }
    catch (e) { setError(`没能${what}：` + errorReason(e)); }
    finally { setBusy(false); }
  };
  const later = <Button size="sm" onClick={closeUpdateDialog}>以后再说</Button>;
  const footer = state.phase === 'available' ? <><span /><span className="step">{later}<Button size="sm" variant="primary" disabled={busy} onClick={() => void run(downloadUpdate, '开始下载')}>下载并安装</Button></span></>
    : state.phase === 'ready' ? <><span /><span className="step">{later}<Button size="sm" variant="primary" disabled={busy} onClick={() => void run(restartForUpdate, '重启')}>{busy ? '正在重启…' : '重启以完成更新'}</Button></span></>
    : state.phase === 'error' ? <><span /><span className="step"><Button size="sm" onClick={closeUpdateDialog}>关闭</Button><Button size="sm" variant="primary" disabled={busy} onClick={() => void run(checkUpdate, '检查')}>重新检查</Button></span></>
    : <><span /><Button size="sm" onClick={closeUpdateDialog}>关闭</Button></>;
  return <Modal size="sm" label="更新" title="更新" onClose={closeUpdateDialog} footer={footer}>
    <div className="update">
      {state.phase === 'available' && <>
        <div className="update-head"><b>派活工作台 {state.version}</b><span className="faint">现在是 {info.version} · {megabytes(state.size)}</span></div>
        {state.notes.trim() && <div className="update-notes" role="group" aria-label="更新说明">{state.notes.trim()}</div>}
      </>}
      {state.phase === 'downloading' && <>
        <div className="update-head"><b>正在下载 {state.version}</b><span className="faint">已下载 {megabytes(state.received)} / {megabytes(state.size)}</span></div>
        <div className="update-bar" role="progressbar" aria-label="下载进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent(state)}><i style={cssVars({ '--done': percent(state) + '%' })} /></div>
        <p className="muted update-tip">可以关掉这个窗口，下载在后台继续。</p>
      </>}
      {state.phase === 'ready' && <>
        <div className="update-head"><b>{state.version} 已下载并核对无误</b></div>
        <p className="muted update-tip">重启只是关掉窗口再打开，在跑的活和群聊不受影响。</p>
      </>}
      {state.phase === 'error' && <p role="alert" className="notice notice-bad">{state.message}</p>}
      {state.phase === 'checking' && <p className="muted" role="status">在检查…</p>}
      {state.phase === 'idle' && <p className="muted">已是最新版本（{info.version}）。</p>}
      {state.phase === 'off' && <p className="muted">{state.reason}</p>}
      {error && <p role="alert" className="notice notice-bad">{error}</p>}
    </div>
  </Modal>;
}

// 设置 → 通用 →“更新”一组：当前版本和状态、“检查更新”或“查看”、自动检查的开关。
function statusLine(info: AppInfo): string {
  const s = info.update;
  if (s.phase === 'off') return s.reason;
  if (s.phase === 'idle') return s.checked ? `已是最新版本 · ${fmtTime(s.checked, true)} 检查过` : '还没检查过';
  if (s.phase === 'checking') return '在检查…';
  if (s.phase === 'available') return `有新版本 ${s.version}`;
  if (s.phase === 'downloading') return `正在下载 ${s.version}…`;
  if (s.phase === 'ready') return `${s.version} 已下载，重启生效`;
  return s.message;
}
export function UpdateSettings() {
  const { info } = useUpdate();
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  if (!info) return null;
  const phase = info.update.phase, off = phase === 'off', pending = phase === 'available' || phase === 'downloading' || phase === 'ready';
  const run = async (action: () => Promise<unknown>, what: string) => {
    setBusy(true); setError('');
    try { await action(); }
    catch (e) { setError(`没能${what}：` + errorReason(e)); }
    finally { setBusy(false); }
  };
  return <SettingGroup head="更新" label="更新">
    <SettingRow title="当前版本" note={error || statusLine(info)} group>
      <span className="update-version"><span className="num muted">{info.version}</span>
        {!off && (pending ? <Button size="sm" onClick={openUpdateDialog}>查看</Button>
          : <Button size="sm" disabled={busy || phase === 'checking'} onClick={() => void run(checkUpdate, '检查')}>检查更新</Button>)}</span>
    </SettingRow>
    {!off && <SettingRow title="自动检查更新" note="每天一次；只连更新地址，不带任何本机信息"><Switch label="自动检查更新" checked={info.autoCheck} onChange={on => void run(() => setAutoCheck(on), '保存')} /></SettingRow>}
  </SettingGroup>;
}

// 设置 → 通用 →“命令行”一组：终端里的 xagents 是不是这个应用里的那一份（docs/ui-spec.md 第 18 节）。开发版不出现。
const CLI_NOTE: Record<Exclude<CliStatus, 'unavailable'>, string> = {
  installed: '已安装。终端里的 xagents 用的就是这个应用里的平台，以后跟着应用一起更新。',
  missing: '还没安装。装好后在终端里就能用 xagents，以后跟着应用一起更新。',
  other: '~/.local/bin/xagents 已经有一个别的（比如链到源码目录的开发版）。替换后改用这个应用里的那一份。',
};
export function CliSettings() {
  const [status, setStatus] = useState<CliStatus | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [confirm, setConfirm] = useState(false);
  useEffect(() => {
    let alive = true;
    if (typeof window.xa?.cliStatus === 'function') void window.xa.cliStatus().then(s => { if (alive) setStatus(s); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  if (!status || status === 'unavailable') return null;
  const install = async (replace: boolean) => {
    setConfirm(false); setBusy(true); setError('');
    try { setStatus(await window.xa.cliInstall(replace)); }
    catch (e) { setError('没能安装：' + errorReason(e)); }
    finally { setBusy(false); }
  };
  return <SettingGroup head="命令行" label="命令行">
    <SettingRow title="终端里的 xagents" note={error || CLI_NOTE[status]} group>
      {status === 'missing' && <Button size="sm" disabled={busy} onClick={() => void install(false)}>安装</Button>}
      {status === 'other' && <Button size="sm" disabled={busy} onClick={() => setConfirm(true)}>替换…</Button>}
    </SettingRow>
    {confirm && <ConfirmDialog tone="primary" busy={busy} message="把现有的 ~/.local/bin/xagents 换成这个应用里的那一份？" detail="原来那个文件会被覆盖；如果它是你自己链到源码目录的开发版，换了以后终端里用的就不再是源码目录里的代码。" confirmLabel="替换" onCancel={() => setConfirm(false)} onConfirm={() => void install(true)} />}
  </SettingGroup>;
}
