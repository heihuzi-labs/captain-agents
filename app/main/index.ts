import { app, BrowserWindow, clipboard, ipcMain, Menu, Notification, nativeTheme, protocol, screen, session, shell } from 'electron';
import { connect, connectArgument, connectStatus, disconnect } from '../../src/core/connect.ts';
import { INTRO_TEXT } from '../../src/core/intro.ts';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { desktopPath, paths } from '../../src/core/paths.ts';
import { buildView } from '../../src/core/view.ts';
import { channels } from '../shared/ipc.ts';
import { readJob } from '../../src/core/job.ts';
import { decide, requestRedo } from '../../src/core/decide.ts';
import { stop } from '../../src/core/commands.ts';
import { addComment, cleanComment } from '../../src/core/comments.ts';
import { readSettings, writeSettings } from '../../src/core/settings.ts';
import { queryQuota, readQuotaCache } from '../../src/core/quota.ts';
import type { View } from '../../src/core/view-types.ts';
import type { Destination } from '../shared/ipc.ts';
import { applyAppearance, syncBackground, windowBackground } from './appearance.ts';
import { jobActions, quotaRefreshHandler, quotaRefresher, settingsActions } from './actions.ts';
import { notificationTracker } from './notifications.ts';
import type { Notice } from './notifications.ts';
import { createTray } from './tray.ts';
import { readIcon } from './icons.ts';
import { migrateIcons } from '../../src/core/icons.ts';
import { httpsLink, securePreferences, secureSession, trustedSender } from './security.ts';
import { loadBounds, saveBounds } from './window-state.ts';
import { watchRegistry } from './watch.ts';
import { startDesktop } from './startup.ts';
import { slimScheduler } from './slim.ts';
import { slimOld } from '../../src/core/slim.ts';

