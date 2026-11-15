import { randomUUID } from 'node:crypto'
import os from 'node:os'
import { isIP } from 'node:net'
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'
import type { OperatingMode } from './operating-mode'
import type { PairingPresentationPort } from './pairing-bootstrap'
import type { PairingManagementPresentationPort } from './pairing-controller'
import type { MainRemoteRuntime } from './main-remote-runtime'
import type { ManagementRemoteDatabase } from './main-remote-reconnection'
import type { PlayerPairingUiEvent, ManagementPairingUiEvent, RemoteUiSnapshot } from './remote-ui-contracts'

const SNAPSHOT_CHANNEL = 'remote-ui:snapshot'
const PLAYER_PAIRING_CHANNEL = 'remote-ui:player:pairing-event'
const MANAGEMENT_PAIRING_CHANNEL = 'remote-ui:management:pairing-event'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
// G1 accepts an ephemeral port only on loopback; the LAN listener needs a
// valid port that can be advertised through DNS-SD.
const PLAYER_PAIRING_LISTENER_PORT = 47831

export interface MainRemoteUiIpcDependencies {
  readonly ipcMain: Pick<IpcMain, 'handle' | 'removeHandler'>
  readonly mode: OperatingMode
  readonly runtime: MainRemoteRuntime
  readonly getPlayerWindow: () => BrowserWindow | null
  readonly getManagementWindow: () => BrowserWindow | null
  readonly assertPlayerSender: (event: IpcMainInvokeEvent) => void
  readonly assertManagementSender: (event: IpcMainInvokeEvent) => void
  readonly getInterfaceAddresses: () => readonly string[]
  readonly getManagementDatabase: () => ManagementRemoteDatabase | undefined
  readonly pairingPresentationApprovedForProduction: boolean
  readonly onError?: (code: string) => void
}

interface PendingPlayerConsent {
  readonly requestId: string
  readonly revision: number
  resolve(value: boolean): void
  timer: ReturnType<typeof setTimeout>
}

interface ActivePlayerPresentation {
  readonly requestId: string
  readonly revision: number
}

interface ActiveManagementPairing {
  readonly requestId: string
  readonly revision: number
  readonly abort: AbortController
  readonly purpose: 'initial' | 'renewal'
  resolveCode?: (value: string | null) => void
  timer?: ReturnType<typeof setTimeout>
  codeDeadline?: number
  removeAbortListener?: () => void
}

function monotonicNow(): number { return Number(process.hrtime.bigint() / 1_000_000n) }
function errorCode(error: unknown): string {
  const nativeCode = error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code ?? '') : ''
  if (/^[A-Z0-9_]{1,64}$/.test(nativeCode)) return nativeCode
  const value = error instanceof Error ? error.message : ''
  return /^[A-Z0-9_]{1,64}$/.test(value) ? value : 'REMOTE_UI_FAILED'
}
function send<T>(window: BrowserWindow | null, channel: string, payload: T): boolean {
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return false
  window.webContents.send(channel, payload)
  return true
}
function plainReply(outcome: 'started' | 'completed' | 'cancelled' | 'failed', code?: string) {
  return code ? { outcome, code } : { outcome }
}

