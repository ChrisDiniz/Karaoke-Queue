import type { PlayerPlaybackHostCommand, PlayerPlaybackMediaObservation } from './player-playback-contracts'

interface PlaybackBridge {
  onCommand(listener: (command: PlayerPlaybackHostCommand) => void): void
  sendEvent(event: { attemptId: string; sequenceNumber: number; observation: PlayerPlaybackMediaObservation }): void
  acknowledge(commandId: string, attemptId: string, accepted: boolean): Promise<void>
  ready(): Promise<void>
  toggleFullScreen(): Promise<boolean>
  exitFullScreen(): Promise<boolean>
  onDisplayStatus(listener: (status: 'idle' | 'loading' | 'playing' | 'paused' | 'failed' | 'uncertain') => void): void
  onDisplayLocation(listener: (location: 'inline' | 'window') => void): void
}

declare global {
  interface Window { playerPlayback?: PlaybackBridge }
}

interface ActiveMedia {
  attemptId: string
  element: HTMLVideoElement
  sequenceNumber: number
  lastProgressSentAt: number
}

class ChromiumPlaybackRenderer {
  private active: ActiveMedia | undefined
  private readonly stage = document.getElementById('playback-stage')

  constructor(private readonly bridge: PlaybackBridge) {}

  start(): void {
    this.bridge.onCommand(command => { void this.handle(command) })
    this.bridge.onDisplayStatus(status => this.showStatus(status))
    this.bridge.onDisplayLocation(location => this.showLocation(location))
    window.addEventListener('keydown', event => {
      if (event.key === 'F11') {
        event.preventDefault()
        void this.bridge.toggleFullScreen().catch(() => undefined)
      } else if (event.key === 'Escape') {
        void this.bridge.exitFullScreen().catch(() => undefined)
      }
    })
    void this.bridge.ready().catch(() => undefined)
  }

  private showStatus(status: 'idle' | 'loading' | 'playing' | 'paused' | 'failed' | 'uncertain'): void {
    const waiting = document.getElementById('player-waiting')
    const loading = document.getElementById('player-loading')
    const error = document.getElementById('player-error')
    if (!waiting || !loading || !error) return
    const isLoading = status === 'loading'
    const isError = status === 'failed' || status === 'uncertain'
    waiting.hidden = isLoading || isError
    loading.hidden = !isLoading
    error.hidden = !isError
  }

  private showLocation(location: 'inline' | 'window'): void {
    const title = document.getElementById('player-waiting-title')
    const copy = document.getElementById('player-waiting-copy')
    const windowHint = document.getElementById('player-window-hint')
    const fullscreenHint = document.getElementById('player-fullscreen-hint')
    if (!title || !copy || !windowHint || !fullscreenHint) return
    const external = location === 'window'
    title.textContent = external ? 'Janela independente do Player' : 'Aguardando reprodução'
    copy.textContent = external ? 'Quando uma música começar, o vídeo aparecerá aqui.' : 'O vídeo será exibido nesta tela.'
    windowHint.hidden = !external
    fullscreenHint.hidden = !external
  }

  private async handle(command: PlayerPlaybackHostCommand): Promise<void> {
    if (!this.isValidCommand(command)) return
    let accepted = false
    try {
      switch (command.type) {
        case 'load': this.load(command); break
        case 'play': this.play(command.attemptId); break
        case 'pause': this.pause(command.attemptId); break
        case 'stop': this.stop(command.attemptId); break
      }
      accepted = true
    } catch {
      accepted = false
    }
    await this.bridge.acknowledge(command.commandId, command.attemptId, accepted).catch(() => undefined)
  }

  private isValidCommand(command: PlayerPlaybackHostCommand): boolean {
    return Boolean(command && typeof command === 'object' &&
      typeof command.commandId === 'string' && command.commandId.length <= 80 &&
      typeof command.attemptId === 'string' && command.attemptId.length <= 80 &&
      ['load', 'play', 'pause', 'stop'].includes(command.type) &&
      (command.type !== 'load' ||
        (/^[0-9]{5}$/.test(command.musicCode) && typeof command.mediaUrl === 'string' &&
          command.mediaUrl.startsWith('kq-media://playback/'))))
  }

  private load(command: Extract<PlayerPlaybackHostCommand, { type: 'load' }>): void {
    if (!this.stage) throw new Error('Playback stage is unavailable.')
    this.releaseActive()
    const element = document.createElement('video')
    element.preload = 'auto'
    element.playsInline = true
    element.controls = false
    element.className = 'playback-media'
    const active: ActiveMedia = { attemptId: command.attemptId, element, sequenceNumber: 0, lastProgressSentAt: 0 }
    this.active = active
    this.bindEvents(active)
    this.stage.replaceChildren(element)
    element.src = command.mediaUrl
    element.load()
  }

  private bindEvents(active: ActiveMedia): void {
    const eventTypes: Array<PlayerPlaybackMediaObservation['type']> = [
      'loadedmetadata', 'timeupdate', 'playing', 'pause', 'ended', 'error', 'emptied', 'waiting', 'stalled'
    ]
    for (const type of eventTypes) {
      active.element.addEventListener(type, () => {
        const media = active.element
        if (type === 'timeupdate') {
          const now = performance.now()
          if (now - active.lastProgressSentAt < 900) return
          active.lastProgressSentAt = now
        }
        this.bridge.sendEvent({
          attemptId: active.attemptId,
          sequenceNumber: ++active.sequenceNumber,
          observation: {
            type,
            ...(Number.isFinite(media.currentTime) ? { currentTime: media.currentTime } : {}),
            ...(Number.isFinite(media.duration) ? { duration: media.duration } : {}),
            ...(media.videoWidth > 0 ? { videoWidth: media.videoWidth } : {}),
            ...(media.videoHeight > 0 ? { videoHeight: media.videoHeight } : {}),
            ...(type === 'error' && media.error ? { mediaErrorCode: media.error.code } : {})
          }
        })
      })
    }
  }

  private play(attemptId: string): void {
    const active = this.requireActive(attemptId)
    const result = active.element.play()
    void result.catch(() => this.emitError(active))
  }

  private pause(attemptId: string): void {
    this.requireActive(attemptId).element.pause()
  }

  private stop(attemptId: string): void {
    const active = this.active
    if (!active || active.attemptId !== attemptId) return
    active.element.pause()
    active.element.removeAttribute('src')
    active.element.load()
  }

  private requireActive(attemptId: string): ActiveMedia {
    if (!this.active || this.active.attemptId !== attemptId) throw new Error('Playback attempt is no longer active.')
    return this.active
  }

  private emitError(active: ActiveMedia): void {
    this.bridge.sendEvent({
      attemptId: active.attemptId,
      sequenceNumber: ++active.sequenceNumber,
      observation: { type: 'error', ...(active.element.error ? { mediaErrorCode: active.element.error.code } : {}) }
    })
  }

  private releaseActive(): void {
    const active = this.active
    this.active = undefined
    if (!active) return
    active.element.pause()
    active.element.removeAttribute('src')
    active.element.load()
    active.element.remove()
  }
}

if (window.playerPlayback) new ChromiumPlaybackRenderer(window.playerPlayback).start()
