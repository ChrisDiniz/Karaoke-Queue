import type { StandalonePlayerCommandRequest } from './standalone-player-contracts'
import type { StandalonePlayerRendererApi, StandalonePlayerIpcCommandReply } from './standalone-player-ipc-contracts'
import type {
  StandalonePlayerInteractionController,
  StandalonePlayerInteractionIntent
} from './standalone-player-interaction'

/** A narrow transport seam; implementations must preserve the request's operationId and payload. */
export type StandalonePlayerCommandTransportPort = Pick<StandalonePlayerRendererApi, 'execute'>

/** Sends B2 intents through the authorized Preload API and feeds the correlated outcome back to B2. */
export class StandalonePlayerInteractionTransport {
  constructor(
    private readonly interaction: StandalonePlayerInteractionController,
    private readonly transport: StandalonePlayerCommandTransportPort
  ) {}

  dispatch(intent: StandalonePlayerInteractionIntent): Promise<StandalonePlayerIpcCommandReply> | undefined {
    if (intent.type !== 'player-command') return undefined
    const request: StandalonePlayerCommandRequest = intent.request
    return this.transport.execute(request).then(reply => {
      if (reply.operationId !== request.operationId) throw new Error('STANDALONE_IPC_INVALID_RESPONSE')
      this.interaction.applyCommandOutcome({
        operationId: reply.operationId,
        outcome: reply.outcome,
        ...('error' in reply ? { errorCode: reply.error.code } : {})
      })
      return reply
    })
  }
}
