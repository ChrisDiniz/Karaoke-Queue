import { advancePairingUiEventCursor, type PairingUiEventCursor, type PlayerPairingUiEvent,
  type PlayerRemoteUiBridge, type RemoteUiSnapshot } from './remote-ui-contracts'

export function describePlayerPairingError(code?: string): string {
  const known: Record<string, string> = {
    REMOTE_DISCOVERY_INTERFACE_INVALID: 'A interface de rede escolhida não está mais disponível.',
    REMOTE_PLAYER_EXPLICITLY_OFFLINE: 'O modo offline está confirmado. Reative a descoberta após escolher uma rede.',
    REMOTE_PLAYER_INTENT_RECOVERY_REQUIRED: 'A intenção de conexão exige recuperação local antes de habilitar descoberta.',
    PAIRING_STORE_INVALID: 'O journal de pareamento está inválido e foi preservado. O Player segue local; não apague os dados.',
    PAIRING_STORE_READ_FAILED: 'Não foi possível ler o journal de pareamento. O Player segue local e os dados foram preservados.',
    PAIRING_STORE_RESULT_UNCERTAIN: 'A gravação do journal não pôde ser confirmada. Preserve os dados e recupere o mesmo vínculo antes de tentar novamente.',
    PAIRING_STORAGE_UNAVAILABLE: 'O armazenamento seguro não está disponível. Nenhum vínculo novo foi confirmado.',
    SECRET_STORAGE_UNAVAILABLE: 'O cofre seguro não está disponível. A descoberta não foi iniciada; o Player continua local.',
    SECRET_STORAGE_UNSUPPORTED: 'Este sistema não oferece o cofre seguro exigido. A descoberta não foi iniciada; o Player continua local.',
    PAIRING_PRESENTATION_UNAPPROVED: 'O pareamento remoto permanece desativado até a aprovação do gate de produção.'
  }
  return code ? known[code] ?? 'Não foi possível habilitar o pareamento. O Player continua independente.'
    : 'Não foi possível habilitar o pareamento. O Player continua independente.'
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!)
}

type DialogMode = 'network' | 'consent' | 'code' | 'offline' | 'result'

export class StandaloneRemotePairingView {
  private readonly trigger = document.getElementById('remote-player-enable') as HTMLButtonElement | null
  private readonly status = document.getElementById('remote-player-connection-status')
  private readonly description = document.getElementById('remote-player-connection-description')
  private readonly disableButton = document.getElementById('remote-player-disable') as HTMLButtonElement | null
  private readonly renewButton = document.getElementById('remote-player-renew') as HTMLButtonElement | null
  private readonly revokeButton = document.getElementById('remote-player-revoke') as HTMLButtonElement | null
  private readonly root = document.createElement('div')
  private readonly playbackToast = document.createElement('div')
  private readonly playbackToastCopy = document.createElement('span')
  private readonly actionToast = document.createElement('div')
  private readonly actionToastCopy = document.createElement('span')
  private playbackToastObserver: MutationObserver | undefined
  private actionToastTimer: number | undefined
  private snapshot: RemoteUiSnapshot | undefined
  private dialogMode: DialogMode | undefined
  private request: { requestId: string; revision: number } | undefined
  private consentSubmitting = false
  private remainingMs = 0
  private startedAt = 0
  private countdownTimer: number | undefined
  private resultTimer: number | undefined
  private resultText = ''
  private resultKind: 'success' | 'warning' | 'error' = 'success'
  private focusedBeforeOpen: HTMLElement | null = null
  private pairingEventCursor: PairingUiEventCursor = { revision: 0, terminal: false }
  private readonly cleanups: Array<() => void> = []

