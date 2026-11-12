'use strict'

const crypto = require('node:crypto')
const path = require('node:path')

async function main() {
  const archive = process.argv[2]
  if (!archive || !archive.endsWith('.asar')) throw new Error('PACKAGED_ASAR_REQUIRED')
  const { MainOpaqueWorker } = require(path.join(archive, 'build/src/opaque-worker-client.js'))
  const { encodeBase64Url, opaqueUserIdentifier } = require(path.join(archive, 'build/src/pairing-crypto.js'))
  const random = () => encodeBase64Url(crypto.randomBytes(32))
  const context = {
    purpose: 'initial', sessionId: random(), operationId: random(), attemptId: random(), nonceC: random(), nonceP: random(),
    controllerId: '11111111-1111-4111-8111-111111111111', playerId: '22222222-2222-4222-8222-222222222222',
    fingerprint: random(), serverName: 'player-22222222-2222-4222-8222-222222222222.karaoke.invalid',
    expectedGeneration: '0', targetGeneration: '1', basePRevision: '0', baseCRevision: '0'
  }
  const worker = new MainOpaqueWorker()
  try {
    const result = await worker.run({ operation: 'player-register', password: '48291507', context,
      userIdentifier: opaqueUserIdentifier(context.sessionId, context.attemptId) })
    if (!result || result.registered !== true) throw new Error('PACKAGED_OPAQUE_REGISTRATION_FAILED')
    process.stdout.write('KQ_PACKAGED_OPAQUE_WORKER=PASS\n')
  } finally { await worker.close() }
}

main().catch(error => {
  process.stderr.write('KQ_PACKAGED_OPAQUE_WORKER=FAIL ' + (error instanceof Error ? error.message : 'UNKNOWN') + '\n')
  process.exitCode = 1
})
