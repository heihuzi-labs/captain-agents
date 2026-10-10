import { useEffect, useRef, useState } from 'react';
import type { View } from '../../../src/core/view-types.ts';
import type { SlimDays } from '../../../src/core/settings.ts';
import { errorReason } from '../lib/errors.ts';
import { SLIM_CHOICES, SLIM_NOTE, storageLine } from '../lib/storage.ts';
import { RUN_CHOICES, STOP_CHOICES } from '../lib/limits.ts';
import { IntroPane } from './IntroPane.tsx';
import { defaultColumns } from '../../shared/ipc.ts';
import type { Settings as Values, SettingsPatch } from '../../shared/ipc.ts';
import { Button, ColorField, Modal, Segmented, Select, SettingGroup, SettingRow, SideNavLayout, Switch } from '../ui/index.ts';
import { policyOf, WorkerSettings } from './WorkerSettings.tsx';
import { CliSettings, UpdateSettings } from './Update.tsx';
import { NetworkSettings } from './NetworkSettings.tsx';

type Who = keyof Values['workers'];
// 界面先显示的新值：选手的改动按选手合并，其余整项替换。
const apply = (base: Values, patch: SettingsPatch): Values => ({ ...base, ...patch, workers: patch.workers ? { ...base.workers, ...patch.workers } : base.workers });
const combine = (queued: SettingsPatch | null, patch: SettingsPatch): SettingsPatch => ({ ...queued, ...patch, ...(patch.workers ? { workers: { ...queued?.workers, ...patch.workers } } : {}) });

// 上次打开的分页记在本机；读写失败（比如浏览器禁用了存储）不影响使用。
const PAGE_KEY = 'xa.settings-page';
const readPage = () => { try { return window.localStorage.getItem(PAGE_KEY); } catch { return null; } };
const rememberPage = (id: string) => { try { window.localStorage.setItem(PAGE_KEY, id); } catch { /* 记不住就算了 */ } };

const APPEARANCES: { id: Values['appearance']; label: string }[] = [{ id: 'system', label: '跟随系统' }, { id: 'light', label: '浅色' }, { id: 'dark', label: '深色' }];