  constructor(private readonly api: PlayerRemoteUiBridge) {
    if (!this.trigger || !this.status || !this.description) return
    this.root.id = 'remote-player-pairing-root'
    document.body.append(this.root)
    this.playbackToast.id = 'remote-player-playback-toast'
    this.playbackToast.className = 'remote-player-playback-toast'
    this.playbackToast.setAttribute('role', 'status')
    this.playbackToast.setAttribute('aria-live', 'polite')
    this.playbackToast.setAttribute('aria-atomic', 'true')
    this.playbackToast.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 8v5m0 3h.01"></path></svg>'
    this.playbackToast.append(this.playbackToastCopy)
    this.playbackToast.hidden = true
    document.body.append(this.playbackToast)
    this.actionToast.id = 'remote-player-action-toast'
    this.actionToast.className = 'remote-player-action-toast'
    this.actionToast.setAttribute('role', 'status')
    this.actionToast.setAttribute('aria-live', 'polite')
    this.actionToast.setAttribute('aria-atomic', 'true')
    this.actionToast.dataset.tone = 'success'
    this.actionToast.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="m8 12 2.5 2.5L16 9"></path></svg>'
    this.actionToast.append(this.actionToastCopy)
    this.actionToast.hidden = true
    document.body.append(this.actionToast)
    const idlePanel = document.getElementById('standalone-idle-panel')
    if (idlePanel) {
      this.playbackToastObserver = new MutationObserver(() => this.syncPlaybackToastVisibility())
      this.playbackToastObserver.observe(idlePanel, { attributes: true, attributeFilter: ['hidden'] })
    }
    this.trigger.addEventListener('click', this.openNetworkDialog)
    this.disableButton?.addEventListener('click', this.openOfflineConfirmation)
    this.renewButton?.addEventListener('click', this.openRenewalNetworkDialog)
    this.revokeButton?.addEventListener('click', this.openRevokeConfirmation)
    this.cleanups.push(api.onSnapshot(snapshot => this.applySnapshot(snapshot)))
    this.cleanups.push(api.onPairingEvent(event => this.onPairingEvent(event)))
    window.addEventListener('keydown', this.onGlobalKeyDown, true)
    window.addEventListener('pagehide', this.dispose, { once: true })
    void api.getSnapshot().then(snapshot => this.applySnapshot(snapshot)).catch(() => {
      this.setStatus('ERRO DE CONEXÃO', 'Não foi possível ler o estado de pareamento do Main.')
    })
  }

  private applySnapshot(snapshot: RemoteUiSnapshot): void {
    if (snapshot.role !== 'player' || (this.snapshot && snapshot.revision <= this.snapshot.revision)) return
    this.snapshot = snapshot
    if (this.trigger) this.trigger.disabled = snapshot.listener === 'starting' || snapshot.listener === 'advertising'
    if (this.renewButton) this.renewButton.hidden = snapshot.playerPairing !== 'active'
    if (this.revokeButton) this.revokeButton.hidden = snapshot.playerPairing !== 'active'
    if (snapshot.playerPairing === 'recovery_required' || snapshot.playerPairing === 'unavailable') {
      this.setStatus(snapshot.playerPairing === 'recovery_required' ? 'RECUPERAÇÃO NECESSÁRIA' : 'COFRE INDISPONÍVEL',
        snapshot.playerPairing === 'recovery_required'
          ? 'O estado de pareamento exige recuperação local. Playback segue independente.'
          : 'O armazenamento seguro não pôde ser consultado. Nenhum vínculo será presumido.')
    } else if (snapshot.connections.some(connection => connection.deviceRole === 'controller' && connection.state === 'authorized')) {
      this.setStatus('TRANSPORTE AUTENTICADO', 'Uma Gestão salvou está conectada por TLS. A reconciliação e a autorização de negócio são estados separados.')
      if (this.disableButton) this.disableButton.hidden = false
    } else if (snapshot.listener === 'starting') {
      this.setStatus('INICIANDO DESCOBERTA', 'A intenção local foi aceita. O Main está iniciando o listener seguro nesta rede.')
      if (this.disableButton) this.disableButton.hidden = false
    } else if (snapshot.listener === 'advertising') {
      const endpoint = snapshot.listenerEndpoint
      const addressText = endpoint ? ` Endereço local: ${endpoint.address}:${endpoint.port}.` : ''
      this.setStatus(snapshot.playerPairing === 'active' ? 'VÍNCULO SALVO · AGUARDANDO CONEXÃO' : 'DESCOBERTA ATIVA',
        `Aguardando pedidos seguros nesta rede.${addressText} A descoberta não verifica identidade.`)
      if (this.disableButton) this.disableButton.hidden = false
    } else if (snapshot.listener === 'error') {
      this.setStatus('ERRO DE CONEXÃO', snapshot.errorCode ? this.describeError(snapshot.errorCode)
        : 'O listener seguro não está disponível. O Player continua independente.')
    } else if (snapshot.intent === 'offline') {
      this.setStatus('MODO OFFLINE', 'A descoberta está desativada por escolha local explícita.')
      if (this.disableButton) this.disableButton.hidden = true
    } else if (snapshot.errorCode) {
      this.setStatus('ERRO DE CONEXÃO', this.describeError(snapshot.errorCode))
    } else {
      const paired = snapshot.playerPairing === 'active'
      this.setStatus(paired ? 'VÍNCULO SALVO · DESCONECTADO' : snapshot.intent === 'enabled' ? 'DESCOBERTA PERMITIDA · INATIVA' : 'DESCONECTADO',
        paired ? 'O vínculo está salvo, mas nenhum transporte está autenticado agora.' : snapshot.intent === 'enabled'
          ? 'A intenção está salva, mas nenhum listener está ativo. Selecione uma rede para iniciar.'
          : 'Sem vínculo remoto. O Player continua funcionando localmente.')
      if (this.disableButton) this.disableButton.hidden = true
    }
    this.updatePlaybackToast(snapshot)
  }

