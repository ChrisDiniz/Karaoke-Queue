const { contextBridge, ipcRenderer } = require('electron')

// Safe bridge to the disk-backed store living in the main process.
// The renderer (contextIsolation: true) cannot touch Node/electron-store
// directly, so it goes through these IPC calls.
contextBridge.exposeInMainWorld('kstore', {
  load: ()     => ipcRenderer.invoke('kstore:load'),
  save: (data) => ipcRenderer.invoke('kstore:save', data)
})
