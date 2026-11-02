import { isNewPlayerOutputReturn, isStalePlayerUiRevision, type KaraokePlayerBridge, type PlayerMusicMetadata, type PlayerUiSnapshot } from './player-ui-contracts'
import type { ManualSequenceItem } from './manual-playback-service'
import type { PlayerPlaybackStatus } from './player-playback-contracts'

declare global { interface Window { karaokePlayer?: KaraokePlayerBridge } }

const bridge = window.karaokePlayer
const byId = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const element = document.getElementById(id)
  if (!element) throw new Error(`Elemento #${id} não encontrado.`)
  return element as T
}

const metadata = new Map<string, PlayerMusicMetadata>()
const metadataRequests = new Set<string>()
let snapshot: PlayerUiSnapshot | undefined
let metadataCatalogRevision: string | null | undefined
let metadataGeneration = 0
let busy = false
let recoverySelectionAttemptId: string | undefined
let pendingShutdownAttemptId: string | undefined
let dismissedErrorKey: string | undefined
let toastTimer: ReturnType<typeof setTimeout> | undefined
let draggingSequenceId: string | undefined
let activeView: 'manual' | 'settings' | 'video' = 'video'
let lastInlineFullScreen: boolean | undefined
let inlineBoundsFrameScheduled = false
let returnToInlineRevision: number | undefined
let inlineVisibilityQueue: Promise<void> = Promise.resolve()

function requireBridge(): KaraokePlayerBridge {
  if (!bridge) throw new Error('A interface segura do Reprodutor não foi carregada.')
  return bridge
}

function formatTime(seconds: number | null | undefined): string {
  if (!Number.isFinite(seconds) || (seconds as number) < 0) return '00:00'
  const whole = Math.floor(seconds as number)
  return `${String(Math.floor(whole / 60)).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`
}

function displayCode(code: string): string {
  const numeric = Number.parseInt(code, 10)
  return Number.isFinite(numeric) ? String(numeric) : code
}

function displayError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const messages: Record<string, string> = {
    INVALID_MUSIC_CODE: 'Digite um código numérico válido com até cinco dígitos.',
    MEDIA_UNAVAILABLE: 'O vídeo não está disponível na biblioteca atual.',
    MEDIA_AMBIGUOUS: 'Há mais de um vídeo indexado com esse código. Revise a biblioteca.',
    MEDIA_UNKNOWN: 'A disponibilidade do vídeo não pôde ser confirmada. Atualize a biblioteca.',
    RECOVERY_PENDING: 'Resolva a reprodução interrompida antes de iniciar outra música.',
    RECOVERY_UNAVAILABLE: 'A recuperação está bloqueada. Nenhuma música foi iniciada.',
    RECOVERY_PERSISTENCE_FAILED: 'O estado da reprodução não pôde ser salvo. A reprodução permanece bloqueada.',
    HOST_NOT_READY: 'A janela de vídeo ainda está sendo preparada. Tente novamente em instantes.',
    HOST_UNAVAILABLE: 'A janela de vídeo não está disponível. Use “Mostrar janela” e tente novamente.',
    HOST_TERMINATED: 'A janela de vídeo foi encerrada. O resultado da reprodução é incerto.',
    COMMAND_TIMEOUT: 'O Player não confirmou o comando dentro do prazo. O resultado permanece incerto.',
    PLAYER_ACTIVE: 'Pare a reprodução atual antes de alterar a biblioteca de vídeos.',
    PLAYBACK_FAILED: 'O vídeo não pôde ser reproduzido. A sequência não avançou.',
    VIDEO_LIBRARY_BUSY: 'A biblioteca está sendo atualizada. Aguarde e tente novamente.'
  }
  const code = Object.keys(messages).find(candidate => raw.includes(candidate))
  if (code) return messages[code]
  if (raw.includes('INVALID_RECOVERY')) return 'A decisão de recuperação ficou desatualizada. Atualize o estado e tente novamente.'
  if (raw.includes('CANCELED') || raw.includes('cancelled')) return 'A operação foi cancelada.'
  return 'Não foi possível concluir a operação. O estado atual foi preservado.'
}

function showToast(message: string): void {
  const toast = byId('player-toast')
  toast.textContent = message
  toast.hidden = false
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toast.hidden = true }, 3200)
}

function dismissToast(): void {
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = undefined
  const toast = byId('player-toast')
  toast.textContent = ''
  toast.hidden = true
}

function statusLabel(status: PlayerPlaybackStatus): string {
  const labels: Record<PlayerPlaybackStatus, string> = {
    idle: 'Aguardando música', loading: 'Preparando vídeo', starting: 'Iniciando reprodução',
    ready: 'Preparando reprodução', playing: 'Tocando agora', paused: 'Pausada',
    stopping: 'Parando música', stopped: 'Parada', completed: 'Término normal',
    failed: 'Falha na reprodução', uncertain: 'Resultado incerto', disposed: 'Player encerrado'
  }
  return labels[status]
}

