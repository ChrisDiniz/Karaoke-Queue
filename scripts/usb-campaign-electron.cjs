'use strict'
const fs = require('node:fs')
const { CampaignError } = require('./usb-reconnect-core.cjs')
const { ElectronUsbAdapter } = require('./usb-reconnect-electron.cjs')
function sameQueue(a, b) { return JSON.stringify(a) === JSON.stringify(b) }
function recoveryOracle(scenario, initial, lost, current) {
  const temporal = ['countdown', 'loading', 'transition', 'celebration'].includes(scenario)
  const expected = ['transition', 'celebration'].includes(scenario) ? initial.target || initial.pending[0]?.entryId : initial.current?.entryId || initial.target
  const recovery = current.recovery
  if (!recovery) {
    if (scenario === 'playing' && current.current?.entryId === initial.current?.entryId && current.attemptId === initial.attemptId &&
        current.media?.currentTime > initial.media?.currentTime && sameQueue(current.pending, initial.pending)) {
      return { status: 'PARTIAL', code: lost.progressWhileAbsent ? 'BUFFER_CONTINUED' : 'NOT_REPRODUCED', progressWhileAbsent: Boolean(lost.progressWhileAbsent), recoveryBranch: 'NOT REPRODUCED', recoverable: false }
    }
    return { status: 'PARTIAL', code: 'NOT_REPRODUCED', recoverable: false }
  }
  if (recovery.target !== expected) {
    if (temporal || current.naturalEnds > initial.naturalEnds) return { status: 'PARTIAL', code: 'TARGET_PHASE_PASSED', recoverable: false }
    throw new CampaignError('CURRENT_OCCURRENCE_LOST', 'FAIL')
  }
  if (current.naturalEnds !== initial.naturalEnds) throw new CampaignError('UNEXPECTED_NATURAL_EOF', 'FAIL')
  if (!sameQueue(current.pending, initial.pending)) throw new CampaignError('QUEUE_OR_PRIORITY_CHANGED', 'FAIL')
  if (!current.modal || !recovery.contained || !['idle', 'failed', 'stopped'].includes(current.engine) || current.streams || current.grants || current.handles) {
    throw new CampaignError('RECOVERY_OR_CONTAINMENT_UNVERIFIED', 'FAIL')
  }
  if (scenario === 'paused' && !recovery.wasPaused) throw new CampaignError('PAUSE_INTENT_LOST', 'FAIL')
  if (scenario === 'countdown' && recovery.phase !== 'countdown') return { status: 'PARTIAL', code: 'NOT_REPRODUCED', recoverable: true, expected }
  if (scenario === 'celebration' && initial.naturalEnds < 1) throw new CampaignError('NATURAL_EOF_NOT_CONFIRMED', 'FAIL')
  return { status: 'PASS', recoverable: true, expected, recoveryBranch: 'OBSERVED', absenceObservedPhase: lost.phase }
}
class CampaignElectronAdapter extends ElectronUsbAdapter {
  async installObservations() {
    await this.app.evaluate(() => {
      const c = global.__t3
      c.campaignEvents = []; c.campaignNaturalEnds = 0
      c.runtime.playback.subscribe(event => {
        if (event.type === 'natural-end-candidate') c.campaignNaturalEnds++
        if (c.campaignEvents.length >= 4000) { c.violation = true; return }
        if (['state-changed', 'natural-end-candidate', 'error', 'uncertain'].includes(event.type)) {
          c.campaignEvents.push({ type: event.type, at: performance.now(), attemptId: event.attemptId || event.state?.attemptId,
            status: event.state?.status, error: event.errorCode })
        }
      })
    })
    await this.page.evaluate(() => {
      window.__usbMediaEvents = []
      const seen = new WeakSet()
      const bind = () => document.querySelectorAll('video').forEach(video => {
        if (seen.has(video)) return; seen.add(video)
        for (const type of ['loadedmetadata', 'playing', 'pause', 'waiting', 'stalled', 'error', 'ended']) video.addEventListener(type, () => {
          if (window.__usbMediaEvents.length < 1000) window.__usbMediaEvents.push({ type, at: performance.now(), currentTime: video.currentTime,
            readyState: video.readyState, networkState: video.networkState, error: video.error?.code ?? null })
        })
      })
      new MutationObserver(bind).observe(document.body, { childList: true, subtree: true }); bind()
    })
  }
  async inspect() {
    const resources = await this.sample()
    if (resources.violation) throw new CampaignError('OBSERVATION_OVERFLOW_OR_IO_VIOLATION', 'FAIL')
    const main = await this.app.evaluate(() => {
      const c = global.__t3, sequence = c.runtime.sequence, s = sequence.getSnapshot()
      const stable = s.playbackCondition === 'ready' ? s.state : s.lastConfirmedState
      const pending = s.playbackCondition === 'ready' ? s.state.pending : s.pending
      const r = s.storageRecovery
      const target = s.playbackCondition === 'transitioning' && 'target' in s ? s.target.entryId : sequence.reservation?.target?.entryId
      const events = c.campaignEvents?.splice(0) || []
      return { at: performance.now(), source: 'Main direct observation', condition: s.playbackCondition,
        phase: r ? 'recovery' : sequence.reservation?.kind === 'next' || sequence.reservation?.kind === 'eof' ? 'transition'
          : s.playbackCondition === 'transitioning' ? s.phase : stable.operationalState,
        current: stable.current ? { entryId: stable.current.entryId } : null, attemptId: stable.current?.attemptId,
        hostEpoch: c.runtime.playback.host?.hostEpoch, target,
        pending: pending.map(e => ({ entryId: e.entryId, priority: sequence.entryOrder.get(e.entryId)?.priority ?? 'reserved' })),
        remainingMs: s.remainingMs ?? null,
        recovery: r ? { target: r.target?.entryId, contained: r.contained, available: r.available, phase: r.phase, wasPaused: r.wasPaused } : null,
        naturalEnds: c.campaignNaturalEnds || 0, libraryStatus: c.runtime.library.getSnapshot().scanStatus, events }
    })
    const ui = await this.page.evaluate(() => {
      const video = document.querySelector('#playback-media-layer video')
      return { modal: document.getElementById('storage-recovery-modal')?.hidden === false,
        media: video ? { at: performance.now(), source: 'Renderer direct observation', currentTime: video.currentTime, paused: video.paused,
          duration: Number.isFinite(video.duration) ? video.duration : null, readyState: video.readyState, networkState: video.networkState,
          buffered: Array.from({ length: video.buffered.length }, (_, i) => [video.buffered.start(i), video.buffered.end(i)]) } : null,
        mediaEvents: window.__usbMediaEvents?.splice(0) || [] }
    })
    this.mediaHistory ||= []
    this.mediaHistory.push(...ui.mediaEvents)
    if (this.mediaHistory.length > 10000) throw new CampaignError('OBSERVATION_OVERFLOW_OR_IO_VIOLATION', 'FAIL')
    const value = { ...resources, protocol: resources.media, ...main, ...ui, engine: resources.playbackStatus }
    this.journal.event('campaign-observation', value)
    return value
  }
  async observeDuring(question) {
    if (!this.app) return question()
    let pending = Promise.resolve(), busy = false, failed
    const timer = setInterval(() => {
      if (busy || !this.app) return
      busy = true; pending = this.inspect().catch(e => { failed = e }).finally(() => { busy = false })
    }, 1000)
    try { const answer = await question(); if (failed) throw failed; return answer }
    finally { clearInterval(timer); await pending; if (failed) throw failed }
  }
  async command(type, extra = {}, detached = false) {
    return this.page.evaluate(({ type, extra, detached }) => {
      const promise = window.standalonePlayer.execute({ operationId: crypto.randomUUID(), command: { type, ...extra } })
      if (detached) { window.__usbPending = promise.catch(() => undefined); return }
      return promise.then(reply => ({ outcome: reply.outcome }))
    }, { type, extra, detached })
  }
  async waitObservation(predicate, code, deadline = 30000, partial = false) {
    let found
    try { await this.until(async () => { found = await this.inspect(); return predicate(found) }, code, deadline) }
    catch (error) { if (partial && error.code === code) return { phaseObserved: false, reason: code }; throw error }
    return found
  }
  async preparePhase(scenario) {
    await this.installObservations()
    const index = JSON.parse(fs.readFileSync(this.indexFile, 'utf8'))
    const rows = index.roots.flatMap(r => r.entries).filter(r => this.synthetic || /\.mp4$/i.test(r.relativePath))
    const codes = [...new Set(rows.map(r => r.musicCode))].filter(code => rows.filter(r => r.musicCode === code).length === 1)
    if (codes.length < 3) throw new CampaignError('THREE_UNAMBIGUOUS_VIDEOS_REQUIRED')
    await this.command('submit-code', { enteredCode: String(Number(codes[0])), priority: 'normal' })
    if (!['countdown', 'loading'].includes(scenario)) {
      await this.waitObservation(v => v.phase === 'playing' && v.media?.currentTime >= 0.25, 'REAL_PLAYBACK_NOT_ADVANCING')
      for (const [code, priority] of [[codes[1], 'normal'], [codes[2], 'priority']]) {
        if ((await this.command('submit-code', { enteredCode: String(Number(code)), priority })).outcome !== 'confirmed') throw new CampaignError('QUEUE_SETUP_FAILED', 'FAIL')
      }
    }
    if (scenario === 'paused') {
      await this.command('toggle-pause')
      await this.waitObservation(v => v.phase === 'paused' && v.media?.paused, 'PAUSE_NOT_CONFIRMED')
    }
    if (scenario === 'transition') await this.command('next', {}, true)
    const initial = await this.waitObservation(v => v.phase === scenario, 'TARGET_PHASE_NOT_OBSERVED',
      scenario === 'celebration' ? 180000 : 30000, ['loading', 'transition', 'celebration'].includes(scenario))
    return { ...initial, phaseObserved: Boolean(initial.phase === scenario) }
  }
  async validateActive(scenario, initial, lost) {
    // Normal product probes: no forced filesystem probe, no forced media fault, no synthetic host events.
    await this.waitObservation(v => v.availability.availableRoots === 1 && v.availability.unavailableRoots === 0 &&
      v.libraryStatus === 'ready' && (!v.recovery || v.recovery.available),
      'PRODUCT_RECONNECTION_NOT_DETECTED', 60000)
    const current = await this.inspect()
    if (current.recovery) {
      await this.waitObservation(v => v.recovery?.contained && !v.streams && !v.grants && !v.handles,
        'RECOVERY_CONTAINMENT_NOT_CONFIRMED', 30000)
    }
    return recoveryOracle(scenario, initial, lost, await this.inspect())
  }
  async recoverActive(initial, result) {
    const before = await this.inspect()
    if (!before.recovery?.contained || !before.recovery.available) throw new CampaignError('RECOVERY_NOT_READY', 'FAIL')
    this.mediaHistory = []
    await this.page.locator('#storage-recovery-retry').click()
    const recovered = await this.waitObservation(v => v.condition === 'ready' && v.phase === 'playing' && v.media?.currentTime >= 0.25,
      'OPERATOR_RECOVERY_NOT_PLAYING', 30000)
    if (recovered.current?.entryId !== result.expected || recovered.attemptId === initial.attemptId) throw new CampaignError('STALE_OR_WRONG_RECOVERY', 'FAIL')
    if (!this.mediaHistory.some(e => e.type === 'loadedmetadata' && e.currentTime === 0) || !this.mediaHistory.some(e => e.type === 'playing')) throw new CampaignError('RESTART_FROM_BEGINNING_NOT_OBSERVED', 'FAIL')
    const expectedQueue = initial.pending.filter(e => e.entryId !== result.expected)
    if (!sameQueue(recovered.pending, expectedQueue)) throw new CampaignError('QUEUE_OR_PRIORITY_CHANGED', 'FAIL')
    this.journal.event('physical-manual-recovery-confirmed', { sameEntry: true, newAttempt: true,
      positionPolicy: 'metadata currentTime=0 + playing observed after explicit click; Main new attempt + real progress >=0.25', uiAttemptCorrelation: 'temporal; Main identity is authoritative', queued: recovered.pending.length })
    // Confirm live cleanup without relying solely on process exit.
    await this.command('stop-all')
    const stopped = await this.waitObservation(v => v.condition === 'ready' && v.phase === 'idle' && !v.streams && !v.grants && !v.handles,
      'POST_RECOVERY_STOP_RESOURCES', 30000)
    if (stopped.protocol.fileHandlesOpened !== stopped.protocol.fileHandlesClosed || stopped.protocol.fileHandleCloseFailures) throw new CampaignError('MEDIA_RESOURCE_LEAK', 'FAIL')
  }
}
module.exports = { CampaignElectronAdapter, recoveryOracle, sameQueue }
