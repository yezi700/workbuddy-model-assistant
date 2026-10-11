const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktop', {
  status: () => ipcRenderer.invoke('desktop:status'),
  start: () => ipcRenderer.invoke('desktop:start'),
  stop: () => ipcRenderer.invoke('desktop:stop'),
  restart: () => ipcRenderer.invoke('desktop:restart'),
  importData: () => ipcRenderer.invoke('desktop:import'),
  openData: () => ipcRenderer.invoke('desktop:open-data'),
  setStartup: enabled => ipcRenderer.invoke('desktop:startup', enabled === true),
  changePort: port => ipcRenderer.invoke('desktop:port', Number(port)),
  quit: () => ipcRenderer.invoke('desktop:quit'),
});