declare const __XA_DEVELOPMENT__: boolean;
protocol.registerSchemesAsPrivileged([{ scheme: 'xa-icon', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
app.setName('派活工作台');
process.env.PATH = desktopPath(process.env.PATH);
// 安装脚本请旧进程退出时，也走 before-quit 保存窗口位置、停止定时清理。
process.once('SIGTERM', () => app.quit());
// 冒烟测试的 Electron 用户数据也与真实应用隔离；生产不设置这个变量。
if (process.env.XAGENTS_USER_DATA) app.setPath('userData', process.env.XAGENTS_USER_DATA);
let window: BrowserWindow | null = null;
let opening: Promise<void> | undefined;
let closeWatch: (() => void) | undefined;
let quotaTimer: ReturnType<typeof setInterval> | undefined;
const QUOTA_EVERY_MS = 15 * 60_000;
let slimmer: ReturnType<typeof slimScheduler> | undefined;
let saving = Promise.resolve();
let exiting = false;
let tray: ReturnType<typeof createTray> | undefined;
let pendingOpen: Destination | undefined;
let track: Awaited<ReturnType<typeof notificationTracker>> | undefined;
let notificationWork = Promise.resolve();
const liveNotifications = new Set<Notification>();
const e2eNotices: Notice[] | undefined = process.env.XAGENTS_E2E === '1' ? [] : undefined;
// 冒烟测试在后台跑：窗口照常创建、绘制和截图，但不显示到屏幕上，程序坞里也不出图标，免得打扰正在用电脑的人。
const e2eHidden = process.env.XAGENTS_E2E === '1';
if (e2eHidden) app.dock?.hide();
function reveal(target?: Destination) {
  if (target) pendingOpen = target;
  void openWindow().then(() => {
    if (pendingOpen && window && !window.webContents.isLoadingMainFrame()) {
      window.webContents.send(channels.open, pendingOpen); pendingOpen = undefined;
    }
  }).catch(console.error);
}
const readDesktopView = buildView;
function publish(view: View) {
  tray?.update(view);
  if (window && !window.isDestroyed()) window.webContents.send(channels.view, view);
  if (track) notificationWork = track(view).catch(console.error);
}
function sendNotice(notice: Notice) {
  if (e2eNotices) { e2eNotices.push(notice); return; }
  if (!Notification.isSupported()) return;
  const notification = new Notification({ title: '派活工作台', body: notice.body });
  liveNotifications.add(notification);
  notification.on('click', () => reveal(notice.target));
  notification.on('close', () => liveNotifications.delete(notification));
  notification.on('failed', () => liveNotifications.delete(notification));
  notification.show();
}
// 构建时折叠为 false，运行构建产物时也不能靠环境变量切回开发服务器。
const devUrl = __XA_DEVELOPMENT__ && !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;
if (devUrl) {
  const url = new URL(devUrl);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('开发页面必须来自本机 Vite');
}
const pageFile = join(import.meta.dirname, '../renderer/index.html');
const pageUrl = devUrl ? new URL(devUrl).href : pathToFileURL(pageFile).href;

// 红黄绿按钮：随顶栏（48px，见 docs/ui-spec.md 第 11 节和 tokens.css 的 --topbar-h）垂直居中；y 是按钮组上沿，按钮约 14px 高。
const TRAFFIC_LIGHTS = { x: 18, y: 16 };

async function openWindow() {
  if (window && !window.isDestroyed()) {
    if (window.isMinimized()) window.restore();
    if (!e2eHidden) { window.show(); window.focus(); }
    return;
  }
  if (opening) return opening;
  opening = (async () => {
    const bounds = await loadBounds(app.getPath('userData'));
    if (bounds.x !== undefined && bounds.y !== undefined && !screen.getAllDisplays().some(display => {
      const area = display.workArea;
      return bounds.x! < area.x + area.width && bounds.x! + bounds.width > area.x && bounds.y! < area.y + area.height && bounds.y! + bounds.height > area.y;
    })) { delete bounds.x; delete bounds.y; }
    const current = new BrowserWindow({ ...bounds, minWidth: 900, minHeight: 600, title: '派活工作台',
      titleBarStyle: 'hiddenInset', trafficLightPosition: TRAFFIC_LIGHTS, show: false,
      backgroundColor: windowBackground(nativeTheme.shouldUseDarkColors),
      webPreferences: { ...securePreferences, preload: join(import.meta.dirname, '../preload/index.cjs'), partition: 'xa-desktop' } });
    window = current;
    // 留给页面处理，防止默认菜单的 Cmd+R 先把整个窗口重载。
    current.webContents.on('before-input-event', (_event, input) => {
      current.webContents.setIgnoreMenuShortcuts(input.meta && ['1', '2', '3', 'r'].includes(input.key.toLowerCase()));
    });
    current.webContents.on('will-navigate', event => event.preventDefault());
    current.webContents.on('will-redirect', event => event.preventDefault());
    current.webContents.on('will-attach-webview', event => event.preventDefault());
    current.webContents.setWindowOpenHandler(({ url }) => {
      const external = httpsLink(url);
      if (external) void shell.openExternal(external).catch(console.error);
      return { action: 'deny' };
    });
    if (!e2eHidden) current.once('ready-to-show', () => current.show());
    current.on('close', event => {
      if (exiting) return;
      event.preventDefault(); current.hide();
      const normal = current.getNormalBounds();
      saving = saving.then(() => saveBounds(app.getPath('userData'), normal)).catch(console.error);
    });
    current.on('closed', () => { if (window === current) window = null; });
    if (devUrl) await current.loadURL(pageUrl); else await current.loadFile(pageFile);
  })().finally(() => { opening = undefined; });
  return opening;
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { void app.whenReady().then(openWindow).catch(console.error); });
  app.on('activate', () => { void openWindow().catch(console.error); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('before-quit', event => {
    closeWatch?.();
    if (quotaTimer) clearInterval(quotaTimer);
    slimmer?.stop();
    tray?.destroy(); tray = undefined;
    if (!exiting) {
      event.preventDefault(); exiting = true;
      if (window && !window.isDestroyed()) {
        const bounds = window.getNormalBounds();
        saving = saving.then(() => saveBounds(app.getPath('userData'), bounds)).catch(console.error);
      }
      void Promise.all([saving, notificationWork]).finally(() => app.quit());
    }
  });
  void app.whenReady().then(async () => {
    await migrateIcons().catch(console.error);
    applyAppearance(nativeTheme, (await readSettings()).appearance);
    nativeTheme.on('updated', () => syncBackground(nativeTheme, window));
    // 自动清理旧日志：冒烟测试（XAGENTS_E2E=1）里不跑。清理后账目变了，重新发一份看板数据；出错只写日志。
    if (!e2eHidden) {
      slimmer = slimScheduler({ run: async () => { if ((await slimOld()).jobs.length) publish(await readDesktopView()); }, onError: console.error });
      slimmer.start();
    }
    const isolated = session.fromPartition('xa-desktop');
    secureSession(isolated, devUrl);
    isolated.protocol.handle('xa-icon', async request => {
      if (request.method !== 'GET') return new Response(null, { status: 405 });
      try { return new Response(await readIcon(request.url, paths().home), { headers: { 'Content-Type': 'image/png', 'X-Content-Type-Options': 'nosniff' } }); }
      catch { return new Response(null, { status: 404 }); }
    });
    const actions = jobActions({ readJob, decide, requestRedo, stop, comment: addComment, checkComment: cleanComment });
    const settings = settingsActions({ readSettings, writeSettings,
      getLogin: () => app.getLoginItemSettings().openAtLogin,
      setLogin: value => app.setLoginItemSettings({ openAtLogin: value }),
      setAppearance: value => applyAppearance(nativeTheme, value, window),
      storageChanged: () => { void slimmer?.now(); },
    }, async () => publish(await readDesktopView()));
    const quota = quotaRefresher({ query: () => queryQuota() }, async () => publish(await readDesktopView()));
    const guard = (event: Electron.IpcMainInvokeEvent) => {
      if (!trustedSender(event, window, pageUrl)) throw new Error('不允许的请求来源。');
    };
    ipcMain.handle(channels.getView, async (event, ...args: unknown[]) => {
      guard(event);
      if (args.length) throw new Error('读取看板不需要参数。');
      const view = await readDesktopView();
      if (pendingOpen) {
        window?.webContents.send(channels.open, pendingOpen); pendingOpen = undefined;
      }
      return view;
    });
    for (const action of ['decide', 'redo', 'stop', 'comment'] as const) ipcMain.handle(channels[action], async (event, ...args: unknown[]) => {
      guard(event); await actions(action, args);
    });
    ipcMain.handle(channels.quotaRefresh, quotaRefreshHandler(quota, event => trustedSender(event, window, pageUrl)));
    // 复制对接提示词：只写固定的那一份，不收参数；窗口自己没有剪贴板权限（security.ts 拒绝一切权限请求）。
    ipcMain.handle(channels.copyIntro, (event, ...args: unknown[]) => { guard(event); if (args.length) throw new Error('复制对接提示词不需要参数。'); clipboard.writeText(INTRO_TEXT); });
    ipcMain.handle(channels.connectStatus, (event, ...args: unknown[]) => { guard(event); if (args.length) throw new Error('读取接入状态不需要参数。'); return connectStatus(); });
    ipcMain.handle(channels.connect, (event, ...args: unknown[]) => { guard(event); return connect(connectArgument(args)); });
    ipcMain.handle(channels.disconnect, (event, ...args: unknown[]) => { guard(event); return disconnect(connectArgument(args)); });
    ipcMain.handle(channels.settingsGet, (event, ...args: unknown[]) => { guard(event); return settings.get(args); });
    ipcMain.handle(channels.settingsSet, (event, ...args: unknown[]) => { guard(event); return settings.set(args); });
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: '派活工作台', submenu: [{ label: '设置…', accelerator: 'CmdOrCtrl+,', click: () => reveal({ kind: 'settings' }) }, { type: 'separator' }, { label: '退出', role: 'quit' }] },
      { label: '编辑', submenu: [{ label: '撤销', role: 'undo' }, { label: '重做', role: 'redo' }, { type: 'separator' }, { label: '剪切', role: 'cut' }, { label: '复制', role: 'copy' }, { label: '粘贴', role: 'paste' }, { label: '全选', role: 'selectAll' }] },
      { label: '窗口', submenu: [{ label: '最小化', role: 'minimize' }, { label: '关闭窗口', role: 'close' }] },
    ]));
    tray = createTray(reveal, () => app.quit());
    if (e2eNotices) Object.defineProperty(globalThis, '__xaE2E', { value: { notices: e2eNotices, tray: () => tray?.inspect() }, configurable: true });
    await startDesktop({
      openWindow,
      startNotifications: async () => { track = await notificationTracker(app.getPath('userData'), sendNotice); },
      startWatching: async () => { closeWatch = await watchRegistry(() => !exiting, publish, console.error, readDesktopView, undefined, true); },
      refresh: async () => { publish(await readDesktopView()); await notificationWork; },
      onError: console.error,
    });
    // 应用开着时每 15 分钟查一次额度；启动时数据已经超过 15 分钟也查一次（冒烟测试里不查）。
    quotaTimer = setInterval(() => { void quota.auto(console.error); }, QUOTA_EVERY_MS);
    if (!e2eNotices) {
      const cached = await readQuotaCache();
      if (!cached || Date.now() - Date.parse(cached.queriedAt) > QUOTA_EVERY_MS) void quota.auto(console.error);
    }
  }).catch(error => { console.error(error); app.quit(); });
}
