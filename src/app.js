'use strict'

// ── Storage keys ──────────────────────────────────────
const KEYS = {
  APP_NAME:           'kshake_app_name',
  QUEUE:              'kshake_queue',
  HISTORY:            'kshake_history',
  SESSIONS:           'kshake_sessions',
  CURRENT_SESSION_ID: 'kshake_current_session',
  PINNED_POSITIONS:   'kshake_pinned',
  LAST_RESET:         'kshake_last_reset'
}

// ── Filter state (in-memory only) ─────────────────────
let historyFilter = {
  search: '',
  table:  null,
  order:  'desc'
}

let statsFilter = {
  name:       '',
  table:      '',
  filterDate: '',  // single date "YYYY-MM-DD"
  filterFrom: '',  // period start
  filterTo:   ''   // period end
}

// ── State ─────────────────────────────────────────────
let state = {
  queue:            [],
  history:          [],   // permanent — never cleared
  sessions:         [],
  currentSessionId: null,
  pinnedPositions:  {}
}

// ── Persistence ───────────────────────────────────────
function loadState() {
  state.queue            = JSON.parse(localStorage.getItem(KEYS.QUEUE)              || '[]')
  state.history          = JSON.parse(localStorage.getItem(KEYS.HISTORY)            || '[]')
  state.sessions         = JSON.parse(localStorage.getItem(KEYS.SESSIONS)           || '[]')
  state.currentSessionId = localStorage.getItem(KEYS.CURRENT_SESSION_ID)            || null
  state.pinnedPositions  = JSON.parse(localStorage.getItem(KEYS.PINNED_POSITIONS)   || '{}')

  // First run or migration: create a session if none exists
  if (state.sessions.length === 0) {
    const session = createSession()
    // Tag any existing history entries with this session
    state.history.forEach(e => { if (!e.sessionId) e.sessionId = session.id })
  } else if (!state.currentSessionId) {
    state.currentSessionId = state.sessions[state.sessions.length - 1].id
  }
}

function saveState() {
  localStorage.setItem(KEYS.QUEUE,              JSON.stringify(state.queue))
  localStorage.setItem(KEYS.HISTORY,            JSON.stringify(state.history))
  localStorage.setItem(KEYS.SESSIONS,           JSON.stringify(state.sessions))
  localStorage.setItem(KEYS.CURRENT_SESSION_ID, state.currentSessionId || '')
  localStorage.setItem(KEYS.PINNED_POSITIONS,   JSON.stringify(state.pinnedPositions))
}

// ── Session management ────────────────────────────────
function createSession() {
  const session = { id: `s-${Date.now()}`, startedAt: Date.now(), endedAt: null }
  state.sessions.push(session)
  state.currentSessionId = session.id
  return session
}

function formatSessionLabel(session) {
  const start   = new Date(session.startedAt)
  const dateStr = start.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' })
  const timeStr = start.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  let label = `Expediente ${dateStr} — ${timeStr}`
  if (session.endedAt) {
    label += ` até ${new Date(session.endedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`
  } else if (session.id === state.currentSessionId) {
    label += ' (em andamento)'
  }
  return label
}

function currentSession() {
  return state.sessions.find(s => s.id === state.currentSessionId)
}

function updateSessionStartInfo() {
  const el = document.getElementById('session-start-info')
  if (!el) return
  const session = currentSession()
  if (!session) { el.textContent = ''; return }
  const time = new Date(session.startedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  const date = new Date(session.startedAt).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })
  el.textContent = `Iniciado ${date} às ${time}`
}

function sessionRunningTime(session) {
  const mins  = Math.floor((Date.now() - session.startedAt) / 60000)
  const hours = Math.floor(mins / 60)
  const rest  = mins % 60
  return hours > 0 ? `${hours}h ${rest}min` : `${mins}min`
}


function getActiveSessionHistory() {
  const sid = historyFilter.sessionId || state.currentSessionId
  return state.history.filter(e => e.sessionId === sid)
}