  private updatePlaybackToast(snapshot: RemoteUiSnapshot): void {
    const authenticated = snapshot.connections.some(connection =>
      connection.deviceRole === 'controller' && connection.state === 'authorized')
    if (snapshot.errorCode) {
      this.playbackToast.dataset.tone = 'warning'
      this.playbackToastCopy.textContent = this.describeError(snapshot.errorCode)
    } else if (snapshot.playerPairing === 'recovery_required') {
      this.playbackToast.dataset.tone = 'warning'
      this.playbackToastCopy.textContent = 'Recuperação local necessária · playback continua independente'
    } else if (authenticated) {
      this.playbackToast.dataset.tone = 'success'
      this.playbackToastCopy.textContent = 'Transporte autenticado · controle de negócio indisponível'
    } else if (snapshot.intent === 'offline') {
      this.playbackToast.dataset.tone = 'warning'
      this.playbackToastCopy.textContent = 'Modo offline confirmado'
    } else if (snapshot.playerPairing === 'active') {
      this.playbackToast.dataset.tone = 'warning'
      this.playbackToastCopy.textContent = 'Vínculo salvo · Gestão desconectada'
    } else if (snapshot.listener === 'starting') {
      this.playbackToast.dataset.tone = 'warning'
      this.playbackToastCopy.textContent = 'Iniciando descoberta segura nesta rede'
    } else if (snapshot.listener === 'advertising') {
      this.playbackToast.dataset.tone = 'warning'
      this.playbackToastCopy.textContent = 'Descoberta local ativa · identidade ainda não verificada'
    } else {
      this.playbackToastCopy.textContent = ''
    }
    this.syncPlaybackToastVisibility()
  }

  private syncPlaybackToastVisibility(): void {
    const idlePanel = document.getElementById('standalone-idle-panel')
    const hasStatus = this.playbackToastCopy.textContent.length > 0
    this.playbackToast.hidden = !hasStatus || !idlePanel?.hidden
  }

  private showActionToast(message: string): void {
    if (this.actionToastTimer !== undefined) window.clearTimeout(this.actionToastTimer)
    this.actionToastCopy.textContent = message
    this.actionToast.hidden = false
    this.actionToastTimer = window.setTimeout(() => {
      this.actionToast.hidden = true
      this.actionToastCopy.textContent = ''
      this.actionToastTimer = undefined
    }, 6000)
  }

  private clearActionToast(): void {
    if (this.actionToastTimer !== undefined) window.clearTimeout(this.actionToastTimer)
    this.actionToastTimer = undefined
    this.actionToastCopy.textContent = ''
    this.actionToast.hidden = true
  }

  private setStatus(label: string, description: string): void {
    if (this.status) this.status.textContent = label
    if (this.description) this.description.textContent = description
  }

  private readonly openNetworkDialog = (): void => { void this.openNetworkDialogFor('pairing') }
  private readonly openRenewalNetworkDialog = (): void => { void this.openNetworkDialogFor('renewal') }

