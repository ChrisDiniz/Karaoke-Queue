'use strict'
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

class CampaignError extends Error {
  constructor(code, status = 'BLOCKED') { super(code); this.code = code; this.status = status }
}
function assertInteractive({ platform, inputTTY, outputTTY, env, authorized, bridge = false }) {
  if (env.CI || env.GITHUB_ACTIONS || env.BUILD_BUILDID) throw new CampaignError('CI_FORBIDDEN')
  if (!inputTTY || !outputTTY) throw new CampaignError('INTERACTIVE_TERMINAL_REQUIRED')
  if (!['linux', 'win32'].includes(platform)) throw new CampaignError('WINDOWS_OR_WSL_REQUIRED')
  if (!authorized) throw new CampaignError('EXPLICIT_PHYSICAL_AUTHORIZATION_REQUIRED')
}
function parseLastAccess(output) {
  const match = /DisableLastAccess\s*=\s*([0-3])(?:\s|$)/i.exec(output)
  if (!match) throw new CampaignError('TIMESTAMP_POLICY_UNVERIFIED')
  return Number(match[1])
}
function assertProtected(policy, volume) {
  if (!Number.isInteger(policy) || policy < 0 || policy > 3) throw new CampaignError('TIMESTAMP_POLICY_UNVERIFIED')
  if (!volume?.present) throw new CampaignError('VOLUME_ABSENT')
  if (volume.online !== true) throw new CampaignError('VOLUME_NOT_ONLINE')
  if (volume.fileSystem !== 'NTFS' || volume.busType !== 'USB' || !/^[a-f0-9]{64}$/.test(volume.key || '')) {
    throw new CampaignError('UNSUPPORTED_OR_UNIDENTIFIED_VOLUME')
  }
  // Strict metadata preservation: disabling LastAccess alone is insufficient.
  // This runner never changes disk/volume attributes or the system policy.
  if (volume.readOnly !== true) throw new CampaignError('WRITE_PROTECTION_REQUIRED')
}
function assertSameVolume(expected, actual) {
  if (!actual?.present) throw new CampaignError('RECONNECTION_NOT_OBSERVED', 'FAIL')
  if (actual.key !== expected.key) throw new CampaignError('DIFFERENT_VOLUME_RECONNECTED', 'FAIL')
  if (actual.drive !== expected.drive) throw new CampaignError('SAME_VOLUME_CHANGED_LETTER')
}
function assertQuiescent(s, closed) {
  if (!s || s.measurementComplete !== true) throw new CampaignError('RESOURCE_METRICS_UNAVAILABLE')
  if ((closed ? s.processes !== 0 : s.processes !== 1) || !s.idle || s.scanActive || s.activeIO !== 0 ||
      s.handles !== 0 || s.streams !== 0 || s.grants !== 0 || s.violation) {
    throw new CampaignError('RESOURCES_NOT_QUIESCENT')
  }
}
function validateEntryPermit(permit, { nonce, session, mediaRoot, profile, ci }) {
  if (!permit || !/^[a-f0-9]{64}$/.test(nonce || '') || permit.nonce !== nonce ||
      permit.session !== session || permit.mediaRoot !== mediaRoot || profile !== path.join(session, 'profile')) {
    throw new CampaignError('ENTRY_SESSION_PERMISSION_REQUIRED')
  }
  if (permit.modality === 'synthetic') {
    if (mediaRoot !== path.join(session, 'fixture')) throw new CampaignError('SYNTHETIC_SCOPE_INVALID')
  } else if (permit.modality !== 'physical' || ci || !permit.preflightApproved) {
    throw new CampaignError('PHYSICAL_ENTRY_NOT_AUTHORIZED')
  }
}
function createJournal(directory) {
  fs.mkdirSync(directory, { recursive: true })
  let sequence = 0
  const summaryCounts = new Map()
  const runId = crypto.randomUUID()
  const eventsFile = path.join(directory, 'events-' + runId + '.jsonl')
  return {
    runId, eventsFile,
    event(type, details = {}) {
      // Callers pass metrics/opaque identities only, never raw media paths or names.
      const record = { runId, sequence: ++sequence, at: new Date().toISOString(), monotonicMs: performance.now(), type, details }
      const fd = fs.openSync(eventsFile, 'a', 0o600)
      try { fs.writeSync(fd, JSON.stringify(record) + '\n'); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    },
    summary(name, value) {
      if (!/^(?:[AB]|(?:B|A|playing|paused|countdown|loading|transition|celebration)-[1-9][0-9]{0,4})$/.test(name)) throw new Error('Invalid scenario')
      const count = (summaryCounts.get(name) || 0) + 1; summaryCounts.set(name, count)
      const target = path.join(directory, `scenario-${name}-${runId}${count === 1 ? '' : '-' + count}.json`)
      fs.writeFileSync(target + '.tmp', JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
      fs.renameSync(target + '.tmp', target)
    }
  }
}
class UsbReconnectCampaign {
  constructor({ adapter, device, ask, journal, save, state, signal, modality = 'physical', validateSelectionAfterRestart = true }) {
    Object.assign(this, { adapter, device, ask, journal, save, state, signal, modality, validateSelectionAfterRestart })
    journal.event('campaign-mode', { modality, physicalExecution: modality === 'physical' })
  }
  checkpoint() { if (this.signal?.aborted) throw new CampaignError('OPERATOR_CANCELLED', 'PARTIAL') }
  async safety() {
    this.checkpoint()
    // Query global policy before volume metadata; neither operation enumerates the library.
    const policy = await this.device.policy()
    const volume = await this.device.observe()
    assertProtected(policy, volume)
    if (this.state.volume) assertSameVolume(this.state.volume, volume)
    else { this.state.volume = volume; await this.save(this.state) }
    if (this.device.validateRoot) await this.device.validateRoot()
    this.journal.event('safety-verified', { policy, volumeKey: volume.key, readOnly: volume.readOnly })
    return volume
  }
  async human(id, message, closed) {
    this.checkpoint()
    assertQuiescent(await this.adapter.resources(), closed)
    this.state.checkpoint = id
    await this.save(this.state)
    this.journal.event('human-checkpoint-pending', { id, closed })
    const answer = await this.ask(message + '\nDigite CONFIRMO, CANCELAR ou BLOQUEADO: ')
    this.checkpoint()
    if (answer === 'CANCELAR') throw new CampaignError('OPERATOR_CANCELLED', 'PARTIAL')
    if (answer === 'BLOQUEADO') throw new CampaignError('WINDOWS_SAFE_REMOVAL_BLOCKED')
    if (answer !== 'CONFIRMO') throw new CampaignError('HUMAN_CONFIRMATION_MISSING', 'NOT RUN')
    // Confirmation alone never proves physical removal/reconnection.
    assertQuiescent(await this.adapter.resources(), closed)
    this.journal.event('human-confirmed', { id })
  }
  async absent() {
    await this.device.policy()
    const observed = await this.device.observe()
    if (observed.present) throw new CampaignError('REMOVAL_NOT_OBSERVED', 'FAIL')
    this.journal.event('volume-absent-observed', { volumeKey: this.state.volume.key })
    await this.adapter.assertPreserved()
  }
  async prepare() {
    await this.safety()
    await this.adapter.start()
    const ready = await this.adapter.ready()
    if (!ready.idle || !ready.indexedFiles || !ready.gated) throw new CampaignError('INITIAL_PREPARATION_FAILED', 'FAIL')
    await this.adapter.rememberInventory()
    await this.adapter.quiesce()
    return ready
  }
  async runB() {
    const initial = await this.prepare()
    await this.adapter.close()
    await this.human('B-remove', 'Preparação concluída. O aplicativo de teste está fechado e seus recursos foram liberados. Use a remoção segura do Windows; só após autorização do Windows desconecte fisicamente o HD e confirme. Se houver impedimento, responda BLOQUEADO.', true)
    await this.absent()
    await this.human('B-reconnect', 'HD indisponível confirmado. Reconecte fisicamente o mesmo dispositivo e confirme quando o Windows reconhecê-lo.', true)
    await this.safety()
    this.journal.event('restart-after-physical-confirmations')
    await this.adapter.start()
    const restored = await this.adapter.ready()
    if (!restored.cacheRestored || !restored.gated || !restored.idle || restored.indexedFiles !== initial.indexedFiles) {
      throw new CampaignError('RESTORED_STARTUP_ASSERTION_FAILED', 'FAIL')
    }
    if (this.validateSelectionAfterRestart) await this.adapter.selectMusic()
    await this.adapter.quiesce()
    await this.adapter.close()
    return { status: 'PASS', initial, restored, physical: this.modality === 'physical' }
  }
  async runA() {
    await this.prepare()
    const scans = (await this.adapter.resources()).scanStarts
    await this.human('A-remove', 'Aplicativo ocioso, operações de mídia suspensas pelo harness e recursos liberados. Use a remoção segura do Windows; só após autorização do Windows desconecte fisicamente o HD e confirme. Se o Windows impedir, responda BLOQUEADO; não retire o cabo à força.', false)
    await this.absent()
    await this.adapter.resumeDiscovery()
    const unavailable = await this.adapter.availability(false)
    await this.adapter.assertPreserved()
    await this.adapter.quiesce()
    await this.human('A-reconnect', 'Indisponibilidade confirmada no Main/UI e I/O novamente suspenso. Reconecte fisicamente o mesmo HD e confirme quando o Windows reconhecê-lo.', false)
    await this.safety()
    await this.adapter.resumeDiscovery()
    const available = await this.adapter.availability(true)
    const ready = await this.adapter.ready()
    const resources = await this.adapter.resources()
    if (!ready.idle || resources.scanStarts !== scans + 1) throw new CampaignError('RECONNECTION_SCAN_DUPLICATED_OR_NOT_READY', 'FAIL')
    await this.adapter.quiesce()
    await this.adapter.close()
    return { status: 'PASS', unavailable, available, physical: this.modality === 'physical' }
  }
  async run(scenarios = ['B', 'A']) {
    for (const scenario of scenarios) {
      if (!['A', 'B'].includes(scenario)) throw new CampaignError('INVALID_SCENARIO')
      if (this.state.results[scenario]?.status === 'PASS') continue
      let result
      try { result = await this[`run${scenario}`]() }
      catch (error) {
        result = { status: error.status || 'FAIL', code: error.code || 'TECHNICAL_FAILURE', physical: this.modality === 'physical' }
        this.journal.event('scenario-error', { scenario, ...result })
      }
      finally {
        try { await this.adapter.close() }
        catch { result = { status: 'BLOCKED', code: 'PROCESS_OR_RESOURCE_CLEANUP_UNVERIFIED', physical: this.modality === 'physical' } }
      }
      this.state.results[scenario] = result
      await this.save(this.state)
      this.journal.summary(scenario, result)
      this.journal.event('scenario-complete', { scenario, status: result.status })
      if (result.status !== 'PASS') return this.state.results
    }
    return this.state.results
  }
}
module.exports = { CampaignError, assertInteractive, parseLastAccess, assertProtected, assertSameVolume,
  assertQuiescent, validateEntryPermit, createJournal, UsbReconnectCampaign }
