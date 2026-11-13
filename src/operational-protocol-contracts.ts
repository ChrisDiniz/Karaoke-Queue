/** Wire contracts for kq-operation/1. These types grant no authority. */
export const OPERATIONAL_PROTOCOL = 'kq-operation/1' as const
export const OPERATIONAL_PROTOCOL_VERSION = 1 as const
export const OPERATIONAL_SCHEMA_VERSION = 1 as const
export const OPERATIONAL_LIMITS = Object.freeze({
  maxEnvelopeBytes: 64 * 1024, maxRecordBytes: 8 * 1024, maxPackageBytes: 8 * 1024,
  maxStringCharacters: 256, maxStringBytes: 1024, maxErrorBytes: 256,
  maxPageEvents: 32, maxSnapshotOperations: 32, maxMusicTracks: 2,
  maxDepth: 8, maxNodes: 4096, maxArrayItems: 128, maxObjectKeys: 32, maxKeyCharacters: 64
})
export const OPERATIONAL_ERROR_CODES = [
  'INVALID_MESSAGE','UNSUPPORTED_VERSION','NOT_AUTHORIZED','BUSY','STALE_TARGET','OPERATION_ID_CONFLICT',
  'TURN_ALREADY_ACCEPTED','MEDIA_UNAVAILABLE','STORAGE_UNAVAILABLE','RESULT_UNCERTAIN','JOURNAL_MISMATCH',
  'CURSOR_GAP','REPLAY_COMPACTED'
] as const
export type OperationalErrorCode = typeof OPERATIONAL_ERROR_CODES[number]
export type OperationalKind = 'hello'|'ready'|'command'|'query'|'response'|'event'|'ack'|'error'
export interface OperationalEnvelope<K extends OperationalKind = OperationalKind, B = unknown> {
  protocolVersion: 1; schemaVersion: 1; kind: K; messageId: string; deviceId: string; controllerId: string; body: B
}
export type OperationalMessage =
  | OperationalEnvelope<'hello', { protocol:'kq-operation/1'; protocolVersion:1; schemaVersion:1 }>
  | OperationalEnvelope<'ready', { protocol:'kq-operation/1'; protocolVersion:1; schemaVersion:1; journalId:string; playerEpoch:string; controlEpoch:string }>
  | OperationalEnvelope<'command', OperationalCommandBody>
  | OperationalEnvelope<'query', OperationalQueryBody>
  | OperationalEnvelope<'response', { correlationId:string; type:OperationalQueryType; payload:Record<string,unknown> }>
  | OperationalEnvelope<'event', JournalEvent>
  | OperationalEnvelope<'ack', { correlationId:string; type:'consumed'; payload:{journalId:string;throughSequence:number;consumerId:string} }>
  | OperationalEnvelope<'error', { correlationId:string|null; code:OperationalErrorCode; state:string }>
export interface ActivationTarget { sessionId:string; turnId:string; controlEpoch:string; playerEpoch:string; stateRevision:number }
export interface ActiveTarget extends ActivationTarget { occurrenceId:string; attemptId:string }
export type OperationalTarget = ActivationTarget | ActiveTarget
export interface TrackOccurrence { occurrenceId:string; trackIndex:1|2; musicCode:string }
export interface ActivateTurnPayload { packageRevision:number; managementRevision:number; singerName:string; table:string; tracks:TrackOccurrence[] }
export type OperationalCommandType = 'activate-turn'|'pause'|'resume'|'restart'|'advance'|'replace-current'
export interface OperationalCommandBody { operationId:string; type:OperationalCommandType; target:OperationalTarget; payload:ActivateTurnPayload|{musicCode:string}|Record<string, never> }
export type OperationalQueryType = 'media-availability'|'operation-status'|'snapshot'|'journal-page'
export interface OperationalQueryBody { queryId:string; type:OperationalQueryType; payload:Record<string,unknown> }
export interface OperationStatusPayload {
  operationId:string; fingerprint:string|null; status:'not-found'|'accepted'|'completed'|'rejected'|'unknown';
  result:Record<string,unknown>|null; eventSequence:number|null
}
export type OperationalEventType = 'turn-accepted'|'attempt-started'|'natural-end-confirmed'|'cancelled'|'restarted'|'media-replaced'|'stop-all'|'turn-ended'|'playback-error'|'interrupted'|'uncertain'|'control-mode-changed'|'operation-result'
export type OperationalEventPayload =
  | {type:'turn-accepted';payload:{packageRevision:number}}
  | {type:'attempt-started'|'natural-end-confirmed'|'restarted';payload:{musicCode:string}}
  | {type:'cancelled';payload:{musicCode:string;reason:string}}
  | {type:'media-replaced';payload:{previousMusicCode:string;musicCode:string}}
  | {type:'stop-all';payload:{reason:string}}
  | {type:'turn-ended';payload:{outcome:'completed'|'cancelled'|'uncertain'}}
  | {type:'playback-error';payload:{code:string}}
  | {type:'interrupted'|'uncertain';payload:{reason:string}}
  | {type:'control-mode-changed';payload:{mode:'paired'|'offline'|'reconciling'}}
  | {type:'operation-result';payload:{operationId:string;status:'accepted'|'completed'|'rejected'|'unknown'}}
export type JournalEvent = {journalId:string;eventSequence:number;schemaVersion:1;causationOperationId:string;sessionId?:string;turnId?:string;occurrenceId?:string;attemptId?:string;stateRevision:number;origin?:'local'|'remote'|'manual'} & OperationalEventPayload
export const OPERATIONAL_EVENT_TYPES: readonly OperationalEventType[] = Object.freeze(['turn-accepted','attempt-started','natural-end-confirmed','cancelled','restarted','media-replaced','stop-all','turn-ended','playback-error','interrupted','uncertain','control-mode-changed','operation-result'])