function renderSessionSelector(currentId, onChangeFn) {
  const sorted = [...state.sessions].sort((a, b) => b.startedAt - a.startedAt)
  return `<select class="session-select" onchange="${onChangeFn}(this.value)">
    ${sorted.map(s => `<option value="${s.id}" ${s.id === currentId ? 'selected' : ''}>${formatSessionLabel(s)}</option>`).join('')}
  </select>`
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
  const historySings  = state.history.filter(h => h.table === entry.table && h.sessionId === state.currentSessionId).length
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
    checked:     false,
    sessionId:   state.currentSessionId
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
  if (!confirm('Limpar o histórico deste expediente? Esta ação não pode ser desfeita.')) return
  state.history = state.history.filter(e => e.sessionId !== state.currentSessionId)
  saveState()
  renderHistory()
}

// ── Session reset ──────────────────────────────────────
function resetSession() {
  const cur = currentSession()
  if (cur && !cur.endedAt) cur.endedAt = Date.now()

  createSession()

  state.queue           = []
  state.pinnedPositions = {}
  historyFilter         = { search: '', table: null, order: 'desc', sessionId: null }
  statsFilter           = { name: '', table: '', filterDate: '', filterFrom: '', filterTo: '' }
  localStorage.setItem(KEYS.LAST_RESET, new Date().toDateString())
  saveState()
  renderQueue()
  renderHistory()
  showToast('Novo expediente iniciado!')
}

function checkAutoReset() {
  const now       = new Date()
  const lastReset = localStorage.getItem(KEYS.LAST_RESET)
  if (now.getHours() === 18 && now.getMinutes() === 0 && lastReset !== now.toDateString()) {
    resetSession()
  }
}

// ── Startup dialog ────────────────────────────────────────
function showStartupDialog() {
  if (state.sessions.length === 0) {
    createSession()
    saveState()
    return
  }

  const lastSession = state.sessions[state.sessions.length - 1]

  if (lastSession.endedAt) {
    resetSession()
    return
  }

  // Session running for more than 15h → auto-start a new one
  const hoursElapsed = (Date.now() - lastSession.startedAt) / 3600000
  if (hoursElapsed > 15) {
    resetSession()
    return
  }

  // Session in progress from the same day — only case that needs user input
  const startStr = new Date(lastSession.startedAt).toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  })
  const running = sessionRunningTime(lastSession)

  document.getElementById('startup-message').textContent = 'Expediente em andamento'
  document.getElementById('startup-detail').textContent  = `Iniciado em ${startStr}`
  document.getElementById('startup-running').textContent = `há ${running}`

  const btnPri = document.getElementById('btn-startup-primary')
  const btnSec = document.getElementById('btn-startup-secondary')
  btnPri.textContent = 'Continuar'
  btnSec.textContent = 'Iniciar novo'
  btnPri.onclick = () => closeStartupModal()
  btnSec.onclick = () => { resetSession(); closeStartupModal() }

  document.getElementById('startup-modal').classList.remove('hidden')
}

function closeStartupModal() {
  document.getElementById('startup-modal').classList.add('hidden')
}

