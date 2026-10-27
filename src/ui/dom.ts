export function getElement<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id)
  if (!element) throw new Error(`Required element #${id} was not found.`)
  return element as T
}

export function getInput(id: string): HTMLInputElement {
  return getElement<HTMLInputElement>(id)
}

export function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export function calcWait(insertedAt: number): string {
  const mins = Math.floor((Date.now() - insertedAt) / 60000)
  if (mins < 1) return 'agora'
  if (mins < 60) return `há ${mins}min`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return m > 0 ? `há ${h}h ${m}min` : `há ${h}h`
}

function dateKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
}

/** Local, compact timestamp shown under a queue wait duration. */
export function formatQueueDateTime(timestamp: number, now = Date.now()): string {
  const date = new Date(timestamp)
  const today = new Date(now)
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
  const label = dateKey(date) === dateKey(today) ? 'Hoje'
    : dateKey(date) === dateKey(yesterday) ? 'Ontem'
      : date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' })
  const time = date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  return `${label} · ${time}`
}

/** Neutral, tabular-friendly wait label used in compact queue cards. */
export function formatQueueWait(insertedAt: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - insertedAt) / 60000))
  if (minutes < 1) return 'agora'
  if (minutes < 60) return `há ${minutes}min`
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  if (hours < 24) return remainder ? `há ${hours}h${String(remainder).padStart(2, '0')}` : `há ${hours}h`
  const days = Math.floor(hours / 24)
  const remainingHours = hours % 24
  return `há ${days}d ${remainingHours}h`
}

let toastTimer: ReturnType<typeof setTimeout> | null = null
export function showToast(message: string): void {
  const element = getElement('toast')
  element.textContent = message
  element.classList.remove('hidden')
  element.classList.add('show')
  if (toastTimer !== null) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    element.classList.remove('show')
    setTimeout(() => element.classList.add('hidden'), 300)
  }, 2500)
}

export class ModalManager {
  show(id: string, withOverlay = false): void {
    getElement(id).classList.remove('hidden')
    if (withOverlay) getElement('overlay').classList.remove('hidden')
  }

  hide(id: string, withOverlay = false): void {
    getElement(id).classList.add('hidden')
    if (withOverlay) getElement('overlay').classList.add('hidden')
  }

  bindOverlay(onClose: () => void): void {
    getElement('overlay').addEventListener('click', onClose)
  }
}


/** Shared storage feedback; intentionally contains no queue data or raw error text. */
export function reportPersistenceFailure(error: unknown): void {
  const message = 'Não foi possível confirmar a alteração. Os dados foram preservados. Verifique o armazenamento e tente novamente.'
  showToast(message)
  window.dispatchEvent(new CustomEvent('persistence-failed', { detail: message }))
}
