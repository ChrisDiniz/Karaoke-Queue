import type { KaraokeApplication, ReadonlyAppState } from '../application'
import { LONG_WAIT_ALERT_AFTER_POSITION, debutTurnIds, longWaitAlertEligibleIds, maxWaitMinutes } from '../queue-rules'
import { completedTurnCountsByTable } from '../history-rules'
import { escapeHtml, formatQueueDateTime, formatQueueWait, getElement, showToast } from './dom'

const BOOST_COLLAPSE_MS = 120000

export interface QueueView {
  render(): void
  beginDragPreview(): void
  endDragPreview(): boolean
  updateWaitTimes(): void
  clearBoostState(id: string): void
  acceptBoost(id: string): void
  dismissBoost(id: string): void
  expandBoost(id: string): void
}

export function createQueueView(
  application: Pick<KaraokeApplication, 'getPlayOrder' | 'canMoveTurn'>,
  getState: () => ReadonlyAppState,
  onPinNext: (id: string) => Promise<boolean | undefined>,
  afterRender: () => void = () => {}
): QueueView {
  const boostTimers: Record<string, ReturnType<typeof setTimeout>> = {}
  const boostCollapsed = new Set<string>()
  const boostDismissed = new Set<string>()
  let dragPreviewActive = false
  let renderDeferredDuringDrag = false

  function clearBoostState(id: string): void {
    if (boostTimers[id]) { clearTimeout(boostTimers[id]); delete boostTimers[id] }
    boostCollapsed.delete(id)
    boostDismissed.delete(id)
  }

  function scheduleBoostCollapse(id: string): void {
    if (boostTimers[id]) return
    boostTimers[id] = setTimeout(() => {
      delete boostTimers[id]
      if (!isWaitAlertEligibleNow(id)) return
      boostCollapsed.add(id)
      render()
    }, BOOST_COLLAPSE_MS)
  }

  function isWaitAlertEligibleNow(id: string): boolean {
    const state = getState()
    const entry = state.queue.find(item => item.id === id)
    if (!entry || boostDismissed.has(id)) return false
    return getWaitAlertEligibleIds(application.getPlayOrder(), state).has(id) &&
      (Date.now() - entry.insertedAt) / 60000 >= maxWaitMinutes(state.queue)
  }

  function getWaitAlertEligibleIds(order: readonly Readonly<QueueEntry>[], state: ReadonlyAppState): Set<string> {
    const nextDynamicPosition = state.frozenTurnIds.length + 1
    return new Set(longWaitAlertEligibleIds(order, state.currentTurnId, state.frozenTurnIds,
      id => application.canMoveTurn(id, nextDynamicPosition)))
  }

  function updateWaitTimes(): void {
    document.querySelectorAll<HTMLElement>('.card-wait[data-inserted]').forEach(element => {
      const insertedAt = parseInt(element.dataset.inserted ?? '0')
      element.textContent = formatQueueWait(insertedAt)
    })
  }

  function songsHtml(entry: Readonly<QueueEntry>): string {
    return `<span class="card-song-number">♫ ${escapeHtml(entry.songNumber)}</span>${entry.songNumber2
      ? `<span class="card-song-number">♫ ${escapeHtml(entry.songNumber2)}</span>` : ''}`
  }

  function singerTurnInfoHtml(entry: Readonly<QueueEntry>, debutIds: ReadonlySet<string>, roundCounts: ReadonlyMap<string, number>): string {
    if (debutIds.has(entry.id)) return '<span class="debut-badge" title="Primeira oportunidade de apresentação da mesa nesta sessão">✦ Estreia</span>'
    const rounds = roundCounts.get(entry.table) || 0
    return rounds > 0
      ? `<span class="rounds-label">${rounds} ${rounds === 1 ? 'rodada' : 'rodadas'}</span>`
      : ''
  }

  function tableBadgeHtml(table: string): string {
    return `<button class="card-table card-table-clickable" onclick="openTableModal('${table}')" title="Ver detalhes da mesa">Mesa ${table}</button>`
  }

  function lockIconHtml(): string {
    return '<svg class="freeze-lock-icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="7" width="9" height="7" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/></svg>'
  }

  function actionMenuHtml(id: string, name: string): string {
    return `<div class="queue-action-menu">
      <button class="queue-action-menu-toggle" type="button" aria-label="Mais ações para ${escapeHtml(name)}" aria-haspopup="menu" aria-expanded="false" onclick="toggleQueueMenu(event,this)"><span aria-hidden="true">⋮</span></button>
      <div class="queue-action-menu-popover" role="menu" aria-label="Ações para ${escapeHtml(name)}">
        <button type="button" role="menuitem" onclick="openEdit('${id}')">Editar</button>
        <button type="button" role="menuitem" onclick="explainQueuePosition('${id}')">Por que esta posição?</button>
        <button type="button" role="menuitem" class="queue-action-menu-danger" onclick="cancelEntry('${id}')">Cancelar</button>
      </div>
    </div>`
  }

  function render(): void {
    if (dragPreviewActive) {
      renderDeferredDuringDrag = true
      return
    }
    const state = getState()
    const nowBlock = getElement('now-block')
    const list = getElement('queue-list')
    const counter = getElement('queue-count')
    const freezeStatus = getElement('queue-freeze-status')
    const releaseFreezeButton = getElement('btn-release-freeze')
    const order = application.getPlayOrder()
    const current = state.currentTurnId
      ? state.queue.find(entry => entry.id === state.currentTurnId) || null
      : null
    const afterCurrent = order.filter(entry => entry.id !== current?.id)
    const frozenIds = new Set(state.frozenTurnIds)
    const debutIds = debutTurnIds(state.queue, state.history, state.currentSessionId)
    const roundCounts = completedTurnCountsByTable(state.history, state.currentSessionId)
    const alertEligibleIds = getWaitAlertEligibleIds(order, state)
    const frozenCount = afterCurrent.filter(entry => frozenIds.has(entry.id)).length
    freezeStatus.textContent = frozenCount ? '' : 'Fila automática'
    freezeStatus.classList.toggle('hidden', frozenCount > 0)
    releaseFreezeButton.classList.toggle('hidden', frozenCount === 0)
    const queuedIds = new Set(afterCurrent.map(entry => entry.id))
    Object.keys(boostTimers).forEach(id => {
      if (!alertEligibleIds.has(id)) {
        clearTimeout(boostTimers[id])
        delete boostTimers[id]
      }
    })
    boostCollapsed.forEach(id => {
      if (!alertEligibleIds.has(id)) boostCollapsed.delete(id)
    })
    boostDismissed.forEach(id => {
      const index = afterCurrent.findIndex(entry => entry.id === id)
      const becameEarlyWhileDynamic = index >= 0 && index < LONG_WAIT_ALERT_AFTER_POSITION && !frozenIds.has(id)
      if (!queuedIds.has(id) || becameEarlyWhileDynamic) boostDismissed.delete(id)
    })
    counter.textContent = String(afterCurrent.length)

    if (current) {
      const currentFixed = state.fixedTurnPositions[current.id] !== undefined
      nowBlock.classList.remove('hidden')
      nowBlock.innerHTML = `
      <div class="now-card"
        ondragover="dragOverTarget(event)" ondrop="dropOnCurrent(event)"
        ondragleave="event.currentTarget.classList.remove('drag-over')">
        <div class="now-label">🎤 Vez atual</div>
        <div class="now-main">
          <div class="now-head">
            ${tableBadgeHtml(current.table)}
            <div class="now-identity"><span class="now-name">${escapeHtml(current.name)}</span>${singerTurnInfoHtml(current, debutIds, roundCounts)}</div>
          </div>
          <div class="now-song">${songsHtml(current)}</div>
        </div>
        <div class="now-right">
          <div class="queue-meta queue-meta--current">
            <span class="card-wait" data-inserted="${current.insertedAt}">${formatQueueWait(current.insertedAt)}</span>
            <span class="card-inserted">${formatQueueDateTime(current.insertedAt)}</span>
          </div>
          <div class="now-actions">
            ${currentFixed ? '<span class="fixed-turn-badge" title="Este turno foi fixado manualmente">📌 Fixado</span>' : ''}
            <button class="btn-done-lg" onclick="markDone('${current.id}')">✓ Cantou</button>
            ${actionMenuHtml(current.id, current.name)}
          </div>
        </div>
      </div>`
    } else {
      nowBlock.classList.add('hidden')
      nowBlock.innerHTML = ''
    }

    if (state.queue.length === 0) {
      list.innerHTML = `
      <div class="empty-state">
        <span class="empty-icon">🎵</span>
        <p>Nenhuma entrada na fila.</p>
        <p>Adicione a primeira música acima!</p>
      </div>`
    } else if (afterCurrent.length === 0) {
      list.innerHTML = `<div class="queue-empty-sm">Nenhuma apresentação pendente.</div>`
    } else {
      const rows = afterCurrent.map((entry, index) => {
        const waitedMin = Math.floor((Date.now() - entry.insertedAt) / 60000)
        const boostEligible = alertEligibleIds.has(entry.id)
        const overdue = boostEligible && (Date.now() - entry.insertedAt) / 60000 >= maxWaitMinutes(state.queue) && !boostDismissed.has(entry.id)
        const collapsed = boostCollapsed.has(entry.id)
        const showFull = overdue && !collapsed
        const showBadge = overdue && collapsed
        const frozen = frozenIds.has(entry.id)
        if (showFull) scheduleBoostCollapse(entry.id)
        return `
      <div class="queue-card${overdue ? ' has-boost' : ''}${state.fixedTurnPositions[entry.id] !== undefined ? ' is-fixed' : ''}${frozen ? ' is-frozen' : ''}" data-id="${entry.id}" data-position="${index + 1}" data-frozen="${frozen}" draggable="true"
        ondragstart="dragStart(event,'${entry.id}')" ondragend="dragEnd(event)"
        ondragover="dragOverQueue(event,'${entry.id}')" ondrop="dropOnQueueCard(event,'${entry.id}')"
        ondragleave="event.currentTarget.classList.remove('drop-before','drop-after')"
      >
        <div class="queue-card-left">
          <div class="queue-card-head">
            <span class="queue-pos">${index + 1}º</span>
            ${tableBadgeHtml(entry.table)}
            <div class="queue-identity">
              <span class="card-name">${escapeHtml(entry.name)}</span>
              ${singerTurnInfoHtml(entry, debutIds, roundCounts)}
            </div>
          </div>
          <div class="queue-card-songs">${songsHtml(entry)}</div>
        </div>
        <div class="queue-meta">
          <span class="card-wait" data-inserted="${entry.insertedAt}">${formatQueueWait(entry.insertedAt)}</span>
          <span class="card-inserted">${formatQueueDateTime(entry.insertedAt)}</span>
          ${showBadge ? `<button class="boost-badge" onclick="expandBoost('${entry.id}')" title="Esperando há muito — ver opções">⏰ furar?</button>` : ''}
        </div>
        <div class="queue-actions">
          ${frozen ? `<span class="frozen-turn-badge" title="Este turno pertence à sequência congelada">${lockIconHtml()}<span>Congelada</span></span>` : ''}
          ${state.fixedTurnPositions[entry.id] !== undefined ? `<span class="fixed-turn-badge" title="Este turno mantém sua posição na fila">📌 Fixado</span><button class="btn btn-outline btn-sm" onclick="unpin('${entry.id}')" title="Remover fixação">Soltar</button>` : ''}
          ${!frozen ? `<button class="btn btn-freeze btn-sm" onclick="freezeThrough('${entry.id}')" title="${frozenCount ? 'Estender congelamento até este turno' : 'Congelar a fila até este turno'}">${lockIconHtml()}<span>${frozenCount ? 'Estender' : 'Congelar até aqui'}</span></button>` : ''}
          ${actionMenuHtml(entry.id, entry.name)}
        </div>
        ${showFull ? `
        <div class="card-boost">
          <span class="card-boost-msg">⏰ Mesa ${entry.table} espera há ${waitedMin} min. Furar pra frente?</span>
          <span class="card-boost-actions">
            <button class="btn-boost-yes" onclick="acceptBoost('${entry.id}')">Sim</button>
            <button class="btn-boost-no" onclick="dismissBoost('${entry.id}')">Não</button>
          </span>
        </div>` : ''}
      </div>`
      })
      if (frozenCount > 0) {
        rows.splice(0, 0, `<div class="queue-section-heading queue-section-heading--frozen" role="heading" aria-level="3">${lockIconHtml()}<span>Congeladas · ${frozenCount}</span></div>`)
        if (frozenCount < afterCurrent.length) {
          rows.splice(frozenCount + 1, 0, '<div class="queue-section-heading queue-section-heading--dynamic" role="heading" aria-level="3"><span>Fila dinâmica</span></div>')
        }
      }
      list.innerHTML = rows.join('')
    }
    updateWaitTimes()
    afterRender()
  }

  return {
    render,
    beginDragPreview() {
      dragPreviewActive = true
      renderDeferredDuringDrag = false
    },
    endDragPreview() {
      dragPreviewActive = false
      const deferred = renderDeferredDuringDrag
      renderDeferredDuringDrag = false
      return deferred
    },
    updateWaitTimes,
    clearBoostState,
    async acceptBoost(id) {
      const moved = isWaitAlertEligibleNow(id) ? await onPinNext(id) : false
      if (moved === undefined) return // Storage feedback was already shown; keep the alert available.
      if (!moved) {
        showToast('A fila mudou; esta apresentação já não pode ser antecipada.')
        render()
        return
      }
      clearBoostState(id)
      render()
    },
    dismissBoost(id) {
      if (!isWaitAlertEligibleNow(id)) return
      if (boostTimers[id]) { clearTimeout(boostTimers[id]); delete boostTimers[id] }
      boostCollapsed.delete(id)
      boostDismissed.add(id)
      render()
    },
    expandBoost(id) {
      if (!isWaitAlertEligibleNow(id)) return
      boostCollapsed.delete(id)
      render()
    }
  }
}
