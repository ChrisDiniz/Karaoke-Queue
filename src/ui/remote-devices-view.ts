import { advancePairingUiEventCursor, getCandidatePairingAction, type PairingUiEventCursor, type ManagementPairingUiEvent,
  type ManagementRemoteUiBridge, type RemoteUiCandidate, type RemoteUiConnection, type RemoteUiSnapshot } from '../remote-ui-contracts'

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!)
}

export function connectionLabel(connection: RemoteUiConnection): string {
  switch (connection.state) {
    case 'connecting': return 'Conectando'
    case 'authorized': return 'Transporte autenticado'
    case 'reconciling': return 'Conciliando estado'
    case 'synchronized': return 'Reconciliado tecnicamente · sem controle de negócio'
    case 'recovery_required': return 'Recuperação necessária'
    case 'conflict': return 'Conflito de confiança'
    case 'blocked': return 'Conexão bloqueada'
    case 'closed': return 'Conexão encerrada'
    case 'stopping': return 'Encerrando conexão'
    case 'backoff': return 'Aguardando nova tentativa'
    case 'disabled': return 'Reconexão desativada'
  }
}

export function connectionTone(state: RemoteUiConnection['state']): 'info' | 'pending' | 'offline' | 'error' {
  switch (state) {
    case 'authorized': case 'synchronized': return 'info'
    case 'connecting': case 'reconciling': case 'backoff': case 'stopping': return 'pending'
    case 'recovery_required': case 'conflict': case 'blocked': return 'error'
    case 'disabled': case 'closed': return 'offline'
  }
}

export function describeManagementPairingError(code?: string): string | undefined {
  const known: Record<string, string> = {
    SECRET_STORAGE_UNAVAILABLE: 'O cofre seguro não está disponível. Nenhum vínculo novo foi confirmado; verifique o armazenamento seguro antes de tentar novamente.',
    SECRET_STORAGE_UNSUPPORTED: 'Este sistema não oferece o cofre seguro exigido para parear. Nenhum vínculo novo foi confirmado.',
    PAIRING_STORE_READ_FAILED: 'Não foi possível ler o journal persistido. Os dados foram preservados; não inicie outro pareamento antes de recuperar o mesmo vínculo.',
    PAIRING_STORE_INVALID: 'O journal persistido está inválido e foi preservado. Pareamento e recuperação permanecem bloqueados.',
    PAIRING_STORE_RESULT_UNCERTAIN: 'A gravação do journal não pôde ser confirmada. Preserve os dados e recupere o mesmo vínculo antes de tentar novamente.',
    PAIRING_RESULT_UNCERTAIN: 'O protocolo preservou um resultado incerto. Consulte a recuperação antes de tentar novamente.'
  }
  return code ? known[code] : undefined
}

export class RemoteDevicesView {
  private readonly root = document.createElement('div')
  private snapshot: RemoteUiSnapshot | undefined
  private open = false
  private waiting = false
  private pairingRequest: { requestId: string; revision: number } | undefined
  private codeSubmitted = false
  private stateMessage = ''
  private stateKind: 'info' | 'warning' | 'error' | 'success' = 'info'
  private stateCode = ''
  private focusedBeforeOpen: HTMLElement | null = null
  private countdownStartedAt = 0
  private countdownMs = 0
  private countdownTimer: number | undefined
  private verificationTimer: number | undefined
  private readonly cleanups: Array<() => void> = []
  private countdownExpired = false
  private verificationTimedOut = false
  private queryingOperationId: string | undefined
  private manualEndpointOpen = false
  private removalConfirmationId: string | undefined
  private pairingPurpose: 'initial' | 'renewal' = 'initial'
  private recoveryRunning = false
  private pairingEventCursor: PairingUiEventCursor = { revision: 0, terminal: false }

  constructor(private readonly api: ManagementRemoteUiBridge) {
    if (!this.trigger) throw new Error('REMOTE_DEVICES_TRIGGER_MISSING')
    this.root.id = 'remote-devices-root'
    document.body.append(this.root)
    document.addEventListener('click', this.onTriggerClick, true)
    window.addEventListener('keydown', this.onKeyDown, true)
    this.cleanups.push(api.onSnapshot(snapshot => {
      if (!this.snapshot || snapshot.revision > this.snapshot.revision) {
        this.snapshot = snapshot
        this.render()
      }
    }))
    this.cleanups.push(api.onPairingEvent(event => this.onPairingEvent(event)))
    window.addEventListener('pagehide', this.dispose, { once: true })
    void api.getSnapshot().then(snapshot => {
      if (!this.snapshot || snapshot.revision > this.snapshot.revision) this.snapshot = snapshot
      this.render()
    }).catch(() => { this.stateMessage = 'Não foi possível ler o estado da conexão.'; this.stateKind = 'error'; this.render() })
  }

  private readonly openPanel = (): void => {
    this.focusedBeforeOpen = this.trigger
    this.open = true
    this.stateCode = ''
    this.render()
    void this.api.startDiscovery().then(reply => {
      if (reply.outcome === 'failed') {
        this.stateMessage = this.describeError(reply.code)
        this.stateKind = 'error'
        this.render()
      }
      return this.api.getSnapshot()
    }).then(snapshot => {
      if (!this.snapshot || snapshot.revision >= this.snapshot.revision) this.snapshot = snapshot
      this.render()
    }).catch(() => {
      this.stateMessage = 'A busca não pôde ser iniciada nesta rede.'
      this.stateKind = 'error'
      this.render()
    })
  }

