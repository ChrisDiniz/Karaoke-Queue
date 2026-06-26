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
      const queueLength  = await win.webContents.executeJavaScript('window.__kqueue.queueLength()')
      const sessionEnded = await win.webContents.executeJavaScript('window.__kqueue.sessionEnded()')

      if (queueLength === 0 && sessionEnded) {
        win.destroy()
        return
      }

      const warnings = []
      if (queueLength > 0) warnings.push(`Há ${queueLength} entrada${queueLength > 1 ? 's' : ''} na fila.`)
      if (!sessionEnded)   warnings.push('O expediente atual não foi encerrado.')

      const buttons = []
      if (!sessionEnded) buttons.push('Encerrar expediente e fechar')
      buttons.push('Fechar assim mesmo')
      buttons.push('Cancelar')

      const { response } = await dialog.showMessageBox(win, {
        type:      'warning',
        title:     'Karaoke Queue',
        message:   warnings.join('\n'),
        buttons,
        defaultId: buttons.length - 1,
        cancelId:  buttons.length - 1
      })

      const chosen = buttons[response]
      if (chosen === 'Cancelar') return
      if (chosen === 'Encerrar expediente e fechar') {
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
