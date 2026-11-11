// @ts-nocheck
// Fault injection only: invoke the actual package Main after wrapping its real window/host boundary.
export {}
const path = require('node:path')
const fs = require('node:fs')
const { app, dialog } = require('electron')
const projectRoot = path.resolve(__dirname, '../..')
app.setAppPath(projectRoot)
const { PlayerVideoWindow } = require('../src/player-video-window')
const probe = global.__f0Bootstrap = { enumerations: 0, actualHostReady: false, dialogErrors: 0 }
probe.reached = new Promise(resolve => { probe.onReached = resolve })
const barrier = new Promise((resolve, reject) => { probe.release = resolve; probe.reject = reject })
void barrier.catch(() => undefined)
const attach = PlayerVideoWindow.prototype.attachControlWindow
PlayerVideoWindow.prototype.attachControlWindow = function (...args) {
  const actual = attach.apply(this, args)
  void actual.then(() => { probe.actualHostReady = true; probe.onReached() }, error => probe.reject(error))
  return actual.then(() => barrier)
}
const readdir = fs.promises.readdir
fs.promises.readdir = async (...args) => {
  if (path.resolve(args[0]) === path.resolve(process.env.KQ_PLAYER_TEST_MEDIA_DIR)) probe.enumerations++
  return readdir.apply(fs.promises, args)
}
// Observe the fatal path without leaving a blocking native dialog on a test desktop.
dialog.showErrorBox = () => { probe.dialogErrors++ }
if (process.env.KQ_F0_BOOTSTRAP_CASE === 'persistence-failure') {
  const { PlayerPlaybackRecoveryStore } = require('../src/player-playback-recovery-store')
  const write = PlayerPlaybackRecoveryStore.prototype.write
  PlayerPlaybackRecoveryStore.prototype.write = function (record) {
    if (record.status === 'dismissed') throw new Error('ISOLATED_RECOVERY_WRITE_FAILURE')
    return write.call(this, record)
  }
}
require(path.join(projectRoot, require(path.join(projectRoot, 'package.json')).main))