  private get trigger(): HTMLButtonElement | null {
    return document.getElementById('btn-devices') as HTMLButtonElement | null
  }

  private readonly onTriggerClick = (event: MouseEvent): void => {
    if (!(event.target instanceof Element) || !event.target.closest('#btn-devices')) return
    this.openPanel()
  }

  private readonly onPairingEvent = (event: ManagementPairingUiEvent): void => {
    const cursor = advancePairingUiEventCursor(this.pairingEventCursor, event, event.type === 'closed')
    if (!cursor) return
    this.pairingEventCursor = cursor
    if (event.type === 'recovery-started') {
      this.pairingRequest = { requestId: event.requestId, revision: event.revision }
      this.recoveryRunning = true
      this.waiting = true
      this.stateMessage = `Recuperando o journal salvo de ${event.playerName}.`
      this.stateKind = 'info'
      this.render()
      return
    }
    if (event.type === 'waiting-consent') {
      this.pairingRequest = { requestId: event.requestId, revision: event.revision }
      this.pairingPurpose = event.purpose
      this.waiting = true
      this.countdownMs = 120_000
      this.countdownStartedAt = performance.now()
      this.countdownExpired = false
      this.stateMessage = 'Aguardando confirmação local no Player.'
      this.stateKind = 'info'
      this.render()
      return
    }
    if (event.type === 'code-request') {
      this.pairingRequest = { requestId: event.requestId, revision: event.revision }
      this.pairingPurpose = event.purpose
      this.codeSubmitted = false
      this.waiting = true
      this.countdownMs = event.remainingMs
      this.countdownStartedAt = performance.now()
      this.countdownExpired = false
      this.stateMessage = `Digite o código temporário mostrado no ${event.playerName}.`
      this.stateKind = 'info'
      this.render()
      this.root.querySelector<HTMLInputElement>('#remote-pairing-code')?.focus()
      return
    }
    this.pairingRequest = undefined
    this.recoveryRunning = false
    this.codeSubmitted = false
    this.waiting = false
    this.clearCountdown()
    this.clearVerificationTimer()
    if (event.outcome === 'active') {
      this.stateMessage = 'Vínculo salvo. A Gestão está verificando a reconexão técnica; operações de negócio continuam indisponíveis.'
      this.stateKind = 'success'
    } else if (event.outcome === 'cancelled') {
      this.stateMessage = 'O pareamento foi cancelado. Uma gravação já admitida continua sujeita à recuperação do protocolo.'
      this.stateKind = 'warning'
    } else {
      this.stateMessage = 'O pareamento terminou com erro. Consulte novamente antes de iniciar outra solicitação.'
      this.stateKind = 'error'
    }
    this.render()
  }