function headerStatus(snapshot: PlayerUiSnapshot): { label: string; state: string } {
  if (snapshot.recovery.status === 'pending') return { label: 'Recuperação pendente', state: 'warning' }
  if (snapshot.recovery.status === 'unreadable' || snapshot.recovery.status === 'unavailable') {
    return { label: 'Reprodução bloqueada', state: 'warning' }
  }
  switch (snapshot.playback.status) {
    case 'playing': return { label: 'Em reprodução', state: 'playing' }
    case 'paused': return { label: 'Pausada', state: 'info' }
    case 'loading': case 'starting': case 'ready': return { label: 'Preparando', state: 'info' }
    case 'stopping': return { label: 'Parando', state: 'warning' }
    case 'failed': return { label: 'Falha na reprodução', state: 'error' }
    case 'uncertain': case 'disposed': return { label: 'Resultado incerto', state: 'warning' }
    case 'stopped': case 'completed': return { label: 'Parada', state: 'neutral' }
    default: return { label: 'Sem música', state: 'neutral' }
  }
}

function libraryStatusLabel(value: PlayerUiSnapshot['library']['status']): string {
  const labels = { 'not-configured': 'Não configurada', empty: 'Nenhum vídeo disponível', indexing: 'Indexando biblioteca',
    available: 'Pasta disponível', unavailable: 'Biblioteca indisponível', error: 'Indexação com problemas' }
  return labels[value]
}

function requestMetadata(codes: string[]): void {
  for (const code of new Set(codes.filter(Boolean))) {
    const generation = metadataGeneration
    const requestKey = `${generation}:${code}`
    if (metadata.has(code) || metadataRequests.has(requestKey)) continue
    metadataRequests.add(requestKey)
    void requireBridge().lookupMusicCode(code).then(item => {
      if (generation === metadataGeneration) {
        metadata.set(code, item)
        render()
      }
    }).catch(() => {
      if (generation === metadataGeneration) {
        metadata.set(code, { videoCode: code, artist: null, title: null, metadataAvailable: false, videoAvailability: 'unknown' })
        render()
      }
    }).finally(() => {
      metadataRequests.delete(requestKey)
      if (generation !== metadataGeneration) requestVisibleMetadata()
    })
  }
}

function requestVisibleMetadata(): void {
  if (!snapshot) return
  const activeCode = snapshot.playback.musicCode ?? snapshot.sequence.current?.musicCode ?? ''
  const recoveryCode = snapshot.recovery.status === 'pending' ? snapshot.recovery.musicCode : ''
  requestMetadata([activeCode, recoveryCode, ...snapshot.sequence.pending.map(item => item.musicCode)])
}

function applySnapshot(next: PlayerUiSnapshot): void {
  if (isStalePlayerUiRevision(snapshot?.revision, next.revision)) return
  const returnedFromDetachedWindow = isNewPlayerOutputReturn(returnToInlineRevision, next.videoWindow.returnToInlineRevision)
  returnToInlineRevision = Math.max(returnToInlineRevision ?? next.videoWindow.returnToInlineRevision,
    next.videoWindow.returnToInlineRevision)
  const nextErrorKey = next.playback.status === 'failed'
    ? `${next.playback.attemptId ?? 'no-attempt'}:${next.playback.musicCode ?? ''}:${next.playback.errorCode ?? ''}`
    : undefined
  if (nextErrorKey !== dismissedErrorKey) dismissedErrorKey = undefined
  const nextCatalogRevision = next.catalog.metadata.revision
  if (nextCatalogRevision !== metadataCatalogRevision) {
    metadataCatalogRevision = nextCatalogRevision
    metadataGeneration++
    metadata.clear()
  }
  snapshot = next
  if (returnedFromDetachedWindow) {
    setView('video')
    void showPlayerInline().catch(error => showToast(displayError(error)))
  }
  render()
  if (activeView === 'video' && snapshot.videoWindow.location === 'inline') scheduleInlineBoundsUpdate()
}

function titleAndArtist(code: string): { title: string; artist: string; metadataAvailable: boolean } {
  const item = metadata.get(code)
  if (!item?.metadataAvailable) return { title: 'Metadados indisponíveis', artist: '', metadataAvailable: false }
  return { title: item.title || 'Título indisponível', artist: item.artist || '', metadataAvailable: true }
}

