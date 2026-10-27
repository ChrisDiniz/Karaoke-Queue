import type { ReadonlyAppState } from '../application'
import { songCount, tableActivitySummary, tableHistorySummary } from '../history-rules'
import { queueTurnPositions, type QueueTurnPosition } from '../queue-rules'
import { escapeHtml, formatTime, getElement, ModalManager, reportPersistenceFailure, showToast } from './dom'

export class TableDialog {
  private selectedTable: string | null = null
  private selectedSessionId: string | null = null
  private readOnly = false
  private bound = false

  constructor(
    private readonly getState: () => ReadonlyAppState,
    private readonly getPlayOrder: () => readonly Readonly<QueueEntry>[],
    private readonly modals: ModalManager,
    private readonly resetHistory: (table: string) => Promise<void>,
    private readonly clearHistoryFilter: () => void,
    private readonly renderQueue: () => void,
    private readonly renderHistory: () => void
  ) {}

  bind(): void {
    if (this.bound) return
    this.bound = true
    const modal = getElement('table-modal')
    modal.addEventListener('click', event => {
      if (event.target === modal) this.close()
    })
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !modal.classList.contains('hidden')) this.close()
    })
  }

  open(table: string, sessionId: string | null = this.getState().currentSessionId, readOnly = false): void {
    const state = this.getState()
    const scopedSessionId = sessionId ?? state.currentSessionId
    const activity = tableActivitySummary(state.history, state.queue, scopedSessionId, table)
    const hasSessionRecord = [...state.history, ...state.queue].some(entry => entry.sessionId === scopedSessionId && entry.table === table)
    if (activity.sungEntries.length === 0 && activity.pendingEntries.length === 0 && !hasSessionRecord) {
      showToast(`Mesa ${table} não tem apresentações ou solicitações nesta sessão.`)
      return
    }

    this.selectedTable = table
    this.selectedSessionId = scopedSessionId
    this.readOnly = readOnly || scopedSessionId !== state.currentSessionId
    this.renderTable(table)
    this.modals.show('table-modal', true)
  }

  /** Refreshes an open modal after queue rendering, retaining its scroll position. */
  refresh(): void {
    const table = this.selectedTable
    const modal = document.getElementById('table-modal')
    if (!table || !modal || modal.classList.contains('hidden')) return
    const body = getElement('table-modal-body')
    this.renderTable(table, body.scrollTop)
  }

  private renderTable(table: string, scrollTop = 0): void {
    const state = this.getState()
    const sessionId = this.selectedSessionId ?? state.currentSessionId
    const activity = tableActivitySummary(state.history, state.queue, sessionId, table)
    const summary = tableHistorySummary(activity.sungEntries)
    const positions = this.readOnly ? new Map<string, QueueTurnPosition>() : queueTurnPositions(this.getPlayOrder(), state.currentTurnId)
    getElement('table-modal-title').textContent = `Mesa ${table}`
    const body = getElement('table-modal-body')
    body.innerHTML = `
    <div class="tmodal-section">
      <h3 class="tmodal-section-title">Resumo da mesa</h3>
      <div class="tmodal-summary">
        <div class="tmodal-stat tmodal-stat--sung"><span class="tmodal-stat-value">${activity.sungSongs}</span><span class="tmodal-stat-label">Músicas cantadas</span></div>
        <div class="tmodal-stat tmodal-stat--pending"><span class="tmodal-stat-value">${activity.pendingSongs}</span><span class="tmodal-stat-label">Músicas pendentes</span></div>
        <div class="tmodal-stat"><span class="tmodal-stat-value">${activity.singerCount}</span><span class="tmodal-stat-label">Cantores</span></div>
        <div class="tmodal-stat"><span class="tmodal-stat-value">${summary.avgWaitMin}min</span><span class="tmodal-stat-label">Espera média cantada</span></div>
      </div>
    </div>
    <div class="tmodal-section">
      <h3 class="tmodal-section-title">Atividade da sessão</h3>
      ${activity.sungEntries.length ? `<div class="tmodal-activity">
        <div class="tmodal-activity-row"><span class="tmodal-activity-label">Rodada atual</span><span class="tmodal-activity-value">${summary.currentRound}ª rodada</span></div>
        <div class="tmodal-activity-row"><span class="tmodal-activity-label">Primeira inserção cantada</span><span class="tmodal-activity-value">${this.formatTimestamp(summary.firstTime)}</span></div>
        <div class="tmodal-activity-row"><span class="tmodal-activity-label">Último canto</span><span class="tmodal-activity-value">${this.formatTimestamp(summary.lastTime)}</span></div>
      </div>` : '<p class="tmodal-song-empty">Ainda não há apresentações concluídas nesta mesa.</p>'}
    </div>
    <div class="tmodal-section">
      <div class="tmodal-section-heading">
        <h3 class="tmodal-section-title">Cantores e músicas</h3>
        ${activity.pendingSongs > 0 ? `<button class="tmodal-position-help" type="button" aria-label="Ajuda sobre as posições na fila"
          title="Vez atual: apresentação selecionada para cantar agora; isso não significa que a reprodução já começou. Aguardando: posição calculada na fila completa após a apresentação atual.">ⓘ</button>` : ''}
      </div>
      ${activity.pendingSongs > 0 ? `<aside class="tmodal-position-info" role="note">
        <span aria-hidden="true">ⓘ</span>
        <p>Posições baseadas na ordem da fila neste momento. Novas solicitações, prioridades e apresentações concluídas podem alterar esta sequência.</p>
      </aside>` : ''}
      ${activity.singers.length ? `<div class="tmodal-activity-singers">
        ${activity.singers.map(singer => `
          <article class="tmodal-activity-singer">
            <header class="tmodal-activity-singer-header">
              <h4>${escapeHtml(singer.name)}</h4>
              <span>${songCount(singer.sung)} cantadas · ${songCount(singer.pending)} na fila</span>
            </header>
            <div class="tmodal-activity-columns">
              <section class="tmodal-song-group tmodal-song-group--sung">
                <h5>✓ Cantadas (${songCount(singer.sung)})</h5>
                ${this.renderSongEntries(singer.sung, true)}
              </section>
              <section class="tmodal-song-group tmodal-song-group--pending">
                <h5>◷ Na fila (${songCount(singer.pending)})</h5>
                ${this.renderSongEntries(singer.pending, false, positions)}
              </section>
            </div>
          </article>`).join('')}
      </div>` : '<div class="tmodal-activity-empty"><p>Nenhuma apresentação ou solicitação nesta mesa.</p></div>'}
    </div>`

    body.scrollTop = scrollTop
    const reset = getElement<HTMLButtonElement>('btn-reset-table')
    reset.hidden = this.readOnly
    reset.onclick = () => this.resetSelectedTable()
  }

  close(): void { this.modals.hide('table-modal', true) }

  private renderSongEntries(
    entries: readonly Readonly<QueueEntry>[],
    sung: boolean,
    positions?: ReadonlyMap<string, QueueTurnPosition>
  ): string {
    if (!entries.length) return '<p class="tmodal-song-empty">Nenhuma música nesta categoria.</p>'
    const rows = sung
      ? entries.flatMap(entry => [entry.songNumber, entry.songNumber2].filter(Boolean).map(song => `
        <li class="tmodal-song-item"><span>🎵 ${escapeHtml(song)}</span><small>Cantou às ${this.formatTimestamp(entry.doneAt ?? entry.insertedAt)}</small></li>`))
      : entries.map(entry => {
        const position = positions?.get(entry.id)
        const label = this.positionLabel(position)
        const songs = [entry.songNumber, entry.songNumber2].filter(Boolean)
          .map(song => `🎵 ${escapeHtml(song)}`).join(' / ')
        return `<li class="tmodal-song-item tmodal-song-item--pending">
          <span>${songs}</span>
          <small>Solicitada às ${this.formatTimestamp(entry.insertedAt)}</small>
          <strong class="tmodal-turn-position" data-entry-id="${escapeHtml(entry.id)}">${escapeHtml(label)}</strong>
        </li>`
      })
    return `<ul class="tmodal-song-list">${rows.join('')}</ul>`
  }

  private positionLabel(position: QueueTurnPosition | undefined): string {
    if (!position) return 'Aguardando · posição indisponível'
    if (position.kind === 'current') return 'Vez atual'
    return `Aguardando · ${position.position}º na fila`
  }

  private formatTimestamp(timestamp: number): string {
    return this.readOnly
      ? new Date(timestamp).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
      : formatTime(timestamp)
  }

  private async resetSelectedTable(): Promise<void> {
    const table = this.selectedTable
    if (this.readOnly || !table || !confirm(`Resetar Mesa ${table}? O histórico desta mesa na sessão atual será apagado.`)) return
    try { await this.resetHistory(table) } catch (error) { reportPersistenceFailure(error); return }
    this.clearHistoryFilter()
    this.renderQueue()
    this.renderHistory()
    this.close()
    showToast(`Mesa ${table} resetada.`)
  }
}
