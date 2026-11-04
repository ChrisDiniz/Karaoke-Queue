import test from 'node:test'
import assert from 'node:assert/strict'
import type { StandalonePlayerIpcCommandReply } from '../src/standalone-player-ipc-contracts'
import { StandalonePlayerInteractionController, type StandaloneInteractionScheduler } from '../src/standalone-player-interaction'
import { StandalonePlayerInteractionTransport } from '../src/standalone-player-interaction-transport'

class FakeScheduler implements StandaloneInteractionScheduler {
  schedule(): unknown { return {} }
  cancel(): void {}
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function build() {
  let id = 0
  const interaction = new StandalonePlayerInteractionController({
    scheduler: new FakeScheduler(),
    digitPanelInactivityMs: 10_000,
    createOperationId: () => `transport-${++id}`
  })
  return { interaction, transport: new StandalonePlayerInteractionTransport(interaction, { execute: async () => {
    throw new Error('test transport not configured')
  } }) }
}

function typeCode(interaction: StandalonePlayerInteractionController, code: string): void {
  for (const digit of code) interaction.handleKeyStroke({ key: digit })
}

function requestFor(interaction: StandalonePlayerInteractionController, code: string) {
  typeCode(interaction, code)
  const intent = interaction.handleKeyStroke({ key: 'Enter' })
  assert.ok(intent && intent.type === 'player-command')
  return intent
}

function reply(operationId: string, outcome: StandalonePlayerIpcCommandReply['outcome']): StandalonePlayerIpcCommandReply {
  const envelope = {
    revision: 1,
    snapshot: {
      playbackCondition: 'ready' as const,
      state: { operationalState: 'idle' as const, current: null, pending: [] as const }
    }
  }
  if (outcome === 'confirmed') return { outcome, operationId, envelope }
  return { outcome, operationId, error: { code: outcome === 'rejected' ? 'INVALID_MUSIC_CODE' : 'RECOVERY_PENDING' }, envelope }
}

test('the B2 transport preserves an intent and settles its matching submission from the IPC reply', async () => {
  const { interaction } = build()
  const intent = requestFor(interaction, '1001')
  let received: unknown
  const transport = new StandalonePlayerInteractionTransport(interaction, {
    execute: async request => {
      received = request
      return reply(request.operationId, 'confirmed')
    }
  })
  const result = await transport.dispatch(intent)
  assert.deepEqual(received, intent.request)
  assert.equal(result?.outcome, 'confirmed')
  assert.deepEqual(interaction.getSnapshot().lastSubmission, {
    operationId: intent.request.operationId,
    enteredCode: '1001', priority: 'normal', outcome: 'confirmed'
  })
  interaction.dispose()
})

test('rejected, blocked and uncertain replies remain distinguishable in B2 state', async () => {
  for (const outcome of ['rejected', 'blocked', 'uncertain'] as const) {
    const { interaction } = build()
    const intent = requestFor(interaction, '1001')
    const transport = new StandalonePlayerInteractionTransport(interaction, {
      execute: async request => reply(request.operationId, outcome)
    })
    await transport.dispatch(intent)
    assert.equal(interaction.getSnapshot().lastSubmission?.outcome, outcome)
    assert.equal(interaction.getSnapshot().lastSubmission?.errorCode,
      outcome === 'rejected' ? 'INVALID_MUSIC_CODE' : 'RECOVERY_PENDING')
    interaction.dispose()
  }
})

test('out-of-order replies settle only their own operation and never overwrite the latest submission', async () => {
  const { interaction } = build()
  const first = requestFor(interaction, '1001')
  const second = requestFor(interaction, '1002')
  const firstReply = deferred<StandalonePlayerIpcCommandReply>()
  const secondReply = deferred<StandalonePlayerIpcCommandReply>()
  const transport = new StandalonePlayerInteractionTransport(interaction, {
    execute: request => request.operationId === first.request.operationId ? firstReply.promise : secondReply.promise
  })
  const firstDispatch = transport.dispatch(first)
  const secondDispatch = transport.dispatch(second)
  secondReply.resolve(reply(second.request.operationId, 'blocked'))
  await secondDispatch
  firstReply.resolve(reply(first.request.operationId, 'confirmed'))
  await firstDispatch
  assert.deepEqual(interaction.getSnapshot().lastSubmission, {
    operationId: second.request.operationId,
    enteredCode: '1002', priority: 'normal', outcome: 'blocked', errorCode: 'RECOVERY_PENDING'
  })
  interaction.dispose()
})

test('a lost transport result remains pending for explicit reconciliation or a retry with the same intent', async () => {
  const { interaction } = build()
  const intent = requestFor(interaction, '1001')
  const transport = new StandalonePlayerInteractionTransport(interaction, {
    execute: async () => { throw new Error('transport lost') }
  })
  const pending = transport.dispatch(intent)
  assert.ok(pending)
  await assert.rejects(pending, /transport lost/)
  assert.equal(interaction.getSnapshot().lastSubmission?.outcome, 'pending')
  interaction.dispose()
})

test('the transport rejects mismatched correlation and does not settle another operation', async () => {
  const { interaction } = build()
  const intent = requestFor(interaction, '1001')
  const transport = new StandalonePlayerInteractionTransport(interaction, {
    execute: async () => reply('different-operation', 'confirmed')
  })
  const pending = transport.dispatch(intent)
  assert.ok(pending)
  await assert.rejects(pending, /STANDALONE_IPC_INVALID_RESPONSE/)
  assert.equal(interaction.getSnapshot().lastSubmission?.outcome, 'pending')
  interaction.dispose()
})

test('an application exit intent is local and is never sent through the playback IPC port', () => {
  const { interaction } = build()
  interaction.handleKeyStroke({ key: 'Escape' })
  interaction.selectMenuAction('exit')
  const intent = interaction.resolveExitConfirmation(true)
  assert.deepEqual(intent, { type: 'request-application-exit' })
  const result = new StandalonePlayerInteractionTransport(interaction, {
    execute: async () => { throw new Error('must not be called') }
  }).dispatch(intent!)
  assert.equal(result, undefined)
  interaction.dispose()
})
