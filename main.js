const { app, BrowserWindow, dialog } = require('electron')
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

  win.on('close', async (e) => {
    e.preventDefault()

    try {
      const sessionEnded = await win.webContents.executeJavaScript('window.__kqueue.sessionEnded()')

      if (sessionEnded) {
        win.destroy()
        return
      }

      const queueLength = await win.webContents.executeJavaScript('window.__kqueue.queueLength()')
      const detail = queueLength > 0
        ? `Há ${queueLength} entrada${queueLength > 1 ? 's' : ''} na fila.`
        : ''

      const { response } = await dialog.showMessageBox(win, {
        type:      'question',
        title:     'Karaoke Queue',
        message:   'Encerrar o expediente antes de sair?',
        detail,
        buttons:   ['Encerrar e sair', 'Sair sem encerrar', 'Cancelar'],
        defaultId: 0,
        cancelId:  2
      })

      if (response === 2) return
      if (response === 0) {
        await win.webContents.executeJavaScript('window.__kqueue.endSessionSilent()')
      }
      win.destroy()

    } catch (err) {
      win.destroy()
    }
  })
}

app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  app.quit()
})
