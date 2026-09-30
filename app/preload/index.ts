import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import { channels } from '../shared/ipc.ts';
import type { Destination, XaBridge } from '../shared/ipc.ts';
import type { View } from '../../src/core/view-types.ts';

const bridge: XaBridge = {
  decide: (id, kind) => ipcRenderer.invoke(channels.decide, id, kind),
  redo: id => ipcRenderer.invoke(channels.redo, id),
  stop: id => ipcRenderer.invoke(channels.stop, id),
  comment: (id, text) => ipcRenderer.invoke(channels.comment, id, text),
  getSettings: () => ipcRenderer.invoke(channels.settingsGet),
  setSettings: patch => ipcRenderer.invoke(channels.settingsSet, patch),
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
