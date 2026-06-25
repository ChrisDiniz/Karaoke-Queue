'use strict'

// ── Storage keys ──────────────────────────────────────
const KEYS = {
  QUEUE:   'kshake_queue',
  HISTORY: 'kshake_history'
}

// ── State ─────────────────────────────────────────────
let state = {
  queue:   [],
  history: []
}

// ── Persistence ───────────────────────────────────────
function loadState() {
  state.queue   = JSON.parse(localStorage.getItem(KEYS.QUEUE)   || '[]')
  state.history = JSON.parse(localStorage.getItem(KEYS.HISTORY) || '[]')
}

function saveState() {
  localStorage.setItem(KEYS.QUEUE,   JSON.stringify(state.queue))
  localStorage.setItem(KEYS.HISTORY, JSON.stringify(state.history))
}

// ── Helpers ───────────────────────────────────────────
function generateLogId() {
  const ts   = Date.now()
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase()
  return `LOG-${ts}-${rand}`
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function formatDateTime(ts) {
  return new Date(ts).toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  })
}

// ── Queue ordering ─────────────────────────────────────
// Round = (entries from same table in history) + (entries from same table
// in queue inserted before this one) + 1.
// Lower round = higher priority. Ties broken by insertion time (FIFO).
function getRound(entry) {
  const historySings  = state.history.filter(h => h.table === entry.table).length
  const queueBefore   = state.queue.filter(q => q.table === entry.table && q.insertedAt < entry.insertedAt).length
  return historySings + queueBefore + 1
}

function sortedQueue() {
  return [...state.queue].sort((a, b) => {
    const roundA = getRound(a)
    const roundB = getRound(b)
    if (roundA !== roundB) return roundA - roundB
    return a.insertedAt - b.insertedAt
  })
}

// ── Actions ───────────────────────────────────────────
function addEntry(name, songNumber, songNumber2, table) {
  const entry = {
    id:          generateLogId(),
    name:        name.trim(),
    songNumber:  songNumber.trim(),
    songNumber2: songNumber2.trim(),
    table:       String(table).trim(),
    insertedAt:  Date.now(),
    checked:     false
  }
  state.queue.push(entry)
  saveState()
  renderQueue()
  showToast(`${entry.name} adicionado(a) à fila!`)
}

function toggleChecked(id) {
  const entry = state.queue.find(e => e.id === id)
  if (!entry) return
  entry.checked = !entry.checked
  saveState()
  renderQueue()
}

function removeEntry(id) {
  const entry = state.queue.find(e => e.id === id)
  if (!entry) return
  if (!confirm(`Remover ${entry.name} (Mesa ${entry.table}) da fila?`)) return
  state.queue = state.queue.filter(e => e.id !== id)
  saveState()
  renderQueue()
  showToast(`${entry.name} removido(a) da fila.`)
}

function markDone(id) {
  const idx = state.queue.findIndex(e => e.id === id)
  if (idx === -1) return
  const [entry] = state.queue.splice(idx, 1)
  entry.doneAt = Date.now()
  state.history.unshift(entry)
  saveState()
  renderQueue()
  renderHistory()
  showToast(`${entry.name} (Mesa ${entry.table}) marcado como cantado!`)
}

function clearHistory() {
  if (!confirm('Limpar todo o histórico? Esta ação não pode ser desfeita.')) return
  state.history = []
  saveState()
  renderHistory()
}

