import { randomUUID } from 'node:crypto'
import { OperationalProtocolService } from './operational-protocol-service'
import type { PlayerOperationalStore } from './player-operational-store'
import { PlayerOperationalStore as PlayerOperationalStoreConstructor } from './player-operational-store'
import { parseOperationalMessageObject } from './operational-protocol-validation'
import type { OperationalMessage } from './operational-protocol-contracts'
import type { RemoteAuthorizationPort, RemoteTransportMessageContext, RemoteTransportMessagePort } from './remote-contracts'

export type PlayerOperationalObservedStatus =
  | 'idle' | 'waiting-turn' | 'presenting' | 'loading' | 'playing' | 'paused'
  | 'transitioning-track' | 'celebrating' | 'uncertain' | 'error'

export interface PlayerOperationalObservation {
  readonly playbackStatus: string
  readonly libraryRevision: string
}

export interface MainPlayerOperationalEndpoint {
  readonly playerEpoch: string
  readonly messagePort: RemoteTransportMessagePort
  close(): Promise<{ readonly state: 'idle' | 'blocked' | 'closed'; readonly activeExecutions: number;
    readonly pendingAdmissions: number }>
}

function observedStatus(status: string): PlayerOperationalObservedStatus {
  switch (status) {
    case 'idle': case 'stopped': case 'completed': return 'idle'
    case 'loading': case 'ready': case 'starting': return 'loading'
    case 'playing': return 'playing'
    case 'paused': return 'paused'
    case 'stopping': return 'transitioning-track'
    case 'uncertain': return 'uncertain'
    case 'failed': case 'disposed': return 'error'
    default: return 'uncertain'
  }
}

function safeLibraryRevision(value: string): string {
  return /^[\x21-\x7e]{1,128}$/.test(value) ? value : 'library-unavailable'
}

const allowedQueries = new Set(['snapshot', 'operation-status', 'journal-page'])

/** G5 Player endpoint: existing G3 durable queries behind the real G2 authorization, with H mutations fenced. */
export function createMainPlayerOperationalEndpoint(options: {
  readonly userDataDirectory: string
  readonly deviceId: string
  readonly authorization: RemoteAuthorizationPort
  readonly observe: () => PlayerOperationalObservation
}): MainPlayerOperationalEndpoint {
  const playerEpoch = randomUUID()
  const hostEpoch = randomUUID()
  // G2 credential rotation is authentication maintenance, not a G4 authority/mode
  // transition. Keep this fence stable for the Player process lifetime.
  const controlEpoch = randomUUID()
  const store: PlayerOperationalStore = new PlayerOperationalStoreConstructor({
    userDataDirectory: options.userDataDirectory,
    journalId: `journal-${options.deviceId}`,
    deviceId: options.deviceId,
    initializeIfMissing: true
  })
  let checkpointSnapshot: Record<string, unknown> | undefined
  const service = new OperationalProtocolService({
    store,
    authorization: options.authorization,
    deviceId: options.deviceId,
    playerEpoch,
    controlEpoch: () => controlEpoch,
    // A direct G3 command cannot cross the Player owner without H's approved target/execution adapter.
    isTargetCurrent: () => false,
    snapshotPort: {
      snapshot() {
        // G3's journal projection and G4 control epoch remain stable across G2 credential renewal.
        if (checkpointSnapshot) return checkpointSnapshot
        const metadata = store.getMetadata()
        const observation = options.observe()
        const status = observedStatus(observation.playbackStatus)
        const libraryRevision = safeLibraryRevision(observation.libraryRevision)
        checkpointSnapshot = {
          journalId: metadata.journalId,
          deviceId: metadata.deviceId,
          playerEpoch,
          hostEpoch,
          controlEpoch,
          stateRevision: 0,
          mode: 'paired',
          observedState: { status },
          acceptedTurn: null,
          active: null,
          libraryRevision,
          highWatermark: metadata.highWatermark,
          compactedThrough: metadata.compactedThrough,
          // This endpoint rejects all command admission, so no G5 operation is represented as accepted.
          operations: []
        }
        return checkpointSnapshot
      },
      mediaAvailability() { throw new Error('REMOTE_MEDIA_QUERY_NOT_ENABLED') }
    }
  })

  const messagePort: RemoteTransportMessagePort = {
    async onMessage(context) {
      const message = parseOperationalMessageObject(context.payload) as OperationalMessage
      if (message.kind === 'hello' || message.kind === 'query' && allowedQueries.has(message.body.type)) {
        await service.onMessage(context)
        return
      }
      const denied = parseOperationalMessageObject({
        protocolVersion: 1,
        schemaVersion: 1,
        kind: 'error',
        messageId: randomUUID(),
        deviceId: options.deviceId,
        controllerId: context.channel.peer.controllerId,
        body: { correlationId: message.messageId, code: 'NOT_AUTHORIZED', state: 'business-control-not-enabled' }
      })
      context.channel.send(JSON.stringify(denied))
    }
  }

  return {
    playerEpoch,
    messagePort,
    async close() {
      const drained = await service.close()
      if (drained.state === 'closed') store.close()
      return drained
    }
  }
}
