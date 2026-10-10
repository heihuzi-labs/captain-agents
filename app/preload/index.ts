import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import { channels } from '../shared/ipc.ts';
import type { Destination, UpdateState, XaBridge } from '../shared/ipc.ts';
import type { View } from '../../src/core/view-types.ts';

const bridge: XaBridge = {
  cliStatus: (...args: unknown[]) => ipcRenderer.invoke(channels.cliStatus, ...args),
  cliInstall: (...args: unknown[]) => ipcRenderer.invoke(channels.cliInstall, ...args),
  appInfo: (...args: unknown[]) => ipcRenderer.invoke(channels.appInfo, ...args),
  updateCheck: (...args: unknown[]) => ipcRenderer.invoke(channels.updateCheck, ...args),
  updateDownload: (...args: unknown[]) => ipcRenderer.invoke(channels.updateDownload, ...args),
  updateRestart: (...args: unknown[]) => ipcRenderer.invoke(channels.updateRestart, ...args),
  setAutoUpdateCheck: (...args: unknown[]) => ipcRenderer.invoke(channels.setAutoUpdateCheck, ...args),
  onUpdate(callback, ...extra: unknown[]) {
    if (typeof callback !== 'function' || extra.length) throw new Error('订阅更新只接收一个回调函数。');
    const listener = (_event: IpcRendererEvent, state: UpdateState) => callback(state);
    ipcRenderer.on(channels.onUpdate, listener);
    return () => ipcRenderer.removeListener(channels.onUpdate, listener);
  },
  decide: (id, kind) => ipcRenderer.invoke(channels.decide, id, kind),
  redo: id => ipcRenderer.invoke(channels.redo, id),
  stop: id => ipcRenderer.invoke(channels.stop, id),
  comment: (id, text) => ipcRenderer.invoke(channels.comment, id, text),
  teamSay: (id, text) => ipcRenderer.invoke(channels.teamSay, id, text),
  teamStop: id => ipcRenderer.invoke(channels.teamStop, id),
  chatCreate: options => ipcRenderer.invoke(channels.chatCreate, options),
  chatSay: (id, text) => ipcRenderer.invoke(channels.chatSay, id, text),
  chatStop: id => ipcRenderer.invoke(channels.chatStop, id),
  chatRename: (id, title) => ipcRenderer.invoke(channels.chatRename, id, title),
  getSettings: () => ipcRenderer.invoke(channels.settingsGet),
  setSettings: patch => ipcRenderer.invoke(channels.settingsSet, patch),
  setNetworkAllowed: on => ipcRenderer.invoke(channels.networkAllowed, on),
  modelsRefresh: () => ipcRenderer.invoke(channels.modelsRefresh),
  modelsKeep: (channel, models) => ipcRenderer.invoke(channels.modelsKeep, channel, models),
  refreshQuota: () => ipcRenderer.invoke(channels.quotaRefresh),
  copyIntro: () => ipcRenderer.invoke(channels.copyIntro),
  connectStatus: () => ipcRenderer.invoke(channels.connectStatus),
  connect: ai => ipcRenderer.invoke(channels.connect, ai),
  disconnect: ai => ipcRenderer.invoke(channels.disconnect, ai),
  onOpen(callback) {
    const listener = (_event: IpcRendererEvent, destination: Destination) => callback(destination);
    ipcRenderer.on(channels.open, listener);
    return () => ipcRenderer.removeListener(channels.open, listener);
  },
  getView: () => ipcRenderer.invoke(channels.getView) as Promise<View>,
  onView(callback) {
    const listener = (_event: IpcRendererEvent, view: View) => callback(view);
    ipcRenderer.on(channels.view, listener);
    return () => ipcRenderer.removeListener(channels.view, listener);
  },
};
contextBridge.exposeInMainWorld('xa', Object.freeze(bridge));