// ── Table detail modal ────────────────────────────────────
function openTableModal(table) {
  const entries = state.history.filter(e =>
    e.sessionId === state.currentSessionId && e.table === table
  )
  if (entries.length === 0) return

  // Summary stats
  const totalSongs    = entries.reduce((a, e) => a + 1 + (e.songNumber2 ? 1 : 0), 0)
  const uniqueSingers = [...new Set(entries.map(e => e.name))]
  const waits         = entries.map(e => e.doneAt - e.insertedAt).filter(Boolean)
  const avgWaitMin    = waits.length ? Math.round(waits.reduce((a, b) => a + b, 0) / waits.length / 60000) : 0
  const timestamps    = entries.flatMap(e => [e.insertedAt, e.doneAt]).filter(Boolean)
  const firstTime     = Math.min(...timestamps)
  const lastTime      = Math.max(...timestamps)
  const durMins       = Math.round((lastTime - firstTime) / 60000)
  const duration      = durMins < 60 ? `${durMins}min` : `${Math.floor(durMins / 60)}h ${durMins % 60}min`
  const currentRound  = entries.length + 1

  // Singers grouped
  const singerMap = {}
  entries.forEach(e => {
    if (!singerMap[e.name]) singerMap[e.name] = []
    singerMap[e.name].push(e)
  })
  const singers = Object.entries(singerMap).sort((a, b) => b[1].length - a[1].length)

  // Songs
  const songCounts = {}
  entries.forEach(e => {
    [e.songNumber, e.songNumber2].filter(Boolean).forEach(s => {
      songCounts[s] = (songCounts[s] || 0) + 1
    })
  })
  const topSongs = Object.entries(songCounts).sort((a, b) => b[1] - a[1])

  document.getElementById('table-modal-title').textContent = `Mesa ${table}`
  document.getElementById('table-modal-body').innerHTML = `
    <div class="tmodal-section">
      <h3 class="tmodal-section-title">Resumo</h3>
      <div class="tmodal-summary">
        <div class="tmodal-stat">
          <span class="tmodal-stat-value">${totalSongs}</span>
          <span class="tmodal-stat-label">Músicas</span>
        </div>
        <div class="tmodal-stat">
          <span class="tmodal-stat-value">${uniqueSingers.length}</span>
          <span class="tmodal-stat-label">Cantores</span>
        </div>
        <div class="tmodal-stat">
          <span class="tmodal-stat-value">${duration}</span>
          <span class="tmodal-stat-label">Duração</span>
        </div>
        <div class="tmodal-stat">
          <span class="tmodal-stat-value">${avgWaitMin}min</span>
          <span class="tmodal-stat-label">Espera média</span>
        </div>
      </div>
    </div>

    <div class="tmodal-section">
      <h3 class="tmodal-section-title">Atividade</h3>
      <div class="tmodal-activity">
        <div class="tmodal-activity-row">
          <span class="tmodal-activity-label">Rodada atual</span>
          <span class="tmodal-activity-value">${currentRound}ª rodada</span>
        </div>
        <div class="tmodal-activity-row">
          <span class="tmodal-activity-label">Primeira inserção</span>
          <span class="tmodal-activity-value">${formatTime(firstTime)}</span>
        </div>
        <div class="tmodal-activity-row">
          <span class="tmodal-activity-label">Último canto</span>
          <span class="tmodal-activity-value">${formatTime(lastTime)}</span>
        </div>
      </div>
    </div>

    <div class="tmodal-section">
      <h3 class="tmodal-section-title">Cantores</h3>
      <div class="tmodal-singers">
        ${singers.map(([name, entries]) => `
          <div class="tmodal-singer">
            <div class="tmodal-singer-header">
              <span class="tmodal-singer-name">${escapeHtml(name)}</span>
              <span class="tmodal-singer-count">${entries.reduce((a, e) => a + 1 + (e.songNumber2 ? 1 : 0), 0)} músicas</span>
            </div>
            ${entries.map(e => `
              <div class="tmodal-singer-entry">
                <div class="tmodal-entry-songs">
                  <span class="tmodal-entry-song">🎵 ${escapeHtml(e.songNumber)}</span>
                  ${e.songNumber2 ? `<span class="tmodal-entry-song">🎵 ${escapeHtml(e.songNumber2)}</span>` : ''}
                </div>
                <div class="tmodal-entry-times">
                  <span class="tmodal-entry-time"><span class="tmodal-entry-time-label">Inserido</span> ${formatTime(e.insertedAt)}</span>
                  <span class="tmodal-entry-arrow">→</span>
                  <span class="tmodal-entry-time"><span class="tmodal-entry-time-label">Cantou</span> ${formatTime(e.doneAt)}</span>
                </div>
              </div>`).join('')}
          </div>`).join('')}
      </div>
    </div>

    <div class="tmodal-section">
      <h3 class="tmodal-section-title">Músicas pedidas</h3>
      <div class="tmodal-songs">
        ${topSongs.map(([song, count]) => `
          <span class="tmodal-song-badge">#${escapeHtml(song)}${count > 1 ? ` ×${count}` : ''}</span>
        `).join('')}
      </div>
    </div>`

  document.getElementById('btn-reset-table').onclick = () => resetTable(table)
  document.getElementById('table-modal').classList.remove('hidden')
  document.getElementById('overlay').classList.remove('hidden')
}

function closeTableModal() {
  document.getElementById('table-modal').classList.add('hidden')
  document.getElementById('overlay').classList.add('hidden')
}