function renderSequenceItem(item: ManualSequenceItem, index: number, total: number): HTMLElement {
  const row = document.createElement('div')
  row.className = 'player-sequence-item'
  row.dataset.sequenceId = item.id
  row.addEventListener('dragover', event => {
    if (!draggingSequenceId || draggingSequenceId === item.id || busy) return
    event.preventDefault()
    row.classList.add('is-drop-target')
  })
  row.addEventListener('dragleave', () => row.classList.remove('is-drop-target'))
  row.addEventListener('drop', event => {
    event.preventDefault()
    row.classList.remove('is-drop-target')
    if (!draggingSequenceId || draggingSequenceId === item.id) return
    void reorderSequenceItem(draggingSequenceId, item.id)
    draggingSequenceId = undefined
  })

  const position = document.createElement('span')
  position.className = 'sequence-position'
  position.textContent = String(index + 1)

  const grip = document.createElement('button')
  grip.type = 'button'
  grip.className = 'sequence-grip'
  grip.setAttribute('aria-label', `Reordenar música ${item.musicCode}; use os controles de teclado desta linha para mover`)
  grip.dataset.sequenceId = item.id
  grip.title = 'Arraste para reordenar'
  grip.draggable = true
  grip.innerHTML = '<svg viewBox="0 0 16 20" aria-hidden="true"><circle cx="5" cy="4" r="1.25"/><circle cx="11" cy="4" r="1.25"/><circle cx="5" cy="10" r="1.25"/><circle cx="11" cy="10" r="1.25"/><circle cx="5" cy="16" r="1.25"/><circle cx="11" cy="16" r="1.25"/></svg>'
  grip.addEventListener('dragstart', event => {
    if (busy) { event.preventDefault(); return }
    draggingSequenceId = item.id
    event.dataTransfer?.setData('text/plain', item.id)
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
    row.classList.add('is-dragging')
  })
  grip.addEventListener('dragend', () => {
    draggingSequenceId = undefined
    row.classList.remove('is-dragging')
    document.querySelectorAll('.player-sequence-item.is-drop-target').forEach(node => node.classList.remove('is-drop-target'))
  })

  const track = document.createElement('div')
  track.className = 'sequence-track'
  const code = document.createElement('strong')
  code.className = 'sequence-code'
  code.textContent = item.musicCode
  const separator = document.createElement('span')
  separator.className = 'sequence-separator'
  const details = document.createElement('span')
  details.className = 'sequence-details'
  const info = titleAndArtist(item.musicCode)
  if (info.artist) {
    separator.textContent = '—'
    const title = document.createElement('span')
    title.className = 'sequence-title'
    title.textContent = info.title
    const metaSeparator = document.createElement('span')
    metaSeparator.className = 'sequence-separator'
    metaSeparator.textContent = '·'
    const artist = document.createElement('span')
    artist.className = 'sequence-artist'
    artist.textContent = info.artist
    details.append(title, metaSeparator, artist)
  } else {
    separator.textContent = '—'
    const fallback = document.createElement('span')
    fallback.className = 'sequence-fallback'
    fallback.textContent = info.title
    details.append(fallback)
  }
  const line = document.createElement('div')
  line.className = 'sequence-track-line'
  line.append(code, separator, details)
  track.append(line)

  const up = sequenceAction('Mover para cima', item.id, 'up')
  up.disabled = index === 0 || busy
  up.addEventListener('click', () => { void moveSequenceItem(index, -1) })
  const down = sequenceAction('Mover para baixo', item.id, 'down')
  down.disabled = index === total - 1 || busy
  down.addEventListener('click', () => { void moveSequenceItem(index, 1) })
  const remove = sequenceAction('Remover da sequência', item.id, 'remove')
  remove.classList.add('sequence-remove')
  remove.addEventListener('click', () => { void runCommand(() => requireBridge().removeFromSequence(item.id)) })
  const accessibleActions = document.createElement('div')
  accessibleActions.className = 'sequence-accessible-actions'
  accessibleActions.append(up, down)
  row.append(position, grip, track, accessibleActions, remove)
  return row
}

function sequenceAction(title: string, itemId: string, action: 'up' | 'down' | 'remove'): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = `sequence-action${action === 'remove' ? ' sequence-remove' : ' sequence-accessible-action'}`
  button.title = title
  button.setAttribute('aria-label', `${title}: ${itemId}`)
  button.dataset.sequenceId = itemId
  button.dataset.action = action
  const icon = action === 'up'
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 14 6-6 6 6"/></svg>'
    : action === 'down'
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 10 6 6 6-6"/></svg>'
      : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>'
  button.innerHTML = icon
  return button
}

async function reorderSequenceItem(sourceId: string, targetId: string): Promise<void> {
  const items = snapshot?.sequence.pending
  if (!items) return
  const sourceIndex = items.findIndex(item => item.id === sourceId)
  const targetIndex = items.findIndex(item => item.id === targetId)
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return
  const ids = items.map(item => item.id)
  const [moved] = ids.splice(sourceIndex, 1)
  ids.splice(targetIndex, 0, moved)
  await runCommand(() => requireBridge().reorderSequence(ids))
}

async function moveSequenceItem(index: number, direction: -1 | 1): Promise<void> {
  const items = snapshot?.sequence.pending
  if (!items) return
  const targetIndex = index + direction
  if (targetIndex < 0 || targetIndex >= items.length) return
  const ids = items.map(item => item.id)
  ;[ids[index], ids[targetIndex]] = [ids[targetIndex], ids[index]]
  await runCommand(() => requireBridge().reorderSequence(ids))
}

function setView(view: 'manual' | 'settings' | 'video'): void {
  activeView = view
  byId('player-manual-view').hidden = view !== 'manual'
  byId('player-settings-view').hidden = view !== 'settings'
  byId('player-video-view').hidden = view !== 'video'
  byId<HTMLButtonElement>('player-nav-video').hidden = view === 'settings'
  byId<HTMLButtonElement>('player-nav-manual').hidden = view === 'settings'
  byId<HTMLButtonElement>('player-nav-video').setAttribute('aria-current', String(view === 'video' ? 'page' : 'false'))
  byId<HTMLButtonElement>('player-nav-manual').setAttribute('aria-current', String(view === 'manual' ? 'page' : 'false'))
  byId('player-header-status').hidden = view === 'settings'
  byId<HTMLButtonElement>('player-nav-settings').hidden = view === 'settings'
  byId<HTMLButtonElement>('player-nav-back').hidden = view !== 'settings'
  document.body.dataset.playerFullscreen = String(view === 'video' && snapshot?.videoWindow.location === 'inline' && snapshot.videoWindow.fullScreen)
  if (view === 'video') {
    if (snapshot?.videoWindow.location === 'inline') scheduleInlineBoundsUpdate()
  } else if (snapshot?.videoWindow.location === 'inline') {
    void enqueueInlineVisibility(() => requireBridge().setPlayerInlineVisible(false).then(() => undefined)).catch(() => undefined)
  }
}

