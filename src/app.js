'use strict'

// ── Storage keys ──────────────────────────────────────
const KEYS = {
  APP_NAME:           'kshake_app_name',
  QUEUE:              'kshake_queue',
  HISTORY:            'kshake_history',
  SESSIONS:           'kshake_sessions',
  CURRENT_SESSION_ID: 'kshake_current_session',
  PRIORITY_IDS:       'kshake_priority',
  CURRENT_TURN_ID:    'kshake_current_turn',
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
  priorityIds:      [],   // manually pinned entries (drag override), front = first
  currentTurnId:    null, // locked "vez atual" — stays put until Cantou/Cancelar
  lastReset:        null  // toDateString() of the last auto-reset (18h)
}

// All critical state lives in electron-store (durable, synchronous disk writes,
// no 5MB cap). localStorage is NOT durable on an abrupt window close — Chromium
// flushes it lazily — so it must not hold the queue/history. STORE_KEY is only
// the browser-dev fallback (theme/app-name keep their own localStorage keys).
const STORE_KEY = 'kshake_store'

// Strictly-increasing insertion timestamp. Guarantees a stable, correct order
// even when several entries are added in the same millisecond (batch add).
let lastInsertedAt = 0
function nextInsertedAt() {
  lastInsertedAt = Math.max(Date.now(), lastInsertedAt + 1)
  return lastInsertedAt
}

// ── Persistence ───────────────────────────────────────
// PERMANENT (grows): history + sessions → electron-store (disk, no 5MB cap),
// with a localStorage fallback when opened directly in a browser (dev).
const store = {
  async load() {
    if (window.kstore) return (await window.kstore.load()) || {}
    const raw = localStorage.getItem(STORE_KEY)
    return raw ? JSON.parse(raw) : {}
  },
  save(blob) {
    if (window.kstore) return window.kstore.save(blob) // returns a promise
    localStorage.setItem(STORE_KEY, JSON.stringify(blob))
    return Promise.resolve()
  }
}

function saveState() {
  return store.save({
    queue:            state.queue,
    history:          state.history,
    sessions:         state.sessions,
    currentSessionId: state.currentSessionId,
    priorityIds:      state.priorityIds,
    currentTurnId:    state.currentTurnId,
    lastReset:        state.lastReset
  })
}

// One-time migration: the old layout kept everything in multi-key localStorage.
function legacyFromLocalStorage() {
  if (localStorage.getItem(KEYS.QUEUE) === null &&
      localStorage.getItem(KEYS.HISTORY) === null &&
      localStorage.getItem(KEYS.SESSIONS) === null) return null
  return {
    queue:            JSON.parse(localStorage.getItem(KEYS.QUEUE)            || '[]'),
    history:          JSON.parse(localStorage.getItem(KEYS.HISTORY)          || '[]'),
    sessions:         JSON.parse(localStorage.getItem(KEYS.SESSIONS)         || '[]'),
    currentSessionId: localStorage.getItem(KEYS.CURRENT_SESSION_ID)          || null,
    priorityIds:      JSON.parse(localStorage.getItem(KEYS.PRIORITY_IDS)     || '[]'),
    currentTurnId:    localStorage.getItem(KEYS.CURRENT_TURN_ID)             || null,
    lastReset:        localStorage.getItem(KEYS.LAST_RESET)                  || null
  }
}