  private render(): void {
    if (!this.open) { this.root.replaceChildren(); return }
    const previousFocus = this.root.contains(document.activeElement) && document.activeElement instanceof HTMLElement
      ? document.activeElement : null
    const previousFocusId = previousFocus?.id
    const previousAction = previousFocus?.dataset.action
    const previousPlayerId = previousFocus?.dataset.playerId
    const previousOperationId = previousFocus?.dataset.operationId
    const previousCandidateId = previousFocus?.dataset.candidateId
    const previousValue = previousFocus instanceof HTMLInputElement ? previousFocus.value : undefined
    const manualValues = ['remote-manual-address', 'remote-manual-port'].map(id => ({
      id, value: this.root.querySelector<HTMLInputElement>(`#${id}`)?.value
    }))
    const previousSelection = previousFocus instanceof HTMLInputElement
      ? { start: previousFocus.selectionStart, end: previousFocus.selectionEnd } : undefined
    const candidates = this.snapshot?.candidates ?? []
    const connections = this.snapshot?.connections ?? []
    const savedDevices = this.snapshot?.savedDevices ?? []
    const connectionItems = savedDevices.map(device => {
      const connection = connections.find(value => value.deviceRole === 'player' && value.deviceId === device.playerId)
      const label = device.recoveryRequired ? 'Recuperação necessária · journal preservado'
        : device.status === 'revoked' ? 'Vínculo removido localmente'
          : connection ? connectionLabel(connection) : 'Vínculo salvo · Player indisponível'
      const tone = device.recoveryRequired ? 'error'
        : device.status === 'revoked' ? 'offline'
          : connection ? connectionTone(connection.state) : 'offline'
      return `<article class="remote-device-card" data-saved-player-id="${escapeHtml(device.playerId)}">
        <div class="remote-device-title">Player salvo · ${escapeHtml(device.playerId.slice(0, 8))}</div>
        <span class="remote-device-state remote-device-state--${tone}" data-connection-state="${connection?.state ?? (device.recoveryRequired ? 'recovery_required' : device.status === 'revoked' ? 'disabled' : 'offline')}">${escapeHtml(label)}</span>
        <div class="remote-device-subtitle">${escapeHtml(device.address)}:${device.port}</div>
        ${connection?.reason ? `<div class="remote-device-reason">${escapeHtml(connection.reason)}</div>` : ''}
        ${device.status === 'active' ? `<button class="remote-button" data-action="remove-local" data-player-id="${escapeHtml(device.playerId)}" ${device.recoveryRequired ? 'disabled' : ''}>Remover desta Gestão</button>` : ''}
      </article>`
    }).join('')
    const candidateItems = candidates.map((candidate, index) => this.candidateMarkup(candidate, index)).join('')
    const operations = this.snapshot?.operations ?? []
    const operationItems = operations.map(operation => this.operationMarkup(operation.playerId, operation.operationId,
      operation.status, operation.updatedAt)).join('')
    const discoveryState = this.snapshot?.discovery === 'ready' ? 'Busca automática ativa' : 'Busca não iniciada'
    const pairingStoreUnavailable = this.snapshot?.pairingStoreStatus === 'unavailable'
    const content = this.waiting && this.pairingRequest
      ? this.pairingMarkup()
      : this.manualEndpointOpen ? this.manualEndpointMarkup()
        : this.removalConfirmationId ? this.removalConfirmationMarkup(this.removalConfirmationId)
      : `<div class="remote-device-scrim" data-action="close"></div>
        <aside class="remote-device-panel" role="dialog" aria-modal="true" aria-labelledby="remote-device-heading">
          <header class="remote-device-header"><div><span class="remote-device-kicker">REDE LOCAL</span><h1 id="remote-device-heading">Dispositivos</h1></div>
            <button class="remote-icon-button" data-action="close" data-autofocus aria-label="Fechar dispositivos">×</button></header>
          <p class="remote-device-description">A descoberta encontra endereços candidatos. A identidade só é confirmada pelo pareamento seguro.</p>
          <div class="remote-discovery-status" role="status" aria-live="polite">${escapeHtml(discoveryState)}${candidates.length ? ` · ${candidates.length} encontrados` : ''}</div>
          ${pairingStoreUnavailable ? '<p class="remote-inline-state remote-inline-state--error" role="alert" data-error-code="PAIRING_STATE_UNAVAILABLE">Não foi possível ler os vínculos e journals persistidos. Pareamento e recuperação estão bloqueados para preservar os dados.</p>' : ''}
          ${this.stateMessage ? `<p class="remote-inline-state remote-inline-state--${this.stateKind}" role="status" aria-live="polite"${this.stateKind === 'error' && this.stateCode ? ` data-error-code="${escapeHtml(this.stateCode)}"` : ''}>${escapeHtml(this.stateMessage)}</p>` : ''}
          <section class="remote-device-list" aria-label="Players encontrados e vínculos salvos">
            ${connectionItems}
            ${candidateItems || (!connections.length && !savedDevices.length ? `<div class="remote-empty-state"><span aria-hidden="true">⌕</span><strong>${this.snapshot?.discovery === 'ready' ? 'Nenhum dispositivo encontrado' : 'Buscando dispositivos'}</strong><p>Confira se o Player está ligado e permitiu a descoberta.</p></div>` : '')}
          </section>
          ${operationItems ? `<section class="remote-operation-list" aria-label="Operações remotas"><h2>Operações remotas</h2>${operationItems}</section>` : ''}
          <footer class="remote-device-actions"><button class="remote-button" data-action="close">Fechar · Esc</button><button class="remote-button" data-action="advanced" ${pairingStoreUnavailable ? 'disabled' : ''}>Configuração avançada</button><button class="remote-button remote-button--primary" data-action="refresh">Atualizar busca</button></footer>
        </aside>`
    this.root.innerHTML = content
    for (const { id, value } of manualValues) {
      const input = this.root.querySelector<HTMLInputElement>(`#${id}`)
      if (input && value !== undefined) input.value = value
    }
    this.root.querySelectorAll<HTMLButtonElement>('[data-action="close"]').forEach(button => button.addEventListener('click', this.closePanel))
    this.root.querySelector<HTMLButtonElement>('[data-action="refresh"]')?.addEventListener('click', this.refresh)
    this.root.querySelector<HTMLButtonElement>('[data-action="advanced"]')?.addEventListener('click', this.openManualEndpoint)
    this.root.querySelectorAll<HTMLButtonElement>('[data-candidate-index]').forEach(button => button.addEventListener('click', () => {
      const index = Number(button.dataset.candidateIndex)
      const candidate = this.snapshot?.candidates[index]
      if (!candidate) return
      if (button.dataset.purpose === 'recovery' && button.dataset.playerId) {
        void this.recoverPairing(button.dataset.playerId, candidate)
      } else void this.beginPairing(candidate, button.dataset.purpose === 'renewal' ? 'renewal' : 'initial')
    }))
    this.root.querySelector<HTMLButtonElement>('[data-action="submit-code"]')?.addEventListener('click', this.submitCode)
    this.root.querySelector<HTMLButtonElement>('[data-action="cancel-pairing"]')?.addEventListener('click', this.cancelPairing)
    this.root.querySelectorAll<HTMLButtonElement>('[data-action="query-operation"]').forEach(button => button.addEventListener('click', () => {
      const playerId = button.dataset.playerId
      const operationId = button.dataset.operationId
      if (playerId && operationId) void this.queryOperation(playerId, operationId)
    }))
    this.root.querySelectorAll<HTMLButtonElement>('[data-action="remove-local"]').forEach(button => button.addEventListener('click', () => {
      const playerId = button.dataset.playerId
      if (playerId) { this.removalConfirmationId = playerId; this.render() }
    }))
    this.root.querySelector<HTMLButtonElement>('[data-action="confirm-remove"]')?.addEventListener('click', this.confirmRemoveLocal)
    this.root.querySelector<HTMLButtonElement>('[data-action="cancel-remove"]')?.addEventListener('click', this.cancelRemoveLocal)
    this.root.querySelector<HTMLButtonElement>('[data-action="manual-cancel"]')?.addEventListener('click', this.cancelManualEndpoint)
    this.root.querySelector<HTMLButtonElement>('[data-action="manual-submit"]')?.addEventListener('click', this.submitManualEndpoint)
    const code = this.root.querySelector<HTMLInputElement>('#remote-pairing-code')
    code?.addEventListener('input', () => { code.value = code.value.replace(/[^0-9]/g, '').slice(0, 8) })
    code?.addEventListener('keydown', event => {
      if (event.key !== 'Enter') return
      event.preventDefault()
      void this.submitCode()
    })
    let focusTarget: HTMLElement | null = null
    if (previousFocusId) focusTarget = [...this.root.querySelectorAll<HTMLElement>('[id]')].find(element => element.id === previousFocusId) ?? null
    if (!focusTarget && previousAction) {
      focusTarget = [...this.root.querySelectorAll<HTMLElement>('[data-action]')].find(element =>
        element.dataset.action === previousAction && element.dataset.playerId === previousPlayerId &&
        element.dataset.operationId === previousOperationId && element.dataset.candidateId === previousCandidateId) ?? null
    }
    if (focusTarget && previousValue !== undefined && focusTarget instanceof HTMLInputElement) {
      const samePairingRequest = focusTarget.id !== 'remote-pairing-code' ||
        previousFocus?.dataset.requestId === this.pairingRequest?.requestId
      if (samePairingRequest) focusTarget.value = previousValue
      focusTarget.focus()
      if (samePairingRequest && previousSelection && previousSelection.start !== null && previousSelection.end !== null) {
        try { focusTarget.setSelectionRange(previousSelection.start, previousSelection.end) } catch {}
      }
    } else if (focusTarget) focusTarget.focus()
    else this.root.querySelector<HTMLElement>('[data-autofocus]')?.focus()
    this.updateCountdown()
  }