// view 里有“选手名单”和展示信息（看板数据），有了才显示“选手与模型”页；设置本身仍单独读、单独存。
export function Settings({ close, view }: { close(): void; view?: Pick<View, 'roster' | 'workers' | 'quota' | 'storage' | 'projects' | 'models'> }) {
  const [values, setValues] = useState<Values | null>(null), [error, setError] = useState(''), [workersError, setWorkersError] = useState('');
  const latest = useRef<Values | null>(null), saved = useRef<Values | null>(null), queued = useRef<SettingsPatch | null>(null);
  const saving = useRef(false), mounted = useRef(true), [remembered, setRemembered] = useState(readPage);
  const show = (next: Values | null) => { latest.current = next; if (mounted.current) setValues(next); };
  useEffect(() => {
    mounted.current = true;
    void window.xa.getSettings().then(v => { saved.current = v; show(v); }).catch(() => { if (mounted.current) setError('读取设置失败，请关掉后重试。'); });
    return () => { mounted.current = false; };
  }, []);
  // 界面先显示新值，不禁用整组；同一时间只发一次保存，保存中来的改动记下来，存完再把最新的一起存上。
  // 失败：全部退回上次存下的值；原因写在出问题的那一块（选手的写在“选手与模型”顶部，其余写在最上面）。
  const save = async (patch: SettingsPatch) => {
    if (!latest.current) return;
    show(apply(latest.current, patch));
    queued.current = combine(queued.current, patch);
    if (saving.current) return;
    saving.current = true; setError(''); setWorkersError('');
    let sending: SettingsPatch = {};
    try {
      while (queued.current) {
        sending = queued.current;
        queued.current = null;
        saved.current = await window.xa.setSettings(sending);
      }
      show(saved.current);
    } catch (e) {
      const lost = { ...sending, ...queued.current }, reason = errorReason(e);
      queued.current = null; show(saved.current);
      if (mounted.current) {
        if (Object.keys(lost).some(key => key !== 'workers')) setError('保存失败：' + reason);
        if (lost.workers) setWorkersError('没能保存：' + reason);
      }
    } finally { saving.current = false; }
  };
  // 旧设置里可能还留着已经没有的列（如以前的“排队”）：读的时候忽略，存的时候只带现有的三列。
  const known = (columns?: Record<string, string>) => Object.fromEntries(Object.entries(columns ?? {}).filter(([name]) => Object.hasOwn(defaultColumns, name)));
  const column = (key: keyof typeof defaultColumns, color: string) => void save({ columns: { ...known(latest.current?.columns), [key]: color } });
  // 一位选手的一项改动：把这位选手现在的整份设置带上一起存（核心按选手整体替换）；最后一位不许关、最后一个强度不许取消。
  const worker = (who: Who, change: Partial<Values['workers'][Who]>) => {
    const roster = view?.roster, entry = roster?.find(r => r.who === who);
    if (!roster || !entry || !latest.current) return;
    const now = policyOf(entry, latest.current.workers), next = { ...now, ...change };
    if (!now.enabled && change.enabled === undefined) return;   // 关掉的选手，别的项灰着不能改
    if (!next.efforts.length) return;
    if (!next.enabled && !roster.some(r => r.who !== who && policyOf(r, latest.current?.workers).enabled)) return;
    void save({ workers: { [who]: next } });
  };
  // 存储：总是带完整的两个字段（开关和天数），以界面上最新的值为底。
  const storage = (change: Partial<Values['storage']>) => { if (latest.current) void save({ storage: { ...latest.current.storage, ...change } }); };
  const limits = (change: Partial<Values['limits']>) => { if (latest.current) void save({ limits: { ...latest.current.limits, ...change } }); };
  // 联网只走专用入口；保存中锁住开关，防止前后两次请求颠倒。
  const [networkSaving, setNetworkSaving] = useState(false);
  const allowNetwork = async (on: boolean) => {
    if (!latest.current || networkSaving) return;
    const previous = latest.current.networkAllowed;
    setNetworkSaving(true); setError('');
    show({ ...latest.current, networkAllowed: on });
    try {
      const result = await window.xa.setNetworkAllowed(on);
      if (saved.current) saved.current = { ...saved.current, networkAllowed: result.networkAllowed };
      if (latest.current) show({ ...latest.current, networkAllowed: result.networkAllowed });
    } catch (e) {
      if (latest.current) show({ ...latest.current, networkAllowed: previous });
      if (mounted.current) setError('没能保存：' + errorReason(e));
    } finally { if (mounted.current) setNetworkSaving(false); }
  };
  const pages = [{ id: 'general', label: '通用' }, ...(view && view.roster.length > 0 ? [{ id: 'workers', label: '选手与模型' }] : []), { id: 'network', label: '联网' }, { id: 'colors', label: '看板颜色' }, { id: 'intro', label: '接入 AI' }];
  const page = pages.find(p => p.id === remembered)?.id ?? 'general';
  return <Modal size="lg" flush label="设置" title="设置" onClose={close}>
    <SideNavLayout label="设置分页" items={pages} value={page} onChange={id => { setRemembered(id); rememberPage(id); }}>
      {error && <p role="alert" className="notice notice-bad">{error}</p>}
      {!values ? <p className="muted">正在读取设置…</p> : <fieldset className="settings">
        {page === 'general' && <><SettingGroup>
          <SettingRow title="外观" note="选了立刻生效" group><Segmented label="外观" items={APPEARANCES} value={values.appearance} onChange={id => void save({ appearance: id as Values['appearance'] })} /></SettingRow>
          {([
          ['keepAwake', '有活在跑时不让电脑自动休眠', '合上盖子仍会休眠'], ['notifications', '系统通知', undefined], ['openAtLogin', '开机自动启动', '登录后自动在菜单栏出现'],
        ] as const).map(([key, label, note]) => <SettingRow key={key} title={label} note={note}><Switch label={label} checked={values[key]} onChange={next => void save({ [key]: next })} /></SettingRow>)}</SettingGroup>
        <SettingGroup head="存储">
          <SettingRow title="自动清理旧日志" note={SLIM_NOTE(values.storage.days)}><Switch label="自动清理旧日志" checked={values.storage.slim} onChange={slim => storage({ slim })} /></SettingRow>
          <SettingRow title="多少天后清理" group><Segmented label="多少天后清理" disabled={!values.storage.slim} items={SLIM_CHOICES.map(d => ({ id: String(d), label: d + ' 天' }))} value={String(values.storage.days)}
            onChange={id => storage({ days: Number(id) as SlimDays })} /></SettingRow>
          {view?.storage && <p className="setting-row setting-foot">{storageLine(view.storage)}</p>}
        </SettingGroup>
        <UpdateSettings />
        <CliSettings /></>}
        {page === 'workers' && view && <>
          <SettingGroup head="派活限制">
            <SettingRow title="同时最多跑" note="在跑的加排队的，满了就先不派新活"><Select label="同时最多跑" items={RUN_CHOICES.map(n => ({ id: String(n), label: n + ' 件' }))} value={String(values.limits.maxRunning)}
              onChange={id => limits({ maxRunning: Number(id) })} /></SettingRow>
            <SettingRow title="额度停派线" note={values.limits.quotaStop === null ? '不按用量停派；额度用尽的那家仍然派不出去' : '某家用到这里就不再派给它'}><Select label="额度停派线" items={STOP_CHOICES.map(n => ({ id: String(n), label: n === null ? '不设限' : n + '%' }))} value={String(values.limits.quotaStop)}
              onChange={id => { const stop = STOP_CHOICES.find(n => String(n) === id); if (stop !== undefined) limits({ quotaStop: stop }); }} /></SettingRow>
          </SettingGroup>
          <WorkerSettings view={view} values={values.workers} error={workersError} change={worker} />
        </>}
        {page === 'network' && <NetworkSettings allowed={values.networkAllowed} saving={networkSaving} setAllowed={on => void allowNetwork(on)} />}
        {page === 'intro' && <IntroPane />}
        {page === 'colors' && <>
          <SettingGroup>{([['running', '进行中'], ['attention', '验收中'], ['done', '已完成']] as const).map(([key, label]) =>
            <SettingRow key={key} title={label}><ColorField value={values.columns?.[key] ?? defaultColumns[key]} onCommit={color => column(key, color)} /></SettingRow>)}</SettingGroup>
          <div className="setting-actions"><Button onClick={() => void save({ columns: {} })}>恢复默认</Button></div>
        </>}
      </fieldset>}
    </SideNavLayout>
  </Modal>;
}
