import type { BrowserWindow, IpcMainInvokeEvent, Session } from 'electron';

export const productionCsp = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' xa-icon:; connect-src 'none'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; worker-src 'none'";
export const securePreferences = { contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true } as const;

export function trustedSender(event: IpcMainInvokeEvent, window: BrowserWindow | null, pageUrl: string): boolean {
  return Boolean(window && !window.isDestroyed() && event.sender === window.webContents &&
    event.senderFrame === window.webContents.mainFrame && event.senderFrame?.url === pageUrl);
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
