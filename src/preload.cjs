const { contextBridge, ipcRenderer } = require('electron');

const subscribe = (channel, listener) => {
  if (typeof listener !== 'function') return () => {};
  const wrapped = (_event, payload) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
};

contextBridge.exposeInMainWorld('hare', Object.freeze({
  getState: () => ipcRenderer.invoke('hare:get-state'),
  saveSettings: patch => ipcRenderer.invoke('hare:save-settings', patch),
  action: name => ipcRenderer.invoke('hare:action', name),
  openSettings: () => ipcRenderer.send('hare:open-settings'),
  setHitTest: hit => ipcRenderer.send('hare:hit-test', hit === true),
  dragStart: () => ipcRenderer.send('hare:drag-start'),
  dragEnd: () => ipcRenderer.send('hare:drag-end'),
  onState: listener => subscribe('hare:state', listener),
  onPet: listener => subscribe('hare:pet', listener)
}));