  private async openNetworkDialogFor(mode: 'pairing' | 'renewal'): Promise<void> {
    this.clearActionToast()
    this.focusedBeforeOpen = this.trigger ?? null
    const networks = await this.api.getNetworkInterfaces().catch(() => [])
    this.dialogMode = 'network'
    if (!networks.length) {
      this.resultKind = 'error'
      this.resultText = mode === 'renewal'
        ? 'Nenhuma interface de rede privada está disponível. O certificado atual e o vínculo salvo foram preservados.'
        : 'Nenhuma interface de rede privada disponível. Conecte o Player a uma rede local e tente novamente.'
      this.dialogMode = 'result'
      this.renderResult()
      return
    }
    this.root.innerHTML = `<section class="stop-confirmation-overlay remote-player-overlay" role="dialog" aria-modal="true" aria-labelledby="remote-network-title">
      <div class="stop-confirmation-dialog remote-player-dialog">
        <div class="stop-confirmation-copy"><div class="stop-confirmation-icon" aria-hidden="true">⌁</div><div class="stop-confirmation-text">
          <h1 id="remote-network-title">${mode === 'renewal' ? 'Renovar o vínculo deste Player?' : 'Permitir descoberta nesta rede?'}</h1>
          <p>${mode === 'renewal' ? 'O Player anunciará temporariamente o novo certificado para a Gestão salva. A renovação exige consentimento e verificação OPAQUE.' : 'A Gestão poderá localizar este Player na rede local. A descoberta não cria um vínculo nem concede controle.'}</p>
        </div></div>
        <label class="remote-player-label" for="remote-player-interface">Rede privada</label>
        <select id="remote-player-interface" class="remote-player-select">${networks.map(network => `<option value="${escapeHtml(network.address)}">${escapeHtml(network.label)}</option>`).join('')}</select>
        <p class="remote-player-warning">Você pode desligar a descoberta a qualquer momento. O nome e o anúncio não verificam a identidade do solicitante.</p>
        <div class="stop-confirmation-actions"><button class="stop-confirmation-button confirm" data-action="close">Agora não · Esc</button><button class="stop-confirmation-button cancel" data-action="${mode === 'renewal' ? 'renew' : 'enable'}">${mode === 'renewal' ? 'Continuar na rede' : 'Permitir descoberta'}</button></div>
        <p class="stop-confirmation-status" id="remote-player-action-status" role="status" aria-live="polite" hidden></p>
      </div></section>`
    this.root.querySelector('[data-action="close"]')?.addEventListener('click', this.closeDialog)
    this.root.querySelector('[data-action="enable"]')?.addEventListener('click', this.enableDiscovery)
    this.root.querySelector('[data-action="renew"]')?.addEventListener('click', this.renewCertificate)
    this.installDialogKeyboard()
    this.root.querySelector<HTMLSelectElement>('#remote-player-interface')?.focus()
  }

  private readonly enableDiscovery = async (): Promise<void> => {
    const select = this.root.querySelector<HTMLSelectElement>('#remote-player-interface')
    const submit = this.root.querySelector<HTMLButtonElement>('[data-action="enable"]')
    if (!select || !submit) return
    submit.disabled = true
    const result = this.root.querySelector<HTMLElement>('#remote-player-action-status')
    if (result) { result.hidden = false; result.textContent = 'Iniciando descoberta local…' }
    const reply = await this.api.enableDiscovery(select.value)
    submit.disabled = false
    if (reply.outcome === 'started') {
      this.dialogMode = undefined
      this.root.replaceChildren()
      void this.api.getSnapshot().then(snapshot => this.applySnapshot(snapshot)).catch(() => undefined)
      return
    }
    if (result) result.textContent = this.describeError(reply.code)
    if (result) {
      result.setAttribute('data-error', 'true')
      if (reply.code) result.dataset.errorCode = reply.code
      else delete result.dataset.errorCode
    }
  }