function enqueueInlineVisibility(operation: () => Promise<void>): Promise<void> {
  const next = inlineVisibilityQueue.catch(() => undefined).then(operation)
  inlineVisibilityQueue = next.catch(() => undefined)
  return next
}

function currentInlineBounds(): { x: number; y: number; width: number; height: number } {
  const rect = byId('player-inline-stage').getBoundingClientRect()
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
}

function scheduleInlineBoundsUpdate(): void {
  if (inlineBoundsFrameScheduled) return
  inlineBoundsFrameScheduled = true
  requestAnimationFrame(() => {
    inlineBoundsFrameScheduled = false
    if (activeView !== 'video' || snapshot?.videoWindow.location !== 'inline') return
    void requireBridge().updatePlayerInlineBounds(currentInlineBounds()).catch(() => undefined)
  })
}

async function showPlayerInline(): Promise<void> {
  dismissToast()
  setView('video')
  await enqueueInlineVisibility(async () => {
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
    await requireBridge().showPlayerInline(currentInlineBounds())
  })
  await refreshSnapshot()
}

async function navigateToManual(): Promise<void> {
  setView('manual')
  byId('player-code').focus()
  await refreshSnapshot()
}

async function detachPlayerToWindow(): Promise<void> {
  if (busy) return
  busy = true
  render()
  try {
    const output = await requireBridge().showVideoWindow()
    if (output.location === 'window') setView('manual')
  } catch (error) { showToast(displayError(error)) }
  finally { busy = false; await refreshSnapshot() }
}

