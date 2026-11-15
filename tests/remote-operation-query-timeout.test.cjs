'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { randomUUID } = require('node:crypto')
const test = require('node:test')
const WebSocket = require('ws')
const { createOperationalQuery, RemoteOperationalClient } = require('../build/src/remote-operational-client.js')

const playerId = '11111111-1111-4111-8111-111111111111'
const controllerId = '22222222-2222-4222-8222-222222222222'

class SocketFixture extends EventEmitter {
  readyState = WebSocket.OPEN
  sent = []
  queryWaiters = []

  send(data, callback) {
    const message = JSON.parse(data)
    this.sent.push(message)
    callback?.()
    if (message.kind === 'hello') {
      const ready = { protocolVersion: 1, schemaVersion: 1, kind: 'ready', messageId: randomUUID(),
        deviceId: playerId, controllerId, body: { protocol: 'kq-operation/1', protocolVersion: 1,
          schemaVersion: 1, journalId: 'journal-timeout-test', playerEpoch: 'player-epoch', controlEpoch: 'control-epoch' } }
      queueMicrotask(() => this.emit('message', Buffer.from(JSON.stringify(ready)), false))
    } else if (message.kind === 'query') {
      const queryCount = this.sent.filter(sent => sent.kind === 'query').length
      const pending = this.queryWaiters.splice(0)
      for (const waiter of pending) {
        if (queryCount >= waiter.count) waiter.resolve()
        else this.queryWaiters.push(waiter)
      }
    }
  }

  waitForQuery(count) {
    if (this.sent.filter(message => message.kind === 'query').length >= count) return Promise.resolve()
    return new Promise(resolve => this.queryWaiters.push({ count, resolve }))
  }

  close(code = 1000) {
    this.readyState = WebSocket.CLOSED
    queueMicrotask(() => this.emit('close', code))
  }

  terminate() { this.close(1006) }
}

test('operation-status timeout does not retry and an explicit follow-up preserves the original operationId', async () => {
  const socket = new SocketFixture()
  const client = new RemoteOperationalClient(socket, { playerId, controllerId, credentialGeneration: 1 },
    { controllerId, credentialGeneration: 1, scopes: ['transport:control'] }, 10)
  const operationId = 'original-operation-id'
  const request = createOperationalQuery(playerId, controllerId, 'operation-status', { operationId })
  // RemoteOperationalClient intentionally unrefs its request timer. Keep this
  // isolated test process alive while awaiting the real short timeout.
  const keepAlive = setInterval(() => undefined, 1000)
  try {
    await client.ready()
    const first = client.query(request, new AbortController().signal)
    await socket.waitForQuery(1)
    await assert.rejects(first, /REMOTE_OPERATIONAL_QUERY_TIMEOUT/)
    assert.equal(socket.sent.filter(message => message.kind === 'query').length, 1,
      'one timed-out explicit request is not automatically resent')
    assert.equal(client.pending.size, 0, 'timeout releases the pending query slot')

    const second = client.query(createOperationalQuery(playerId, controllerId, 'operation-status', { operationId }),
      new AbortController().signal)
    await socket.waitForQuery(2)
    await assert.rejects(second, /REMOTE_OPERATIONAL_QUERY_TIMEOUT/)
    const queries = socket.sent.filter(message => message.kind === 'query')
    assert.equal(queries.length, 2, 'a later operator action creates exactly one new query')
    assert.ok(queries.every(message => message.body.type === 'operation-status' &&
      message.body.payload.operationId === operationId), 'both requests query the original operationId')
    assert.notEqual(queries[0].body.queryId, queries[1].body.queryId,
      'each explicit query uses its own response correlation')
  } finally {
    await client.close()
    clearInterval(keepAlive)
  }
})