async function loadState() {
  let data = await store.load()
  let migrated = false

  // First run on the store: migrate any legacy multi-key localStorage data so
  // existing users keep their history.
  if (data.queue === undefined && data.history === undefined && data.sessions === undefined) {
    const legacy = legacyFromLocalStorage()
    if (legacy) { data = legacy; migrated = true }
  }

  state.queue            = data.queue            || []
  state.history          = data.history          || []
  state.sessions         = data.sessions         || []
  state.currentSessionId = data.currentSessionId || null
  state.priorityIds      = data.priorityIds      || []
  state.currentTurnId    = data.currentTurnId    || null
  state.lastReset        = data.lastReset        || null

  // First run or migration: create a session if none exists
  if (state.sessions.length === 0) {
    const session = createSession()
    // Tag any existing history entries with this session
    state.history.forEach(e => { if (!e.sessionId) e.sessionId = session.id })
  } else if (!state.currentSessionId) {
    state.currentSessionId = state.sessions[state.sessions.length - 1].id
  }

  saveState() // persist in the new split layout (also completes migration)

  // Free the old multi-key localStorage copy once safely migrated.
  if (migrated) {
    [KEYS.QUEUE, KEYS.HISTORY, KEYS.SESSIONS, KEYS.CURRENT_SESSION_ID,
     KEYS.PRIORITY_IDS, KEYS.CURRENT_TURN_ID, KEYS.LAST_RESET]
      .forEach(k => localStorage.removeItem(k))
  }
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
// Base order is FIFO by insertedAt. A single anti-repetition rule applies:
// when picking the next entry, if the front entry belongs to the same table
// that just sang (or is singing now = the current top), skip to the next entry
// of a different table. If no other table is waiting, the same table repeats.
// Pinned entries (manual drag override) are forced to be the next ones to sing.

// Entries from the current session that actually sang (excludes cancelled).
function sungEntries(sessionId = state.currentSessionId) {
  return state.history.filter(e => e.sessionId === sessionId && e.status !== 'cancelled')
}

// Table of the most recently sung entry in the current session (null if none).
function lastSungTable() {
  const sung = sungEntries()
  if (sung.length === 0) return null
  return sung.reduce((a, b) => (b.doneAt > a.doneAt ? b : a)).table
}

// When to *offer* the operator a boost prompt on a waiting card. Adaptive to
// how busy the queue is: a full rotation cycle ≈ (distinct tables) × MIN_PER_TURN,
// so the prompt only appears once someone waited clearly longer than a normal
// rotation — small queue → short, big queue → longer. It never auto-reorders;
// the operator decides with Sim/Não on the card.
const MIN_PER_TURN   = 6    // estimated minutes a table occupies (up to 2 songs)
const WAIT_MARGIN    = 1.5  // offer the boost only after ~1.5 full rotations
const MIN_WAIT_FLOOR = 30   // never below this, for tiny queues

function maxWaitMinutes() {
  const distinct = new Set(state.queue.map(e => e.table)).size
  return Math.max(MIN_WAIT_FLOOR, Math.round(WAIT_MARGIN * distinct * MIN_PER_TURN))
}

// Arrival-order queue (FIFO) with two anti-monopoly safeguards, seeded by the
// last sung table. No history penalty: a table that already sang is NOT pushed
// back for having sung — it simply competes by when it (re-)entered, and since
// re-adding lands at the back, it naturally waits a full lap.
//   1. queueRound = how many entries of the SAME table are waiting ahead. The
//      extra entries of a table that registered several at once drop behind
//      other tables, so it never takes many turns in a row.
//   2. anti-repetition (greedy below): the same table doesn't sing twice in a
//      row while another table is waiting.
// Ties broken by insertedAt (arrival order).
function fairOrder(entries, seedLastTable) {
  const queueRound = e => entries.filter(o => o.table === e.table && o.insertedAt < e.insertedAt).length
  const remaining  = [...entries].sort((a, b) => {
    const qa = queueRound(a), qb = queueRound(b)
    if (qa !== qb) return qa - qb
    return a.insertedAt - b.insertedAt
  })
  const result    = []
  let lastTable   = seedLastTable
  while (remaining.length > 0) {
    let idx = remaining.findIndex(e => e.table !== lastTable)
    if (idx === -1) idx = 0 // all remaining are the same table → allow repeat
    const [picked] = remaining.splice(idx, 1)
    result.push(picked)
    lastTable = picked.table
  }
  return result
}

function calcWait(insertedAt) {
  const mins = Math.floor((Date.now() - insertedAt) / 60000)
  if (mins < 1) return 'agora'
  if (mins < 60) return `há ${mins}min`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return m > 0 ? `há ${h}h ${m}min` : `há ${h}h`
}

function updateWaitTimes() {
  document.querySelectorAll('.card-wait[data-inserted]').forEach(el => {
    const insertedAt = parseInt(el.dataset.inserted)
    const mins       = Math.floor((Date.now() - insertedAt) / 60000)
    el.textContent   = calcWait(insertedAt)
    el.className     = 'card-wait' +
      (mins >= 30 ? ' card-wait--danger' : mins >= 15 ? ' card-wait--warning' : '')
  })
}

// Full ordered queue. Pinned entries are injected right after the current
// turn (slot 1+), so a manual drag bumps someone to "próximo" without
// interrupting whoever is the current turn.
function sortedQueue() {
  const pinnedSet  = new Set(state.priorityIds)
  const nonPinned  = state.queue.filter(e => !pinnedSet.has(e.id))
  const fair       = fairOrder(nonPinned, lastSungTable())
  const pinned     = state.priorityIds
    .map(id => state.queue.find(e => e.id === id))
    .filter(Boolean)

  if (pinned.length === 0) return fair

  const result = [...fair]
  result.splice(1, 0, ...pinned) // insert pinned as the next ones to sing
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
    insertedAt:  nextInsertedAt(),
    status:      'pending',
    sessionId:   state.currentSessionId
  }
  state.queue.push(entry)
  saveState()
  renderQueue()
  showToast(`${entry.name} adicionado(a) à fila!`)
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

function cancelEntry(id) {
  const entry = state.queue.find(e => e.id === id)
  if (!entry) return
  if (!confirm(`Cancelar ${entry.name} (Mesa ${entry.table})? A entrada sai da fila e fica registrada como cancelada.`)) return
  state.queue = state.queue.filter(e => e.id !== id)
  state.priorityIds = state.priorityIds.filter(p => p !== id)
  clearBoostState(id)
  if (state.currentTurnId === id) state.currentTurnId = null
  entry.status      = 'cancelled'
  entry.cancelledAt = Date.now()
  state.history.unshift(entry)
  saveState()
  renderQueue()
  renderHistory()
  showToast(`${entry.name} (Mesa ${entry.table}) cancelado(a).`)
}

function markDone(id) {
  const idx = state.queue.findIndex(e => e.id === id)
  if (idx === -1) return
  const [entry] = state.queue.splice(idx, 1)
  entry.status = 'done'
  entry.doneAt = Date.now()
  state.priorityIds = state.priorityIds.filter(p => p !== entry.id)
  clearBoostState(entry.id)
  if (state.currentTurnId === entry.id) state.currentTurnId = null
  state.history.unshift(entry)
  saveState()
  renderQueue()
  renderHistory()
  showToast(`${entry.name} (Mesa ${entry.table}) marcado como cantado!`)
}

// ── Manual priority (drag override) ───────────────────────
function pinNext(id) {
  state.priorityIds = state.priorityIds.filter(p => p !== id)
  state.priorityIds.unshift(id)
  clearBoostState(id)
  saveState()
  renderQueue()
}

function unpin(id) {
  state.priorityIds = state.priorityIds.filter(p => p !== id)
  saveState()
  renderQueue()
}

// ── Overdue boost prompt (operator decides) ───────────────
// Non-blocking: the entry keeps flowing in the queue normally. When it has
// waited past the threshold the full prompt shows. Two outcomes:
//   • "Não" (explicit decision) → the alert is fully dismissed for this entry.
//   • untouched for BOOST_COLLAPSE_MS → it collapses to a small ⏰ marker the
//     operator can click to reopen — so an ignored alert isn't lost.
let boostTimers          = {}        // id -> auto-collapse timeout handle
let boostCollapsed       = new Set()  // ids collapsed to the ⏰ marker (untouched)
let boostDismissed       = new Set()  // ids the operator said "Não" to (fully hidden)
const BOOST_COLLAPSE_MS  = 120000  // collapse the full prompt after 2 min untouched

function boostOverdue(entry) {
  return (Date.now() - entry.insertedAt) / 60000 >= maxWaitMinutes()
}

function clearBoostState(id) {
  if (boostTimers[id]) { clearTimeout(boostTimers[id]); delete boostTimers[id] }
  boostCollapsed.delete(id)
  boostDismissed.delete(id)
}

// Schedule the auto-collapse (once per expanded streak).
function scheduleBoostCollapse(id) {
  if (boostTimers[id]) return
  boostTimers[id] = setTimeout(() => {
    delete boostTimers[id]
    boostCollapsed.add(id)
    renderQueue()
  }, BOOST_COLLAPSE_MS)
}

function acceptBoost(id)  { clearBoostState(id); pinNext(id) }   // Sim → bump to "próximo"
function dismissBoost(id) {                                       // Não → fully hide the alert
  if (boostTimers[id]) { clearTimeout(boostTimers[id]); delete boostTimers[id] }
  boostCollapsed.delete(id)
  boostDismissed.add(id)
  renderQueue()
}
function expandBoost(id) { boostCollapsed.delete(id); renderQueue() } // click marker → reopen

// ── Session reset ──────────────────────────────────────
function resetSession() {
  const cur = currentSession()
  if (cur && !cur.endedAt) cur.endedAt = Date.now()

  createSession()

  state.queue           = []
  state.priorityIds     = []
  state.currentTurnId   = null
  historyFilter         = { search: '', table: null, order: 'desc', sessionId: null }
  statsFilter           = { name: '', table: '', filterDate: '', filterFrom: '', filterTo: '' }
  state.lastReset = new Date().toDateString()
  saveState()
  renderQueue()
  renderHistory()
  showToast('Novo expediente iniciado!')
}

function checkAutoReset() {
  const now = new Date()
  if (now.getHours() === 18 && now.getMinutes() === 0 && state.lastReset !== now.toDateString()) {
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
  const entries = sungEntries().filter(e => e.table === table)
  if (entries.length === 0) {
    showToast(`Mesa ${table} ainda não tem histórico nesta sessão.`)
    return
  }

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
function songsHtml(entry) {
  return `🎵 ${escapeHtml(entry.songNumber)}${entry.songNumber2 ? ` &nbsp;🎵 ${escapeHtml(entry.songNumber2)}` : ''}`
}

function tableBadgeHtml(table) {
  return `<button class="card-table card-table-clickable" onclick="openTableModal('${table}')" title="Ver detalhes da mesa">Mesa ${table}</button>`
}

function renderQueue() {
  const nowBlock  = document.getElementById('now-block')
  const nextBlock = document.getElementById('next-block')
  const list      = document.getElementById('queue-list')
  const counter   = document.getElementById('queue-count')

  const fair = sortedQueue()

  // Lock the current turn: once shown as "vez atual" it stays until the
  // operator marks Cantou/Cancelar — new arrivals and manual boosts only
  // affect "próximo" onwards, never the person already at the mic.
  let current = state.currentTurnId
    ? state.queue.find(e => e.id === state.currentTurnId) || null
    : null
  if (!current) {
    current = fair[0] || null
    state.currentTurnId = current ? current.id : null
    saveState()
  }
  const next   = fair.find(e => e.id !== current?.id) || null

  const topIds  = new Set([current?.id, next?.id].filter(Boolean))
  const waiting = state.queue
    .filter(e => !topIds.has(e.id))
    .sort((a, b) => a.insertedAt - b.insertedAt)

  // Prune boost state for entries no longer in the waiting list (promoted to
  // vez atual/próximo, sung, cancelled, or wiped by a new expediente), clearing
  // any pending auto-collapse timer so it can't fire after the entry left.
  const waitingIds = new Set(waiting.map(e => e.id))
  Object.keys(boostTimers).forEach(id => {
    if (!waitingIds.has(id)) { clearTimeout(boostTimers[id]); delete boostTimers[id] }
  })
  boostCollapsed.forEach(id => { if (!waitingIds.has(id)) boostCollapsed.delete(id) })
  boostDismissed.forEach(id => { if (!waitingIds.has(id)) boostDismissed.delete(id) })

  counter.textContent = waiting.length

  // ── Vez atual
  if (current) {
    const pinned = state.priorityIds.includes(current.id)
    nowBlock.classList.remove('hidden')
    nowBlock.innerHTML = `
      <div class="now-card${pinned ? ' is-pinned' : ''}">
        <div class="now-label">🎤 Vez atual</div>
        <div class="now-main">
          ${tableBadgeHtml(current.table)}
          <span class="now-name">${escapeHtml(current.name)}</span>
          <span class="now-song">${songsHtml(current)}</span>
        </div>
        <div class="now-actions">
          <button class="btn btn-outline btn-sm" onclick="openEdit('${current.id}')" title="Editar">✏️</button>
          <button class="btn btn-danger-outline btn-sm" onclick="cancelEntry('${current.id}')">Cancelar</button>
          <button class="btn-done-lg" onclick="markDone('${current.id}')">✓ Cantou</button>
        </div>
      </div>`
  } else {
    nowBlock.classList.add('hidden')
    nowBlock.innerHTML = ''
  }

  // ── Próximo recomendado
  if (next) {
    const pinned       = state.priorityIds.includes(next.id)
    const minPending   = Math.min(...[next, ...waiting].map(e => e.insertedAt))
    const skipped      = !pinned && current && next.insertedAt > minPending
    const reason       = pinned
      ? '📌 Fixado manualmente'
      : skipped
        ? 'ⓘ Ajustado para a mesma mesa não cantar em seguida'
        : ''
    nextBlock.classList.remove('hidden')
    nextBlock.innerHTML = `
      <div class="next-card${pinned ? ' is-pinned' : ''}">
        <div class="next-label">Próximo recomendado</div>
        <div class="next-main">
          ${tableBadgeHtml(next.table)}
          <span class="next-name">${escapeHtml(next.name)}</span>
          <span class="next-song">${songsHtml(next)}</span>
        </div>
        ${reason ? `<div class="next-reason">${reason}</div>` : ''}
        <div class="next-actions">
          ${pinned ? `<button class="btn btn-outline btn-sm" onclick="unpin('${next.id}')">Soltar 📌</button>` : ''}
          <button class="btn btn-outline btn-sm" onclick="openEdit('${next.id}')" title="Editar">✏️</button>
          <button class="btn btn-danger-outline btn-sm" onclick="cancelEntry('${next.id}')">Cancelar</button>
        </div>
      </div>`
  } else {
    nextBlock.classList.add('hidden')
    nextBlock.innerHTML = ''
  }

  // ── Fila de espera (ordem de chegada)
  if (state.queue.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <span class="empty-icon">🎵</span>
        <p>Nenhuma entrada na fila.</p>
        <p>Adicione a primeira música acima!</p>
      </div>`
  } else if (waiting.length === 0) {
    list.innerHTML = `<div class="queue-empty-sm">Sem mais ninguém na espera.</div>`
  } else {
    list.innerHTML = waiting.map((entry, i) => {
      const pinned    = state.priorityIds.includes(entry.id)
      const waitedMin = Math.floor((Date.now() - entry.insertedAt) / 60000)
      const overdue   = !pinned && boostOverdue(entry) && !boostDismissed.has(entry.id)
      const collapsed = boostCollapsed.has(entry.id)
      const showFull  = overdue && !collapsed
      const showBadge = overdue && collapsed
      if (showFull) scheduleBoostCollapse(entry.id)
      return `
      <div class="queue-card${pinned ? ' is-pinned' : ''}${overdue ? ' has-boost' : ''}" data-id="${entry.id}" draggable="true"
        ondragstart="dragStart(event,'${entry.id}')" ondragend="dragEnd(event)"
        ondragover="dragOver(event)" ondrop="drop(event,'${entry.id}')"
        ondragleave="event.currentTarget.classList.remove('drag-over')"
      >
        <span class="queue-pos">${i + 1}</span>
        ${tableBadgeHtml(entry.table)}
        <div class="queue-main">
          <span class="card-name">${escapeHtml(entry.name)}</span>
          <span class="card-song">${songsHtml(entry)}</span>
        </div>
        <div class="queue-meta">
          <span class="card-inserted">&#9201; ${formatTime(entry.insertedAt)}</span>
          <span class="card-wait" data-inserted="${entry.insertedAt}">${calcWait(entry.insertedAt)}</span>
          ${showBadge ? `<button class="boost-badge" onclick="expandBoost('${entry.id}')" title="Esperando há muito — ver opções">⏰ furar?</button>` : ''}
        </div>
        <div class="queue-actions">
          ${pinned ? `<button class="btn btn-outline btn-sm" onclick="unpin('${entry.id}')">Soltar 📌</button>` : ''}
          <button class="btn btn-outline btn-sm" onclick="openEdit('${entry.id}')" title="Editar">✏️</button>
          <button class="btn btn-danger-outline btn-sm" onclick="cancelEntry('${entry.id}')">Cancelar</button>
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
    }).join('')
  }

  updateWaitTimes()
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
  // (cancelled entries never count as sung)
  const singerCounts   = {}
  const singerLastSang = {}
  const tableCounts    = {}
  sungEntries().forEach(e => {
    const n   = 1 + (e.songNumber2 ? 1 : 0)
    const key = e.name.toLowerCase()
    singerCounts[key]    = (singerCounts[key]    || 0) + n
    tableCounts[e.table] = (tableCounts[e.table] || 0) + n
    if (!singerLastSang[key] || e.doneAt > singerLastSang[key]) {
      singerLastSang[key] = e.doneAt
    }
  })

  list.innerHTML = filtered.map(entry => {
    const cancelled = entry.status === 'cancelled'
    if (cancelled) {
      return `
    <div class="history-card history-card--cancelled">
      <div class="history-card-top">
        <span class="history-name">${escapeHtml(entry.name)}</span>
        <span class="history-badge-table history-badge-cancelled">Mesa ${entry.table}</span>
        <span class="history-song">${songsHtml(entry)}</span>
        <span class="history-cancelled-tag">Cancelada</span>
      </div>
      <div class="history-card-bottom">
        <div class="history-times">
          <span class="history-time"><span class="history-time-label">Inserido</span> ${formatTime(entry.insertedAt)}</span>
          <span class="history-time-arrow">→</span>
          <span class="history-time"><span class="history-time-label">Cancelada</span> ${formatTime(entry.cancelledAt)}</span>
        </div>
      </div>
    </div>`
    }
    const key         = entry.name.toLowerCase()
    const singerTotal = singerCounts[key] || 0
    const lastSang    = singerLastSang[key] || 0
    return `
    <div class="history-card">
      <div class="history-card-top">
        <span class="history-name">${escapeHtml(entry.name)}</span>
        <button class="history-badge-table history-badge-clickable" onclick="openTableModal('${entry.table}')" title="Ver detalhes da mesa">Mesa ${entry.table}</button>
        <span class="history-song">${songsHtml(entry)}</span>
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
  let h = state.history.filter(e => sessionIds.includes(e.sessionId) && e.status !== 'cancelled')
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
  const dragged = draggedId
  draggedId = null
  if (!dragged || dragged === targetId) return
  // Dragging a card bumps it to be the next one to sing (manual override).
  pinNext(dragged)
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
document.addEventListener('DOMContentLoaded', async () => {
  // Load app name before anything else to prevent it from being overwritten
  const _savedName = localStorage.getItem(KEYS.APP_NAME)
  if (_savedName) {
    document.getElementById('app-name').textContent = _savedName
  }

  await loadState() // disk-backed store is async; finish before first render
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
  setInterval(updateWaitTimes, 30000)
  // Re-render periodically so the "furar pra frente?" prompt appears once a
  // card crosses the wait threshold, even without a queue event.
  setInterval(renderQueue, 60000)

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
    // async + awaited by main.js so the final write completes before the
    // window is destroyed (the store save is an async IPC roundtrip).
    endSessionSilent: async () => {
      const s = currentSession()
      if (s && !s.endedAt) { s.endedAt = Date.now(); await saveState() }
    }
  }
})
