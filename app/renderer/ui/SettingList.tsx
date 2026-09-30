import type { ReactNode } from 'react';

// 分组面板：圆角浅底面板，组内行之间细分隔线（像 macOS 系统设置）。head 是可选的组头（选手页的厂家名和额度）。
export function SettingGroup({ label, head, className, children }: { label?: string; head?: ReactNode; className?: string; children: ReactNode }) {
  return <section className={'panel setting-group' + (className ? ' ' + className : '')} aria-label={label}>{head && <div className="setting-group-head">{head}</div>}{children}</section>;
}
// 一行 = 左边标题（需要时下面一行小字说明）+ 右边控件。整行是一个 label：点标题也能操作里面的开关或取色框。
// group：右边是一组按钮（如分段切换）时传 true——整行不再是 label（否则点标题会点到第一个按钮），改成带名字的 group。
// icon：标题前的小图标（接入 AI 的各家图标）；dim：整行变淡（接入 AI 里“没装”的那家）。
export function SettingRow({ title, note, group = false, icon, dim = false, children }: { title: string; note?: string; group?: boolean; icon?: ReactNode; dim?: boolean; children: ReactNode }) {
  const copy = <span className="setting-copy"><span className="setting-title">{title}</span>{note && <small className="setting-note">{note}</small>}</span>;
  const head = icon ? <span className="setting-lead">{icon}{copy}</span> : copy;
  const cls = 'setting-row' + (dim ? ' setting-row-dim' : '');
  return group ? <div className={cls} role="group" aria-label={title}>{head}{children}</div> : <label className={cls}>{head}{children}</label>;
}