  private readonly openOfflineConfirmation = (): void => {
    this.clearActionToast()
    this.focusedBeforeOpen = this.disableButton ?? null
    this.dialogMode = 'offline'
    this.root.innerHTML = `<section class="stop-confirmation-overlay remote-player-overlay" role="alertdialog" aria-modal="true" aria-labelledby="remote-offline-title">
      <div class="stop-confirmation-dialog remote-player-dialog"><div class="remote-player-eyebrow">REPRODUTOR · MODO PAREADO</div>
        <h1 id="remote-offline-title">Entrar em modo offline?</h1>
        <div class="remote-player-requester"><strong>Conexão remota ativa ou permitida</strong><span>O Player encerrará os canais remotos após confirmar a intenção offline.</span></div>
        <p class="remote-player-copy">Resultados confirmados serão preservados. A reprodução e a sequência local continuam independentes; nenhum comando remoto antigo será executado.</p>
        <p class="remote-player-countdown">Abrir esta janela não pausa a reprodução.</p>
        <div class="stop-confirmation-actions"><button class="stop-confirmation-button confirm" data-action="cancel-offline" data-autofocus>Cancelar · Esc</button><button class="stop-confirmation-button cancel" data-action="confirm-offline">Entrar em modo offline</button></div>
        <p class="stop-confirmation-status" id="remote-offline-status" role="status" aria-live="polite" hidden></p>
      </div></section>`
    this.root.querySelector('[data-action="cancel-offline"]')?.addEventListener('click', this.closeDialog)
    this.root.querySelector('[data-action="confirm-offline"]')?.addEventListener('click', this.disableDiscovery)
    this.installDialogKeyboard()
    this.root.querySelector<HTMLButtonElement>('[data-autofocus]')?.focus()
  }

  private readonly disableDiscovery = async (): Promise<void> => {
    const button = this.root.querySelector<HTMLButtonElement>('[data-action="confirm-offline"]')
    const status = this.root.querySelector<HTMLElement>('#remote-offline-status')
    if (button) button.disabled = true
    let result: import('./remote-ui-contracts').RemoteUiActionReply
    try { result = await this.api.disableDiscovery() }
    catch {
      if (button) button.disabled = false
      if (status) { status.hidden = false; status.textContent = 'Não foi possível confirmar a intenção offline. O estado remoto foi preservado.' }
      return
    }
    if (result.outcome !== 'completed') {
      if (button) button.disabled = false
      if (status) { status.hidden = false; status.textContent = this.describeError(result.code); status.setAttribute('data-error', 'true') }
      return
    }
    this.closeDialog()
    void this.api.getSnapshot().then(snapshot => this.applySnapshot(snapshot)).catch(() => undefined)
  }

  private readonly renewCertificate = async (): Promise<void> => {
    const select = this.root.querySelector<HTMLSelectElement>('#remote-player-interface')
    const submit = this.root.querySelector<HTMLButtonElement>('[data-action="renew"]')
    if (!select || !submit) return
    submit.disabled = true
    const status = this.root.querySelector<HTMLElement>('#remote-player-action-status')
    if (status) { status.hidden = false; status.textContent = 'Preparando a renovação local…' }
    const reply = await this.api.renewCertificate(select.value)
    submit.disabled = false
    if (reply.outcome === 'started') {
      this.dialogMode = undefined
      this.root.replaceChildren()
      void this.api.getSnapshot().then(snapshot => this.applySnapshot(snapshot)).catch(() => undefined)
    } else if (status) {
      status.textContent = this.describeError(reply.code)
      status.setAttribute('data-error', 'true')
    }
  }

  private readonly openRevokeConfirmation = (): void => {
    this.clearActionToast()
    this.focusedBeforeOpen = this.revokeButton ?? null
    this.dialogMode = 'result'
    this.root.innerHTML = `<section class="stop-confirmation-overlay remote-player-overlay" role="alertdialog" aria-modal="true" aria-labelledby="remote-revoke-title">
      <div class="stop-confirmation-dialog remote-player-dialog"><div class="remote-player-eyebrow">VÍNCULO SALVO</div>
        <h1 id="remote-revoke-title">Revogar acesso deste Player?</h1>
        <p>Esta ação revoga o vínculo localmente no Player e fecha os canais autenticados. A Gestão será desconectada. O Player continuará funcionando.</p>
        <p class="remote-player-warning">A revogação será persistida antes da confirmação visual. Journals e dados de playback são preservados.</p>
        <div class="stop-confirmation-actions"><button class="stop-confirmation-button confirm" data-action="cancel-revoke" data-autofocus>Cancelar · Esc</button><button class="stop-confirmation-button cancel" data-action="confirm-revoke">Revogar vínculo</button></div>
        <p class="stop-confirmation-status" id="remote-player-action-status" role="status" aria-live="polite" hidden></p>
      </div></section>`
    this.root.querySelector('[data-action="cancel-revoke"]')?.addEventListener('click', this.closeDialog)
    this.root.querySelector('[data-action="confirm-revoke"]')?.addEventListener('click', this.confirmRevokePairing)
    this.installDialogKeyboard()
    this.root.querySelector<HTMLButtonElement>('[data-autofocus]')?.focus()
  }

