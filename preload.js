const { contextBridge, ipcRenderer } = require('electron')

// Keep SQLite in the main process. The isolated renderer receives only the
// state load/save operations it needs, never a database connection or SQL API.
contextBridge.exposeInMainWorld('karaokeDatabase', {
  load: ()     => ipcRenderer.invoke('app-data:load'),
  save: (data) => ipcRenderer.invoke('app-data:save', data)
})
