import { PlayerPlaybackError, type PlayerPlaybackEvent, type PlayerPlaybackListener, type PlayerPlaybackState } from '../../src/player-playback-contracts'
import type { StandalonePlaybackPort } from '../../src/standalone-player-contracts'

export interface PlaybackGate {
  readonly started: Promise<void>
  release(): void
}

export class FakeStandalonePlayback implements StandalonePlaybackPort {
  private state: PlayerPlaybackState = { status: 'idle' }
  private readonly listeners = new Set<PlayerPlaybackListener>()
  private readonly validationGates = new Map<string, { started: () => void; promise: Promise<void>; release: () => void }>()
  private readonly stopGates: Array<{ started: () => void; promise: Promise<void>; release: () => void }> = []
  private nextAttempt = 0
  private startOutcome: 'playing' | 'blocked' | 'uncertain' = 'playing'
  readonly starts: string[] = []
  readonly validated: string[] = []
  disposeCount = 0

  getState(): PlayerPlaybackState { return { ...this.state } }
  get listenerCount(): number { return this.listeners.size }

  holdValidation(code: string): PlaybackGate {
    let started!: () => void
    let release!: () => void
    const startedPromise = new Promise<void>(resolve => { started = resolve })
    const promise = new Promise<void>(resolve => { release = resolve })
    this.validationGates.set(code, { started, promise, release })
    return { started: startedPromise, release }
  }

  holdNextStop(): PlaybackGate {
    let started!: () => void
    let release!: () => void
    const startedPromise = new Promise<void>(resolve => { started = resolve })
    const promise = new Promise<void>(resolve => { release = resolve })
    this.stopGates.push({ started, promise, release })
    return { started: startedPromise, release }
  }

  configureNextStart(outcome: 'playing' | 'blocked' | 'uncertain'): void { this.startOutcome = outcome }

  async validateMusicCode(code: string): Promise<void> {
    this.validated.push(code)
    const gate = this.validationGates.get(code)
    if (gate) {
      gate.started()
      await gate.promise
      if (this.validationGates.get(code) === gate) this.validationGates.delete(code)
    }
    if (!/^\d{5}$/.test(code)) throw new PlayerPlaybackError('INVALID_MUSIC_CODE', 'invalid code')
  }

  async playImmediately(code: string): Promise<PlayerPlaybackState> {
    this.starts.push(code)
    const outcome = this.startOutcome
    this.startOutcome = 'playing'
    if (outcome === 'blocked') throw new PlayerPlaybackError('PLAYBACK_FAILED', 'known failure')
    const state: PlayerPlaybackState = {
      status: outcome === 'uncertain' ? 'uncertain' : 'playing',
      attemptId: `fake-attempt-${++this.nextAttempt}`,
      musicCode: code,
      ...(outcome === 'uncertain' ? { errorCode: 'COMMAND_TIMEOUT' as const } : {})
    }
    this.update(state)
    return this.getState()
  }

  async pause(): Promise<PlayerPlaybackState> {
    this.update({ ...this.state, status: 'paused' })
    return this.getState()
  }

  async resume(): Promise<PlayerPlaybackState> {
    this.update({ ...this.state, status: 'playing' })
    return this.getState()
  }

  async restart(): Promise<PlayerPlaybackState> {
    if (!this.state.musicCode) throw new PlayerPlaybackError('INVALID_STATE', 'no current song')
    const state: PlayerPlaybackState = {
      status: 'playing', attemptId: `fake-attempt-${++this.nextAttempt}`, musicCode: this.state.musicCode
    }
    this.update(state)
    return this.getState()
  }

  async stop(expectedAttemptId?: string): Promise<PlayerPlaybackState> {
    const gate = this.stopGates.shift()
    if (gate) {
      gate.started()
      await gate.promise
    }
    if (expectedAttemptId && this.state.attemptId !== expectedAttemptId) {
      throw new PlayerPlaybackError('SUPERSEDED', 'stale attempt')
    }
    if (this.state.status === 'completed') throw new PlayerPlaybackError('SUPERSEDED', 'natural EOF won')
    this.update({ status: 'stopped', ...(this.state.attemptId ? { attemptId: this.state.attemptId } : {}),
      ...(this.state.musicCode ? { musicCode: this.state.musicCode } : {}) })
    return this.getState()
  }

  async clearCompletedMedia(expectedAttemptId: string): Promise<boolean> {
    if (this.state.status !== 'completed' || this.state.attemptId !== expectedAttemptId) return false
    this.update({ status: 'idle' })
    return true
  }

  async clearStoppedMedia(expectedAttemptId: string): Promise<boolean> {
    if (this.state.status !== 'stopped' || this.state.attemptId !== expectedAttemptId) return false
    this.update({ status: 'idle' })
    return true
  }

  async resolveRecoveryAsStopped(expectedAttemptId: string, musicCode: string): Promise<PlayerPlaybackState> {
    this.update({ status: 'stopped', attemptId: expectedAttemptId, musicCode })
    return this.getState()
  }

  subscribe(listener: PlayerPlaybackListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  completeNaturally(): void {
    const { attemptId, musicCode } = this.state
    if (!attemptId || !musicCode) throw new Error('No active fake playback to complete.')
    this.state = { status: 'completed', attemptId, musicCode }
    this.emit({ type: 'natural-end-candidate', attemptId, musicCode, duration: 10, endedAt: new Date(0).toISOString() })
  }

  async dispose(): Promise<void> {
    if (this.disposeCount > 0) return
    this.disposeCount += 1
    for (const gate of this.validationGates.values()) gate.release()
    this.validationGates.clear()
    for (const gate of this.stopGates.splice(0)) gate.release()
    this.update({ status: 'disposed' })
  }

  private update(state: PlayerPlaybackState): void {
    this.state = { ...state }
    this.emit({ type: 'state-changed', state: this.getState() })
  }

  private emit(event: PlayerPlaybackEvent): void {
    for (const listener of [...this.listeners]) listener(event)
  }
}