function render(): void {
  if (!snapshot) return
  const { playback, library, sequence, progress, recovery } = snapshot
  const activeCode = playback.musicCode ?? sequence.current?.musicCode ?? ''
  const status = statusLabel(playback.status)
  const header = headerStatus(snapshot)
  const headerStatusNode = byId('player-header-status')
  headerStatusNode.className = `player-state-pill player-state-pill--${header.state}`
  const headerDot = headerStatusNode.querySelector('i')
  headerStatusNode.replaceChildren(...(headerDot ? [headerDot] : []), document.createTextNode(header.label))
  const currentBadge = byId('player-current-status')
  const activeInfo = activeCode ? titleAndArtist(activeCode) : undefined
  const progressMatches = Boolean(progress && progress.attemptId === playback.attemptId)
  const elapsed = playback.status === 'stopped' ? 0 : progressMatches ? progress!.currentTime : 0
  const badgeDot = currentBadge.querySelector('i') ?? document.createElement('i')
  const badgeText = document.createElement('span')
  badgeText.textContent = `${status} · ${formatTime(elapsed)}`
  currentBadge.replaceChildren(badgeDot, badgeText)
  currentBadge.dataset.state = playback.status
  const hasSelectedMusic = Boolean(activeCode)
  currentBadge.hidden = !hasSelectedMusic
  byId('player-current-code').textContent = activeCode ? displayCode(activeCode) : 'Nenhuma música em reprodução'
  byId('player-current-separator').hidden = !activeCode || !activeInfo?.metadataAvailable
  const titleNode = byId('player-current-title')
  titleNode.textContent = activeInfo?.metadataAvailable ? activeInfo.title ?? '' : ''
  titleNode.hidden = !activeCode || !activeInfo?.metadataAvailable
  byId('player-current-empty-hint').hidden = hasSelectedMusic
  byId('player-current-metadata-missing').hidden = !activeCode || Boolean(activeInfo?.metadataAvailable)
  byId('player-current-artist').textContent = activeInfo?.artist ?? ''
  byId('player-current-artist').hidden = !activeInfo?.artist
  byId('player-current-content').dataset.hasCurrent = String(hasSelectedMusic)
  byId('player-track-actions').hidden = !hasSelectedMusic
  const currentNote = byId('player-current-note')
  currentNote.hidden = playback.status !== 'stopped'
  currentNote.textContent = playback.status === 'stopped'
    ? 'A música atual foi parada manualmente. A sequência permanece intacta e não avançará automaticamente.' : ''
  const currentError = byId('player-current-error')
  currentError.hidden = playback.status !== 'failed' && playback.status !== 'uncertain'
  currentError.textContent = playback.status === 'failed' || playback.status === 'uncertain'
    ? displayError(playback.errorCode ?? 'PLAYBACK_FAILED') : ''

  const toggle = byId<HTMLButtonElement>('player-toggle')
  const canCommand = !busy && recovery.status !== 'unreadable' && recovery.status !== 'unavailable' && recovery.status !== 'pending'
  const hasAttempt = Boolean(activeCode && playback.attemptId)
  const canToggle = playback.status === 'playing' || playback.status === 'paused'
  const canReplayStopped = playback.status === 'stopped' || playback.status === 'completed'
  toggle.disabled = !canCommand || !activeCode || (!canToggle && !canReplayStopped)
  toggle.title = playback.status === 'playing' ? 'Pausar' : playback.status === 'paused' ? 'Continuar' : 'Reproduzir'
  toggle.setAttribute('aria-label', toggle.title)
  toggle.innerHTML = playback.status === 'playing'
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5h3v14H8zM15 5h3v14h-3z"/></svg>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 5 12 7-12 7z"/></svg>'
  byId<HTMLButtonElement>('player-restart').disabled = !canCommand || !hasAttempt || playback.status === 'stopped'
  byId<HTMLButtonElement>('player-stop').disabled = !canCommand || !hasAttempt || playback.status === 'stopped'
  byId<HTMLButtonElement>('player-add-sequence').disabled = busy || recovery.status === 'pending' || recovery.status === 'unreadable' || recovery.status === 'unavailable' || library.status !== 'available'
  byId<HTMLButtonElement>('player-play-now').disabled = busy || recovery.status === 'unreadable' || recovery.status === 'unavailable' || library.status !== 'available'
  byId<HTMLInputElement>('player-code').disabled = busy || recovery.status === 'unreadable' || recovery.status === 'unavailable'

  const sequenceNode = byId('player-sequence')
  sequenceNode.replaceChildren(...sequence.pending.map((item, index) => renderSequenceItem(item, index, sequence.pending.length)))
  const hasPending = sequence.pending.length > 0
  byId('player-sequence-empty').hidden = hasPending
  byId('player-sequence-policy').hidden = !hasPending
  byId('player-sequence-count').textContent = `${sequence.pending.length} ${sequence.pending.length === 1 ? 'música pendente' : 'músicas pendentes'}`
  const clearSequence = byId<HTMLButtonElement>('player-sequence-clear')
  clearSequence.hidden = !hasPending
  clearSequence.disabled = busy
  const videoWindowButton = byId<HTMLButtonElement>('player-video-window')
  videoWindowButton.disabled = true
  videoWindowButton.title = 'Pareamento — Em breve'
  videoWindowButton.setAttribute('aria-label', videoWindowButton.title)
  byId<HTMLButtonElement>('player-detach-video').disabled = busy
  byId<HTMLButtonElement>('player-inline-fullscreen').disabled = busy || !snapshot.videoWindow.open
  const inlineFullscreen = activeView === 'video' && snapshot.videoWindow.location === 'inline' && snapshot.videoWindow.fullScreen
  document.body.dataset.playerFullscreen = String(inlineFullscreen)
  if (lastInlineFullScreen !== undefined && lastInlineFullScreen !== inlineFullscreen) scheduleInlineBoundsUpdate()
  lastInlineFullScreen = inlineFullscreen

  const libraryNotReady = library.status === 'not-configured' || library.status === 'empty'
  byId('player-header-status').hidden = activeView === 'settings' || libraryNotReady
  byId('player-manual-view').dataset.libraryEmpty = String(libraryNotReady)
  byId('player-library-empty-view').hidden = !libraryNotReady
  byId('player-manual-content').hidden = libraryNotReady
  byId('player-library-empty-title').textContent = library.status === 'empty'
    ? 'Nenhum vídeo disponível na biblioteca' : 'Biblioteca de vídeos não selecionada'
  byId('player-library-empty-text').textContent = library.status === 'empty'
    ? 'A pasta selecionada não contém vídeos com códigos válidos. Escolha outra pasta para começar a reproduzir.'
    : 'Selecione a pasta onde estão os vídeos do karaokê para começar a reproduzir suas músicas.'
  byId('player-library-configure').querySelector('span')!.textContent = library.status === 'empty' ? 'Alterar biblioteca' : 'Configurar biblioteca'
  const libraryWarning = byId('player-library-warning')
  const showLibraryWarning = ['indexing', 'unavailable', 'error'].includes(library.status)
  libraryWarning.hidden = !showLibraryWarning
  byId('player-library-warning-title').textContent = library.status === 'indexing'
    ? 'Indexando biblioteca' : library.status === 'unavailable' ? 'Biblioteca indisponível' : 'Não foi possível atualizar a biblioteca'
  byId('player-library-warning-text').textContent = library.status === 'indexing'
    ? 'Aguarde a conclusão da indexação antes de iniciar uma música.'
    : 'Verifique a pasta configurada ou escolha outra biblioteca.'
  byId<HTMLButtonElement>('player-library-configure-warning').hidden = library.status === 'indexing'
  byId<HTMLButtonElement>('player-library-configure-warning').textContent = library.configuredFolders.length ? 'Alterar pasta' : 'Configurar'
  byId<HTMLButtonElement>('player-library-configure-warning').disabled = busy
  byId<HTMLButtonElement>('player-nav-settings').hidden = activeView === 'settings'

  renderSettings()
  requestVisibleMetadata()
  updateRecoveryDialogs()
  updateErrorDialog()
}

