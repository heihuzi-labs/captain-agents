import type { BrowserWindow, IpcMainInvokeEvent, Session } from 'electron';
import { fileURLToPath } from 'node:url';
import { posix, win32 } from 'node:path';

export const productionCsp = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' xa-icon:; connect-src 'none'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; worker-src 'none'";
export const securePreferences = { contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true } as const;
// 窗口用的会话：名字必须以 persist: 开头，否则 Electron 只放在内存里，“记在本机”的东西（群读到哪、置顶、归档、选中的分页）每次重启都丢。
export const windowPartition = 'persist:xa-desktop';

export function trustedSender(event: IpcMainInvokeEvent, window: BrowserWindow | null, pageUrl: string, windows = process.platform === 'win32'): boolean {
  return Boolean(window && !window.isDestroyed() && event.sender === window.webContents &&
    event.senderFrame === window.webContents.mainFrame && samePage(event.senderFrame?.url, pageUrl, windows));
}
// 窗口里的地址和我们算出来的页面地址是不是同一个文件。本地页面不能逐字比：Node 和浏览器对路径里的字符转义写法不一样
// （2026-10-14 Windows 流水线：装在带“~”的短路径下，Node 写 %7E、浏览器写 ~，所有请求都被当成来路不明，设置读不出来）。
// 所以本地页面按文件路径比（Windows 上不分大小写）；开发时的网页地址仍逐字比。带查询串或 # 的一律不认。
export function samePage(url: string | undefined, pageUrl: string, windows = process.platform === 'win32'): boolean {
  if (!url) return false;
  if (url === pageUrl) return true;
  try {
    const actual = new URL(url), expected = new URL(pageUrl);
    if (actual.protocol !== 'file:' || expected.protocol !== 'file:' || actual.search || actual.hash || actual.host !== expected.host) return false;
    const path = windows ? win32 : posix, left = fileURLToPath(actual, { windows }), right = fileURLToPath(expected, { windows });
    return windows ? path.relative(left.toLowerCase(), right.toLowerCase()) === '' : path.relative(left, right) === '';
  } catch { return false; }
}

export function httpsLink(value: string): string | null {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; }
  catch { return null; }
}

export function secureSession(session: Session, devUrl?: string) {
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
  session.webRequest.onBeforeRequest((details, callback) => {
    const url = new URL(details.url);
    // 仅 electron-vite dev 使用本地 HTTP/HMR；构建后不允许任何网络请求。
    const dev = devUrl ? new URL(devUrl) : null;
    const development = dev && url.host === dev.host && [dev.protocol, 'ws:'].includes(url.protocol);
    callback({ cancel: !(['file:', 'xa-icon:'].includes(url.protocol) || development) });
  });
}