/** Main-only UI facade for G1/G2/G4. It sends DTOs and never exposes protocol or persistence objects. */
export function registerMainRemoteUiIpcHandlers(deps: MainRemoteUiIpcDependencies): () => void {
  const managementMode = deps.mode === 'combined'
  const playerMode = deps.mode === 'player'
  let disposed = false
  let playerRevision = 0
  let managementRevision = 0
  let activePlayerPresentation: ActivePlayerPresentation | undefined
  let pendingConsent: PendingPlayerConsent | undefined
  let activeManagementPairing: ActiveManagementPairing | undefined

  const playerWindow = (): BrowserWindow | null => playerMode ? deps.getPlayerWindow() : null
  const managementWindow = (): BrowserWindow | null => managementMode ? deps.getManagementWindow() : null
  const playerPresentation: PairingPresentationPort = {
    approvedForProduction: true,
    requestConsent: input => {
      if (activePlayerPresentation || pendingConsent) throw new Error('PAIRING_BUSY')
      const context = { requestId: randomUUID(), revision: ++playerRevision }
      activePlayerPresentation = context
      return new Promise<boolean>(resolve => {
        const remainingMs = Math.max(0, input.expiresAt - monotonicNow())
        const timer = setTimeout(() => {
          if (pendingConsent?.requestId !== context.requestId) return
          pendingConsent = undefined
          resolve(false)
        }, remainingMs)
        pendingConsent = { ...context, resolve, timer }
        const sent = send<PlayerPairingUiEvent>(playerWindow(), PLAYER_PAIRING_CHANNEL, {
          type: 'consent-request', ...context, displayName: input.displayName.slice(0, 64),
          purpose: input.purpose, remainingMs
        })
        if (!sent) {
          clearTimeout(timer)
          pendingConsent = undefined
          resolve(false)
        }
      })
    },
    showTemporaryCode: input => {
      const context = activePlayerPresentation
      if (!context) throw new Error('PAIRING_PRESENTATION_UNAVAILABLE')
      const remainingMs = Math.max(0, input.expiresAt - monotonicNow())
      if (!send<PlayerPairingUiEvent>(playerWindow(), PLAYER_PAIRING_CHANNEL, {
        type: 'temporary-code', ...context, groupedCode: input.groupedCode, remainingMs
      })) throw new Error('PAIRING_PRESENTATION_UNAVAILABLE')
    },
    closePairing: input => {
      const context = activePlayerPresentation
      if (!context) return
      send<PlayerPairingUiEvent>(playerWindow(), PLAYER_PAIRING_CHANNEL, {
        type: 'closed', ...context, outcome: input.outcome
      })
      activePlayerPresentation = undefined
    }
  }

  const validateRequest = (requestId: unknown, revision: unknown): requestId is string =>
    typeof requestId === 'string' && UUID_PATTERN.test(requestId) && Number.isSafeInteger(revision) && Number(revision) >= 0

  const publishSnapshot = (role: 'player' | 'management'): void => {
    if (disposed) return
    void deps.runtime.getRemoteUiSnapshot(role, role === 'management' ? deps.getManagementDatabase() : undefined).then(snapshot => {
      if (disposed) return
      send<RemoteUiSnapshot>(role === 'player' ? playerWindow() : managementWindow(), SNAPSHOT_CHANNEL, snapshot)
    }).catch(error => deps.onError?.(errorCode(error)))
  }
  const unsubscribeRemoteUi = deps.runtime.subscribeRemoteUi(() => {
    if (playerMode) publishSnapshot('player')
    if (managementMode) publishSnapshot('management')
  })
  const onPlayerLoad = (): void => { if (playerMode) publishSnapshot('player') }
  const onManagementLoad = (): void => { if (managementMode) publishSnapshot('management') }
  const playerContents = playerWindow()?.webContents
  const managementContents = managementWindow()?.webContents
  const invalidatePlayerPresentation = (): void => {
    if (!activePlayerPresentation && !pendingConsent) return
    playerRevision++
    if (pendingConsent) {
      clearTimeout(pendingConsent.timer)
      pendingConsent.resolve(false)
      pendingConsent = undefined
    }
    const wasActive = Boolean(activePlayerPresentation)
    activePlayerPresentation = undefined
    if (wasActive) void deps.runtime.cancelPlayerPairing().catch(error => deps.onError?.(errorCode(error)))
  }
  const invalidateManagementPresentation = (): void => {
    const current = activeManagementPairing
    if (!current) return
    managementRevision++
    current.abort.abort()
    if (current.timer) clearTimeout(current.timer)
    current.resolveCode?.(null)
    current.resolveCode = undefined
  }
  const onPlayerNavigation = (_event: Electron.Event, _url: string, _inPlace: boolean, isMainFrame: boolean): void => {
    if (isMainFrame) invalidatePlayerPresentation()
  }
  const onManagementNavigation = (_event: Electron.Event, _url: string, _inPlace: boolean, isMainFrame: boolean): void => {
    if (isMainFrame) invalidateManagementPresentation()
  }
  const onPlayerContentsDestroyed = (): void => invalidatePlayerPresentation()
  const onManagementContentsDestroyed = (): void => invalidateManagementPresentation()
  playerContents?.on('did-finish-load', onPlayerLoad)
  managementContents?.on('did-finish-load', onManagementLoad)
  playerContents?.on('did-start-navigation', onPlayerNavigation)
  managementContents?.on('did-start-navigation', onManagementNavigation)
  playerContents?.once('destroyed', onPlayerContentsDestroyed)
  managementContents?.once('destroyed', onManagementContentsDestroyed)

  const handle = (channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown): void => {
    deps.ipcMain.handle(channel, listener)
  }

  if (managementMode) {
    handle('remote-ui:management:get-snapshot', event => {
      deps.assertManagementSender(event)
      return deps.runtime.getRemoteUiSnapshot('management', deps.getManagementDatabase())
    })
    handle('remote-ui:management:start-discovery', async event => {
      deps.assertManagementSender(event)
      try {
        await deps.runtime.startManagementDiscovery(deps.getInterfaceAddresses())
        return plainReply('started')
      } catch (error) {
        deps.onError?.(errorCode(error))
        return plainReply('failed', errorCode(error))
      }
    })
    handle('remote-ui:management:refresh-discovery', async event => {
      deps.assertManagementSender(event)
      try {
        const discovery = deps.runtime.getCurrentManagementDiscovery()
        if (discovery) await discovery.refresh()
        else await deps.runtime.startManagementDiscovery(deps.getInterfaceAddresses())
        return plainReply('started')
      } catch (error) {
        deps.onError?.(errorCode(error))
        return plainReply('failed', errorCode(error))
      }
    })
    handle('remote-ui:management:query-operation', async (event, playerId: unknown, operationId: unknown) => {
      deps.assertManagementSender(event)
      if (typeof playerId !== 'string' || !UUID_PATTERN.test(playerId) || typeof operationId !== 'string' ||
          operationId.length < 1 || operationId.length > 128 || !/^[A-Za-z0-9_-]+$/.test(operationId)) {
        return plainReply('failed', 'REMOTE_OPERATION_REQUEST_INVALID')
      }
      try {
        const outcome = await deps.runtime.queryRemoteOperationStatus(playerId, operationId)
        return outcome === 'not-found' ? plainReply('completed', 'REMOTE_OPERATION_NOT_FOUND')
          : outcome === 'terminal' ? plainReply('completed', 'REMOTE_OPERATION_TERMINAL')
            : plainReply('completed')
      } catch (error) {
        deps.onError?.(errorCode(error))
        return plainReply('failed', errorCode(error))
      }
    })
    const beginManagementPairing = async (purpose: 'initial' | 'renewal', pair: (
      presentation: PairingManagementPresentationPort, signal: AbortSignal) => Promise<import('./pairing-controller').PairingControllerResult>) => {
      if (!deps.pairingPresentationApprovedForProduction) return plainReply('failed', 'PAIRING_PRESENTATION_UNAPPROVED')
      if (activeManagementPairing) return plainReply('failed', 'PAIRING_BUSY')
      const context: ActiveManagementPairing = {
        requestId: randomUUID(), revision: ++managementRevision, abort: new AbortController(), purpose
      }
      activeManagementPairing = context
      const presentation: PairingManagementPresentationPort = {
        approvedForProduction: deps.pairingPresentationApprovedForProduction,
        enterTemporaryCode: input => new Promise<string | null>(resolve => {
          if (activeManagementPairing !== context || context.abort.signal.aborted) { resolve(null); return }
          const remainingMs = Math.max(0, input.expiresAt - monotonicNow())
          context.codeDeadline = input.expiresAt
          let settled = false
          const finish = (value: string | null): void => {
            if (settled) return
            settled = true
            if (context.timer) clearTimeout(context.timer)
            context.timer = undefined
            context.removeAbortListener?.()
            context.removeAbortListener = undefined
            context.resolveCode = undefined
            resolve(value)
          }
          context.resolveCode = finish
          context.timer = setTimeout(() => {
            if (activeManagementPairing !== context) return
            finish(null)
          }, remainingMs)
          const abort = (): void => finish(null)
          context.removeAbortListener = () => input.signal.removeEventListener('abort', abort)
          input.signal.addEventListener('abort', abort, { once: true })
          const sent = send<ManagementPairingUiEvent>(managementWindow(), MANAGEMENT_PAIRING_CHANNEL, {
            type: 'code-request', requestId: context.requestId, revision: context.revision,
            playerName: input.playerName.slice(0, 64), remainingMs, purpose: context.purpose
          })
          if (!sent) abort()
        }),
        closePairing: input => {
          send<ManagementPairingUiEvent>(managementWindow(), MANAGEMENT_PAIRING_CHANNEL, {
            type: 'closed', requestId: context.requestId, revision: context.revision, outcome: input.outcome
          })
        }
      }
      send<ManagementPairingUiEvent>(managementWindow(), MANAGEMENT_PAIRING_CHANNEL, {
        type: 'waiting-consent', requestId: context.requestId, revision: context.revision,
        playerName: 'Player selecionado', purpose
      })
      try {
        const result = await pair(presentation, context.abort.signal)
        try { await deps.runtime.acceptG2PairingUpdate(result.playerId) }
        catch (error) {
          deps.onError?.(errorCode(error))
          return plainReply('completed', 'PAIRING_CONFIRMED_CONNECTION_BLOCKED')
        }
        const database = deps.getManagementDatabase()
        if (!database) return plainReply('completed', 'REMOTE_RECONNECTION_UNAVAILABLE')
        try { await deps.runtime.enableManagementReconnection(database, deps.getInterfaceAddresses()) }
        catch (error) {
          deps.onError?.(errorCode(error))
          return plainReply('completed', errorCode(error))
        }
        return plainReply('completed', result.phase === 'active-awaiting-reconciliation' ? undefined : 'PAIRING_RESULT_UNCERTAIN')
      } catch (error) {
        deps.onError?.(errorCode(error))
        return plainReply(context.abort.signal.aborted ? 'cancelled' : 'failed', errorCode(error))
      } finally {
        if (context.timer) clearTimeout(context.timer)
        context.resolveCode?.(null)
        if (activeManagementPairing === context) activeManagementPairing = undefined
      }
    }
    handle('remote-ui:management:pair', async (event, candidateId: unknown) => {
      deps.assertManagementSender(event)
      if (typeof candidateId !== 'string' || !UUID_PATTERN.test(candidateId)) return plainReply('failed', 'REMOTE_CANDIDATE_INVALID')
      return beginManagementPairing('initial', (presentation, signal) =>
        deps.runtime.pairWithDiscoveredCandidate(candidateId, presentation, signal, 'initial'))
    })
    handle('remote-ui:management:pair-renewal', async (event, candidateId: unknown) => {
      deps.assertManagementSender(event)
      if (typeof candidateId !== 'string' || !UUID_PATTERN.test(candidateId)) return plainReply('failed', 'REMOTE_CANDIDATE_INVALID')
      return beginManagementPairing('renewal', (presentation, signal) =>
        deps.runtime.pairWithDiscoveredCandidate(candidateId, presentation, signal, 'renewal'))
    })
    handle('remote-ui:management:pair-recover', async (event, playerId: unknown, candidateId: unknown) => {
      deps.assertManagementSender(event)
      if (typeof playerId !== 'string' || !UUID_PATTERN.test(playerId) ||
          typeof candidateId !== 'string' || !UUID_PATTERN.test(candidateId)) return plainReply('failed', 'REMOTE_CANDIDATE_INVALID')
      if (!deps.pairingPresentationApprovedForProduction) return plainReply('failed', 'PAIRING_PRESENTATION_UNAPPROVED')
      if (activeManagementPairing) return plainReply('failed', 'PAIRING_BUSY')
      const context: ActiveManagementPairing = {
        requestId: randomUUID(), revision: ++managementRevision, abort: new AbortController(), purpose: 'initial'
      }
      activeManagementPairing = context
      send<ManagementPairingUiEvent>(managementWindow(), MANAGEMENT_PAIRING_CHANNEL, {
        type: 'recovery-started', requestId: context.requestId, revision: context.revision,
        playerName: `Player ${playerId.slice(0, 8)}`
      })
      try {
        const result = await deps.runtime.recoverManagementPairing(playerId, candidateId, {
          approvedForProduction: true,
          enterTemporaryCode: async () => { throw new Error('PAIRING_RECOVERY_CODE_NOT_REQUIRED') }
        }, context.abort.signal)
        await deps.runtime.acceptG2PairingUpdate(result.playerId)
        const database = deps.getManagementDatabase()
        if (!database) return plainReply('completed', 'REMOTE_RECONNECTION_UNAVAILABLE')
        try { await deps.runtime.enableManagementReconnection(database, deps.getInterfaceAddresses()) }
        catch (error) {
          deps.onError?.(errorCode(error))
          return plainReply('completed', errorCode(error))
        }
        return plainReply('completed', result.phase === 'active-awaiting-reconciliation' ? undefined : 'PAIRING_RESULT_UNCERTAIN')
      } catch (error) {
        deps.onError?.(errorCode(error))
        return plainReply(context.abort.signal.aborted ? 'cancelled' : 'failed', errorCode(error))
      } finally {
        if (activeManagementPairing === context) activeManagementPairing = undefined
      }
    })
    handle('remote-ui:management:pair-manual', async (event, address: unknown, port: unknown) => {
      deps.assertManagementSender(event)
      if (typeof address !== 'string' || address.length > 45 || !Number.isSafeInteger(port) || Number(port) < 1024 || Number(port) > 65535) {
        return plainReply('failed', 'REMOTE_MANUAL_ENDPOINT_INVALID')
      }
      return beginManagementPairing('initial', (presentation, signal) =>
        deps.runtime.pairWithManualAddress(address, Number(port), presentation, signal))
    })
    handle('remote-ui:management:revoke-local', async (event, playerId: unknown) => {
      deps.assertManagementSender(event)
      if (typeof playerId !== 'string' || !UUID_PATTERN.test(playerId)) return plainReply('failed', 'REMOTE_DEVICE_INVALID')
      try {
        await deps.runtime.revokeManagementPeerLocally(playerId)
        return plainReply('completed', 'LOCAL_ONLY')
      } catch (error) {
        deps.onError?.(errorCode(error))
        return plainReply('failed', errorCode(error))
      }
    })
    handle('remote-ui:management:submit-code', (event, requestId: unknown, revision: unknown, code: unknown) => {
      deps.assertManagementSender(event)
      const current = activeManagementPairing
      if (!validateRequest(requestId, revision) || !current || requestId !== current.requestId || revision !== current.revision ||
          typeof code !== 'string' || !/^\d{8}$/.test(code) || !current.resolveCode ||
          current.codeDeadline === undefined || current.codeDeadline <= monotonicNow()) return false
      const resolve = current.resolveCode
      resolve(code)
      return true
    })
    handle('remote-ui:management:cancel-pairing', (event, requestId: unknown, revision: unknown) => {
      deps.assertManagementSender(event)
      const current = activeManagementPairing
      if (!validateRequest(requestId, revision) || !current || requestId !== current.requestId || revision !== current.revision) return false
      current.abort.abort()
      if (current.timer) clearTimeout(current.timer)
      current.resolveCode?.(null)
      current.resolveCode = undefined
      return true
    })
  }

  if (playerMode) {
    handle('remote-ui:player:is-available', event => {
      deps.assertPlayerSender(event)
      return true
    })
  } else {
    handle('remote-ui:player:is-available', event => {
      deps.assertPlayerSender(event)
      return false
    })
  }

  if (playerMode) {
    handle('remote-ui:player:get-snapshot', event => {
      deps.assertPlayerSender(event)
      return deps.runtime.getRemoteUiSnapshot('player')
    })
    handle('remote-ui:player:get-interfaces', event => {
      deps.assertPlayerSender(event)
      return deps.getInterfaceAddresses().map(address => ({ address, label: address }))
    })
    handle('remote-ui:player:enable-discovery', async (event, interfaceAddress: unknown) => {
      deps.assertPlayerSender(event)
      if (typeof interfaceAddress !== 'string' || isIP(interfaceAddress) !== 4 ||
          !deps.getInterfaceAddresses().includes(interfaceAddress)) return plainReply('failed', 'REMOTE_DISCOVERY_INTERFACE_INVALID')
      try {
        if (!deps.pairingPresentationApprovedForProduction) return plainReply('failed', 'PAIRING_PRESENTATION_UNAPPROVED')
        await deps.runtime.setRemoteControlIntent('enabled')
        await deps.runtime.configurePlayerPairingPresentation(playerPresentation)
        await deps.runtime.startPlayer({
          interfaceAddress, displayName: (os.hostname().trim() || 'Karaoke Player').slice(0, 64),
          port: PLAYER_PAIRING_LISTENER_PORT, authorization: deps.runtime.createPlayerPairingAuthorization()
        })
        return plainReply('started')
      } catch (error) {
        deps.onError?.(errorCode(error))
        return plainReply('failed', errorCode(error))
      }
    })
    handle('remote-ui:player:disable-discovery', async event => {
      deps.assertPlayerSender(event)
      try {
        await deps.runtime.setRemoteControlIntent('offline')
        return plainReply('completed')
      } catch (error) {
        deps.onError?.(errorCode(error))
        return plainReply('failed', errorCode(error))
      }
    })
    handle('remote-ui:player:renew-certificate', async (event, interfaceAddress: unknown) => {
      deps.assertPlayerSender(event)
      if (!deps.pairingPresentationApprovedForProduction) return plainReply('failed', 'PAIRING_PRESENTATION_UNAPPROVED')
      if (typeof interfaceAddress !== 'string' || isIP(interfaceAddress) !== 4 ||
          !deps.getInterfaceAddresses().includes(interfaceAddress)) return plainReply('failed', 'REMOTE_DISCOVERY_INTERFACE_INVALID')
      try {
        await deps.runtime.startGuidedPlayerCertificateRenewal({ interfaceAddress,
          displayName: (os.hostname().trim() || 'Karaoke Player').slice(0, 64), port: PLAYER_PAIRING_LISTENER_PORT,
          authorization: deps.runtime.createPlayerPairingAuthorization(), presentation: playerPresentation })
        return plainReply('started')
      } catch (error) {
        deps.onError?.(errorCode(error))
        return plainReply('failed', errorCode(error))
      }
    })
    handle('remote-ui:player:revoke-pairing', async event => {
      deps.assertPlayerSender(event)
      try {
        await deps.runtime.revokePlayerPairingLocally()
        return plainReply('completed', 'LOCAL_PLAYER_REVOKED')
      } catch (error) {
        deps.onError?.(errorCode(error))
        return plainReply('failed', errorCode(error))
      }
    })
    handle('remote-ui:player:answer-consent', (event, requestId: unknown, revision: unknown, accepted: unknown) => {
      deps.assertPlayerSender(event)
      const current = pendingConsent
      if (!validateRequest(requestId, revision) || !current || requestId !== current.requestId || revision !== current.revision ||
          typeof accepted !== 'boolean') return false
      clearTimeout(current.timer)
      pendingConsent = undefined
      current.resolve(accepted)
      return true
    })
    handle('remote-ui:player:cancel-pairing', async (event, requestId: unknown, revision: unknown) => {
      deps.assertPlayerSender(event)
      if (!validateRequest(requestId, revision) || !activePlayerPresentation ||
          requestId !== activePlayerPresentation.requestId || revision !== activePlayerPresentation.revision) {
        return plainReply('failed', 'PAIRING_REQUEST_STALE')
      }
      if (pendingConsent?.requestId === requestId) {
        clearTimeout(pendingConsent.timer)
        const current = pendingConsent
        pendingConsent = undefined
        current.resolve(false)
        return plainReply('cancelled')
      }
      try {
        const cancelled = await deps.runtime.cancelPlayerPairing()
        return cancelled ? plainReply('cancelled') : plainReply('failed', 'PAIRING_RESULT_UNCERTAIN')
      } catch (error) {
        deps.onError?.(errorCode(error))
        return plainReply('failed', errorCode(error))
      }
    })
  }

  const unsubscribeLoadHandlers = (): void => {
    playerContents?.removeListener('did-finish-load', onPlayerLoad)
    managementContents?.removeListener('did-finish-load', onManagementLoad)
    playerContents?.removeListener('did-start-navigation', onPlayerNavigation)
    managementContents?.removeListener('did-start-navigation', onManagementNavigation)
    playerContents?.removeListener('destroyed', onPlayerContentsDestroyed)
    managementContents?.removeListener('destroyed', onManagementContentsDestroyed)
  }
  return () => {
    if (disposed) return
    disposed = true
    unsubscribeRemoteUi()
    unsubscribeLoadHandlers()
    if (pendingConsent) {
      clearTimeout(pendingConsent.timer)
      pendingConsent.resolve(false)
      pendingConsent = undefined
    }
    invalidatePlayerPresentation()
    invalidateManagementPresentation()
    activeManagementPairing = undefined
    const channels = managementMode ? [
      'remote-ui:management:get-snapshot', 'remote-ui:management:start-discovery',
      'remote-ui:management:refresh-discovery', 'remote-ui:management:pair', 'remote-ui:management:pair-renewal',
      'remote-ui:management:pair-recover',
      'remote-ui:management:pair-manual', 'remote-ui:management:revoke-local',
      'remote-ui:management:submit-code', 'remote-ui:management:cancel-pairing',
      'remote-ui:management:query-operation'
    ] : []
    if (playerMode) channels.push('remote-ui:player:get-snapshot', 'remote-ui:player:get-interfaces',
      'remote-ui:player:enable-discovery', 'remote-ui:player:disable-discovery', 'remote-ui:player:renew-certificate',
      'remote-ui:player:revoke-pairing',
      'remote-ui:player:answer-consent', 'remote-ui:player:cancel-pairing')
    channels.push('remote-ui:player:is-available')
    for (const channel of channels) deps.ipcMain.removeHandler(channel)
  }
}
