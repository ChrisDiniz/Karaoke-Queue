import type { MusicCatalogImportPreparation } from './music-catalog-service'
import type { MusicCatalogImportIssue } from './music-catalog'
import type { WelcomeMediaSetup } from './welcome-media-setup'
type WelcomeMediaState = ReturnType<WelcomeMediaSetup['snapshot']>
import type { OperatingMode } from './operating-mode'

declare global {
  interface Window {
    karaokeWelcome?: {
      getState(): Promise<{ page: 'mode' | 'setup'; role: OperatingMode | null; libraryRoot: string | null; media?: WelcomeMediaState | null }>
      chooseMode(mode: OperatingMode): Promise<{ page: 'setup'; role: OperatingMode }>
      chooseLibrary(): Promise<{ cancelled: true } | { cancelled: false; path: string; media: WelcomeMediaState }>
      chooseCatalog(): Promise<{ cancelled: true } | { cancelled: false; path: string; preparation: MusicCatalogImportPreparation }>
      confirmCatalog(token: string): Promise<{ recordCount: number; issueCount: number }>
      cancelCatalog(token: string): Promise<void>
      catalogIssues(offset: number): Promise<{ total: number; offset: number; issues: MusicCatalogImportIssue[] }>
      onMediaChanged(callback: (state: WelcomeMediaState) => void): () => void
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
let mediaBusy = false
let catalogToken: string | undefined
let issuesOffset = 0
let dialogBusy = false
let dialogOrigin: HTMLElement | null = null
let selectedLibraryRoot: string | undefined
let selectedCatalogFile: string | undefined
let pendingCatalogFile: string | undefined

function setPage(page: 'mode' | 'setup'): void {
  modePage.hidden = page !== 'mode'
  setupPage.hidden = page !== 'setup'
}

function updateSetupContinue(): void {
  setupContinueButton.disabled = setupSubmitting || mediaBusy || !!catalogToken || (!selectedLibraryRoot && !selectedCatalogFile)
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
    if (state.media) renderMediaState(state.media)
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
  mediaBusy = true
  updateSetupContinue()
  configureLaterButton.disabled = true
  catalogChooseButton.disabled = true
  libraryChooseButton.disabled = true
  configureLaterButton.disabled = true
  mediaBusy = true
  updateSetupContinue()
  setupErrorText.hidden = true
  try {
    const result = await window.karaokeWelcome.chooseLibrary()
    if (!result.cancelled) {
      renderMediaState(result.media)
      selectedLibraryRoot = result.path
      setSelectedValue(libraryValue, result.path, `Pasta dos vídeos: ${result.path}`)
    }
  } catch {
    showSetupError('Não foi possível acessar essa pasta. Escolha uma pasta disponível ou configure a biblioteca depois.')
  } finally { mediaBusy = false; libraryChooseButton.disabled = false; catalogChooseButton.disabled = false; configureLaterButton.disabled = false; updateSetupContinue() }
})

catalogChooseButton.addEventListener('click', async () => {
  if (setupSubmitting || !window.karaokeWelcome) return
  catalogChooseButton.disabled = true
  setupErrorText.hidden = true
  try {
    const result = await window.karaokeWelcome.chooseCatalog()
    if (!result.cancelled) {
      setSelectedValue(catalogValue, result.path, `Arquivo CSV: ${result.path}`)
      if (result.preparation.outcome === 'confirmation-required') {
        pendingCatalogFile = result.path
        catalogToken = result.preparation.token
        openCatalogDialog(true, `${result.preparation.recordCount} músicas válidas serão importadas e ${result.preparation.issueCount} registros serão ignorados. O catálogo anterior só será substituído depois da sua confirmação.`)
      } else {
        selectedCatalogFile = result.path
        catalogStatus.textContent = `CSV importado: ${result.preparation.result.recordCount} músicas cadastradas.`
        catalogStatus.hidden = false
        viewIssuesButton.hidden = true
      }
    }
  } catch {
    showSetupError('Não foi possível selecionar o catálogo. Você pode escolher outro arquivo ou continuar sem catálogo.')
  } finally { mediaBusy = false; catalogChooseButton.disabled = false; libraryChooseButton.disabled = false; configureLaterButton.disabled = false; updateSetupContinue() }
})

async function completeSetup(configureLater: boolean): Promise<void> {
  if (setupSubmitting || mediaBusy || catalogToken || !window.karaokeWelcome) return
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
      ...(selectedLibraryRoot ? { libraryRoot: selectedLibraryRoot } : {})
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

const libraryStatus = document.querySelector<HTMLElement>('#welcome-library-status')!
const catalogStatus = document.querySelector<HTMLElement>('#welcome-catalog-status')!
const viewIssuesButton = document.querySelector<HTMLButtonElement>('#welcome-catalog-view-issues')!
const catalogDialog = document.querySelector<HTMLElement>('#welcome-catalog-dialog')!
const dialogTitle = document.querySelector<HTMLElement>('#welcome-catalog-dialog-title')!
const dialogDescription = document.querySelector<HTMLElement>('#welcome-catalog-dialog-description')!
const dialogSummary = document.querySelector<HTMLElement>('#welcome-catalog-confirmation-summary')!
const dialogStatus = document.querySelector<HTMLElement>('#welcome-catalog-dialog-status')!
const dialogList = document.querySelector<HTMLElement>('#welcome-catalog-issues-list')!
const dialogListWrap = document.querySelector<HTMLElement>('#welcome-catalog-issues-list-wrap')!
const dialogPage = document.querySelector<HTMLElement>('#welcome-catalog-issues-page')!
const dialogPrevious = document.querySelector<HTMLButtonElement>('#welcome-catalog-issues-previous')!
const dialogNext = document.querySelector<HTMLButtonElement>('#welcome-catalog-issues-next')!
const dialogCancel = document.querySelector<HTMLButtonElement>('#welcome-catalog-dialog-cancel')!
const dialogConfirm = document.querySelector<HTMLButtonElement>('#welcome-catalog-dialog-confirm')!

function renderMediaState(state: WelcomeMediaState): void {
  libraryStatus.replaceChildren()
  libraryStatus.hidden = state.library.scanStatus === 'not-scanned'
  if (state.library.scanStatus === 'scanning') {
    const spinner = document.createElement('span')
    spinner.className = 'welcome-index-spinner'
    spinner.setAttribute('aria-hidden', 'true')
    libraryStatus.append(spinner, 'Indexando biblioteca…')
  } else {
    libraryStatus.textContent = `${state.library.counts.indexedFiles} vídeos indexados. ${state.library.counts.invalidFilenames} arquivos com nome inválido. ${state.library.counts.unreadableFiles} arquivos indisponíveis.`
  }
}
function openCatalogDialog(confirmation: boolean, description = ''): void {
  dialogOrigin = document.activeElement instanceof HTMLElement ? document.activeElement : catalogChooseButton
  setupPage.inert = true
  catalogDialog.hidden = false
  dialogTitle.textContent = confirmation ? 'Substituir catálogo?' : 'Problemas na importação'
  dialogDescription.textContent = confirmation ? 'Cancelar mantém os dados atuais.' : 'Registros ignorados durante a importação.'
  dialogSummary.textContent = description
  dialogSummary.hidden = !confirmation
  dialogConfirm.hidden = !confirmation
  dialogCancel.textContent = confirmation ? 'Cancelar' : 'Fechar'
  dialogStatus.hidden = true
  issuesOffset = 0
  dialogCancel.focus()
  void loadIssues()
}
async function loadIssues(): Promise<void> {
  if (!window.karaokeWelcome) return
  dialogBusy = true
  dialogPrevious.disabled = dialogNext.disabled = true
  try {
    const page = await window.karaokeWelcome.catalogIssues(issuesOffset)
    dialogList.replaceChildren()
    for (const issue of page.issues) {
      const row = document.createElement('li')
      row.className = 'catalog-issue-item'
      for (const text of [`Linha ${issue.rowNumber}`, `Campo: ${issue.field}`, `Valor: ${issue.value}`, `Motivo: ${issue.reason}`]) {
        const cell = document.createElement('div'); cell.textContent = text; row.append(cell)
      }
      dialogList.append(row)
    }
    dialogListWrap.hidden = page.total === 0
    dialogPage.textContent = `Registros ${page.total ? page.offset + 1 : 0}–${Math.min(page.offset + 50, page.total)} de ${page.total}`
    dialogPrevious.disabled = page.offset === 0
    dialogNext.disabled = page.offset + 50 >= page.total
  } catch {
    dialogStatus.textContent = 'Não foi possível carregar o relatório. Tente novamente.'; dialogStatus.hidden = false
  } finally { dialogBusy = false }
}
async function closeCatalogDialog(): Promise<void> {
  if (dialogBusy) return
  if (catalogToken && window.karaokeWelcome) {
    try {
      await window.karaokeWelcome.cancelCatalog(catalogToken); catalogToken = undefined; pendingCatalogFile = undefined
      setSelectedValue(catalogValue, selectedCatalogFile ?? 'Nenhum catálogo selecionado', selectedCatalogFile ? `Arquivo CSV: ${selectedCatalogFile}` : 'Arquivo CSV não selecionado')
    }
    catch { dialogStatus.textContent = 'Não foi possível cancelar a importação.'; dialogStatus.hidden = false; return }
  }
  catalogDialog.hidden = true
  setupPage.inert = false
  dialogOrigin?.focus()
  updateSetupContinue()
}
dialogCancel.addEventListener('click', () => { void closeCatalogDialog() })
dialogConfirm.addEventListener('click', async () => {
  if (!catalogToken || dialogBusy || !window.karaokeWelcome) return
  dialogBusy = true
  dialogConfirm.disabled = dialogCancel.disabled = true
  try {
    const result = await window.karaokeWelcome.confirmCatalog(catalogToken)
    catalogToken = undefined
    selectedCatalogFile = pendingCatalogFile
    pendingCatalogFile = undefined
    dialogTitle.textContent = 'Problemas na importação'
    dialogDescription.textContent = `${result.issueCount} registros foram ignorados durante a importação.`
    dialogSummary.hidden = dialogConfirm.hidden = true
    dialogCancel.textContent = 'Fechar'
    catalogStatus.textContent = `CSV importado: ${result.recordCount} músicas cadastradas. ${result.issueCount} registros ignorados.`
    catalogStatus.hidden = viewIssuesButton.hidden = false
  } catch { dialogStatus.textContent = 'Não foi possível confirmar a importação. O catálogo anterior foi preservado.'; dialogStatus.hidden = false }
  finally { dialogBusy = false; dialogConfirm.disabled = dialogCancel.disabled = false; updateSetupContinue() }
})
dialogPrevious.addEventListener('click', () => { if (!dialogBusy) { issuesOffset = Math.max(0, issuesOffset - 50); void loadIssues() } })
dialogNext.addEventListener('click', () => { if (!dialogBusy) { issuesOffset += 50; void loadIssues() } })
viewIssuesButton.addEventListener('click', () => openCatalogDialog(false))
document.addEventListener('keydown', event => {
  if (catalogDialog.hidden) return
  if (event.key === 'Escape') { event.preventDefault(); void closeCatalogDialog() }
  if (event.key === 'Tab') {
    const buttons = [...catalogDialog.querySelectorAll<HTMLButtonElement>('button')].filter(button => !button.disabled && !button.hidden && !button.closest('[hidden]'))
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const next = buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]
    if (next) { event.preventDefault(); next.focus() }
  }
})
window.karaokeWelcome?.onMediaChanged(renderMediaState)
void loadWelcomeState()
