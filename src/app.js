'use strict'

// ── Storage keys ──────────────────────────────────────
const KEYS = {
  QUEUE:            'kshake_queue',
  HISTORY:          'kshake_history',
  PINNED_POSITIONS: 'kshake_pinned'
}

// ── State ─────────────────────────────────────────────
let state = {
  queue:           [],
  history:         [],
  pinnedPositions: {}  // { [id]: targetIndex } — cards pinned by drag
}

// ── Persistence ───────────────────────────────────────
function loadState() {
  state.queue           = JSON.parse(localStorage.getItem(KEYS.QUEUE)            || '[]')
  state.history         = JSON.parse(localStorage.getItem(KEYS.HISTORY)          || '[]')
  state.pinnedPositions = JSON.parse(localStorage.getItem(KEYS.PINNED_POSITIONS) || '{}')
}

function saveState() {
  localStorage.setItem(KEYS.QUEUE,            JSON.stringify(state.queue))
  localStorage.setItem(KEYS.HISTORY,          JSON.stringify(state.history))
  localStorage.setItem(KEYS.PINNED_POSITIONS, JSON.stringify(state.pinnedPositions))
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
function adjustPinsAfterRemoval(removedId) {
  const sorted     = sortedQueue()
  const removedPos = sorted.findIndex(e => e.id === removedId)
  if (removedPos === -1) return
  Object.keys(state.pinnedPositions).forEach(id => {
    if (id !== removedId && state.pinnedPositions[id] >= removedPos) {
      state.pinnedPositions[id]--
    }
  })
}

function getRoundColor(round) {
  const colors = ['#10b981', '#06b6d4', '#f59e0b', '#f97316', '#ef4444']
  return colors[Math.min(round - 1, colors.length - 1)]
}

function getRound(entry) {
  const historySings  = state.history.filter(h => h.table === entry.table).length
  const queueBefore   = state.queue.filter(q => q.table === entry.table && q.insertedAt < entry.insertedAt).length
  return historySings + queueBefore + 1
}

function sortedQueue() {
  const pinnedIds = Object.keys(state.pinnedPositions)

  // Sort non-pinned cards by round-robin
  const nonPinned = state.queue
    .filter(e => !pinnedIds.includes(e.id))
    .sort((a, b) => {
      const rA = getRound(a), rB = getRound(b)
      if (rA !== rB) return rA - rB
      return a.insertedAt - b.insertedAt
    })

  // Build result: start with non-pinned, then inject pinned at their target positions
  const result = [...nonPinned]
  Object.entries(state.pinnedPositions)
    .sort(([, a], [, b]) => a - b)
    .forEach(([id, pos]) => {
      const entry = state.queue.find(e => e.id === id)
      if (entry) result.splice(Math.min(pos, result.length), 0, entry)
    })

  return result
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

function openEdit(id) {
  const entry = state.queue.find(e => e.id === id)
  if (!entry) return
  document.getElementById('edit-id').value    = entry.id
  document.getElementById('edit-name').value  = entry.name
  document.getElementById('edit-song').value  = entry.songNumber
  document.getElementById('edit-song2').value = entry.songNumber2 || ''
  document.getElementById('edit-table').value = entry.table
  document.getElementById('edit-modal').classList.remove('hidden')
  document.getElementById('edit-name').focus()
}

function closeEdit() {
  document.getElementById('edit-modal').classList.add('hidden')
}

function saveEdit() {
  const id    = document.getElementById('edit-id').value
  const name  = document.getElementById('edit-name').value.trim()
  const song  = document.getElementById('edit-song').value.trim()
  const song2 = document.getElementById('edit-song2').value.trim()
  const table = document.getElementById('edit-table').value.trim()

  if (!name || !song || !table) {
    showToast('Preencha nome, 1ª música e mesa.')
    return
  }

  const entry = state.queue.find(e => e.id === id)
  if (!entry) return

  entry.name        = name
  entry.songNumber  = song
  entry.songNumber2 = song2
  entry.table       = table

  saveState()
  renderQueue()
  closeEdit()
  showToast('Registro atualizado!')
}

function removeEntry(id) {
  const entry = state.queue.find(e => e.id === id)
  if (!entry) return
  if (!confirm(`Remover ${entry.name} (Mesa ${entry.table}) da fila?`)) return
  adjustPinsAfterRemoval(id)
  state.queue = state.queue.filter(e => e.id !== id)
  delete state.pinnedPositions[id]
  saveState()
  renderQueue()
  showToast(`${entry.name} removido(a) da fila.`)
}

function markDone(id) {
  const idx = state.queue.findIndex(e => e.id === id)
  if (idx === -1) return
  adjustPinsAfterRemoval(state.queue[idx].id)
  const [entry] = state.queue.splice(idx, 1)
  entry.doneAt = Date.now()
  delete state.pinnedPositions[entry.id]
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
    const round    = getRound(entry)
    const isPinned = state.pinnedPositions[entry.id] !== undefined
    const pinClass = isPinned ? ' is-pinned' : ''
    return `
      <div class="${cardClass}${pinClass}" data-id="${entry.id}" draggable="true"
        ondragstart="dragStart(event,'${entry.id}')" ondragend="dragEnd(event)"
        ondragover="dragOver(event)" ondrop="drop(event,'${entry.id}')"
        ondragleave="event.currentTarget.classList.remove('drag-over')"
      >
        <div class="card-left-actions">
          <button class="btn-remove" onclick="removeEntry('${entry.id}')" title="Remover da fila">✕</button>
          <button class="btn-edit" onclick="openEdit('${entry.id}')" title="Editar registro">✏️</button>
        </div>
        <div class="card-pin-col">${isPinned ? '<span class="card-pin-icon" title="Prioridade manual">📌</span>' : ''}</div>
        <div class="card-position-wrap">
          <span class="card-position ${posClass}">${i + 1}</span>
        </div>
        <div class="card-info">
          <div class="card-top">
            <div class="card-table-wrap">
              <span class="card-table">Mesa ${entry.table}</span>
              <span class="card-round" style="color:${getRoundColor(round)}">Rodada ${round}</span>
            </div>
            <div class="card-info-main">
              <div class="card-info-top">
                <span class="card-name">${escapeHtml(entry.name)}</span>
                <span class="card-song">🎵 ${escapeHtml(entry.songNumber)}${entry.songNumber2 ? ` &nbsp;🎵 ${escapeHtml(entry.songNumber2)}` : ''}</span>
              </div>
              <span class="card-inserted">&#9201; Inserido às ${formatTime(entry.insertedAt)}</span>
            </div>
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

// ── Drag & drop ───────────────────────────────────────
let draggedId = null

function dragStart(event, id) {
  draggedId = id
  setTimeout(() => event.target.closest('.queue-card').classList.add('dragging'), 0)
}

function dragEnd(event) {
  event.target.closest('.queue-card').classList.remove('dragging')
  document.querySelectorAll('.queue-card').forEach(c => c.classList.remove('drag-over'))
}

function dragOver(event) {
  event.preventDefault()
  const card = event.target.closest('.queue-card')
  if (card) {
    document.querySelectorAll('.queue-card').forEach(c => c.classList.remove('drag-over'))
    card.classList.add('drag-over')
  }
}

function drop(event, targetId) {
  event.preventDefault()
  if (!draggedId || draggedId === targetId) return
  const sorted = sortedQueue()
  const toIdx  = sorted.findIndex(e => e.id === targetId)
  state.pinnedPositions[draggedId] = toIdx
  draggedId = null
  saveState()
  renderQueue()
}

// ── Batch add ─────────────────────────────────────────
let batchRowCount = 0

function openBatch() {
  batchRowCount = 0
  document.getElementById('batch-rows').innerHTML = ''
  document.getElementById('batch-modal').classList.remove('hidden')
  addBatchRow()
  addBatchRow()
  addBatchRow()
  document.querySelector('.batch-row .b-name').focus()
}

function closeBatch() {
  document.getElementById('batch-modal').classList.add('hidden')
}

function addBatchRow() {
  const idx = batchRowCount++
  const row = document.createElement('div')
  row.className = 'batch-row'
  row.dataset.idx = idx
  row.innerHTML = `
    <input type="text" placeholder="Nome do cantor" class="b-name" />
    <input type="text" inputmode="numeric" pattern="[0-9]*" placeholder="Ex: 1234" class="b-song" />
    <input type="text" inputmode="numeric" pattern="[0-9]*" placeholder="Ex: 5678" class="b-song2" />
    <input type="number" placeholder="Mesa" min="1" class="b-table" />
    <button type="button" class="btn-batch-remove" onclick="removeBatchRow(this)" title="Remover linha">✕</button>
  `
  row.querySelectorAll('.b-song, .b-song2').forEach(input => {
    input.addEventListener('keypress', e => { if (!/[0-9]/.test(e.key)) e.preventDefault() })
    input.addEventListener('input', () => { input.value = input.value.replace(/[^0-9]/g, '') })
  })
  row.querySelectorAll('input').forEach(input => {
    input.addEventListener('input', updateBatchCount)
  })
  document.getElementById('batch-rows').appendChild(row)
  updateBatchCount()
}

function removeBatchRow(btn) {
  const row = btn.closest('.batch-row')
  const allRows = document.querySelectorAll('.batch-row')
  if (allRows.length === 1) return
  row.remove()
  updateBatchCount()
}

function updateBatchCount() {
  const count = getCompleteBatchRows().length
  const label = document.getElementById('batch-count-label')
  label.textContent = `${count} entrada${count !== 1 ? 's' : ''} pronta${count !== 1 ? 's' : ''}`
  label.style.color = count > 0 ? 'var(--success)' : 'var(--text-dim)'
}

function getCompleteBatchRows() {
  return [...document.querySelectorAll('.batch-row')].filter(row => {
    const name  = row.querySelector('.b-name').value.trim()
    const song  = row.querySelector('.b-song').value.trim()
    const table = row.querySelector('.b-table').value.trim()
    return name && song && table
  })
}

function confirmBatch() {
  const complete = getCompleteBatchRows()
  if (complete.length === 0) {
    showToast('Nenhuma entrada completa para adicionar.')
    return
  }
  complete.forEach(row => {
    const name  = row.querySelector('.b-name').value.trim()
    const song  = row.querySelector('.b-song').value.trim()
    const song2 = row.querySelector('.b-song2').value.trim()
    const table = row.querySelector('.b-table').value.trim()
    addEntry(name, song, song2, table)
  })
  closeBatch()
  showToast(`${complete.length} entrada${complete.length !== 1 ? 's' : ''} adicionada${complete.length !== 1 ? 's' : ''} à fila!`)
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

  document.getElementById('btn-close-edit').addEventListener('click', closeEdit)
  document.getElementById('btn-cancel-edit').addEventListener('click', closeEdit)
  document.getElementById('btn-save-edit').addEventListener('click', saveEdit)
  document.querySelectorAll('#edit-song, #edit-song2').forEach(input => {
    input.addEventListener('keypress', e => { if (!/[0-9]/.test(e.key)) e.preventDefault() })
    input.addEventListener('input', () => { input.value = input.value.replace(/[^0-9]/g, '') })
  })

  document.getElementById('btn-open-batch').addEventListener('click', openBatch)
  document.getElementById('btn-close-batch').addEventListener('click', closeBatch)
  document.getElementById('btn-cancel-batch').addEventListener('click', closeBatch)
  document.getElementById('btn-confirm-batch').addEventListener('click', confirmBatch)
  document.getElementById('btn-add-batch-row').addEventListener('click', () => {
    addBatchRow()
    const rows = document.querySelectorAll('.batch-row')
    rows[rows.length - 1].querySelector('.b-name').focus()
  })

  document.getElementById('btn-history').addEventListener('click', openHistory)
  document.getElementById('btn-close-history').addEventListener('click', closeHistory)
  document.getElementById('overlay').addEventListener('click', closeHistory)
  document.getElementById('btn-clear-history').addEventListener('click', clearHistory)
})
