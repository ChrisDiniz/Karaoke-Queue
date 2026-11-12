const test = require('node:test')
const assert = require('node:assert/strict')
const { fork } = require('node:child_process')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const worker = path.join(__dirname, '../tests/remote-process-worker.cjs')
function launch(role, profile) {
  const child = fork(worker, [role, profile], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  child.auditOutput = ''
  child.stderr.on('data', chunk => { child.auditOutput += chunk.toString() })
  return child
}
function message(child, type) {
  return new Promise((resolve, reject) => {
    const onMessage = value => { if (value?.type === type) { cleanup(); resolve(value) } }
    const onExit = code => { cleanup(); reject(new Error(`${type} worker exited ${code}: ${child.auditOutput}`)) }
    const cleanup = () => { child.off('message', onMessage); child.off('exit', onExit) }
    child.on('message', onMessage)
    child.once('exit', onExit)
  })
}
function exited(child) {
  return new Promise(resolve => child.once('exit', resolve))
}

test('independent Player and Management processes reconnect with persisted identities', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kq-g1-processes-'))
  const playerProfile = path.join(root, 'player-profile')
  const controllerProfile = path.join(root, 'management-profile')
  await fs.mkdir(playerProfile); await fs.mkdir(controllerProfile)
  let player, controller
  try {
    player = launch('player', playerProfile)
    const ready1 = await message(player, 'ready')
    controller = launch('controller', controllerProfile)
    controller.send(ready1)
    const connected1 = await message(controller, 'connected')
    assert.equal(connected1.statusCode, 200)
    assert.equal(connected1.response, '{"process":"player"}')
    await exited(controller)
    assert.equal(player.exitCode, null)

    player.kill('SIGKILL')
    await exited(player)
    player = launch('player', playerProfile)
    const ready2 = await message(player, 'ready')
    assert.equal(ready2.deviceId, ready1.deviceId)
    assert.equal(ready2.fingerprintSha256, ready1.fingerprintSha256)

    controller = launch('controller', controllerProfile)
    controller.send(ready2)
    const connected2 = await message(controller, 'connected')
    assert.equal(connected2.controllerDeviceId, connected1.controllerDeviceId)
    assert.equal(connected2.statusCode, 200)
    await exited(controller)
    player.send('close')
    await exited(player)

    const playerStore = JSON.parse(await fs.readFile(path.join(playerProfile, 'remote-player-identity.json'), 'utf8'))
    const controllerStore = JSON.parse(await fs.readFile(path.join(controllerProfile, 'remote-controller-identity.json'), 'utf8'))
    assert.ok(playerStore.encryptedPrivateKey)
    assert.equal(playerStore.privateKeyPem, undefined)
    assert.equal(playerStore.deviceId, ready1.deviceId)
    assert.equal(controllerStore.deviceId, connected1.controllerDeviceId)
  } finally {
    if (controller && controller.exitCode === null) controller.kill('SIGKILL')
    if (player && player.exitCode === null) player.kill('SIGKILL')
    await fs.rm(root, { recursive: true, force: true })
  }
})
