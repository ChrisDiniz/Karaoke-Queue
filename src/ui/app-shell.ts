import type { KaraokeApplication, ReadonlyAppState } from '../application'
import { getElement, getInput, ModalManager, showToast, reportPersistenceFailure } from './dom'
import { trialLabel } from '../licensing'

export class AppShell {
  private licenseStatus: LicenseStatus | null = null
  private refreshTimer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly application: KaraokeApplication,
    private readonly getState: () => ReadonlyAppState,
    private readonly modals: ModalManager,
    private readonly startNewShift: () => boolean | Promise<boolean>,
    private readonly onResumeSession?: () => void
  ) {}

  bind(): void {
    getElement('license-form').addEventListener('submit', event => {
      event.preventDefault()
      this.activateLicense(getInput('license-code').value)
    })
    getElement('btn-license-open').addEventListener('click', () => this.showLicenseModal())
    getElement('btn-license-cancel').addEventListener('click', () => {
      if (!this.licenseStatus?.expired) this.modals.hide('license-modal')
    })
    this.refreshTimer = setInterval(() => { void this.refreshLicense() }, 60000)
    this.bindTheme()
    getElement('btn-notifications').addEventListener('click', () => showToast('Notificações em breve'))
  }

  async initializeLicense(): Promise<LicenseStatus> {
    if (!window.karaokeLicense) throw new Error('The main-process license service is unavailable.')
    const status = await window.karaokeLicense.getStatus()
    this.applyLicenseStatus(status)
    return status
  }

  get isLicenseExpired(): boolean { return this.licenseStatus?.expired === true }

  showStartupOrLicense(skipSessionPrompt = false): void {
    if (!this.licenseStatus?.expired) {
      if (!skipSessionPrompt) this.showStartupDialog()
    }
    else this.showLicenseModal()
  }

  updateSessionStartInfo(): void {
    const element = document.getElementById('session-start-info')
    if (!element) return
    const session = this.getState().sessions.find(item => item.id === this.getState().currentSessionId)
    if (!session) { element.textContent = ''; return }
    const time = new Date(session.startedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    const date = new Date(session.startedAt).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })
    element.textContent = `Iniciado ${date} às ${time}`
  }

  private async showStartupDialog(): Promise<void> {
    const state = this.getState()
    if (state.sessions.length === 0) {
      await this.application.ensureSession()
      return
    }
    const lastSession = state.sessions[state.sessions.length - 1]
    if (lastSession.endedAt) return
    const startStr = new Date(lastSession.startedAt).toLocaleString('pt-BR', {
      day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
    })
    const mins = Math.floor((Date.now() - lastSession.startedAt) / 60000)
    const hours = Math.floor(mins / 60)
    const rest = mins % 60
    const running = hours > 0 ? `${hours}h ${rest}min` : `${mins}min`
    getElement('startup-message').textContent = 'Sessão em andamento'
    getElement('startup-detail').textContent = `Iniciado em ${startStr}`
    getElement('startup-running').textContent = `há ${running}`
    const primary = getElement('btn-startup-primary')
    const secondary = getElement('btn-startup-secondary')
    primary.textContent = 'Continuar sessão'
    secondary.textContent = 'Nova sessão'
    primary.onclick = () => {
      this.onResumeSession?.()
      this.closeStartupModal()
      document.getElementById('input-table')?.focus()
    }
    secondary.onclick = async () => {
      if (await this.startNewShift()) {
        this.closeStartupModal()
        document.getElementById('input-table')?.focus()
      }
    }
    this.modals.show('startup-modal')
  }

  private closeStartupModal(): void { this.modals.hide('startup-modal') }

  private applyLicenseStatus(status: LicenseStatus): void {
    this.licenseStatus = status
    const controls = getElement('license-trial-controls')
    controls.classList.toggle('hidden', status.activated)
    if (!status.activated) {
      const badge = getElement('license-trial-badge')
      getElement('license-trial-label').textContent = trialLabel(status)
      badge.classList.toggle('trial-near-expiry', !status.expired && status.remainingMs <= 3 * 24 * 60 * 60 * 1000)
      badge.classList.toggle('trial-expired', status.expired)
    }
    getElement('license-lock-message').classList.toggle('hidden', !status.expired)
    getElement('btn-license-cancel').classList.toggle('hidden', status.expired)
    if (status.expired && !getElement('license-modal').classList.contains('hidden')) {
      getElement('license-lock-message').classList.remove('hidden')
    }
  }

  private showLicenseModal(): void {
    this.modals.show('license-modal')
    getElement('license-lock-message').classList.toggle('hidden', !this.licenseStatus?.expired)
    getElement('btn-license-cancel').classList.toggle('hidden', Boolean(this.licenseStatus?.expired))
    getInput('license-code').focus()
  }

  private async refreshLicense(): Promise<void> {
    try {
      const status = await window.karaokeLicense?.getStatus()
      if (!status) return
      const wasExpired = this.licenseStatus?.expired
      this.applyLicenseStatus(status)
      if (status.expired && !wasExpired) this.showLicenseModal()
    } catch { /* A transient status read cannot change the confirmed license state. */ }
  }

  private async activateLicense(code: string): Promise<void> {
    const error = getElement('license-error')
    try {
      const status = await window.karaokeLicense!.activate(code)
      this.applyLicenseStatus(status)
      this.modals.hide('license-modal')
      error.textContent = ''
      getInput('license-code').value = ''
    } catch (failure) {
      if (failure instanceof Error && failure.message.includes('INVALID_ACTIVATION_TOKEN')) {
        error.textContent = 'Token de ativação inválido.'
        return
      }
      reportPersistenceFailure(failure)
    }
  }

  private bindTheme(): void {
    const toggle = getElement('btn-theme-toggle')
    let currentTheme = localStorage.getItem('kshake_theme') || 'dark'
    const apply = (theme: string) => {
      document.documentElement.setAttribute('data-theme', theme)
      getElement('theme-toggle-icon').innerHTML = theme === 'dark'
        ? '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42"/></svg>'
        : '<svg viewBox="0 0 24 24"><path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.463.402.807a6.5 6.5 0 0 0 8.268 8.268c.344-.215.829-.003.803.397Z"/></svg>'
      currentTheme = theme
      localStorage.setItem('kshake_theme', theme)
    }
    apply(currentTheme)
    toggle.addEventListener('click', () => apply(currentTheme === 'dark' ? 'light' : 'dark'))
  }
}
