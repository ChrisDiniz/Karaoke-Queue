import type { OperatingMode } from './operating-mode'

declare global {
  interface Window {
    karaokeWelcome?: {
      getState(): Promise<{ page: 'mode' | 'setup'; role: OperatingMode | null; libraryRoot: string | null }>
      chooseMode(mode: OperatingMode): Promise<{ page: 'setup'; role: OperatingMode }>
      chooseLibrary(): Promise<{ cancelled: true } | { cancelled: false; path: string }>
      chooseCatalog(): Promise<{ cancelled: true } | { cancelled: false; path: string }>
      completeSetup(selection: { libraryRoot?: string; catalogFile?: string }): Promise<{ completed: true }>
    }
  }
}

const modePage = document.querySelector<HTMLElement>('#welcome-mode-page')!
const setupPage = document.querySelector<HTMLElement>('#welcome-setup-page')!
const cards = [...document.querySelectorAll<HTMLButtonElement>('.mode-card')]
const continueButton = document.querySelector<HTMLButtonElement>('#welcome-continue')!
const errorText = document.querySelector<HTMLElement>('#welcome-error')!
const libraryChooseButton = document.querySelector<HTMLButtonElement>('#welcome-library-choose')!
const catalogChooseButton = document.querySelector<HTMLButtonElement>('#welcome-catalog-choose')!
const libraryValue = document.querySelector<HTMLElement>('#welcome-library-value')!
const catalogValue = document.querySelector<HTMLElement>('#welcome-catalog-value')!
const setupContinueButton = document.querySelector<HTMLButtonElement>('#welcome-setup-continue')!
const configureLaterButton = document.querySelector<HTMLButtonElement>('#welcome-configure-later')!
const setupErrorText = document.querySelector<HTMLElement>('#welcome-setup-error')!
let selectedMode: OperatingMode | undefined
let submitting = false
let setupSubmitting = false
let selectedLibraryRoot: string | undefined
let selectedCatalogFile: string | undefined

function setPage(page: 'mode' | 'setup'): void {
  modePage.hidden = page !== 'mode'
  setupPage.hidden = page !== 'setup'
}

function updateSetupContinue(): void {
  setupContinueButton.disabled = setupSubmitting || (!selectedLibraryRoot && !selectedCatalogFile)
}

function setSelectedValue(element: HTMLElement, text: string, accessibleLabel: string): void {
  const label = element.querySelector('span')
  if (label) label.textContent = text
  element.setAttribute('aria-label', accessibleLabel)
  element.title = text
}

function showSetupError(message: string): void {
  setupErrorText.textContent = message
  setupErrorText.hidden = false
}

async function loadWelcomeState(): Promise<void> {
  try {
    if (!window.karaokeWelcome) throw new Error('A configuração inicial não está disponível.')
    const state = await window.karaokeWelcome.getState()
    setPage(state.page)
    selectedLibraryRoot = state.libraryRoot ?? undefined
    if (selectedLibraryRoot) setSelectedValue(libraryValue, selectedLibraryRoot, `Pasta dos vídeos: ${selectedLibraryRoot}`)
    updateSetupContinue()
  } catch {
    setPage('mode')
    errorText.textContent = 'Não foi possível validar a configuração inicial. Os dados foram preservados.'
    errorText.hidden = false
    continueButton.disabled = true
  }
}

function selectCard(card: HTMLButtonElement): void {
  const mode = card.dataset.mode
  if (mode !== 'player' && mode !== 'combined') return
  selectedMode = mode
  for (const item of cards) {
    const selected = item === card
    item.setAttribute('aria-checked', String(selected))
    item.tabIndex = selected ? 0 : -1
    item.classList.toggle('is-selected', selected)
  }
  continueButton.disabled = submitting || !selectedMode
}

for (const [index, card] of cards.entries()) {
  card.tabIndex = index === 0 ? 0 : -1
  card.addEventListener('click', () => selectCard(card))
  card.addEventListener('keydown', event => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowRight' &&
        event.key !== 'ArrowUp' && event.key !== 'ArrowLeft') return
    event.preventDefault()
    const direction = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1
    const nextIndex = (index + direction + cards.length) % cards.length
    cards[nextIndex].focus()
    selectCard(cards[nextIndex])
  })
}

continueButton.addEventListener('click', async () => {
  if (!selectedMode || submitting) return
  submitting = true
  continueButton.disabled = true
  errorText.hidden = true
  try {
    if (!window.karaokeWelcome) throw new Error('A configuração inicial não está disponível.')
    const result = await window.karaokeWelcome.chooseMode(selectedMode)
    if (result?.page === 'setup') {
      setPage('setup')
      setupErrorText.hidden = true
      updateSetupContinue()
    }
  } catch {
    submitting = false
    continueButton.disabled = false
    errorText.textContent = 'Não foi possível salvar o modo. O estado atual foi preservado; tente novamente.'
    errorText.hidden = false
  }
})

libraryChooseButton.addEventListener('click', async () => {
  if (setupSubmitting || !window.karaokeWelcome) return
  libraryChooseButton.disabled = true
  setupErrorText.hidden = true
  try {
    const result = await window.karaokeWelcome.chooseLibrary()
    if (!result.cancelled) {
      selectedLibraryRoot = result.path
      setSelectedValue(libraryValue, result.path, `Pasta dos vídeos: ${result.path}`)
    }
  } catch {
    showSetupError('Não foi possível acessar essa pasta. Escolha uma pasta disponível ou configure a biblioteca depois.')
  } finally { libraryChooseButton.disabled = false; updateSetupContinue() }
})

catalogChooseButton.addEventListener('click', async () => {
  if (setupSubmitting || !window.karaokeWelcome) return
  catalogChooseButton.disabled = true
  setupErrorText.hidden = true
  try {
    const result = await window.karaokeWelcome.chooseCatalog()
    if (!result.cancelled) {
      selectedCatalogFile = result.path
      setSelectedValue(catalogValue, result.path, `Arquivo CSV: ${result.path}`)
    }
  } catch {
    showSetupError('Não foi possível selecionar o catálogo. Você pode escolher outro arquivo ou continuar sem catálogo.')
  } finally { catalogChooseButton.disabled = false; updateSetupContinue() }
})

async function completeSetup(configureLater: boolean): Promise<void> {
  if (setupSubmitting || !window.karaokeWelcome) return
  if (!configureLater && !selectedLibraryRoot && !selectedCatalogFile) return
  setupSubmitting = true
  setupContinueButton.disabled = true
  configureLaterButton.disabled = true
  libraryChooseButton.disabled = true
  catalogChooseButton.disabled = true
  setupErrorText.hidden = true
  try {
    // Deferring setup is an explicit empty selection. In particular, do not retry a
    // selected path that just failed validation/import when the optional setup is skipped.
    await window.karaokeWelcome.completeSetup(configureLater ? {} : {
      ...(selectedLibraryRoot ? { libraryRoot: selectedLibraryRoot } : {}),
      ...(selectedCatalogFile ? { catalogFile: selectedCatalogFile } : {})
    })
  } catch {
    showSetupError('Não foi possível salvar a configuração. O que já foi confirmado foi preservado; corrija o item e tente novamente.')
    setupSubmitting = false
    configureLaterButton.disabled = false
    libraryChooseButton.disabled = false
    catalogChooseButton.disabled = false
    updateSetupContinue()
  }
}

setupContinueButton.addEventListener('click', () => { void completeSetup(false) })
configureLaterButton.addEventListener('click', () => { void completeSetup(true) })

void loadWelcomeState()