function renderSettings(): void {
  if (!snapshot) return
  const library = snapshot.library
  byId('player-library-path').textContent = library.configuredFolders.length
    ? library.configuredFolders.join(' · ') : 'Nenhuma pasta selecionada'
  const libraryStatus = byId('player-library-status')
  libraryStatus.querySelector('span')!.textContent = libraryStatusLabel(library.status)
  libraryStatus.dataset.state = library.status
  byId('player-library-count-number').textContent = library.indexedFiles.toLocaleString('pt-BR')
  byId('player-library-date').textContent = library.lastIndexedAt
    ? `Última indexação: ${new Date(library.lastIndexedAt).toLocaleString('pt-BR', { dateStyle: 'medium', timeStyle: 'short' })}` : 'Ainda não indexada'
  const libraryBusy = busy || library.status === 'indexing'
  byId<HTMLButtonElement>('player-library-change').disabled = libraryBusy
  byId<HTMLButtonElement>('player-library-refresh').disabled = libraryBusy || library.status === 'not-configured'
  const issues = library.ambiguousCodes + library.missingCodes + library.unreadableCodes + library.unknownCodes
  const problems = byId('player-library-problems')
  problems.hidden = issues === 0
  problems.textContent = issues > 0
    ? `${library.ambiguousCodes} códigos ambíguos · ${library.missingCodes} ausentes · ${library.unreadableCodes} inacessíveis · ${library.unknownCodes} não confirmados.` : ''
  const catalog = snapshot.catalog
  const catalogStatus = byId('player-catalog-status')
  catalogStatus.querySelector('span')!.textContent = catalog.status === 'available' ? 'Importado' : 'Não configurado'
  catalogStatus.dataset.state = catalog.status
  byId('player-catalog-file').textContent = catalog.metadata.sourceName ?? 'Nenhum arquivo CSV selecionado'
  byId('player-catalog-count').textContent = catalog.metadata.recordCount.toLocaleString('pt-BR')
  byId('player-catalog-date').textContent = catalog.metadata.importedAt
    ? `Última importação: ${new Date(catalog.metadata.importedAt).toLocaleString('pt-BR', { dateStyle: 'medium', timeStyle: 'short' })}` : 'Ainda não importado'
  const importButton = byId<HTMLButtonElement>('player-catalog-import')
  importButton.querySelector('span')!.textContent = catalog.status === 'available' ? 'Substituir CSV' : 'Importar CSV'
  importButton.disabled = busy
}

function updateRecoveryDialogs(): void {
  if (!snapshot) return
  const recovery = snapshot.recovery
  const pendingDialog = byId<HTMLDialogElement>('player-recovery-dialog')
  const invalidDialog = byId<HTMLDialogElement>('player-invalid-recovery-dialog')
  if (recovery.status === 'pending') {
    byId('recovery-code').textContent = displayCode(recovery.musicCode)
    const details = titleAndArtist(recovery.musicCode)
    const recoveryTitle = byId('recovery-title-song')
    recoveryTitle.textContent = details.metadataAvailable ? ` — ${details.title}` : ''
    recoveryTitle.hidden = !details.metadataAvailable
    byId('recovery-artist').textContent = details.artist
    byId('recovery-artist').hidden = !details.artist
    if (!pendingDialog.open && recoverySelectionAttemptId !== recovery.attemptId) pendingDialog.showModal()
  } else if (pendingDialog.open) pendingDialog.close()

  const invalid = recovery.status === 'unreadable' || recovery.status === 'unavailable'
  if (invalid) {
    const summary = snapshot.recoveryDiagnostic
    byId('invalid-recovery-message').querySelector('span')!.textContent = summary?.message ?? 'A reprodução permanece bloqueada até uma decisão segura.'
    if (!invalidDialog.open) invalidDialog.showModal()
  } else if (invalidDialog.open) invalidDialog.close()
  for (const selector of ['player-code', 'player-add-sequence', 'player-play-now', 'player-toggle', 'player-restart', 'player-stop']) {
    byId(selector).toggleAttribute('aria-disabled', invalid)
  }
}

function updateErrorDialog(): void {
  if (!snapshot) return
  const dialog = byId<HTMLDialogElement>('player-error-dialog')
  const errorKey = snapshot.playback.status === 'failed'
    ? `${snapshot.playback.attemptId ?? 'no-attempt'}:${snapshot.playback.musicCode ?? ''}:${snapshot.playback.errorCode ?? ''}`
    : undefined
  if (snapshot.playback.status !== 'failed' || snapshot.recovery.status === 'pending' || errorKey === dismissedErrorKey) {
    if (dialog.open) dialog.close()
    return
  }
  const code = snapshot.playback.musicCode ?? ''
  byId('playback-error-code').textContent = code ? displayCode(code) : '—'
  const details = code ? titleAndArtist(code) : undefined
  byId('playback-error-song').textContent = details?.metadataAvailable ? ` — ${details.title}${details.artist ? ` · ${details.artist}` : ''}` : ''
  byId('playback-error-song').hidden = !details?.metadataAvailable
  byId('playback-error-message').textContent = displayError(snapshot.playback.errorCode ?? 'PLAYBACK_FAILED')
  if (!dialog.open) dialog.showModal()
}

async function refreshSnapshot(): Promise<void> {
  try {
    applySnapshot(await requireBridge().getSnapshot())
  } catch (error) { showToast(displayError(error)) }
}

