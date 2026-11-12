import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { BonjourDiscoveryPort, BonjourPlayerAdvertisementPort } from '../src/remote-discovery'
import { isPrivateIpv4 } from '../src/remote-tls'

function availablePrivateInterface(): string | undefined {
  try {
    for (const entries of Object.values(os.networkInterfaces())) {
      const entry = entries?.find(value => value.family === 'IPv4' && !value.internal && isPrivateIpv4(value.address))
      if (entry) return entry.address
    }
  } catch { return undefined }
  return undefined
}

function waitForSnapshot(
  discovery: BonjourDiscoveryPort,
  predicate: (candidates: ReturnType<BonjourDiscoveryPort['getSnapshot']>['candidates']) => boolean
): Promise<ReturnType<BonjourDiscoveryPort['getSnapshot']>['candidates']> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe()
      reject(new Error('MDNS_DISCOVERY_TIMEOUT'))
    }, 8000)
    const unsubscribe = discovery.subscribe(snapshot => {
      if (!predicate(snapshot.candidates)) return
      clearTimeout(timeout)
      unsubscribe()
      resolve(snapshot.candidates)
    })
  })
}

test('real mDNS advertisement is discoverable, untrusted, and withdrawn on shutdown', {
  skip: process.env.KQ_RUN_MDNS_INTEGRATION !== '1' ? 'explicit mDNS integration opt-in required' : !availablePrivateInterface()
    ? 'no eligible private IPv4 interface' : false
}, async () => {
  const address = availablePrivateInterface()
  assert.ok(address)
  const deviceId = randomUUID()
  const discovery = new BonjourDiscoveryPort()
  const advertisement = new BonjourPlayerAdvertisementPort()
  const found = waitForSnapshot(discovery, candidates => candidates.some(candidate => candidate.deviceIdClaim === deviceId))
  await discovery.start([address])
  try {
    await advertisement.start({ deviceId, displayName: 'KQ transient discovery test', address, port: 47831 })
    const candidates = await found
    const candidate = candidates.find(value => value.deviceIdClaim === deviceId)
    assert.ok(candidate)
    assert.equal(candidate.verified, false)
    assert.equal(candidate.displayName, 'KQ transient discovery test')
    assert.deepEqual(candidate.addresses, [address])

    const withdrawn = waitForSnapshot(discovery, values => !values.some(value => value.deviceIdClaim === deviceId))
    await advertisement.stop()
    await withdrawn
  } finally {
    await advertisement.stop()
    await discovery.stop()
  }
})