  private candidateMarkup(candidate: RemoteUiCandidate, index: number): string {
    const address = candidate.addresses[0] ?? 'Endereço local indisponível'
    const action = this.snapshot ? getCandidatePairingAction(this.snapshot, candidate) : { kind: 'initial' as const }
    return `<article class="remote-device-card">
      <div class="remote-device-title">${escapeHtml(candidate.displayName)}</div>
      <div class="remote-device-subtitle">Descoberto agora · ${escapeHtml(address)}</div>
      <span class="remote-device-unverified">AINDA NÃO VERIFICADO</span>
      ${action.kind === 'unavailable' ? ''
        : action.kind === 'recovery' ? `<button class="remote-button remote-button--primary remote-candidate-button" data-candidate-index="${index}" data-candidate-id="${escapeHtml(candidate.candidateId)}" data-player-id="${escapeHtml(action.playerId)}" data-purpose="recovery">Recuperar operação pareada</button>`
        : action.kind === 'recovery-blocked' ? '<div class="remote-inline-state remote-inline-state--warning">Resultado G2 incerto preservado. Não repita o pareamento; esta fase não tem ação segura para este journal.</div>'
        : action.kind === 'renewal' ? `<button class="remote-button remote-button--primary remote-candidate-button" data-candidate-index="${index}" data-candidate-id="${escapeHtml(candidate.candidateId)}" data-player-id="${escapeHtml(action.playerId)}" data-purpose="renewal">Renovar vínculo salvo</button>`
        : action.kind === 'saved' ? '<div class="remote-device-subtitle">Candidato anunciado; o vínculo salvo será verificado pela reconexão segura.</div>'
      : `<button class="remote-button remote-button--primary remote-candidate-button" data-candidate-index="${index}" data-candidate-id="${escapeHtml(candidate.candidateId)}" data-purpose="initial">Solicitar vínculo</button>`}
    </article>`
  }

