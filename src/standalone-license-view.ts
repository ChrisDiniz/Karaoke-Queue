import { trialLabel, type LicenseStatus } from './licensing'

/** Uses the same restricted Main service/file as Management, never its own license. */
export class StandaloneLicenseView {
  private status: LicenseStatus | undefined
  private available = false
  private busy = false
  private generation = 0
  private readonly api = window.karaokeLicense
  private readonly controls = document.getElementById('standalone-license-controls')!
  private readonly modal = document.getElementById('standalone-license-modal')!
  private readonly input = document.getElementById('standalone-license-code') as HTMLInputElement
  private readonly error = document.getElementById('standalone-license-error')!
  private readonly openButton = document.getElementById('standalone-license-open') as HTMLButtonElement
  private readonly cancelButton = document.getElementById('standalone-license-cancel') as HTMLButtonElement
  private readonly submitButton = document.getElementById('standalone-license-submit') as HTMLButtonElement
  private readonly timer: ReturnType<typeof setInterval>

  constructor() {
    this.openButton.addEventListener('click', () => {
      if (!this.available || this.status?.activated) return
      this.modal.hidden = false
      this.error.textContent = ''
      this.input.focus()
    })
    this.cancelButton.addEventListener('click', () => this.close())
    document.getElementById('standalone-license-form')!.addEventListener('submit', event => {
      event.preventDefault()
      void this.activate()
    })
    this.timer = setInterval(() => { void this.refresh() }, 60_000)
    void this.refresh()
  }

  setAvailable(available: boolean): void {
    this.available = available
    if (!available) { this.modal.hidden = true; this.input.value = '' }
    this.render()
  }

  /** Consume modal keyboard events before the music-code shortcuts. */
  handleKeyDown(event: KeyboardEvent): boolean {
    if (this.modal.hidden) {
      if (event.target === this.openButton && (event.key === 'Enter' || event.key === ' ')) {
        // Retain native button activation; these keys must not become song commands.
        event.stopImmediatePropagation()
        return true
      }
      return false
    }
    event.stopImmediatePropagation()
    if (event.key === 'Escape') { event.preventDefault(); this.close() }
    if (event.key === 'Tab') {
      event.preventDefault()
      const controls = [this.input, this.cancelButton, this.submitButton].filter(control => !control.disabled)
      if (!controls.length) return true
      const index = controls.indexOf(document.activeElement as HTMLInputElement)
      controls[(index + (event.shiftKey ? controls.length - 1 : 1)) % controls.length]!.focus()
    }
    return true
  }

  private close(): void {
    if (this.busy) return
    this.modal.hidden = true
    this.input.value = ''
    if (!this.controls.hidden) this.openButton.focus()
    else document.body.focus()
  }

  private render(): void {
    this.controls.hidden = !this.api || !this.available || this.status?.activated === true
    document.getElementById('standalone-license-label')!.textContent = this.status ? trialLabel(this.status) : 'Licença indisponível'
  }

  private async refresh(): Promise<void> {
    if (!this.api || this.busy) return
    const generation = ++this.generation
    try {
      const status = await this.api.getStatus()
      if (generation !== this.generation) return
      this.status = status
      if (status.activated) { this.modal.hidden = true; this.input.value = '' }
      this.render()
    } catch { /* A read failure cannot replace the confirmed license state. */ }
  }

  private async activate(): Promise<void> {
    if (!this.api || !this.available || this.busy || this.modal.hidden) return
    this.busy = true
    ++this.generation // Ignore any status read started before this activation.
    this.input.disabled = this.cancelButton.disabled = this.submitButton.disabled = true
    this.error.textContent = ''
    try {
      this.status = await this.api.activate(this.input.value)
      this.input.value = ''
      this.modal.hidden = true
      this.render()
      document.body.focus()
    } catch (error) {
      this.error.textContent = error instanceof Error && error.message.includes('INVALID_ACTIVATION_TOKEN')
        ? 'Token de ativação inválido.' : 'Não foi possível confirmar a ativação. Tente novamente.'
    } finally {
      this.busy = false
      this.input.disabled = this.cancelButton.disabled = this.submitButton.disabled = false
      if (!this.modal.hidden) this.input.focus()
    }
  }

  dispose(): void { ++this.generation; clearInterval(this.timer) }
}
