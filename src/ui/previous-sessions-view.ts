import type { ReadonlyAppState } from '../application'
import { sessionWasActiveOnLocalDate } from '../history-rules'
import { escapeHtml, getElement } from './dom'

function dateTime(value: number): string {
  return new Date(value).toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
  })
}

function shortDate(value: number): string {
  return new Date(value).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

function duration(start: number, end: number): string {
  const minutes = Math.max(0, Math.floor((end - start) / 60_000))
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}min`
}

export class PreviousSessionsView {
  private bound = false
  private loading = false

  constructor(
    private readonly getState: () => ReadonlyAppState,
    private readonly openSession: (sessionId: string) => void
  ) {}

  bind(): void {
    if (this.bound) return
    this.bound = true
    getElement<HTMLInputElement>('previous-sessions-date').addEventListener('input', () => this.render())
    getElement('btn-clear-previous-date').addEventListener('click', () => {
      getElement<HTMLInputElement>('previous-sessions-date').value = ''
      this.render()
    })
    getElement('previous-sessions-list').addEventListener('click', event => {
      const retry = (event.target as Element).closest('[data-retry-sessions]')
      if (retry) { this.render(); return }
      const card = (event.target as Element).closest<HTMLElement>('[data-session-id]')
      if (card?.dataset.sessionId) this.openSession(card.dataset.sessionId)
    })
  }

  open(): void {
    getElement('dashboard-page').classList.add('hidden')
    getElement('settings-page').classList.add('hidden')
    getElement('history-panel').classList.add('hidden')
    getElement('previous-sessions-page').classList.remove('hidden')
    this.loading = true
    this.render()
    queueMicrotask(() => {
      this.loading = false
      if (!getElement('previous-sessions-page').classList.contains('hidden')) this.render()
    })
  }

  close(): void { getElement('previous-sessions-page').classList.add('hidden') }

  render(): void {
    const list = getElement('previous-sessions-list')
    if (this.loading) {
      list.innerHTML = '<div class="empty-state"><p>Carregando sessões…</p></div>'
      return
    }
    try {
      const state = this.getState()
      const dateFilter = getElement<HTMLInputElement>('previous-sessions-date').value
      const past = state.sessions.filter(session => session.id !== state.currentSessionId)
        .filter(session => !dateFilter || sessionWasActiveOnLocalDate(session, [...state.history, ...state.queue], dateFilter))
        .sort((a, b) => b.startedAt - a.startedAt || b.id.localeCompare(a.id))
      if (!past.length) {
        const message = dateFilter ? 'Nenhuma sessão esteve em funcionamento nesta data.' : 'Nenhuma sessão anterior encontrada.'
        list.innerHTML = `<div class="empty-state"><span class="empty-icon">▦</span><p>${message}</p></div>`
        return
      }
      list.innerHTML = past.map(session => {
        const records = [...state.history, ...state.queue].filter(entry => entry.sessionId === session.id)
        const completed = records.filter(entry => entry.status === 'done' && entry.doneAt != null).length
        const tables = new Set(records.map(entry => entry.table).filter(Boolean)).size
        const title = `Sessão de ${shortDate(session.startedAt)}`
        const end = session.endedAt == null ? 'Encerramento não registrado' : dateTime(session.endedAt)
        const status = session.endedAt == null ? 'Período incompleto' : 'Encerrada'
        const sessionDuration = session.endedAt == null ? 'Indisponível' : duration(session.startedAt, session.endedAt)
        return `<button class="previous-session-card" type="button" data-session-id="${escapeHtml(session.id)}">
          <span class="previous-session-card-heading"><strong>${escapeHtml(title)}</strong><span class="previous-session-status ${session.endedAt == null ? 'is-unknown' : ''}">${status}</span></span>
          <span class="previous-session-period"><span>Início <b>${dateTime(session.startedAt)}</b></span><span>Encerramento <b>${end}</b></span></span>
          <span class="previous-session-metrics"><span>Duração <b>${sessionDuration}</b></span><span>Apresentações concluídas <b>${completed}</b></span><span>Mesas participantes <b>${tables}</b></span></span>
          <span class="previous-session-open">Ver detalhes <span aria-hidden="true">→</span></span>
        </button>`
      }).join('')
    } catch {
      list.innerHTML = `<div class="empty-state"><p>Não foi possível carregar as sessões.</p><button class="btn btn-outline btn-sm" type="button" data-retry-sessions>Tentar novamente</button></div>`
    }
  }
}
