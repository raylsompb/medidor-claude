const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('medidor', {
  getState: () => ipcRenderer.invoke('get-state'),
  refresh: () => ipcRenderer.invoke('refresh'),
  logout: () => ipcRenderer.invoke('logout'),
  login: () => ipcRenderer.invoke('login'),
  loginBrowser: () => ipcRenderer.invoke('login-browser'),
  useClaudeCode: () => ipcRenderer.invoke('use-claude-code'),
  setSetting: (k, v) => ipcRenderer.invoke('set-setting', k, v),
  testAlert: () => ipcRenderer.invoke('test-alert'),
  hide: () => ipcRenderer.invoke('hide'),
  quit: () => ipcRenderer.invoke('quit'),
  on: (channel, fn) => {
    if (['state', 'chime', 'opened', 'show-view'].includes(channel)) ipcRenderer.on(channel, (_e, ...a) => fn(...a));
  },
});
