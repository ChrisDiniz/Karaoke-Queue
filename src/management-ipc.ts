import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import type { FileLogger } from './logging'
import type { MainManagementHost } from './main-management-host'
import type { ManagementCommand, ManagementCommandRequest } from './management-contracts'
import type { ManagementSnapshot } from './management-contracts'
import type { NewQueueEntry } from './application'
import { LEGACY_STATE_STORAGE_KEYS, PersistenceError, type LegacyStateStorageDto } from './persistence-contracts'

export interface ManagementIpcDependencies {
  ipcMain: IpcMain
  host: MainManagementHost
  logger: Pick<FileLogger, 'warn' | 'error'>
  assertSender(event: IpcMainInvokeEvent): void
  sendState(snapshot: import('./management-contracts').ManagementSnapshot): void
  initializeHost(legacyState: LegacyStateStorageDto): Promise<ManagementSnapshot>
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

const MAX_LEGACY_STORAGE_BYTES = 32 * 1024 * 1024

export function validateLegacyStateStorageDto(value: unknown): LegacyStateStorageDto {
  const keys = Object.values(LEGACY_STATE_STORAGE_KEYS)
  if (!record(value) || !exactKeys(value, keys)) throw new Error('INVALID_MANAGEMENT_LEGACY_STORAGE')
  let bytes = 0
  const result: Record<string, string | null> = {}
  for (const key of keys) {
    const item = value[key]
    if (item !== null && typeof item !== 'string') throw new Error('INVALID_MANAGEMENT_LEGACY_STORAGE')
    if (typeof item === 'string') bytes += Buffer.byteLength(item, 'utf8')
    if (bytes > MAX_LEGACY_STORAGE_BYTES) throw new Error('MANAGEMENT_LEGACY_STORAGE_TOO_LARGE')
    result[key] = item as string | null
  }
  return result as LegacyStateStorageDto
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200
}

function validEntry(value: unknown): value is NewQueueEntry {
  return record(value) && exactKeys(value, ['name', 'songNumber', 'songNumber2', 'table']) &&
    ['name', 'songNumber', 'songNumber2', 'table'].every(key => typeof value[key] === 'string' && (value[key] as string).length <= 500)
}

export function validateManagementCommandRequest(value: unknown): ManagementCommandRequest {
  if (!record(value) || !exactKeys(value, ['operationId', 'command']) ||
      typeof value.operationId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value.operationId) || !record(value.command)) {
    throw new Error('INVALID_MANAGEMENT_COMMAND_REQUEST')
  }
  const command = value.command
  const oneId = (type: string): ManagementCommand => {
    if (!exactKeys(command, ['type', 'id']) || command.type !== type || !validId(command.id)) throw new Error('INVALID_MANAGEMENT_COMMAND_PAYLOAD')
    return { type, id: command.id } as ManagementCommand
  }
  switch (command.type) {
    case 'addEntries':
      if (!exactKeys(command, ['type', 'entries', 'selectCurrent']) || !Array.isArray(command.entries) ||
          command.entries.length > 500 || !command.entries.every(validEntry) || typeof command.selectCurrent !== 'boolean') {
        throw new Error('INVALID_MANAGEMENT_COMMAND_PAYLOAD')
      }
      return { operationId: value.operationId, command: { type: 'addEntries', entries: structuredClone(command.entries), selectCurrent: command.selectCurrent } }
    case 'editEntry':
      if (!exactKeys(command, ['type', 'id', 'input']) || !validId(command.id) || !validEntry(command.input)) throw new Error('INVALID_MANAGEMENT_COMMAND_PAYLOAD')
      return { operationId: value.operationId, command: { type: 'editEntry', id: command.id, input: structuredClone(command.input) } }
    case 'moveTurn':
      if (!exactKeys(command, ['type', 'id', 'targetPosition']) || !validId(command.id) ||
          !Number.isSafeInteger(command.targetPosition) || (command.targetPosition as number) < 1 || (command.targetPosition as number) > 10000) {
        throw new Error('INVALID_MANAGEMENT_COMMAND_PAYLOAD')
      }
      return { operationId: value.operationId, command: { type: 'moveTurn', id: command.id, targetPosition: command.targetPosition as number } }
    case 'cancelAndAdvance': case 'completeAndAdvance': case 'pinNext': case 'unpin':
    case 'promoteToCurrent': case 'freezeThrough':
      return { operationId: value.operationId, command: oneId(command.type) }
    case 'resetTableHistory':
      if (!exactKeys(command, ['type', 'table']) || typeof command.table !== 'string' || command.table.length > 200) throw new Error('INVALID_MANAGEMENT_COMMAND_PAYLOAD')
      return { operationId: value.operationId, command: { type: 'resetTableHistory', table: command.table } }
    case 'releaseFreeze': case 'startNewSession': case 'ensureSession': case 'recoverPersistence':
      if (!exactKeys(command, ['type'])) throw new Error('INVALID_MANAGEMENT_COMMAND_PAYLOAD')
      return { operationId: value.operationId, command: { type: command.type } }
    default: throw new Error('INVALID_MANAGEMENT_COMMAND_TYPE')
  }
}

export function registerManagementIpcHandlers(deps: ManagementIpcDependencies): () => void {
  const channels: string[] = []
  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    unsubscribe()
    for (const channel of channels.splice(0).reverse()) deps.ipcMain.removeHandler(channel)
  }
  const handle = (channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => {
    try { deps.ipcMain.handle(channel, listener); channels.push(channel) }
    catch (error) { dispose(); throw error }
  }
  const unsubscribe = deps.host.subscribe(deps.sendState)
  try {
    handle('management:initialize', async (event, payload) => {
      deps.assertSender(event)
      return deps.initializeHost(validateLegacyStateStorageDto(payload))
    })
    handle('management:snapshot', event => {
      deps.assertSender(event)
      return deps.host.snapshot()
    })
    handle('management:command', async (event, payload) => {
      deps.assertSender(event)
      const request = validateManagementCommandRequest(payload)
      try { return await deps.host.execute(request) } catch (error) {
        if (error instanceof PersistenceError) {
          if (error.outcome !== 'rejected') {
            deps.logger.error('sqlite', 'SQLITE_SAVE_FAILED', 'Falha ao confirmar a operação operacional da Gestão.', error)
          }
          throw new Error(`KQ_PERSISTENCE_ERROR:${error.outcome}:${error.message}`)
        }
        throw error
      }
    })
    handle('management:acknowledge', (event, operationId) => {
      deps.assertSender(event)
      if (typeof operationId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(operationId)) {
        throw new Error('INVALID_MANAGEMENT_OPERATION_ID')
      }
      deps.host.acknowledge(operationId)
      return true
    })
    handle('management:flush', async event => {
      deps.assertSender(event)
      await deps.host.flush()
      return true
    })
  } catch (error) {
    deps.logger.warn('ipc', 'MANAGEMENT_IPC_REGISTRATION_FAILED', 'Falha ao registrar o adapter IPC de Gestão.', undefined, {
      error: error instanceof Error ? error.message : String(error)
    })
    dispose()
    throw error
  }
  return dispose
}
