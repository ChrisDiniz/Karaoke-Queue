import { getElement } from './dom'
import type { UiScalePreference, UiScaleState } from './ui-scale'
import {
  countVisibleCharacters,
  DEFAULT_SIDEBAR_DISPLAY_NAME,
  normalizeSidebarDisplayName,
  sanitizeSidebarDisplayNameInput
} from './sidebar-display-name'

/** Settings presentation and local UI feedback; Electron remains the scale source of truth. */
export class SettingsView {
  private bound = false
  private unsubscribe: (() => void) | undefined

  bind(): void {
    if (this.bound) return
    this.bound = true
    this.bindSidebarDisplayName()
    const bridge = window.karaokeUiScale
    if (!bridge) {
      this.showError('Não foi possível carregar as preferências de escala.')
      return
    }

    this.unsubscribe = bridge.onChanged(state => this.renderScaleState(state))
    const openLogsButton = document.getElementById('settings-open-logs') as HTMLButtonElement | null
    openLogsButton?.addEventListener('click', async () => {
      const diagnostics = window.karaokeDiagnostics
      const status = document.getElementById('settings-diagnostics-status')
      if (!diagnostics || !openLogsButton) return
      openLogsButton.disabled = true
      if (status) status.textContent = ''
      try {
        const result = await diagnostics.openLogsFolder()
        if (status) status.textContent = result.ok
          ? 'Pasta de logs aberta.'
          : `Não foi possível abrir a pasta de logs${result.error ? `: ${result.error}` : '.'}`
      } catch {
        if (status) status.textContent = 'Não foi possível abrir a pasta de logs.'
      } finally {
        openLogsButton.disabled = false
      }
    })
    getElement<HTMLSelectElement>('settings-scale-select').addEventListener('change', async event => {
      const select = event.currentTarget as HTMLSelectElement
      const preference = select.value as UiScalePreference
      select.disabled = true
      this.showError('')
      try {
        const state = await bridge.setPreference(preference)
        this.renderScaleState(state)
      } catch {
        this.showError('Não foi possível salvar a escala. A preferência anterior foi mantida.')
        try { this.renderScaleState(await bridge.getState()) } catch { /* keep the visible fallback */ }
      } finally {
        select.disabled = false
      }
    })

    void bridge.getState().then(state => this.renderScaleState(state)).catch(() => {
      this.showError('Não foi possível carregar as preferências de escala.')
    })
  }

  open(): void {
    getElement('dashboard-page').classList.add('hidden')
    getElement('history-panel').classList.add('hidden')
    getElement('settings-page').classList.remove('hidden')
  }

  close(): void {
    getElement('settings-page').classList.add('hidden')
    getElement('dashboard-page').classList.remove('hidden')
  }

  private renderScaleState(state: UiScaleState): void {
    getElement<HTMLSelectElement>('settings-scale-select').value = state.preference
    getElement('settings-scale-effective').textContent = `${Math.round(state.effectiveFactor * 100)}%`
  }

  private showError(message: string): void {
    const element = getElement('settings-scale-error')
    element.textContent = message
    element.hidden = !message
  }

  private bindSidebarDisplayName(): void {
    const input = document.getElementById('settings-sidebar-name') as HTMLInputElement | null
    const counter = document.getElementById('settings-sidebar-name-count')
    const status = document.getElementById('settings-sidebar-name-status')
    const saveButton = document.getElementById('settings-sidebar-name-save') as HTMLButtonElement | null
    const resetButton = document.getElementById('settings-sidebar-name-reset') as HTMLButtonElement | null
    const preferences = window.karaokePreferences
    if (!input || !counter || !status || !saveButton || !resetButton) return
    let inputEdited = false

    const renderCount = () => {
      counter.textContent = `${countVisibleCharacters(input.value)}/17`
    }
    const updateSidebar = (name: string) => {
      const brand = document.querySelector<HTMLElement>('.sidebar-brand-name')
      if (!brand) return
      brand.textContent = name
      brand.title = name
    }
    const sanitizeInput = () => {
      const start = input.selectionStart ?? input.value.length
      const next = sanitizeSidebarDisplayNameInput(input.value)
      if (input.value !== next) {
        input.value = next
        const caret = Math.min(start, next.length)
        input.setSelectionRange(caret, caret)
      }
      renderCount()
      status.textContent = ''
    }
    const persist = async (name: string, successMessage: string) => {
      if (!preferences) {
        status.textContent = 'Não foi possível salvar as preferências.'
        return
      }
      saveButton.disabled = true
      resetButton.disabled = true
      status.textContent = ''
      try {
        const savedName = await preferences.setSidebarDisplayName(name)
        input.value = savedName
        renderCount()
        updateSidebar(savedName)
        status.textContent = successMessage
      } catch {
        status.textContent = 'Não foi possível salvar o nome. A preferência anterior foi mantida.'
      } finally {
        saveButton.disabled = false
        resetButton.disabled = false
      }
    }

    input.addEventListener('input', event => {
      inputEdited = true
      if ((event as InputEvent).isComposing) return
      sanitizeInput()
    })
    input.addEventListener('compositionend', () => {
      inputEdited = true
      sanitizeInput()
    })
    saveButton.addEventListener('click', () => {
      const name = normalizeSidebarDisplayName(input.value)
      if (!name) {
        status.textContent = 'Digite um nome antes de salvar.'
        input.focus()
        return
      }
      void persist(name, 'Nome salvo.')
    })
    resetButton.addEventListener('click', () => {
      void persist(DEFAULT_SIDEBAR_DISPLAY_NAME, 'Nome padrão restaurado.')
    })

    if (!preferences) {
      status.textContent = 'Não foi possível carregar as preferências do menu.'
      return
    }
    void preferences.getSidebarDisplayName().then(name => {
      updateSidebar(name)
      if (!inputEdited) {
        input.value = name
        renderCount()
      }
    }).catch(() => {
      updateSidebar(DEFAULT_SIDEBAR_DISPLAY_NAME)
      if (!inputEdited) {
        input.value = DEFAULT_SIDEBAR_DISPLAY_NAME
        renderCount()
      }
      status.textContent = 'Não foi possível carregar o nome salvo.'
    })
  }
}