async function runCommand(command: () => Promise<unknown>): Promise<boolean> {
  if (busy) return false
  busy = true
  render()
  let succeeded = true
  try {
    const result = await command() as { outcome?: string; reason?: string }
    if (result?.outcome === 'failed' || result?.outcome === 'unavailable' || result?.outcome === 'uncertain') {
      showToast(displayError(result.reason ?? 'PLAYBACK_FAILED'))
      succeeded = false
    } else if (result?.outcome === 'boundary') { showToast('Não há outra música nessa posição da sequência.'); succeeded = false }
  } catch (error) { showToast(displayError(error)); succeeded = false }
  finally { busy = false; await refreshSnapshot() }
  return succeeded
}

async function playNow(): Promise<boolean> {
  const code = byId<HTMLInputElement>('player-code').value.trim()
  if (!code) { showToast('Digite o código da música.'); byId('player-code').focus(); return false }
  try {
    if (snapshot?.videoWindow.location !== 'window' &&
        (snapshot?.videoWindow.location !== 'inline' || activeView !== 'video')) await showPlayerInline()
  } catch (error) { showToast(displayError(error)); return false }
  if (recoverySelectionAttemptId) {
    const attemptId = recoverySelectionAttemptId
    const succeeded = await runCommand(() => requireBridge().chooseAnotherRecovery(attemptId, code))
    if (succeeded || snapshot?.recovery.status !== 'pending') recoverySelectionAttemptId = undefined
    return succeeded
  }
  return runCommand(() => requireBridge().playNow(code))
}

async function selectLibraryFolder(): Promise<void> {
  if (busy) return
  busy = true; render()
  try {
    const result = await requireBridge().selectLibraryFolder()
    if ('cancelled' in result) return
    applySnapshot(result)
    showToast('Biblioteca atualizada.')
  } catch (error) { showToast(displayError(error)) }
  finally { busy = false; await refreshSnapshot() }
}

async function refreshLibrary(): Promise<void> {
  if (busy) return
  busy = true; render()
  try { applySnapshot(await requireBridge().refreshLibrary()); showToast('Indexação concluída.') }
  catch (error) { showToast(displayError(error)) }
  finally { busy = false; await refreshSnapshot() }
}

