// @ts-nocheck
export {}

const { app, BrowserWindow } = require('electron')
const path = require('node:path')

const userDataDirectory = path.resolve(process.env.KQ_TEST_LEGACY_SEED_USER_DATA)
const documentPath = path.resolve(process.env.KQ_TEST_LEGACY_SEED_DOCUMENT)
app.setPath('userData', userDataDirectory)

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } })
  await window.loadFile(documentPath)
  await window.webContents.executeJavaScript(`(() => {
    localStorage.setItem('kshake_queue', JSON.stringify([{
      id: 'legacy-local-storage-entry', name: 'Legacy Singer', songNumber: '12345', songNumber2: '',
      table: '7', insertedAt: 1700000000000, status: 'pending', sessionId: null
    }]))
    localStorage.setItem('kshake_history', '[]')
    localStorage.setItem('kshake_sessions', '[]')
    localStorage.setItem('kshake_priority', '[]')
    localStorage.setItem('kshake_fixed_turn_positions', '{}')
    localStorage.setItem('kshake_frozen_turn_ids', '[]')
  })()`)
  window.destroy()
  app.quit()
}).catch(error => {
  console.error(error)
  app.exit(1)
})