  private readonly confirmRevokePairing = async (): Promise<void> => {
    const button = this.root.querySelector<HTMLButtonElement>('[data-action="confirm-revoke"]')
    const status = this.root.querySelector<HTMLElement>('#remote-player-action-status')
    if (!button) return
    button.disabled = true
    const result = await this.api.revokePairing()
    if (result.outcome === 'completed') {
      this.dialogMode = undefined
      this.root.replaceChildren()
      void this.api.getSnapshot().then(snapshot => this.applySnapshot(snapshot)).catch(() => undefined)
      this.showActionToast('Vínculo revogado localmente. O Player continua funcionando.')
      this.focusedBeforeOpen?.focus()
    } else {
      button.disabled = false
      if (status) { status.hidden = false; status.textContent = this.describeError(result.code); status.setAttribute('data-error', 'true') }
    }
  }

  private readonly onPairingEvent = (event: PlayerPairingUiEvent): void => {
    const cursor = advancePairingUiEventCursor(this.pairingEventCursor, event, event.type === 'closed')
    if (!cursor) return
    this.pairingEventCursor = cursor
    this.clearResultTimer()
    if (event.type === 'consent-request') {
      this.request = { requestId: event.requestId, revision: event.revision }
      this.consentSubmitting = false
      this.remainingMs = event.remainingMs
      this.startedAt = performance.now()
      this.dialogMode = 'consent'
      this.root.innerHTML = `<section class="stop-confirmation-overlay remote-player-overlay" role="dialog" aria-modal="true" aria-labelledby="remote-consent-title">
        <div class="stop-confirmation-dialog remote-player-dialog"><div class="remote-player-eyebrow">PEDIDO DE VÍNCULO · ${event.purpose === 'renewal' ? 'RENOVAÇÃO' : 'INICIAL'}</div>
          <h1 id="remote-consent-title">Permitir esta Gestão?</h1>
          <div class="remote-player-requester"><strong>${escapeHtml(event.displayName)}</strong><span>Nome informado · ainda não verificado</span></div>
          <p class="remote-player-copy">Só permita se você iniciou o pareamento nesta Gestão. A confirmação criptográfica verificará a identidade depois.</p>
          <p class="remote-player-countdown" role="status" aria-live="polite"></p>
          <div class="stop-confirmation-actions"><button class="stop-confirmation-button confirm" data-action="reject" data-autofocus>Rejeitar · Esc</button><button class="stop-confirmation-button cancel" data-action="accept">Permitir neste Player</button></div>
        </div></section>`
      this.root.querySelector('[data-action="reject"]')?.addEventListener('click', () => void this.answerConsent(false))
      this.root.querySelector('[data-action="accept"]')?.addEventListener('click', () => void this.answerConsent(true))
      this.installDialogKeyboard()
      this.root.querySelector<HTMLButtonElement>('[data-action="reject"]')?.focus()
      this.updateCountdown()
      return
    }
    if (event.type === 'temporary-code') {
      if (this.request && (event.requestId !== this.request.requestId || event.revision !== this.request.revision)) return
      this.request = { requestId: event.requestId, revision: event.revision }
      this.consentSubmitting = false
      this.remainingMs = event.remainingMs
      this.startedAt = performance.now()
      this.dialogMode = 'code'
      this.root.innerHTML = `<section class="stop-confirmation-overlay remote-player-overlay" role="dialog" aria-modal="true" aria-labelledby="remote-code-title">
        <div class="stop-confirmation-dialog remote-player-dialog remote-player-code-dialog"><div class="remote-player-eyebrow">DIGITE ESTE CÓDIGO NA GESTÃO</div>
          <h1 id="remote-code-title">Confirme o pareamento</h1><p>Este código é temporário. Mostrá-lo aqui não identifica a Gestão; a verificação segura acontece em seguida.</p>
          <div class="remote-player-temporary-code" aria-label="Código temporário de oito dígitos"></div>
          <p class="remote-player-countdown" role="status" aria-live="polite"></p>
          <div class="stop-confirmation-actions"><button class="stop-confirmation-button confirm" data-action="cancel" data-autofocus>Cancelar solicitação · Esc</button></div>
        </div></section>`
      const code = this.root.querySelector<HTMLElement>('.remote-player-temporary-code')
      if (code) code.textContent = event.groupedCode
      this.root.querySelector('[data-action="cancel"]')?.addEventListener('click', () => void this.cancelPairing())
      this.installDialogKeyboard()
      this.root.querySelector<HTMLButtonElement>('[data-action="cancel"]')?.focus()
      this.updateCountdown()
      return
    }
    this.clearCountdown()
    this.request = undefined
    this.consentSubmitting = false
    const outcomes = {
      rejected: ['Pedido recusado', 'O pedido de pareamento foi rejeitado neste Player. Nenhum código temporário foi emitido.', 'warning'],
      cancelled: ['Pareamento cancelado', 'A solicitação foi cancelada. Uma gravação durável não é desfeita automaticamente.', 'warning'],
      'timed-out': ['Esta solicitação expirou', 'O código temporário foi removido e não pode ser reutilizado.', 'error'],
      active: ['Vínculo confirmado', 'A Gestão salvou o vínculo e está reconciliando o estado técnico. Nenhuma música foi iniciada.', 'success'],
      error: ['Não foi possível concluir o pareamento', 'O estado de segurança foi preservado. Consulte a Gestão antes de iniciar outra solicitação.', 'error']
    } as const
    const [title, message, kind] = outcomes[event.outcome]
    this.resultKind = kind
    this.resultText = message
    this.dialogMode = 'result'
    this.renderResult(title)
  }

