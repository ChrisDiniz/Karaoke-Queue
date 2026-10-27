'use strict'

import { KaraokeApplication } from './application'
import { createRendererStateRepository } from './state-repository'
import { AppShell } from './ui/app-shell'
import { Navigation } from './ui/navigation'
import { HistoryView } from './ui/history-view'
import { PreviousSessionsView } from './ui/previous-sessions-view'
import { SettingsView } from './ui/settings-view'
import { getElement, getInput, ModalManager, showToast, reportPersistenceFailure } from './ui/dom'
import { QueueInteractions } from './ui/queue-interactions'
import { createQueueView, type QueueView } from './ui/queue-view'
import { TableDialog } from './ui/table-dialog'

function reportRendererError(event: string, message: string, error?: unknown): void {
  const stack = error instanceof Error ? error.stack : undefined
  window.karaokeDiagnostics?.reportRendererError(event, message, stack)
}

window.addEventListener('error', event => {
  reportRendererError('RENDERER_UNCAUGHT_EXCEPTION', event.message || 'Erro JavaScript não tratado.', event.error)
})
window.addEventListener('unhandledrejection', event => {
  const reason = event.reason
  reportRendererError('RENDERER_UNHANDLED_REJECTION', reason instanceof Error ? reason.message : String(reason), reason)
})

const application = new KaraokeApplication(createRendererStateRepository())
const modals = new ModalManager()
let tableDialog!: TableDialog
const historyView = new HistoryView(() => application.state,
  (table, sessionId, readOnly) => tableDialog.open(table, sessionId ?? application.state.currentSessionId, readOnly))
const previousSessionsView = new PreviousSessionsView(() => application.state, sessionId => historyView.openPreviousSession(sessionId))
const settingsView = new SettingsView()
const navigation = new Navigation(
  () => historyView.open(), () => historyView.close(),
  () => settingsView.open(), () => settingsView.close(),
  () => previousSessionsView.open(), () => previousSessionsView.close()
)
historyView.setReturnToSessions(() => {
  previousSessionsView.open()
  navigation.activatePreviousSessions()
})
let queueView: QueueView
let queueInteractions: QueueInteractions

