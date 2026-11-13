'use strict'

const { RemoteControlIntentStore } = require('../build/src/remote-control-intent.js')

const store = new RemoteControlIntentStore(process.argv[2])
process.on('message', async message => {
  try {
    if (message?.type === 'read') {
      process.send({ id: message.id, ok: true, value: await store.read() })
    } else if (message?.type === 'set') {
      process.send({ id: message.id, ok: true, value: await store.set(message.intent, message.expectedRevision) })
    } else if (message?.type === 'close') {
      process.send({ id: message.id, ok: true })
      process.disconnect()
    }
  } catch (error) {
    process.send({ id: message?.id, ok: false, code: error instanceof Error ? error.message : 'UNKNOWN' })
  }
})

process.send({ type: 'ready' })