function resetTable(table) {
  if (!confirm(`Resetar Mesa ${table}? O histórico desta mesa na sessão atual será apagado.`)) return
  state.history = state.history.filter(e =>
    !(e.sessionId === state.currentSessionId && e.table === table)
  )
  historyFilter.table = null
  saveState()
  renderQueue()
  renderHistory()
  closeTableModal()
  showToast(`Mesa ${table} resetada.`)
}

// ── History filters ────────────────────────────────────
function getFilteredHistory() {
  let result = state.history.filter(e => e.sessionId === state.currentSessionId)
  if (historyFilter.search) {
    const s = historyFilter.search.toLowerCase()
    result = result.filter(e => e.name.toLowerCase().includes(s))
  }
  if (historyFilter.table) {
    result = result.filter(e => e.table === historyFilter.table)
  }
  if (historyFilter.order === 'asc') result.reverse()
  return result
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
  const list    = document.getElementById('history-list')
  const filtered = getFilteredHistory()

  // Render table filter buttons
  const tables = [...new Set(state.history.filter(e => e.sessionId === state.currentSessionId).map(e => e.table))].sort((a, b) => Number(a) - Number(b))
  const tableFilters = document.getElementById('history-table-filters')
  if (tableFilters) {
    tableFilters.innerHTML = tables.map(t => `
      <button class="btn-table-filter ${historyFilter.table === t ? 'active' : ''}"
        onclick="setTableFilter('${t}')">Mesa ${t}</button>
    `).join('')
    if (tables.length > 0) {
      tableFilters.innerHTML = `
        <button class="btn-table-filter ${historyFilter.table === null ? 'active' : ''}"
          onclick="setTableFilter(null)">Todas</button>
      ` + tableFilters.innerHTML
    }
  }

  // Update sort button label
  const sortBtn = document.getElementById('btn-sort-history')
  if (sortBtn) sortBtn.textContent = historyFilter.order === 'desc' ? '↓ Recente' : '↑ Antiga'

  if (filtered.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <span class="empty-icon">📋</span>
        <p>${state.history.length === 0 ? 'Nenhum registro no histórico.' : 'Nenhum resultado para os filtros.'}</p>
      </div>`
    return
  }

  // Compute song counts and last sang time per singer, and counts per table
  const sessionHistory = state.history.filter(e => e.sessionId === state.currentSessionId)
  const singerCounts   = {}
  const singerLastSang = {}
  const tableCounts    = {}
  sessionHistory.forEach(e => {
    const n   = 1 + (e.songNumber2 ? 1 : 0)
    const key = e.name.toLowerCase()
    singerCounts[key]    = (singerCounts[key]    || 0) + n
    tableCounts[e.table] = (tableCounts[e.table] || 0) + n
    if (!singerLastSang[key] || e.doneAt > singerLastSang[key]) {
      singerLastSang[key] = e.doneAt
    }
  })

  list.innerHTML = filtered.map(entry => {
    const key         = entry.name.toLowerCase()
    const singerTotal = singerCounts[key] || 0
    const lastSang    = singerLastSang[key] || 0
    const tableTotal  = tableCounts[entry.table] || 0
    return `
    <div class="history-card">
      <div class="history-card-top">
        <span class="history-name">${escapeHtml(entry.name)}</span>
        <button class="history-badge-table history-badge-clickable" onclick="openTableModal('${entry.table}')" title="Ver detalhes da mesa">Mesa ${entry.table}</button>
        <span class="history-song">🎵 ${escapeHtml(entry.songNumber)}${entry.songNumber2 ? ` &nbsp;🎵 ${escapeHtml(entry.songNumber2)}` : ''}</span>
      </div>
      <div class="history-card-bottom">
        <div class="history-times">
          <span class="history-time"><span class="history-time-label">Inserido</span> ${formatTime(entry.insertedAt)}</span>
          <span class="history-time-arrow">→</span>
          <span class="history-time"><span class="history-time-label">Cantou</span> ${formatTime(entry.doneAt)}</span>
        </div>
        <div class="history-counts">
          <span class="history-count">🎤 ${singerTotal} música${singerTotal !== 1 ? 's' : ''} · último às ${formatTime(lastSang)}</span>
        </div>
      </div>
    </div>`
  }).join('')
}

function setTableFilter(table) {
  historyFilter.table = table
  renderHistory()
}

// ── Statistics ────────────────────────────────────────
function openStats() {
  statsFilter = { name: '', table: '', filterDate: '', filterFrom: '', filterTo: '' }
  document.getElementById('stats-search-name').value  = ''
  document.getElementById('stats-search-table').value = ''
  document.getElementById('stats-panel').classList.remove('hidden')
  document.getElementById('overlay').classList.remove('hidden')
  renderStats()
}

function closeStats() {
  document.getElementById('stats-panel').classList.add('hidden')
  document.getElementById('overlay').classList.add('hidden')
}

function sessionDateStr(session) {
  return new Date(session.startedAt).toISOString().slice(0, 10)
}

function getSessionsForStats() {
  if (statsFilter.filterDate) {
    return state.sessions
      .filter(s => sessionDateStr(s) === statsFilter.filterDate)
      .map(s => s.id)
  }
  if (statsFilter.filterFrom || statsFilter.filterTo) {
    const from = statsFilter.filterFrom || '0000-01-01'
    const to   = statsFilter.filterTo   || '9999-12-31'
    return state.sessions
      .filter(s => { const d = sessionDateStr(s); return d >= from && d <= to })
      .map(s => s.id)
  }
  return [state.currentSessionId]
}

function renderStats() {
  const body = document.getElementById('stats-body')

  const sessionIds = getSessionsForStats()
  let h = state.history.filter(e => sessionIds.includes(e.sessionId))
  if (statsFilter.name)  h = h.filter(e => e.name.toLowerCase().includes(statsFilter.name.toLowerCase()))
  if (statsFilter.table) h = h.filter(e => e.table === statsFilter.table)

  if (h.length === 0) {
    body.innerHTML = `
      <div class="empty-state">
        <span class="empty-icon">📊</span>
        <p>Nenhum dado ainda.</p>
        <p>As estatísticas aparecerão após as primeiras músicas cantadas.</p>
      </div>`
    return
  }

  // ── Summary
  const totalSongs   = h.reduce((acc, e) => acc + 1 + (e.songNumber2 ? 1 : 0), 0)
  const uniqueSingers = new Set(h.map(e => e.name.toLowerCase())).size
  const uniqueTables  = new Set(h.map(e => e.table)).size
  const duration      = calcDuration(h)
  const avgWait       = calcAvgWait(h)

  // ── By singer (grouped by table + name)
  const bySinger = groupAndSort(h, e => `${e.name} · Mesa ${e.table}`, e => 1 + (e.songNumber2 ? 1 : 0))

  // ── By table
  const byTable = groupAndSort(h, e => `Mesa ${e.table}`, e => 1 + (e.songNumber2 ? 1 : 0))

  // ── Most requested songs
  const songCounts = {}
  h.forEach(e => {
    if (e.songNumber)  songCounts[e.songNumber]  = (songCounts[e.songNumber]  || 0) + 1
    if (e.songNumber2) songCounts[e.songNumber2] = (songCounts[e.songNumber2] || 0) + 1
  })
  const topSongs = Object.entries(songCounts).sort((a, b) => b[1] - a[1]).slice(0, 8)

  // ── Peak hours
  const byHour = {}
  h.forEach(e => {
    const hour = new Date(e.doneAt).getHours()
    byHour[hour] = (byHour[hour] || 0) + 1 + (e.songNumber2 ? 1 : 0)
  })
  const peakHours = Object.entries(byHour).sort((a, b) => b[1] - a[1]).slice(0, 5)

  body.innerHTML = `
    <section class="stats-section">
      <h3 class="stats-section-title">Resumo da Sessão</h3>
      <div class="stats-summary">
        <div class="stat-card">
          <span class="stat-value">${totalSongs}</span>
          <span class="stat-label">Músicas cantadas</span>
        </div>
        <div class="stat-card">
          <span class="stat-value">${uniqueSingers}</span>
          <span class="stat-label">Cantores únicos</span>
        </div>
        <div class="stat-card">
          <span class="stat-value">${uniqueTables}</span>
          <span class="stat-label">Mesas ativas</span>
        </div>
        <div class="stat-card">
          <span class="stat-value">${duration}</span>
          <span class="stat-label">Duração da sessão</span>
        </div>
        <div class="stat-card">
          <span class="stat-value">${avgWait}</span>
          <span class="stat-label">Espera média</span>
        </div>
      </div>
    </section>

    <div class="stats-grid">
      <section class="stats-section">
        <h3 class="stats-section-title">Por Cantor</h3>
        <div class="stats-ranking">
          ${bySinger.map(([ name, count ], i) => `
            <div class="rank-row">
              <span class="rank-pos">${i + 1}</span>
              <span class="rank-name">${escapeHtml(name)}</span>
              <span class="rank-bar-wrap"><span class="rank-bar" style="width:${(count / bySinger[0][1]) * 100}%"></span></span>
              <span class="rank-count">${count} 🎵</span>
            </div>`).join('')}
        </div>
      </section>

      <section class="stats-section">
        <h3 class="stats-section-title">Por Mesa</h3>
        <div class="stats-ranking">
          ${byTable.map(([ table, count ], i) => `
            <div class="rank-row">
              <span class="rank-pos">${i + 1}</span>
              <span class="rank-name">${escapeHtml(table)}</span>
              <span class="rank-bar-wrap"><span class="rank-bar" style="width:${(count / byTable[0][1]) * 100}%"></span></span>
              <span class="rank-count">${count} 🎵</span>
            </div>`).join('')}
        </div>
      </section>

      <section class="stats-section">
        <h3 class="stats-section-title">Músicas Mais Pedidas</h3>
        <div class="stats-ranking">
          ${topSongs.length === 0 ? '<p class="stats-empty">Sem dados</p>' :
            topSongs.map(([ song, count ], i) => `
            <div class="rank-row">
              <span class="rank-pos">${i + 1}</span>
              <span class="rank-name">#${escapeHtml(song)}</span>
              <span class="rank-bar-wrap"><span class="rank-bar" style="width:${(count / topSongs[0][1]) * 100}%"></span></span>
              <span class="rank-count">${count}x</span>
            </div>`).join('')}
        </div>
      </section>

      <section class="stats-section">
        <h3 class="stats-section-title">Horário de Pico</h3>
        <div class="stats-ranking">
          ${peakHours.map(([ hour, count ], i) => `
            <div class="rank-row">
              <span class="rank-pos">${i + 1}</span>
              <span class="rank-name">${String(hour).padStart(2,'0')}h</span>
              <span class="rank-bar-wrap"><span class="rank-bar" style="width:${(count / peakHours[0][1]) * 100}%"></span></span>
              <span class="rank-count">${count} 🎵</span>
            </div>`).join('')}
        </div>
      </section>
    </div>`
}

function groupAndSort(history, keyFn, countFn) {
  const map = {}
  history.forEach(e => {
    const key = keyFn(e)
    map[key] = (map[key] || 0) + countFn(e)
  })
  return Object.entries(map).sort((a, b) => b[1] - a[1])
}

function calcDuration(history) {
  if (history.length < 2) return '—'
  const timestamps = history.flatMap(e => [e.insertedAt, e.doneAt]).filter(Boolean)
  const mins = Math.round((Math.max(...timestamps) - Math.min(...timestamps)) / 60000)
  if (mins < 60) return `${mins} min`
  return `${Math.floor(mins / 60)}h ${mins % 60}min`
}

function calcAvgWait(history) {
  const waits = history.map(e => e.doneAt - e.insertedAt).filter(Boolean)
  if (waits.length === 0) return '—'
  const avgMin = Math.round(waits.reduce((a, b) => a + b, 0) / waits.length / 60000)
  return `${avgMin} min`
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
  // Load app name before anything else to prevent it from being overwritten
  const _savedName = localStorage.getItem(KEYS.APP_NAME)
  if (_savedName) {
    document.getElementById('app-name').textContent = _savedName
  }

  loadState()
  renderQueue()
  updateClock()
  updateSessionStartInfo()
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

  document.getElementById('btn-stats').addEventListener('click', openStats)
  document.getElementById('btn-close-stats').addEventListener('click', closeStats)
  document.getElementById('stats-search-name').addEventListener('input', e => {
    statsFilter.name = e.target.value
    renderStats()
  })
  document.getElementById('stats-search-table').addEventListener('input', e => {
    statsFilter.table = e.target.value.trim()
    renderStats()
  })
  document.getElementById('btn-history').addEventListener('click', openHistory)
  document.getElementById('btn-close-history').addEventListener('click', closeHistory)
  document.getElementById('overlay').addEventListener('click', () => { closeHistory(); closeStats(); closeTableModal() })
  document.getElementById('btn-close-table-modal').addEventListener('click', closeTableModal)
  document.getElementById('btn-clear-history').addEventListener('click', clearHistory)
  document.getElementById('btn-clear-date').addEventListener('click', () => {
    statsFilter.filterDate = ''
    document.getElementById('stats-filter-date').value = ''
    renderStats()
  })

  document.getElementById('btn-clear-period').addEventListener('click', () => {
    statsFilter.filterFrom = ''; statsFilter.filterTo = ''
    document.getElementById('stats-filter-from').value = ''
    document.getElementById('stats-filter-to').value   = ''
    renderStats()
  })

  document.getElementById('stats-filter-date').addEventListener('change', e => {
    statsFilter.filterDate = e.target.value
    if (e.target.value) {
      statsFilter.filterFrom = ''; statsFilter.filterTo = ''
      document.getElementById('stats-filter-from').value = ''
      document.getElementById('stats-filter-to').value   = ''
    }
    renderStats()
  })
  document.getElementById('stats-filter-from').addEventListener('change', e => {
    statsFilter.filterFrom = e.target.value
    if (e.target.value) {
      statsFilter.filterDate = ''
      document.getElementById('stats-filter-date').value = ''
    }
    renderStats()
  })
  document.getElementById('stats-filter-to').addEventListener('change', e => {
    statsFilter.filterTo = e.target.value
    if (e.target.value) {
      statsFilter.filterDate = ''
      document.getElementById('stats-filter-date').value = ''
    }
    renderStats()
  })

  document.getElementById('history-search').addEventListener('input', e => {
    historyFilter.search = e.target.value
    renderHistory()
  })

  document.getElementById('btn-sort-history').addEventListener('click', () => {
    historyFilter.order = historyFilter.order === 'desc' ? 'asc' : 'desc'
    renderHistory()
  })

  setInterval(checkAutoReset, 60000)

  showStartupDialog()

  // ── Editable app name ──────────────────────────────
  const appNameEl  = document.getElementById('app-name')
  const popover    = document.getElementById('name-popover')
  const popInput   = document.getElementById('name-popover-input')
  const btnEdit    = document.getElementById('btn-edit-name')
  const btnSave    = document.getElementById('btn-name-save')
  const btnCancel  = document.getElementById('btn-name-cancel')

  const savedName = localStorage.getItem(KEYS.APP_NAME)
  if (savedName) appNameEl.textContent = savedName

  function openNamePopover() {
    popInput.value = appNameEl.textContent
    popover.classList.remove('hidden')
    popInput.focus()
    popInput.select()
  }

  function saveAppName() {
    const val = popInput.value.trim() || 'Karaoke Queue'
    appNameEl.textContent = val
    localStorage.setItem(KEYS.APP_NAME, val)
    popover.classList.add('hidden')
  }

  function cancelNameEdit() {
    popover.classList.add('hidden')
  }

  btnEdit.addEventListener('click', openNamePopover)
  btnSave.addEventListener('click', saveAppName)
  btnCancel.addEventListener('click', cancelNameEdit)
  popInput.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); saveAppName() }
    if (e.key === 'Escape') cancelNameEdit()
  })

  // ── Theme toggle ───────────────────────────────────
  const btnThemeToggle = document.getElementById('btn-theme-toggle')
  let currentTheme = localStorage.getItem('kshake_theme') || 'dark'

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme)
    btnThemeToggle.textContent = theme === 'dark' ? '☀️' : '🌙'
    currentTheme = theme
    localStorage.setItem('kshake_theme', theme)
  }

  applyTheme(currentTheme)

  btnThemeToggle.addEventListener('click', () => {
    applyTheme(currentTheme === 'dark' ? 'light' : 'dark')
  })

  // Expose state to main process for close event handling
  window.__kqueue = {
    queueLength:      () => state.queue.length,
    sessionEnded:     () => { const s = currentSession(); return !s || !!s.endedAt },
    endSessionSilent: () => {
      const s = currentSession()
      if (s && !s.endedAt) { s.endedAt = Date.now(); saveState() }
    }
  }
})
