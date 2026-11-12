const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const path = require('node:path')
const { MainOpaqueWorker } = require('../build/src/opaque-worker-client.js')

function b64(value) { return Buffer.from(value).toString('base64url') }
function newId() { return b64(crypto.randomBytes(32)) }

function context() {
  const playerId = '22222222-2222-4222-8222-222222222222'
  return {
    purpose: 'initial', sessionId: newId(), operationId: newId(), attemptId: newId(),
    nonceC: newId(), nonceP: newId(), controllerId: '11111111-1111-4111-8111-111111111111',
    playerId, fingerprint: b64(crypto.randomBytes(32)),
    serverName: `player-${playerId}.karaoke.invalid`, expectedGeneration: '0', targetGeneration: '1',
    basePRevision: '0', baseCRevision: '0'
  }
}

async function pairing(passwordC = '00981234') {
  const cx = context()
  const player = new MainOpaqueWorker(path.join(__dirname, '../build/src/opaque-pairing-worker.js'))
  const controller = new MainOpaqueWorker(path.join(__dirname, '../build/src/opaque-pairing-worker.js'))
  try {
    const userIdentifier = `KQ-Pair-v2/${cx.sessionId}/${cx.attemptId}`
    await player.run({ operation: 'player-register', password: '00981234', context: cx, userIdentifier })
    const started = await controller.run({ operation: 'controller-start', password: passwordC, context: cx })
    const response = await player.run({ operation: 'player-start', ke1: started.KE1, userIdentifier })
    const finished = await controller.run({ operation: 'controller-finish', password: passwordC, ke2: response.KE2 })
    const playerAuthenticated = await player.run({ operation: 'player-finish', ke3: finished.KE3 })
    const controllerConfirmed = await controller.run({ operation: 'controller-confirm-player-bind', playerBind: playerAuthenticated.playerBind })
    const playerConfirmed = await player.run({ operation: 'player-confirm-controller-bind', controllerBind: controllerConfirmed.controllerBind })
    return { playerAuthenticated, controllerConfirmed, playerConfirmed }
  } finally {
    await Promise.all([player.close(), controller.close()])
  }
}

async function main() {
  const cancelledWorker = new MainOpaqueWorker(path.join(__dirname, '../build/src/opaque-pairing-worker.js'))
  const cancelled = cancelledWorker.run({ operation: 'controller-start', password: '00981234', context: context() })
  const cancellationResult = assert.rejects(cancelled, /OPAQUE_WORKER_CANCELLED/)
  await cancelledWorker.cancel()
  await cancellationResult
  await cancelledWorker.close()

  const result = await pairing()
  assert.equal(result.playerConfirmed.confirmed, true)
  assert.equal(result.playerAuthenticated.transcriptHash, result.controllerConfirmed.transcriptHash)
  assert.equal(result.playerAuthenticated.recoveryRoot, result.controllerConfirmed.recoveryRoot)
  assert.equal(result.playerAuthenticated.transcript, result.controllerConfirmed.transcript)
  assert.equal(result.playerAuthenticated.playerBind.length, 43)
  assert.equal(result.controllerConfirmed.controllerBind.length, 43)
  await assert.rejects(pairing('12345678'), /PAIRING_AUTH_FAILED/)
  console.log('pairing-opaque-worker: PASS (real OPAQUE in independent Main-owned workers; cancellation/termination; bilateral binding; wrong-code rejection)')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