// ── Render: Queue ─────────────────────────────────────
function renderQueue() {
  const list    = document.getElementById('queue-list')
  const counter = document.getElementById('queue-count')
  const sorted  = sortedQueue()

  counter.textContent = sorted.length

  if (sorted.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <span class="empty-icon">🎵</span>
        <p>Nenhuma entrada na fila.</p>
        <p>Adicione a primeira música acima!</p>
      </div>`
    return
  }

  list.innerHTML = sorted.map((entry, i) => {
    const posClass  = i === 0 ? 'first' : ''
    const cardClass = entry.checked ? 'queue-card is-checked' : 'queue-card'
    const round     = getRound(entry)
    return `
      <div class="${cardClass}" data-id="${entry.id}">
        <button class="btn-remove" onclick="removeEntry('${entry.id}')" title="Remover da fila">✕</button>
        <div class="card-position-wrap">
          <span class="card-position ${posClass}">${i + 1}</span>
        </div>
        <div class="card-info">
          <div class="card-top">
            <div class="card-table-wrap">
              <span class="card-round">Rodada ${round}</span>
              <span class="card-table">Mesa ${entry.table}</span>
              <span class="card-time">${formatTime(entry.insertedAt)}</span>
            </div>
            <span class="card-name">${escapeHtml(entry.name)}</span>
            <span class="card-song">🎵 ${escapeHtml(entry.songNumber)}${entry.songNumber2 ? ` &nbsp;🎵 ${escapeHtml(entry.songNumber2)}` : ''}</span>
          </div>
        </div>
        <div class="card-actions">
          <label class="check-toggle" title="Inserido no sistema de karaoke">
            <input type="checkbox" ${entry.checked ? 'checked' : ''} onchange="toggleChecked('${entry.id}')" />
            <span class="check-box">✓</span>
            <span class="check-label">No sistema</span>
          </label>
        </div>
        <div class="card-actions">
          <button class="btn-done" onclick="markDone('${entry.id}')">✓ Cantou</button>
        </div>
      </div>`
  }).join('')
}

// ── Render: History ───────────────────────────────────
function renderHistory() {
  const list = document.getElementById('history-list')

  if (state.history.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <span class="empty-icon">📋</span>
        <p>Nenhum registro no histórico.</p>
      </div>`
    return
  }

  list.innerHTML = state.history.map(entry => `
    <div class="history-card">
      <div class="history-card-top">
        <span class="history-badge-table">Mesa ${entry.table}</span>
        <span class="history-name">${escapeHtml(entry.name)}</span>
        <span class="history-song">🎵 ${escapeHtml(entry.songNumber)}${entry.songNumber2 ? ` &nbsp;🎵 ${escapeHtml(entry.songNumber2)}` : ''}</span>
      </div>
      <div class="history-meta">
        <span class="history-time">Inserido: ${formatDateTime(entry.insertedAt)}</span>
        <span class="history-time">Cantou: ${formatDateTime(entry.doneAt)}</span>
      </div>
    </div>`
  ).join('')
}

// ── History panel ─────────────────────────────────────
function openHistory() {
  document.getElementById('history-panel').classList.remove('hidden')
  document.getElementById('overlay').classList.remove('hidden')
  renderHistory()
}

function closeHistory() {
  document.getElementById('history-panel').classList.add('hidden')
  document.getElementById('overlay').classList.add('hidden')
}

// ── Toast ─────────────────────────────────────────────
let toastTimer = null
function showToast(msg) {
  const el = document.getElementById('toast')
  el.textContent = msg
  el.classList.remove('hidden')
  el.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    el.classList.remove('show')
    setTimeout(() => el.classList.add('hidden'), 300)
  }, 2500)
}

// ── Clock ─────────────────────────────────────────────
function updateClock() {
  document.getElementById('clock').textContent =
    new Date().toLocaleTimeString('pt-BR')
}

// ── Security: escape HTML ─────────────────────────────
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ── Init ──────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadState()
  renderQueue()
  updateClock()
  setInterval(updateClock, 1000)

  document.getElementById('form-entry').addEventListener('submit', e => {
    e.preventDefault()
    const name   = document.getElementById('input-name').value
    const song   = document.getElementById('input-song').value
    const song2  = document.getElementById('input-song2').value
    const table  = document.getElementById('input-table').value
    addEntry(name, song, song2, table)
    e.target.reset()
    document.getElementById('input-name').focus()
  })

  document.querySelectorAll('#input-song, #input-song2').forEach(input => {
    input.addEventListener('keypress', e => {
      if (!/[0-9]/.test(e.key)) e.preventDefault()
    })
    input.addEventListener('input', () => {
      input.value = input.value.replace(/[^0-9]/g, '')
    })
  })

  document.getElementById('btn-history').addEventListener('click', openHistory)
  document.getElementById('btn-close-history').addEventListener('click', closeHistory)
  document.getElementById('overlay').addEventListener('click', closeHistory)
  document.getElementById('btn-clear-history').addEventListener('click', clearHistory)
})
