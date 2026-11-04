import type {
  StandalonePlayerCommandRequest,
  StandalonePlayerError,
  StandalonePlayerSnapshot
} from './standalone-player-contracts'

export const enum STANDALONE_PLAYER_IPC_CHANNELS {
  getSnapshot = 'standalone:v1:get-snapshot',
  execute = 'standalone:v1:execute',
  subscribe = 'standalone:v1:subscribe',
  unsubscribe = 'standalone:v1:unsubscribe',
  snapshotChanged = 'standalone:v1:snapshot-changed'
}

export interface StandalonePlayerSnapshotEnvelope {
  readonly revision: number
  readonly snapshot: StandalonePlayerSnapshot
}

export interface StandalonePlayerSubscriptionRef {
  readonly subscriptionId: string
  /** Main-issued generation makes a delayed unsubscribe from a previous document harmless. */
  readonly generation: number
}

export interface StandalonePlayerSnapshotUpdate extends StandalonePlayerSubscriptionRef {
  readonly envelope: StandalonePlayerSnapshotEnvelope
}

export type StandalonePlayerIpcCommandReply =
  | {
      readonly outcome: 'confirmed'
      readonly operationId: string
      readonly attemptId?: string
      readonly envelope: StandalonePlayerSnapshotEnvelope
    }
  | {
      readonly outcome: 'rejected' | 'blocked' | 'uncertain'
      readonly operationId: string
      readonly error: StandalonePlayerError
      readonly attemptId?: string
      readonly envelope: StandalonePlayerSnapshotEnvelope
    }

export interface StandalonePlayerRendererApi {
  getSnapshot(): Promise<StandalonePlayerSnapshotEnvelope>
  execute(request: StandalonePlayerCommandRequest): Promise<StandalonePlayerIpcCommandReply>
  /** Calls listener with a consistent initial snapshot before resolving, then with newer revisions only. */
  subscribe(listener: (envelope: StandalonePlayerSnapshotEnvelope) => void): Promise<StandalonePlayerSubscriptionRef>
  unsubscribe(subscription: StandalonePlayerSubscriptionRef): Promise<boolean>
}

export interface StandalonePlayerMainIpcBridgeOptions {
  readonly ipcMain: Electron.IpcMain
  readonly webContents: Electron.WebContents
  readonly expectedDocumentUrl: string
  readonly control: import('./standalone-player-contracts').StandalonePlayerControl
}