async function startNewShift(): Promise<boolean> {
  const previousSessionId = application.state.currentSessionId
  window.karaokeDiagnostics?.logSessionEvent('SESSION_CLOSE_REQUESTED', previousSessionId, 'operator-new-session')
  const pendingCount = application.state.queue.filter(entry => entry.status === 'pending').length
  const pendingLabel = pendingCount === 1 ? 'apresentação pendente' : 'apresentações pendentes'
  if (pendingCount > 0 && !confirm(`Iniciar uma nova sessão removerá ${pendingCount} ${pendingLabel} da fila atual. O histórico será preservado. Deseja continuar?`)) {
    window.karaokeDiagnostics?.logSessionEvent('SESSION_CLOSE_CANCELLED', previousSessionId, 'operator-cancelled-confirmation')
    return false
  }
  try {
    await application.startNewSession()
  } catch (error) {
    window.karaokeDiagnostics?.logSessionEvent('SESSION_CLOSE_CANCELLED', previousSessionId, 'persistence-failed')
    reportRendererError('RENDERER_IPC_FAILED', 'Falha ao persistir a transição para uma nova sessão.', error)
    showToast(`Não foi possível iniciar a nova sessão: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
  window.karaokeDiagnostics?.logSessionEvent('SESSION_ENDED', previousSessionId, 'new-session-started')
  window.karaokeDiagnostics?.logSessionEvent('SESSION_PERSISTED', previousSessionId, 'confirmed')
  window.karaokeDiagnostics?.logSessionEvent('SESSION_STARTED', application.state.currentSessionId, 'operator-started')
  historyView.resetFilters()
  queueView.render()
  historyView.render()
  previousSessionsView.render()
  showToast('Nova sessão iniciada!')
  return true
}

tableDialog = new TableDialog(
  () => application.state,
  () => application.getPlayOrder(),
  modals,
  async table => (await application.resetTableHistory(table)),
  () => historyView.clearTableFilter(),
  () => queueView.render(),
  () => historyView.render()
)

queueView = createQueueView(application, () => application.state, id => queueInteractions.pinNext(id), () => tableDialog.refresh())
queueInteractions = new QueueInteractions(
  application,
  () => application.state,
  queueView,
  historyView,
  modals,
  (table, sessionId, readOnly) => tableDialog.open(table, sessionId ?? application.state.currentSessionId, readOnly)
)
const appShell = new AppShell(application, () => application.state, modals, startNewShift, () => {
  window.karaokeDiagnostics?.logSessionEvent('SESSION_RESUMED', application.state.currentSessionId, 'operator-continued')
})

document.addEventListener('DOMContentLoaded', async () => {
  // Existing HTML templates call these handlers by name; keep that contract.
  Object.assign(window as unknown as Record<string, unknown>, queueInteractions.globalHandlers)

  const recovery = document.createElement('div')
  recovery.className = 'persistence-feedback'
  recovery.setAttribute('role', 'alert')
  recovery.hidden = true
  const message = document.createElement('span')
  message.textContent = 'A alteração não foi confirmada. '
  const retry = document.createElement('button')
  retry.textContent = 'Verificar armazenamento'
  retry.type = 'button'
  retry.className = 'btn btn-secondary'
  recovery.append(message, retry)
  document.body.prepend(recovery)
  window.addEventListener('persistence-failed', () => { recovery.hidden = false })
  retry.onclick = async () => {
    retry.disabled = true
    try {
      const result = await application.recoverPersistence()
      window.dispatchEvent(new CustomEvent('persistence-recovered', { detail: result }))
      recovery.hidden = true
      queueView.render()
      historyView.render()
      showToast(result === 'committed' ? 'A gravação foi confirmada. A alteração já está salva; não é necessário repeti-la.'
        : 'Estado verificado. A alteração não foi salva; você pode tentar novamente.')
    } catch (error) { reportPersistenceFailure(error) }
    finally { retry.disabled = false }
  }
  let licenseStatus: LicenseStatus
  try { licenseStatus = await appShell.initializeLicense() } catch (error) {
    reportRendererError('RENDERER_IPC_FAILED', 'Não foi possível consultar a licença local.', error)
    return
  }
  try { await application.load(licenseStatus.expired) } catch (error) {
    reportPersistenceFailure(error)
    retry.onclick = () => location.reload()
    retry.textContent = 'Tentar carregar novamente'
    return
  }
  if (application.didStartFreshSessionOnLoad) {
    window.karaokeDiagnostics?.logSessionEvent('SESSION_STARTED', application.state.currentSessionId,
      application.didRecoverEndedSession ? 'after-previous-session-ended' : 'initial-session')
  }
  settingsView.bind()
  if (!appShell.isLicenseExpired) {
    try { await application.ensureCurrentTurn() } catch (error) { reportPersistenceFailure(error) }
  }
  queueView.render()
  appShell.updateSessionStartInfo()

  queueInteractions.bind()
  historyView.bind()
  previousSessionsView.bind()
  navigation.bind()
  modals.bindOverlay(() => tableDialog.close())
  tableDialog.bind()
  getElement('btn-close-table-modal').addEventListener('click', () => tableDialog.close())
  appShell.bind()

  setInterval(() => queueView.updateWaitTimes(), 30000)
  setInterval(() => queueView.render(), 60000)
  setInterval(() => historyView.updateStats(), 60000)
  appShell.showStartupOrLicense(application.didRecoverEndedSession)
  if (getElement('startup-modal').classList.contains('hidden')) getInput('input-table').focus()

  window.__kqueue = {
    queueLength: () => application.state.queue.filter(entry => entry.status === 'pending').length,
    prepareToClose: () => application.prepareToClose(),
    cancelClose: () => application.cancelClose(),
    closeSummary: () => {
      const session = application.state.sessions.find(item => item.id === application.state.currentSessionId)
      const pending = application.state.queue.filter(entry => entry.status === 'pending')
      const ids = new Set(pending.map(entry => entry.id))
      if (application.state.currentTurnId && application.state.queue.some(entry => entry.id === application.state.currentTurnId)) {
        ids.add(application.state.currentTurnId)
      }
      return { sessionActive: !!session && session.endedAt == null, uncompletedCount: ids.size,
        sessionId: session?.id ?? null }
    },
    sessionEnded: () => {
      const current = application.state.sessions.find(session => session.id === application.state.currentSessionId)
      return !current || !!current.endedAt
    },
    flushState: async () => {
      await application.flush()
      return true
    },
    endSessionAndArchive: async () => {
      try { return await application.endCurrentSession() } catch (error) {
        reportPersistenceFailure(error)
        throw error
      }
    }
  }
})
