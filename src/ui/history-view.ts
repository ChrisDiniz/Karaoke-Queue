import type { ReadonlyAppState } from '../application'
import { normalizeSingerName, sessionHistory, sessionSingerSummaries, sessionSummary, sessionTableSummaries, singerIdentityKey } from '../history-rules'
import { escapeHtml, formatTime, getElement } from './dom'

export class HistoryView {
  private filter: HistoryFilter = { search: '', table: null, order: 'desc' }
  private viewedSessionId: string | null = null
  private returnToSessions: () => void = () => undefined
  private bound = false
  private tablesPopoverOpen = false
  private tableFilterPopoverOpen = false

  constructor(
    private readonly getState: () => ReadonlyAppState,
    private readonly openTable: (table: string, sessionId: string, readOnly: boolean) => void
  ) {}

  setReturnToSessions(callback: () => void): void { this.returnToSessions = callback }

  bind(): void {
    if (this.bound) return
    this.bound = true
    getElement('history-search').addEventListener('input', event => {
      this.filter.search = (event.currentTarget as HTMLInputElement).value
      this.render()
    })
    getElement('btn-sort-history').addEventListener('click', () => {
      this.filter.order = this.filter.order === 'desc' ? 'asc' : 'desc'
      this.render()
    })
    getElement('btn-back-previous-sessions').addEventListener('click', () => this.returnToSessions())
    getElement('btn-view-tables').addEventListener('click', () => this.toggleTablesPopover())
    // Keep the click handling on the stable picker container. The caret is
    // decorative CSS, so every point on the button resolves to the same control.
    getElement('table-filter-picker').addEventListener('click', event => {
      if ((event.target as Element).closest('#btn-table-filter-select')) this.toggleTableFilterPopover()
    })
    getElement('table-filter-search').addEventListener('input', () => {
      const state = this.getState()
      const sessionId = this.viewedSessionId ?? state.currentSessionId
      const pending = sessionId === state.currentSessionId ? state.queue : state.queue.filter(entry => entry.sessionId === sessionId)
      this.renderTableFilterOptions(sessionTableSummaries(state.history, pending, sessionId))
    })
    getElement('table-filter-options').addEventListener('click', event => {
      const option = (event.target as Element).closest<HTMLButtonElement>('[data-table-option]')
      if (!option) return
      const table = option.dataset.tableOption ?? ''
      this.closeTableFilterPopover(true)
      this.setTableFilter(table || null)
    })
    getElement('tables-popover-list').addEventListener('click', event => {
      const card = (event.target as Element).closest<HTMLButtonElement>('[data-table]')
      if (!card) return
      const table = card.dataset.table
      if (!table) return
      this.closeTablesPopover()
      const state = this.getState()
      const sessionId = this.viewedSessionId ?? state.currentSessionId
      this.openTable(table, sessionId ?? '', sessionId !== state.currentSessionId)
    })
    document.addEventListener('click', event => {
      if (this.tablesPopoverOpen && !getElement('tables-picker').contains(event.target as Node)) this.closeTablesPopover()
      if (this.tableFilterPopoverOpen && !getElement('table-filter-picker').contains(event.target as Node)) {
        this.closeTableFilterPopover()
      }
    })
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && (this.tablesPopoverOpen || this.tableFilterPopoverOpen)) {
        event.preventDefault()
        if (this.tablesPopoverOpen) this.closeTablesPopover()
        if (this.tableFilterPopoverOpen) this.closeTableFilterPopover(true)
      }
    })
  }

  resetFilters(): void {
    this.filter = { search: '', table: null, order: 'desc' }
    getElement<HTMLInputElement>('history-search').value = ''
  }

  clearTableFilter(): void { this.filter.table = null }

  setTableFilter(table: string | null): void {
    this.closeTableFilterPopover()
    this.filter.table = table
    this.render()
  }

  open(): void {
    this.viewedSessionId = this.getState().currentSessionId
    this.closeTablesPopover()
    this.closeTableFilterPopover()
    getElement('dashboard-page').classList.add('hidden')
    getElement('history-panel').classList.remove('hidden')
    this.render()
  }

  openPreviousSession(sessionId: string): void {
    const state = this.getState()
    if (sessionId === state.currentSessionId || !state.sessions.some(session => session.id === sessionId)) return
    this.viewedSessionId = sessionId
    this.closeTablesPopover()
    this.closeTableFilterPopover()
    getElement('dashboard-page').classList.add('hidden')
    getElement('settings-page').classList.add('hidden')
    getElement('previous-sessions-page').classList.add('hidden')
    getElement('history-panel').classList.remove('hidden')
    this.render()
  }

  close(): void {
    this.closeTablesPopover()
    this.closeTableFilterPopover()
    getElement('history-panel').classList.add('hidden')
    getElement('dashboard-page').classList.remove('hidden')
    this.viewedSessionId = null
  }

  updateStats(): void {
    const state = this.getState()
    const sessionId = this.viewedSessionId ?? state.currentSessionId
    const historical = sessionId !== state.currentSessionId
    const session = state.sessions.find(item => item.id === sessionId) ?? null
    const records = state.history.filter(entry => entry.sessionId === sessionId)
    const summary = sessionSummary(records, session)
    getElement('history-stat-songs').textContent = String(summary.sungSongs)
    getElement('history-stat-singers').textContent = String(summary.singers)
    getElement('history-stat-tables').textContent = String(summary.tables)
    getElement('history-stat-duration').textContent = historical && session?.endedAt == null
      ? 'Indisponível' : this.formatDuration(summary.durationMinutes)

    const start = getElement('session-start-info')
    const status = getElement('session-status')
    const title = getElement('session-page-title')
    const back = getElement<HTMLButtonElement>('btn-back-previous-sessions')
    back.classList.toggle('hidden', !historical)
    if (session) {
      const startDate = new Date(session.startedAt)
      const fullStart = startDate.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
      title.textContent = historical ? `Sessão de ${startDate.toLocaleDateString('pt-BR')}` : 'Sessão atual'
      if (historical) {
        const shortStart = startDate.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
        const shortEnd = session.endedAt == null ? null : new Date(session.endedAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
        start.textContent = shortEnd ? `${shortStart} → ${shortEnd}` : `Início ${fullStart} · encerramento não registrado`
      } else start.textContent = `Iniciada em ${fullStart}`
      const ended = session.endedAt !== null
      status.textContent = historical ? (ended ? 'Sessão encerrada' : 'Encerramento não registrado') : 'Sessão em andamento'
      status.classList.toggle('is-ended', ended || historical)
    } else {
      start.textContent = 'Início indisponível'
      status.textContent = 'Sem sessão ativa'
      status.classList.add('is-ended')
    }
  }

  render(): void {
    const state = this.getState()
    const sessionId = this.viewedSessionId ?? state.currentSessionId
    const historical = sessionId !== state.currentSessionId
    this.updateStats()
    const list = getElement('history-list')
    const activeSessionHistory = sessionHistory(state.history, sessionId)
    const historicalPending = historical ? state.queue.filter(entry => entry.sessionId === sessionId && entry.status === 'pending') : []
    const records = [...activeSessionHistory, ...historicalPending.filter(entry => !activeSessionHistory.some(item => item.id === entry.id))]
    const pendingForSession = historical ? historicalPending : state.queue
    const tableSummaries = sessionTableSummaries(state.history, pendingForSession, sessionId)
    this.renderTablesPopover(tableSummaries)
    this.renderTableFilterOptions(tableSummaries)
    let filtered = records.filter(entry => entry.status === 'done' || entry.status === 'cancelled' || (historical && entry.status === 'pending'))
    if (this.filter.search) {
      const search = normalizeSingerName(this.filter.search)
      filtered = filtered.filter(entry => normalizeSingerName(entry.name).includes(search))
    }
    if (this.filter.table) filtered = filtered.filter(entry => entry.table === this.filter.table)
    if (this.filter.order === 'asc') filtered.reverse()

    getElement('btn-sort-history').textContent = this.filter.order === 'desc' ? '↓ Recentes' : '↑ Antigas'

    if (filtered.length === 0) {
      list.innerHTML = `<div class="empty-state"><span class="empty-icon">📋</span><p>${
        records.length === 0 ? 'Nenhuma apresentação nesta sessão.' : 'Nenhum resultado para os filtros.'
      }</p></div>`
      return
    }

    const singerSummaries = new Map(sessionSingerSummaries(state.history, sessionId)
      .map(singer => [singer.identityKey, singer]))
    list.innerHTML = filtered.map(entry => {
      const table = escapeHtml(entry.table)
      if (entry.status === 'pending') {
        return `
    <div class="history-card history-card--pending">
      <div class="history-card-top">
        <span class="history-name">${escapeHtml(entry.name)}</span>
        <button class="history-badge-table history-badge-clickable" onclick="openTableModal('${table}', '${sessionId}', true)" title="Ver detalhes da mesa">Mesa ${table}</button>
        <span class="history-cancelled-tag">Pendente</span>
        ${this.tableCardButton(table, sessionId, true)}
      </div>
      <div class="history-card-bottom"><div class="history-times">
        <span class="history-time"><span class="history-time-label">Solicitada</span> ${this.formatHistoryTimestamp(entry.insertedAt, true)}</span>
      </div></div>
    </div>`
      }
      if (entry.status === 'cancelled') {
        return `
    <div class="history-card history-card--cancelled">
      <div class="history-card-top">
        <span class="history-name">${escapeHtml(entry.name)}</span>
        <button class="history-badge-table history-badge-clickable history-badge-cancelled" onclick="openTableModal('${table}', '${sessionId}', ${historical})" title="Ver detalhes da mesa">Mesa ${table}</button>
        <span class="history-cancelled-tag">Cancelada</span>
        ${this.tableCardButton(table, sessionId, historical)}
      </div>
      <div class="history-card-bottom"><div class="history-times">
        <span class="history-time"><span class="history-time-label">Inserida</span> ${this.formatHistoryTimestamp(entry.insertedAt, historical)}</span>
        <span class="history-time-arrow">→</span>
        <span class="history-time"><span class="history-time-label">Cancelada</span> ${this.formatHistoryTimestamp(entry.cancelledAt ?? entry.insertedAt, historical)}</span>
      </div></div>
    </div>`
      }
      if (entry.doneAt == null) return ''
      const singer = singerSummaries.get(singerIdentityKey(entry.name, entry.table))
      const singerSongCount = singer?.sungSongs ?? 0
      return `
    <div class="history-card history-card--done">
      <div class="history-card-top">
        <span class="history-name">${escapeHtml(entry.name)}</span>
        <button class="history-badge-table history-badge-clickable" onclick="openTableModal('${table}', '${sessionId}', ${historical})" title="Ver detalhes da mesa">Mesa ${table}</button>
        ${this.tableCardButton(table, sessionId, historical)}
      </div>
      <div class="history-card-bottom">
        <div class="history-times"><span class="history-time"><span class="history-time-label">Inserida</span> ${this.formatHistoryTimestamp(entry.insertedAt, historical)}</span>
          <span class="history-time-arrow">→</span><span class="history-time"><span class="history-time-label">Cantou</span> ${this.formatHistoryTimestamp(entry.doneAt, historical)}</span></div>
        <div class="history-counts"><span class="history-count">🎤 ${singerSongCount} música${singerSongCount !== 1 ? 's' : ''}</span></div>
      </div>
    </div>`
    }).join('')
  }

  private formatDuration(minutes: number): string {
    if (minutes < 60) return `${minutes}min`
    return `${Math.floor(minutes / 60)}h ${minutes % 60}min`
  }

  private formatHistoryTimestamp(timestamp: number, historical: boolean): string {
    if (!historical) return formatTime(timestamp)
    return new Date(timestamp).toLocaleString('pt-BR', {
      day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
    })
  }

  private toggleTablesPopover(): void {
    this.tablesPopoverOpen ? this.closeTablesPopover() : this.openTablesPopover()
  }

  private toggleTableFilterPopover(): void {
    this.tableFilterPopoverOpen ? this.closeTableFilterPopover(true) : this.openTableFilterPopover()
  }

  private openTableFilterPopover(): void {
    this.closeTablesPopover()
    this.tableFilterPopoverOpen = true
    const state = this.getState()
    const sessionId = this.viewedSessionId ?? state.currentSessionId
    const pending = sessionId === state.currentSessionId ? state.queue : state.queue.filter(entry => entry.sessionId === sessionId)
    getElement<HTMLInputElement>('table-filter-search').value = ''
    this.renderTableFilterOptions(sessionTableSummaries(state.history, pending, sessionId))
    getElement('table-filter-popover').classList.remove('hidden')
    getElement('btn-table-filter-select').setAttribute('aria-expanded', 'true')
    getElement<HTMLInputElement>('table-filter-search').focus()
  }

  private closeTableFilterPopover(focusButton = false): void {
    this.tableFilterPopoverOpen = false
    document.getElementById('table-filter-popover')?.classList.add('hidden')
    document.getElementById('btn-table-filter-select')?.setAttribute('aria-expanded', 'false')
    const search = document.getElementById('table-filter-search') as HTMLInputElement | null
    if (search) search.value = ''
    if (focusButton) document.getElementById('btn-table-filter-select')?.focus()
  }

  private openTablesPopover(): void {
    const state = this.getState()
    const sessionId = this.viewedSessionId ?? state.currentSessionId
    const pending = sessionId === state.currentSessionId ? state.queue : state.queue.filter(entry => entry.sessionId === sessionId)
    this.renderTablesPopover(sessionTableSummaries(state.history, pending, sessionId))
    this.tablesPopoverOpen = true
    getElement('tables-popover').classList.remove('hidden')
    getElement('btn-view-tables').setAttribute('aria-expanded', 'true')
  }

  private closeTablesPopover(): void {
    this.tablesPopoverOpen = false
    const popover = document.getElementById('tables-popover')
    const button = document.getElementById('btn-view-tables')
    popover?.classList.add('hidden')
    button?.setAttribute('aria-expanded', 'false')
  }

  private renderTablesPopover(tables: ReturnType<typeof sessionTableSummaries>): void {
    const list = getElement('tables-popover-list')
    list.innerHTML = tables.length ? tables.map(table => `
      <button class="table-picker-card" type="button" data-table="${escapeHtml(table.table)}">
        <strong>Mesa ${escapeHtml(table.table)}</strong>
        <span><b>${table.sungSongs}</b> cantadas</span>
        <span><b>${table.pendingSongs}</b> pendentes</span>
      </button>`).join('') : '<p class="tables-popover-empty">Nenhuma mesa nesta sessão.</p>'
  }

  private renderTableFilterOptions(tables: ReturnType<typeof sessionTableSummaries>): void {
    const search = getElement<HTMLInputElement>('table-filter-search').value.trim().toLocaleLowerCase('pt-BR')
    const visible = search ? tables.filter(item => item.table.toLocaleLowerCase('pt-BR').includes(search)) : tables
    const options = [`<button class="table-filter-option ${this.filter.table === null ? 'is-selected' : ''}"
      type="button" role="option" aria-selected="${this.filter.table === null}" data-table-option="">Todas as mesas</button>`]
    options.push(...visible.map(item => `<button class="table-filter-option ${this.filter.table === item.table ? 'is-selected' : ''}"
      type="button" role="option" aria-selected="${this.filter.table === item.table}"
      data-table-option="${escapeHtml(item.table)}">Mesa ${escapeHtml(item.table)}</button>`))
    if (search && visible.length === 0) options.push('<p class="table-filter-no-results">Nenhuma mesa encontrada.</p>')
    getElement('table-filter-options').innerHTML = options.join('')
    const label = this.filter.table ? `Mesa ${this.filter.table}` : 'Todas as mesas'
    getElement('table-filter-label').textContent = label
  }

  private tableCardButton(table: string, sessionId: string | null, readOnly: boolean): string {
    return `<button class="history-view-table" type="button" onclick="openTableModal('${table}', '${sessionId ?? ''}', ${readOnly})" title="Ver detalhes da mesa ${table}">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h16v16H4zM8 8h3v3H8zM14 8h3M14 11h3M8 14h9M8 17h9"/></svg><span>Ver mesa</span>
    </button>`
  }
}