function bind(): void {
  window.addEventListener('resize', scheduleInlineBoundsUpdate)
  setView('video')
  byId('player-nav-settings').addEventListener('click', () => setView('settings'))
  byId('player-nav-video').addEventListener('click', () => { void showPlayerInline().catch(error => showToast(displayError(error))) })
  byId('player-nav-manual').addEventListener('click', () => { void navigateToManual().catch(error => showToast(displayError(error))) })
  byId('player-nav-back').addEventListener('click', () => { void navigateToManual().catch(error => showToast(displayError(error))) })
  byId('player-detach-video').addEventListener('click', () => { void detachPlayerToWindow() })
  byId('player-inline-fullscreen').addEventListener('click', () => { void requireBridge().toggleVideoFullScreen().catch(error => showToast(displayError(error))) })
  byId('player-library-configure').addEventListener('click', () => { setView('settings'); void selectLibraryFolder() })
  byId('player-library-configure-warning').addEventListener('click', () => { setView('settings'); void selectLibraryFolder() })
  byId('player-library-change').addEventListener('click', () => { void selectLibraryFolder() })
  byId('player-library-refresh').addEventListener('click', () => { void refreshLibrary() })
  byId('player-catalog-import').addEventListener('click', async () => {
    if (busy) return
    busy = true; render()
    try {
      const result = await requireBridge().importCatalog()
      if (!('cancelled' in result)) showToast(`${result.recordCount.toLocaleString('pt-BR')} músicas importadas.`)
    } catch (error) { showToast(displayError(error)) }
    finally { busy = false; await refreshSnapshot() }
  })

  const input = byId<HTMLInputElement>('player-code')
  input.addEventListener('input', () => { input.value = input.value.replace(/\D/g, '').slice(0, 5) })
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') void playNow().then(succeeded => { if (succeeded) input.value = '' })
  })
  byId('player-add-sequence').addEventListener('click', () => {
    const value = input.value.trim()
    if (!value) { showToast('Digite o código da música.'); input.focus(); return }
    void runCommand(() => requireBridge().addToSequence(value)).then(succeeded => { if (succeeded) input.value = '' })
  })
  byId('player-play-now').addEventListener('click', () => { void playNow().then(succeeded => { if (succeeded) input.value = '' }) })
  byId('player-toggle').addEventListener('click', () => {
    if (!snapshot) return
    if (snapshot.playback.status === 'playing') { void runCommand(() => requireBridge().pause()); return }
    if (snapshot.playback.status === 'paused') { void runCommand(() => requireBridge().resume()); return }
    if (snapshot.playback.status === 'stopped' || snapshot.playback.status === 'completed') {
      void runCommand(() => requireBridge().restart())
    }
  })
  byId('player-restart').addEventListener('click', () => { void runCommand(() => requireBridge().restart()) })
  byId('player-stop').addEventListener('click', () => { void runCommand(() => requireBridge().stop()) })
  byId('player-sequence-clear').addEventListener('click', () => { void runCommand(() => requireBridge().clearSequence()) })

  byId('recovery-replay').addEventListener('click', () => {
    if (snapshot?.recovery.status !== 'pending') return
    const attemptId = snapshot.recovery.attemptId
    void showPlayerInline().then(() => runCommand(() => requireBridge().replayPreviousRecovery(attemptId)))
      .catch(error => showToast(displayError(error)))
  })
  byId('recovery-choose').addEventListener('click', () => {
    if (snapshot?.recovery.status !== 'pending') return
    recoverySelectionAttemptId = snapshot.recovery.attemptId
    byId<HTMLDialogElement>('player-recovery-dialog').close()
    setView('manual')
    input.focus()
    showToast('Digite o novo código e selecione “Tocar agora”.')
  })
  byId('recovery-stay').addEventListener('click', () => {
    if (snapshot?.recovery.status !== 'pending') return
    const attemptId = snapshot.recovery.attemptId
    void runCommand(() => requireBridge().leaveRecoveryStopped(attemptId))
  })

  byId('invalid-recovery-resolve').addEventListener('click', async () => {
    if (busy) return
    busy = true; render()
    try {
      const result = await requireBridge().resolveInvalidRecovery()
      applySnapshot(await requireBridge().getSnapshot())
      render()
      showToast(`Estado preservado com segurança (${result.preservedFileCount} arquivo(s)).`)
    } catch (error) { showToast(displayError(error)) }
    finally { busy = false; await refreshSnapshot() }
  })
  byId('invalid-recovery-copy').addEventListener('click', async () => {
    try {
      const result = await requireBridge().copyRecoveryDiagnostic()
      showToast(result.copied ? 'Informações seguras copiadas.' : 'Não há informações seguras para copiar.')
    } catch (error) { showToast(displayError(error)) }
  })
  byId('invalid-recovery-close').addEventListener('click', () => window.close())

  byId('playback-error-retry').addEventListener('click', () => {
    const code = snapshot?.playback.musicCode
    if (!code) return
    byId<HTMLDialogElement>('player-error-dialog').close()
    input.value = code.replace(/^0+(?=\d)/, '')
    void playNow()
  })
  byId('playback-error-choose').addEventListener('click', () => {
    byId<HTMLDialogElement>('player-error-dialog').close()
    input.value = ''
    setView('manual')
    input.focus()
  })
  byId('playback-error-stay').addEventListener('click', () => {
    if (snapshot?.playback.status === 'failed') {
      dismissedErrorKey = `${snapshot.playback.attemptId ?? 'no-attempt'}:${snapshot.playback.musicCode ?? ''}:${snapshot.playback.errorCode ?? ''}`
    }
    byId<HTMLDialogElement>('player-error-dialog').close()
  })

  byId('player-close-cancel').addEventListener('click', async () => {
    if (!pendingShutdownAttemptId) return
    try {
      await requireBridge().cancelShutdown(pendingShutdownAttemptId)
      pendingShutdownAttemptId = undefined
      byId<HTMLDialogElement>('player-close-confirm').close()
    } catch (error) { showToast(displayError(error)); await refreshSnapshot() }
  })
  byId('player-close-stop').addEventListener('click', async () => {
    if (!pendingShutdownAttemptId || busy) return
    const attemptId = pendingShutdownAttemptId
    busy = true
    byId('player-close-stop-label').textContent = 'Encerrando…'
    try {
      const result = await requireBridge().confirmShutdown(attemptId)
      if (result.outcome === 'uncertain') {
        byId('shutdown-result').hidden = false
        byId('shutdown-result').textContent = 'A parada não pôde ser confirmada. O resultado foi preservado como incerto; o aplicativo será encerrado sem retomar a reprodução.'
      }
      await requireBridge().finishShutdown(attemptId)
    } catch (error) {
      busy = false
      byId('player-close-stop-label').textContent = 'Interromper e sair'
      showToast(displayError(error))
      await refreshSnapshot()
    }
  })
  for (const dialogId of ['player-recovery-dialog', 'player-invalid-recovery-dialog', 'player-close-confirm']) {
    byId<HTMLDialogElement>(dialogId).addEventListener('cancel', event => event.preventDefault())
  }

  requireBridge().onSnapshot(applySnapshot)
  requireBridge().onPlaybackEvent(() => { void refreshSnapshot() })
  requireBridge().onShutdownRequest(request => {
    pendingShutdownAttemptId = request.attemptId
    byId('shutdown-code').textContent = request.musicCode ? displayCode(request.musicCode) : '—'
    const details = request.musicCode ? titleAndArtist(request.musicCode) : undefined
    byId('shutdown-song').textContent = details?.metadataAvailable ? ` — ${details.title}${details.artist ? ` · ${details.artist}` : ''}` : ''
    byId('shutdown-song').hidden = !details?.metadataAvailable
    byId<HTMLDialogElement>('player-close-confirm').showModal()
    if (request.musicCode) requestMetadata([request.musicCode])
  })
  void refreshSnapshot().then(() => {
    if (snapshot?.videoWindow.location !== 'window') return showPlayerInline()
    setView('manual')
  }).catch(error => showToast(displayError(error)))
}

document.addEventListener('DOMContentLoaded', () => {
  try { bind() } catch (error) { showToast(displayError(error)) }
})
