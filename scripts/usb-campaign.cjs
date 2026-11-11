'use strict'
// Extension of the T3 controller, never an entry point or a device-removal tool.
const { CampaignError, UsbReconnectCampaign, assertProtected, assertQuiescent } = require('./usb-reconnect-core.cjs')
const SCENARIOS = ['B', 'A', 'playing', 'paused', 'countdown', 'loading', 'transition', 'celebration']
const RISK_TEXT = 'Leituras podem alterar LastAccessTime. Remoção abrupta pode corromper o filesystem, tornar arquivos inacessíveis ou exigir reformatação. Não há garantia de integridade. Este programa nunca formata, repara ou ejeta dispositivos.'
function assertTestPath(root, initial = true) {
  if (typeof root !== 'string' || !/^[A-Z]:\\musicas$/i.test(root) || /^[CD]:/i.test(root) || initial && !/^F:/i.test(root)) {
    throw new CampaignError('TEST_DEVICE_PATH_REQUIRED')
  }
}
function assertTestVolume(policy, volume, { mode, disposableConsent, protectedConsent, root, expectedKey }) {
  assertTestPath(root, !expectedKey)
  if (!Number.isInteger(policy) || policy < 0 || policy > 3) throw new CampaignError('TIMESTAMP_POLICY_UNVERIFIED')
  if (!volume?.present) throw new CampaignError('VOLUME_ABSENT')
  if (volume.drive !== root.slice(0, 2).toUpperCase() || String(volume.label).toLowerCase() !== 'testekaraoke' || volume.online !== true || volume.busType !== 'USB' ||
      !['NTFS', 'EXFAT', 'FAT32'].includes(String(volume.fileSystem).toUpperCase()) || !/^[a-f0-9]{64}$/.test(volume.key || '') || volume.healthy !== true) {
    throw new CampaignError('TEST_DEVICE_IDENTITY_OR_HEALTH_INVALID')
  }
  if (expectedKey && volume.key !== expectedKey) throw new CampaignError('DIFFERENT_VOLUME_RECONNECTED')
  if (mode === 'disposable') {
    if (!disposableConsent) throw new CampaignError('DISPOSABLE_CONSENT_REQUIRED')
  } else if (mode === 'protected') {
    if (!protectedConsent) throw new CampaignError('WRITE_PROTECTION_ATTESTATION_MISSING')
    assertProtected(policy, volume)
  } else throw new CampaignError('MEDIA_MODE_REQUIRED')
}
function validateCampaignState(state, session) {
  const path = require('node:path')
  if (!state || !state.results || Array.isArray(state.results) || typeof state.results !== 'object' ||
      state.completed !== undefined && (!Array.isArray(state.completed) || state.completed.some(s => !SCENARIOS.includes(s))) ||
      state.history !== undefined && (!Array.isArray(state.history) || state.history.length > 10000 || state.history.some(r => !r ||
        !SCENARIOS.includes(r.scenario) || !['PASS', 'FAIL', 'PARTIAL', 'BLOCKED', 'NOT RUN'].includes(r.status))) ||
      state.scenarioProfiles !== undefined && (!Array.isArray(state.scenarioProfiles) || state.scenarioProfiles.some(profile =>
        typeof profile !== 'string' || path.basename(profile) !== 'profile' || path.dirname(path.dirname(path.resolve(profile))) !== path.resolve(session) ||
        !/^scenario-(B|A|playing|paused|countdown|loading|transition|celebration)-[1-9][0-9]{0,4}-[a-f0-9-]{36}$/.test(path.basename(path.dirname(profile)))))) {
    throw new CampaignError('CAMPAIGN_STATE_INVALID')
  }
}
class UnifiedUsbCampaign extends UsbReconnectCampaign {
  constructor(options) {
    super({ ...options, validateSelectionAfterRestart: false })
    Object.assign(this, { factory: options.factory, mode: options.mode, consent: options.consent, root: options.root })
    this.state.history ||= []
    this.state.completed ||= []
  }
  async prompt(id, message, expected = 'CONFIRMO') {
    this.checkpoint()
    this.state.checkpoint = id
    await this.save(this.state)
    this.journal.event('campaign-checkpoint', { id, scenario: this.scenario, physical: this.modality === 'physical' })
    const question = () => this.ask(`[${this.scenario}] ${message}\n${expected} / PULAR / CANCELAR / BLOQUEADO: `)
    const answer = this.adapter?.observeDuring ? await this.adapter.observeDuring(question) : await question()
    this.checkpoint()
    if (answer === 'CANCELAR') throw new CampaignError('OPERATOR_CANCELLED', 'PARTIAL')
    if (answer === 'PULAR') throw new CampaignError('OPERATOR_SKIPPED', 'NOT RUN')
    if (answer === 'BLOQUEADO') throw new CampaignError('OPERATOR_REPORTED_BLOCK', 'BLOCKED')
    if (answer !== expected) throw new CampaignError('HUMAN_CONFIRMATION_MISSING', 'NOT RUN')
    this.journal.event('campaign-human-confirmed', { id, scenario: this.scenario })
  }
  async safety() {
    this.checkpoint()
    assertTestPath(this.root, !this.state.volume) // lexical rejection precedes ANY native call
    const policy = await this.device.policy()
    const volume = await this.device.observe()
    if (!volume.present && this.state.volume && this.device.identifyOtherLetter) {
      this.journal.event('letter-identification-required', { scenario: this.scenario })
      const answer = await this.ask('A letra autorizada não está disponível. Se mudou, informe LETRA G: (a letra real; nunca D:) ou CANCELAR. Nenhuma outra unidade será selecionada automaticamente: ')
      if (answer === 'CANCELAR') throw new CampaignError('OPERATOR_CANCELLED', 'PARTIAL')
      const match = /^LETRA ([A-Z]:)$/.exec(answer)
      if (!match) throw new CampaignError('VOLUME_ABSENT')
      const verified = await this.device.identifyOtherLetter(match[1])
      await this.prompt('confirm-letter', 'Identidade do mesmo testekaraoke verificada por metadados. O cenário atual ficará PARTIAL; só cenários novos com perfil novo usarão esta letra.', 'CONFIRMO LETRA ' + match[1])
      this.device.bindVerifiedLetter(verified)
      this.root = match[1] + '\\musicas'
      this.state.authorizedRoot = this.root
      await this.save(this.state)
      this.journal.event('letter-change-confirmed', { volumeKey: verified.key, scenario: this.scenario, restartRequired: true })
      throw new CampaignError('LETTER_CHANGED_RESTART_REQUIRED', 'PARTIAL')
    }
    assertTestVolume(policy, volume, { mode: this.mode, ...this.consent, root: this.root, expectedKey: this.state.volume?.key })
    if (this.state.volume && volume.key !== this.state.volume.key) throw new CampaignError('DIFFERENT_VOLUME_RECONNECTED')
    this.state.volume ||= volume
    await this.save(this.state)
    if (this.device.validateRoot) await this.device.validateRoot()
    this.journal.event('campaign-preflight', { policy, mode: this.mode, volumeKey: volume.key, readOnly: volume.readOnly,
      writeProtectionClaimed: this.mode === 'protected', labelVerified: true, healthy: volume.healthy })
    return volume
  }
  async human(id, message, closed) {
    assertQuiescent(await this.adapter.resources(), closed)
    await this.prompt(id, message.replaceAll('HD', 'pendrive testekaraoke'))
    assertQuiescent(await this.adapter.resources(), closed)
  }
  async absent() {
    const volume = await this.device.observe()
    if (volume.present) throw new CampaignError('REMOVAL_NOT_OBSERVED', 'FAIL')
    this.journal.event('campaign-native-absence', { volumeKey: this.state.volume.key })
    await this.adapter.assertPreserved()
  }
  async runActive() {
    if (this.mode !== 'disposable' || !this.consent.disposableConsent) throw new CampaignError('ACTIVE_REMOVAL_REQUIRES_DISPOSABLE')
    await this.safety()
    await this.prompt('risk-' + this.scenario, RISK_TEXT + '\nAutorização específica deste cenário para remoção abrupta do pendrive descartável; não remova ainda.', 'AUTORIZO REMOCAO ABRUPTA ' + this.scenario)
    await this.adapter.start()
    await this.adapter.ready()
    await this.adapter.rememberInventory()
    const initial = await this.adapter.preparePhase(this.scenario)
    if (!initial.phaseObserved) return { status: 'PARTIAL', code: 'NOT_REPRODUCED', phase: this.scenario }
    this.journal.event('physical-target-observed', { scenario: this.scenario, observation: initial })
    // No quiescence is imposed here: ONLY this dedicated disposable mode permits the human to accept active-I/O risk.
    await this.prompt('remove-' + this.scenario,
      `Estado observado: ${this.scenario}. Pode haver leitura ativa. Somente no pendrive testekaraoke cuja identidade foi verificada, execute a remoção física autorizada para este cenário; confirme quando terminar. Se a janela temporal passou, não tente sincronizar à força: PULAR.`, 'REMOVIDO')
    await this.absent()
    const lost = await this.adapter.inspect()
    const nextObservation = await this.adapter.inspect()
    const stillAbsent = !(await this.device.observe()).present
    lost.progressWhileAbsent = Boolean(stillAbsent && lost.attemptId && lost.attemptId === nextObservation.attemptId &&
      nextObservation.media?.currentTime > lost.media?.currentTime)
    lost.progressEvidence = { nativeAbsentAfterSample: stillAbsent, firstTime: lost.media?.currentTime ?? null,
      secondTime: nextObservation.media?.currentTime ?? null, source: 'two direct samples bracketed by native absence; no deliberate wait for buffer exhaustion' }
    this.journal.event('physical-loss-observation', { scenario: this.scenario, observation: lost })
    // Reconnect promptly. Never wait for a fully-buffered song to exhaust merely to manufacture a failure.
    await this.prompt('reconnect-' + this.scenario, 'Reconecte fisicamente o mesmo pendrive testekaraoke e confirme quando o Windows reconhecê-lo.')
    await this.safety()
    const result = await this.adapter.validateActive(this.scenario, initial, lost)
    this.journal.event('physical-branch-result', result)
    if (result.recoverable) {
      await this.prompt('manual-recovery-' + this.scenario,
        'A biblioteca voltou. A reprodução NÃO será retomada automaticamente. Confirme quando estiver pronto para o runner acionar a recuperação manual pelo botão existente.')
      await this.adapter.recoverActive(initial, result)
    }
    return result
  }
  async run(scenarios = SCENARIOS) {
    if (!scenarios.length || scenarios.some(s => !SCENARIOS.includes(s))) throw new CampaignError('INVALID_SCENARIO')
    for (const scenario of scenarios) {
      if (this.state.completed.includes(scenario)) continue
      this.scenario = scenario
      let repeat
      do {
        repeat = false
        const attempt = this.state.history.filter(r => r.scenario === scenario).length + 1
        this.adapter = undefined
        let result
        try {
          await this.prompt('start-' + scenario, 'Novo cenário com perfil operacional novo. INICIAR para preparar, PULAR para não executá-lo.', 'INICIAR')
          await this.safety()
          this.adapter = await this.factory(scenario, attempt, this.root)
          result = scenario === 'B' ? await super.runB() : scenario === 'A' ? await super.runA() : await this.runActive()
        } catch (error) {
          result = { status: error.status || 'FAIL', code: error.code || 'SCENARIO_FAILED' }
        } finally {
          try { await this.adapter?.close() }
          catch (error) { result = { ...result, primaryStatus: result?.status, status: 'BLOCKED', code: 'CLEANUP_UNVERIFIED', cleanupError: error.code || 'CLOSE_FAILED' } }
        }
        result = { ...result, scenario, attempt, physical: this.modality === 'physical' }
        this.state.history.push(result)
        this.state.results[scenario] = result
        this.journal.summary(scenario + '-' + attempt, result)
        this.journal.event('campaign-scenario-result', result)
        await this.save(this.state)
        // Identity/health/cleanup uncertainty cannot be overridden by a next/repeat answer.
        const fatal = ['CLEANUP_UNVERIFIED', 'TEST_DEVICE_IDENTITY_OR_HEALTH_INVALID', 'DIFFERENT_VOLUME_RECONNECTED',
          'WINDOWS_VOLUME_METADATA_UNAVAILABLE', 'LIBRARY_PATH_VALIDATION_FAILED', 'EIO', 'ENODEV', 'EUCLEAN', 'EROFS'].includes(result.code)
        if (fatal || result.code === 'OPERATOR_CANCELLED' || this.signal?.aborted) return this.state.results
        if (result.code === 'OPERATOR_SKIPPED') { this.state.completed.push(scenario); await this.save(this.state); continue }
        const answer = await this.ask(`[${scenario}] ${result.status}${result.code ? ' (' + result.code + ')' : ''}. ` +
          (result.status === 'FAIL' ? 'Avalie a falha. AVALIADO REPETIR / CANCELAR: ' : 'PROXIMO / REPETIR / CANCELAR: '))
        if (answer === 'REPETIR' && result.status !== 'FAIL' || answer === 'AVALIADO REPETIR' && result.status === 'FAIL') {
          repeat = true // factory creates fresh profile; no volatile state or attempt is adopted
        } else if (answer === 'PROXIMO' && result.status !== 'FAIL') {
          this.state.completed.push(scenario); await this.save(this.state)
        } else return this.state.results
      } while (repeat)
    }
    return this.state.results
  }
}
module.exports = { SCENARIOS, RISK_TEXT, assertTestPath, assertTestVolume, validateCampaignState, UnifiedUsbCampaign }
