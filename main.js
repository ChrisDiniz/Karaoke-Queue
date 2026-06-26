const { app, BrowserWindow } = require('electron')
const path = require('path')

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    },
    title: 'Karaoke Queue',
    autoHideMenuBar: true
  })

  win.loadFile(path.join(__dirname, 'src', 'index.html'))
}

app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  app.quit()
})