  private manualEndpointMarkup(): string {
    return `<div class="remote-device-scrim remote-device-scrim--modal" data-action="manual-cancel"></div>
      <section class="remote-pairing-dialog" role="dialog" aria-modal="true" aria-labelledby="remote-manual-heading">
        <span class="remote-device-kicker">CONFIGURAÇÃO AVANÇADA</span><h1 id="remote-manual-heading">Adicionar endereço manual</h1>
        <p class="remote-device-description">Use um IPv4 privado desta rede local. O endereço não confirma a identidade do Player.</p>
        ${this.stateMessage ? `<p class="remote-inline-state remote-inline-state--${this.stateKind}" role="status" aria-live="polite">${escapeHtml(this.stateMessage)}</p>` : ''}
        <label class="remote-code-label" for="remote-manual-address">Endereço IPv4</label>
        <input id="remote-manual-address" class="remote-code-input" type="text" inputmode="decimal" autocomplete="off" value="">
        <label class="remote-code-label" for="remote-manual-port">Porta</label>
        <input id="remote-manual-port" class="remote-code-input" type="number" min="1024" max="65535" placeholder="Porta exibida no Player">
        <p class="remote-device-subtitle">Digite o endereço e a porta atuais exibidos no Player. A Gestão verificará o certificado TLS e OPAQUE antes de salvar o vínculo.</p>
        <div class="remote-device-actions"><button class="remote-button" data-action="manual-cancel" data-autofocus>Cancelar · Esc</button><button class="remote-button remote-button--primary" data-action="manual-submit">Verificar endereço</button></div>
      </section>`
  }

  private removalConfirmationMarkup(playerId: string): string {
    return `<div class="remote-device-scrim remote-device-scrim--modal"></div>
      <section class="remote-pairing-dialog" role="alertdialog" aria-modal="true" aria-labelledby="remote-remove-heading">
        <span class="remote-device-kicker">GERENCIAR VÍNCULO</span><h1 id="remote-remove-heading">Remover deste computador?</h1>
        <p class="remote-device-description">Esta ação desativa o vínculo salvo somente nesta Gestão. O Player remoto pode continuar reconhecendo a Gestão até que a revogação seja feita no Player.</p>
        <p class="remote-inline-state remote-inline-state--warning">Journals duráveis serão preservados. Remoção local não confirma revogação remota.</p>
        <div class="remote-device-actions"><button class="remote-button" data-action="cancel-remove" data-autofocus>Manter vínculo</button><button class="remote-button remote-button--primary" data-action="confirm-remove" data-player-id="${escapeHtml(playerId)}">Remover localmente</button></div>
      </section>`
  }

  private readonly openManualEndpoint = (): void => {
    this.stateMessage = ''
    this.stateCode = ''
    this.manualEndpointOpen = true
    this.render()
    this.root.querySelector<HTMLInputElement>('#remote-manual-address')?.focus()
  }

  private readonly cancelManualEndpoint = (): void => {
    this.manualEndpointOpen = false
    this.stateMessage = ''
    this.render()
  }