  private readonly answerConsent = async (accepted: boolean): Promise<void> => {
    const request = this.request
    if (!request || this.consentSubmitting || this.dialogMode !== 'consent') return
    this.consentSubmitting = true
    const resolved = await this.api.answerConsent(request.requestId, request.revision, accepted)
    const current = this.request
    const isCurrent = current?.requestId === request.requestId && current.revision === request.revision
    if (!resolved) {
      if (!isCurrent || this.dialogMode !== 'consent') return
      this.consentSubmitting = false
      this.resultKind = 'error'
      this.resultText = 'A solicitação expirou ou mudou. O Main rejeitou esta resposta tardia.'
      this.dialogMode = 'result'
      this.renderResult()
    } else if (!accepted) {
      if (!isCurrent || this.dialogMode !== 'consent') return
      this.consentSubmitting = false
      this.dialogMode = undefined
      this.root.replaceChildren()
      this.request = undefined
      this.focusedBeforeOpen?.focus()
    }
    // On acceptance, keep the consent overlay until G2 publishes the next real
    // state. The temporary-code event can arrive before this IPC reply resolves.
  }

  private readonly cancelPairing = async (): Promise<void> => {
    const request = this.request
    if (!request) return
    const reply = await this.api.cancelPairing(request.requestId, request.revision)
    if (reply.outcome === 'failed') {
      this.resultKind = 'warning'
      this.resultText = 'O resultado pode ser incerto. O Player preservará as provas para recuperação.'
      this.dialogMode = 'result'
      this.renderResult()
    }
  }

  private renderResult(title = this.resultKind === 'success' ? 'Vínculo confirmado'
    : this.resultKind === 'warning' ? 'Solicitação encerrada' : 'Não foi possível concluir') : void {
    const className = `remote-player-result remote-player-result--${this.resultKind}`
    this.root.innerHTML = `<section class="stop-confirmation-overlay remote-player-overlay" role="alertdialog" aria-modal="true" aria-labelledby="remote-result-title">
      <div class="stop-confirmation-dialog remote-player-dialog"><div class="remote-player-eyebrow">PAREAMENTO SEGURO</div>
        <h1 id="remote-result-title">${escapeHtml(title)}</h1><p class="${className}">${escapeHtml(this.resultText)}</p>
        <div class="stop-confirmation-actions"><button class="stop-confirmation-button cancel" data-action="close" data-autofocus>Fechar · Enter</button></div>
      </div></section>`
    this.root.querySelector('[data-action="close"]')?.addEventListener('click', this.closeDialog)
    this.dialogMode = 'result'
    this.installDialogKeyboard()
    this.root.querySelector<HTMLButtonElement>('[data-action="close"]')?.focus()
    if (this.resultKind === 'success') this.resultTimer = window.setTimeout(() => {
      if (this.dialogMode === 'result') this.closeDialog()
    }, 4500)
  }