  private readonly submitManualEndpoint = async (): Promise<void> => {
    const address = this.root.querySelector<HTMLInputElement>('#remote-manual-address')?.value.trim()
    const port = Number(this.root.querySelector<HTMLInputElement>('#remote-manual-port')?.value)
    if (!address || address.split('.').length !== 4 || !address.split('.').every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255) ||
        !Number.isInteger(port) || port < 1024 || port > 65535) {
      this.stateMessage = 'Informe um endereço IPv4 privado e uma porta entre 1024 e 65535.'
      this.stateKind = 'error'
      this.render()
      this.root.querySelector<HTMLInputElement>('#remote-manual-address')?.focus()
      return
    }
    this.manualEndpointOpen = false
    this.waiting = true
    this.stateMessage = 'Verificando endpoint pela mesma apresentação OPAQUE…'
    this.stateKind = 'info'
    this.render()
    try {
      const reply = await this.api.pairManualAddress(address, port)
      this.finishPairing(reply)
    } catch {
      this.waiting = false
      this.stateMessage = 'A solicitação manual falhou. Nenhuma identidade foi presumida a partir do endereço.'
      this.stateKind = 'error'
      this.render()
    }
  }

  private readonly confirmRemoveLocal = async (): Promise<void> => {
    const playerId = this.removalConfirmationId
    if (!playerId) return
    const reply = await this.api.revokePeerLocally(playerId)
    this.removalConfirmationId = undefined
    if (reply.outcome === 'completed') {
      this.stateMessage = 'Vínculo removido somente nesta Gestão. A revogação no Player não foi confirmada.'
      this.stateKind = 'warning'
      const snapshot = await this.api.getSnapshot().catch(() => undefined)
      if (snapshot && (!this.snapshot || snapshot.revision >= this.snapshot.revision)) this.snapshot = snapshot
    } else {
      this.stateMessage = reply.code === 'PAIRING_RESULT_UNCERTAIN'
        ? 'Há um journal incerto. A remoção foi bloqueada para preservar a recuperação.'
        : 'Não foi possível confirmar a remoção local. O estado do vínculo foi preservado.'
      this.stateKind = 'error'
    }
    this.render()
  }

  private readonly cancelRemoveLocal = (): void => { this.removalConfirmationId = undefined; this.render() }

  private pairingMarkup(): string {
    const request = this.pairingRequest!
    const countdown = Math.max(0, Math.ceil((this.countdownMs - (performance.now() - this.countdownStartedAt)) / 1000))
    return `<div class="remote-device-scrim remote-device-scrim--modal"></div>
      <section class="remote-pairing-dialog" role="dialog" aria-modal="true" aria-labelledby="remote-pairing-heading">
        <span class="remote-device-kicker">${this.pairingPurpose === 'renewal' ? 'RENOVAÇÃO SEGURA · OPAQUE-3DH' : 'PAREAMENTO SEGURO · OPAQUE-3DH'}</span>
        <h1 id="remote-pairing-heading">${this.recoveryRunning ? 'Recuperando vínculo salvo' : this.stateMessage.includes('Aguardando') ? 'Confirme no Player' : 'Digite o código do Player'}</h1>
        <p class="remote-device-description">${escapeHtml(this.stateMessage)}</p>
        ${this.recoveryRunning ? '<div class="remote-waiting" role="status" aria-live="polite">Verificando o mesmo journal com a prova criptográfica persistida. Nenhum novo código ou efeito operacional será criado.</div>'
        : this.codeSubmitted ? this.verificationTimedOut
          ? `<div class="remote-inline-state remote-inline-state--warning" role="status" aria-live="polite">A confirmação ainda não retornou. O Main preserva o resultado; não inicie outro pareamento.</div>`
          : `<div class="remote-waiting" role="status" aria-live="polite">Verificando o código, o certificado e o vínculo seguro…</div>`
          : this.stateMessage.includes('Aguardando') ? `<div class="remote-waiting" role="status" aria-live="polite">A solicitação não identifica a Gestão antes da verificação criptográfica.</div>`
            : this.countdownExpired ? `<div class="remote-inline-state remote-inline-state--warning" role="status" aria-live="polite">O prazo de entrada terminou. O Main validará a expiração do pedido.</div>`
              : `<label class="remote-code-label" for="remote-pairing-code">Código temporário</label><input id="remote-pairing-code" data-request-id="${escapeHtml(request.requestId)}" class="remote-code-input" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="8" aria-describedby="remote-code-help"><p id="remote-code-help" class="remote-device-subtitle">Expira em ${countdown}s · oito dígitos ASCII</p>`}
        <div class="remote-device-actions"><button class="remote-button" data-action="cancel-pairing" data-autofocus>Cancelar · Esc</button>${this.recoveryRunning || this.stateMessage.includes('Aguardando') || this.codeSubmitted || this.countdownExpired ? '' : '<button class="remote-button remote-button--primary" data-action="submit-code">Verificar código</button>'}</div>
      </section>`
  }

  private operationMarkup(playerId: string, operationId: string, status: string, updatedAt: number): string {
    const labels: Record<string, string> = { 'not-sent': 'Não enviada', rejected: 'Rejeitada', accepted: 'Aceita · ainda pendente',
      completed: 'Concluída', unknown: 'Resultado incerto' }
    const connection = this.snapshot?.connections.find(value => value.deviceRole === 'player' && value.deviceId === playerId)
    const canQuery = (status === 'accepted' || status === 'unknown') &&
      connection?.state === 'synchronized' && connection.reconciled
    const busy = this.queryingOperationId === operationId
    const date = Number.isFinite(updatedAt) ? new Date(updatedAt).toLocaleString() : 'data indisponível'
    return `<article class="remote-device-card" data-player-id="${escapeHtml(playerId)}" data-operation-id="${escapeHtml(operationId)}"><div class="remote-device-title">Operação ${escapeHtml(operationId.slice(0, 12))}</div>
      <div class="remote-device-subtitle">${escapeHtml(labels[status] ?? 'Estado indisponível')} · atualizado ${escapeHtml(date)}</div>
      ${canQuery ? `<button class="remote-button" data-action="query-operation" data-player-id="${escapeHtml(playerId)}" data-operation-id="${escapeHtml(operationId)}" ${busy ? 'disabled' : ''}>${busy ? 'Consultando…' : 'Consultar estado'}</button>`
        : status === 'accepted' || status === 'unknown' ? '<p class="remote-device-subtitle">Consulta disponível quando o canal seguro estiver reconciliado.</p>' : ''}
      ${busy ? '<p class="remote-inline-state" role="status" aria-live="polite">Consulta com prazo limitado; nenhum comando será reenviado.</p>' : ''}</article>`
  }

  private readonly queryOperation = async (playerId: string, operationId: string): Promise<void> => {
    if (this.queryingOperationId) return
    this.queryingOperationId = operationId
    this.render()
    try {
      const reply = await this.api.queryOperation(playerId, operationId)
      if (reply.code === 'REMOTE_OPERATION_NOT_FOUND') {
        this.stateMessage = 'O Player ainda não possui prova desta operação. A outbox permanece incerta; consulte novamente mais tarde.'
        this.stateKind = 'warning'
      } else if (reply.outcome === 'failed') {
        this.stateMessage = 'A consulta não terminou. A operação original continua preservada e não foi reenviada.'
        this.stateKind = 'warning'
      } else if (reply.code === 'REMOTE_OPERATION_TERMINAL') {
        this.stateMessage = 'A operação já está em estado terminal na outbox local.'
        this.stateKind = 'info'
      } else {
        this.stateMessage = 'O Main registrou a resposta autenticada do Player na outbox.'
        this.stateKind = 'success'
      }
      const snapshot = await this.api.getSnapshot()
      if (!this.snapshot || snapshot.revision >= this.snapshot.revision) this.snapshot = snapshot
    } catch {
      this.stateMessage = 'A consulta falhou ou expirou. O resultado permanece preservado para nova consulta explícita.'
      this.stateKind = 'warning'
    } finally {
      this.queryingOperationId = undefined
      this.render()
    }
  }

  private readonly beginPairing = async (candidate: RemoteUiCandidate, purpose: 'initial' | 'renewal'): Promise<void> => {
    this.stateCode = ''
    this.pairingPurpose = purpose
    this.waiting = true
    this.stateMessage = `Aguardando confirmação local no Player encontrado.`
    this.stateKind = 'info'
    this.countdownMs = 120_000
    this.countdownStartedAt = performance.now()
    this.render()
    let reply
    try { reply = purpose === 'renewal' ? await this.api.renewPairing(candidate.candidateId) : await this.api.pair(candidate.candidateId) }
    catch { reply = { outcome: 'failed' as const, code: 'REMOTE_UI_FAILED' }
    }
    this.finishPairing(reply)
  }

  private readonly recoverPairing = async (playerId: string, candidate: RemoteUiCandidate): Promise<void> => {
    this.waiting = true
    this.recoveryRunning = true
    this.stateMessage = 'Iniciando recuperação do journal persistido…'
    this.stateKind = 'info'
    this.render()
    let reply
    try { reply = await this.api.recoverPairing(playerId, candidate.candidateId) }
    catch { reply = { outcome: 'failed' as const, code: 'REMOTE_UI_FAILED' } }
    this.recoveryRunning = false
    this.finishPairing(reply)
  }

  private finishPairing(reply: import('../remote-ui-contracts').RemoteUiActionReply): void {
    this.stateCode = reply.code ?? ''
    this.waiting = false
    this.pairingRequest = undefined
    this.recoveryRunning = false
    this.clearCountdown()
    if (reply.outcome === 'completed') {
      this.stateMessage = reply.code
        ? 'Vínculo salvo, mas a reconexão técnica não foi iniciada. O resultado do pareamento permanece confirmado.'
        : 'Vínculo salvo. Transporte e reconciliação estão sendo atualizados; isso não habilita operações de negócio.'
      this.stateKind = reply.code ? 'warning' : 'success'
    } else if (reply.outcome === 'cancelled') {
      this.stateMessage = 'Solicitação cancelada. Se a operação já havia sido admitida, o Main preservará o resultado para recuperação.'
      this.stateKind = 'warning'
    } else {
      this.stateMessage = this.describeError(reply.code)
      this.stateKind = 'error'
    }
    this.render()
  }

  private readonly submitCode = async (): Promise<void> => {
    const input = this.root.querySelector<HTMLInputElement>('#remote-pairing-code')
    const request = this.pairingRequest
    if (!input || !request || !/^\d{8}$/.test(input.value)) {
      this.stateMessage = 'Digite exatamente oito dígitos ASCII.'
      this.stateKind = 'error'
      this.render()
      this.root.querySelector<HTMLInputElement>('#remote-pairing-code')?.focus()
      return
    }
    const code = input.value
    input.value = ''
    this.codeSubmitted = true
    this.verificationTimedOut = false
    this.clearCountdown()
    this.clearVerificationTimer()
    this.verificationTimer = window.setTimeout(() => {
      if (!this.codeSubmitted) return
      this.verificationTimedOut = true
      this.render()
    }, 20_000)
    this.stateMessage = 'Verificando código e identidade criptográfica…'
    this.render()
    const accepted = await this.api.submitPairingCode(request.requestId, request.revision, code)
    if (!accepted) {
      this.codeSubmitted = false
      this.stateMessage = 'Esta solicitação expirou ou não está mais ativa. Atualize a busca e inicie um novo pedido.'
      this.stateKind = 'error'
      this.waiting = false
      this.pairingRequest = undefined
      this.clearCountdown()
      this.clearVerificationTimer()
      this.render()
    }
  }

  private readonly cancelPairing = async (): Promise<void> => {
    const request = this.pairingRequest
    if (!request) return
    const cancelled = await this.api.cancelPairing(request.requestId, request.revision)
    this.stateMessage = cancelled
      ? 'Cancelamento solicitado. Uma gravação durável não é desfeita automaticamente.'
      : 'O resultado pode ser incerto. Não repita o pareamento antes da recuperação do mesmo vínculo.'
    this.stateKind = cancelled ? 'warning' : 'error'
    if (cancelled) { this.waiting = false; this.pairingRequest = undefined; this.clearCountdown() }
    this.render()
  }

  private readonly refresh = async (): Promise<void> => {
    this.stateMessage = ''
    this.render()
    const reply = await this.api.refreshDiscovery()
    if (reply.outcome === 'failed') { this.stateMessage = this.describeError(reply.code); this.stateKind = 'error' }
    const snapshot = await this.api.getSnapshot()
    if (!this.snapshot || snapshot.revision >= this.snapshot.revision) this.snapshot = snapshot
    this.render()
  }

  private readonly closePanel = (): void => {
    if (this.waiting && this.pairingRequest) { void this.cancelPairing(); return }
    this.open = false
    this.clearCountdown()
    this.clearVerificationTimer()
    this.render()
    this.focusedBeforeOpen?.focus()
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!this.open) return
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopImmediatePropagation()
      if (this.manualEndpointOpen) this.cancelManualEndpoint()
      else if (this.removalConfirmationId) this.cancelRemoveLocal()
      else this.closePanel()
      return
    }
    if (event.key !== 'Tab') return
    const dialog = this.root.querySelector<HTMLElement>('[role="dialog"], [role="alertdialog"]')
    if (!dialog) return
    const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)')]
    if (!focusable.length) { event.preventDefault(); event.stopImmediatePropagation(); return }
    const first = focusable[0]!, last = focusable[focusable.length - 1]!
    if (!dialog.contains(document.activeElement)) {
      event.preventDefault(); event.stopImmediatePropagation(); (event.shiftKey ? last : first).focus()
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault(); event.stopImmediatePropagation(); last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault(); event.stopImmediatePropagation(); first.focus()
    }
  }

  private updateCountdown(): void {
    if (!this.waiting || !this.pairingRequest) { this.clearCountdown(); return }
    if (this.countdownExpired) { this.clearCountdown(); return }
    const label = this.root.querySelector<HTMLElement>('#remote-code-help')
    if (label) label.textContent = `Expira em ${Math.max(0, Math.ceil((this.countdownMs - (performance.now() - this.countdownStartedAt)) / 1000))}s · oito dígitos ASCII`
    if (this.countdownMs - (performance.now() - this.countdownStartedAt) <= 0) {
      this.countdownExpired = true
      this.render()
      return
    }
    this.countdownTimer = window.setTimeout(() => this.updateCountdown(), 250)
  }

  private clearCountdown(): void {
    if (this.countdownTimer !== undefined) window.clearTimeout(this.countdownTimer)
    this.countdownTimer = undefined
  }

  private clearVerificationTimer(): void {
    if (this.verificationTimer !== undefined) window.clearTimeout(this.verificationTimer)
    this.verificationTimer = undefined
  }

  private describeError(code?: string): string {
    const pairingError = describeManagementPairingError(code)
    if (pairingError) return pairingError
    const known: Record<string, string> = {
      REMOTE_CANDIDATE_STALE: 'Este dispositivo saiu da descoberta. Atualize a busca antes de solicitar o vínculo.',
      REMOTE_DISCOVERY_INTERFACE_INVALID: 'A rede selecionada não está mais disponível.',
      PAIRING_BUSY: 'Já existe uma solicitação de pareamento em andamento.',
      PAIRING_RESULT_UNCERTAIN: 'O protocolo preservou um resultado incerto. Consulte a recuperação antes de tentar novamente.',
      REMOTE_RECONNECTION_START_FAILED: 'O vínculo foi preservado, mas a reconexão técnica não iniciou.',
      PAIRING_CODE_INVALID: 'O código não foi aceito. Confira os oito dígitos no Player.',
      PAIRING_AUTH_FAILED: 'O código ou a prova criptográfica não foi aceito. Confira o código temporário no Player.',
      PAIRING_RATE_LIMITED: 'O Player bloqueou novas tentativas. Aguarde o prazo de segurança indicado pelo Player.',
      PAIRING_ATTEMPTS_EXHAUSTED: 'As tentativas desta solicitação foram esgotadas. Aguarde o bloqueio e inicie um novo pedido depois.',
      PAIRING_ATTEMPTS_EXHAUSTED_SESSION_UNCLOSED: 'As tentativas se esgotaram, mas não foi possível confirmar o encerramento da sessão no Player. Aguarde o código expirar antes de iniciar outro pedido.',
      REMOTE_MANUAL_ENDPOINT_OUTSIDE_LAN: 'O endereço não pertence a uma interface local compartilhada com esta Gestão.',
      PAIRING_PRESENTATION_UNAPPROVED: 'A apresentação de pareamento não está aprovada para produção.',
      PAIRING_RECOVERY_NOT_FOUND: 'Não há um journal recuperável para este vínculo. Nenhuma operação nova foi criada.',
      PAIRING_RECOVERY_IDENTITY_MISMATCH: 'A identidade TLS observada não corresponde ao vínculo e às provas persistidas.',
      PAIRING_CONFIRMED_CONNECTION_BLOCKED: 'O vínculo foi confirmado e salvo, mas a conexão técnica continua bloqueada para recuperação.',
      LOCAL_REVOCATION_CONFIRMED_CHANNEL_CLOSE_FAILED: 'A remoção local foi persistida, mas o canal antigo não confirmou encerramento. A Gestão bloqueia o vínculo e preserva o estado para recuperação.'
    }
    return code ? known[code] ?? 'Não foi possível concluir a solicitação. O estado salvo será preservado.' : 'Não foi possível concluir a solicitação. O estado salvo será preservado.'
  }

  private readonly dispose = (): void => {
    document.removeEventListener('click', this.onTriggerClick, true)
    window.removeEventListener('keydown', this.onKeyDown, true)
    for (const cleanup of this.cleanups.splice(0)) cleanup()
    this.clearCountdown()
    this.clearVerificationTimer()
    this.root.remove()
  }
}