  private updateCountdown(): void {
    if (this.dialogMode !== 'consent' && this.dialogMode !== 'code') { this.clearCountdown(); return }
    const remaining = Math.max(0, this.remainingMs - (performance.now() - this.startedAt))
    const label = this.root.querySelector<HTMLElement>('.remote-player-countdown')
    if (label) label.textContent = `Expira em ${Math.ceil(remaining / 1000)}s · prazo validado pelo Player`
    if (remaining <= 0) {
      const code = this.root.querySelector<HTMLElement>('.remote-player-temporary-code')
      if (code) code.textContent = ''
      this.resultKind = 'warning'
      this.resultText = 'O prazo visual terminou. O Player encerrará a sessão conforme o deadline G2.'
      this.dialogMode = 'result'
      this.renderResult('Solicitação expirada')
      return
    }
    this.countdownTimer = window.setTimeout(() => this.updateCountdown(), 250)
  }

  private clearCountdown(): void {
    if (this.countdownTimer !== undefined) window.clearTimeout(this.countdownTimer)
    this.countdownTimer = undefined
  }

  private clearResultTimer(): void {
    if (this.resultTimer !== undefined) window.clearTimeout(this.resultTimer)
    this.resultTimer = undefined
  }

  private installDialogKeyboard(): void {
    const overlay = this.root.querySelector<HTMLElement>('[role="dialog"], [role="alertdialog"]')
    if (overlay) overlay.dataset.remotePairingDialog = 'true'
  }

  /** Installed in capture phase so Player music hotkeys never receive dialog keystrokes. */
  private readonly onGlobalKeyDown = (event: KeyboardEvent): void => {
    if (!this.dialogMode) return
    const overlay = this.root.querySelector<HTMLElement>('[data-remote-pairing-dialog="true"]')
    if (!overlay) return
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopImmediatePropagation()
      if (this.dialogMode === 'consent') void this.answerConsent(false)
      else if (this.dialogMode === 'code') void this.cancelPairing()
      else this.closeDialog()
      return
    }
    if (event.key === 'Tab') {
      event.stopImmediatePropagation()
      const controls = [...overlay.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled)')]
      if (!controls.length) { event.preventDefault(); return }
      const first = controls[0]!, last = controls[controls.length - 1]!
      if (!overlay.contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first).focus() }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
      return
    }
    event.stopImmediatePropagation()
    const target = event.target
    const isControl = target instanceof HTMLInputElement || target instanceof HTMLSelectElement ||
      target instanceof HTMLButtonElement
    if (!isControl) event.preventDefault()
  }

  private readonly closeDialog = (): void => {
    this.clearCountdown()
    this.clearResultTimer()
    this.root.replaceChildren()
    this.dialogMode = undefined
    this.request = undefined
    this.focusedBeforeOpen?.focus()
  }

  private describeError(code?: string): string {
    return describePlayerPairingError(code)
  }

  private readonly dispose = (): void => {
    this.trigger?.removeEventListener('click', this.openNetworkDialog)
    this.disableButton?.removeEventListener('click', this.openOfflineConfirmation)
    this.renewButton?.removeEventListener('click', this.openRenewalNetworkDialog)
    this.revokeButton?.removeEventListener('click', this.openRevokeConfirmation)
    this.cleanups.splice(0).forEach(cleanup => cleanup())
    window.removeEventListener('keydown', this.onGlobalKeyDown, true)
    this.playbackToastObserver?.disconnect()
    this.playbackToastObserver = undefined
    this.clearActionToast()
    this.clearCountdown()
    this.clearResultTimer()
    this.root.remove()
    this.playbackToast.remove()
    this.actionToast.remove()
  }
}
