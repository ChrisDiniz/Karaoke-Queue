import { PersistenceError } from '../state-repository'
import type { KaraokeApplication, ReadonlyAppState } from '../application'
import type { QueueView } from './queue-view'
import type { HistoryView } from './history-view'
import { getElement, getInput, ModalManager, showToast, reportPersistenceFailure } from './dom'
import { queuePositionReason } from '../queue-rules'
import { singerSuggestions, type SingerSuggestion } from '../singer-suggestions'

const PROMOTE_TO_CURRENT_MSG = 'Colocar esta mesa para cantar AGORA? A mesa que está na vez passa a ser a próxima.'
const DRAG_SCROLL_EDGE = 80
const DRAG_SCROLL_MAX_SPEED = 18
const QUEUE_MENU_VIEWPORT_MARGIN = 8
const QUEUE_MENU_GAP = 5

export class QueueInteractions {
  private uncertainFormValues: string | null = null
  private uncertainBatch = false
  private saving = new Set<string>()
  private draggedId: string | null = null
  private dragSource: HTMLElement | null = null
  private dragPlaceholder: HTMLElement | null = null
  private dragOriginalIds: string[] = []
  private dragOriginalChildren: HTMLElement[] = []
  private dragPreviewOrder: string[] = []
  private dragAwaitingConfirmation = false
  private batchRowCount = 0
  private pendingManualMove: { id: string; position: number; sessionId: string } | null = null
  private queueReasonReturnFocus: HTMLElement | null = null
  private visibleSingerSuggestions: SingerSuggestion[] = []
  private activeSingerSuggestionIndex = -1
  private selectedMusicSource: 'local' | 'youtube' = 'local'
  private openQueueMenuOwner: HTMLElement | null = null
  private openQueueMenuButton: HTMLElement | null = null
  private openQueueMenuPopover: HTMLElement | null = null
  private queueMenuObserver: MutationObserver | null = null

  constructor(
    private readonly application: KaraokeApplication,
    private readonly getState: () => ReadonlyAppState,
    private readonly queueView: QueueView,
    private readonly historyView: HistoryView,
    private readonly modals: ModalManager,
    private readonly openTable: (table: string, sessionId?: string, readOnly?: boolean) => void
  ) {}

  get globalHandlers() {
    return {
      openTableModal: (table: string, sessionId?: string, readOnly?: boolean) =>
        this.openTable(table, sessionId && sessionId !== 'null' ? sessionId : undefined, readOnly),
      cancelEntry: (id: string) => this.cancelEntry(id),
      markDone: (id: string) => this.markDone(id),
      openEdit: (id: string) => this.openEdit(id),
      explainQueuePosition: (id: string) => this.explainQueuePosition(id),
      unpin: (id: string) => this.unpin(id),
      freezeThrough: (id: string) => this.freezeThrough(id),
      releaseFreeze: () => this.releaseFreeze(),
      removeBatchRow: (button: HTMLButtonElement) => this.removeBatchRow(button),
      dragStart: (event: DragEvent, id: string) => this.dragStart(event, id),
      dragEnd: (event: DragEvent) => this.dragEnd(event),
      dragOverTarget: (event: DragEvent) => this.dragOverTarget(event),
      dropOnCurrent: (event: DragEvent) => this.dropOnCurrent(event),
      dragOverQueue: (event: DragEvent, id: string) => this.dragOverQueue(event, id),
      dropOnQueueCard: (event: DragEvent, id: string) => this.dropOnQueueCard(event, id),
      acceptBoost: (id: string) => this.queueView.acceptBoost(id),
      dismissBoost: (id: string) => this.queueView.dismissBoost(id),
      expandBoost: (id: string) => this.queueView.expandBoost(id),
      setTableFilter: (table: string | null) => this.historyView.setTableFilter(table),
      toggleQueueMenu: (event: Event, button: HTMLElement) => this.toggleQueueMenu(event, button)
    }
  }

  bind(): void {
    this.queueMenuObserver = new MutationObserver(() => {
      if (this.openQueueMenuButton && !this.openQueueMenuButton.isConnected) this.closeQueueMenus()
    })
    this.queueMenuObserver.observe(document.body, { childList: true, subtree: true })
    window.addEventListener('resize', () => this.closeQueueMenus())
    getElement('queue-list').closest<HTMLElement>('.app-main')?.addEventListener('scroll', () => {
      if (!this.openQueueMenuButton || !this.openQueueMenuPopover || !this.openQueueMenuButton.isConnected ||
          !this.positionQueueMenu(this.openQueueMenuButton, this.openQueueMenuPopover)) this.closeQueueMenus()
    })
    window.addEventListener('persistence-recovered', event => {
      if ((event as CustomEvent).detail === 'committed') {
        const values = JSON.stringify(['input-name', 'input-song', 'input-song2', 'input-table'].map(id => getInput(id).value))
        if (values === this.uncertainFormValues) {
          (getElement('form-entry') as HTMLFormElement).reset()
          this.closeSingerSuggestions()
        }
        if (this.uncertainBatch) this.closeBatch()
      }
      this.uncertainFormValues = null
      this.uncertainBatch = false
    })
    getElement('form-entry').addEventListener('submit', async event => {
      event.preventDefault()
      const form = event.currentTarget as HTMLFormElement
      if (form.getAttribute('aria-busy') === 'true') return
      const inputs = ['input-name', 'input-song', 'input-song2', 'input-table'].map(id => getInput(id))
      const button = form.querySelector<HTMLButtonElement>('button[type="submit"]')!
      const previousReadOnly = inputs.map(input => input.readOnly)
      form.setAttribute('aria-busy', 'true')
      button.disabled = true
      inputs.forEach(input => { input.readOnly = true })
      try {
        if (!await this.addEntry(inputs[0].value, inputs[1].value, inputs[2].value, inputs[3].value)) return
        this.closeSingerSuggestions()
        form.reset()
        getInput('input-table').focus()
      } finally {
        form.removeAttribute('aria-busy')
        button.disabled = false
        inputs.forEach((input, index) => { input.readOnly = previousReadOnly[index] })
      }
    })
    this.bindSingerAutocomplete()
    this.bindSourceSelection()
    this.bindNumericFields('#input-song, #input-song2')

    getElement('btn-close-edit').addEventListener('click', () => this.closeEdit())
    getElement('btn-cancel-edit').addEventListener('click', () => this.closeEdit())
    getElement('btn-save-edit').addEventListener('click', () => this.saveEdit())
    this.bindNumericFields('#edit-song, #edit-song2')

    getElement('btn-open-batch').addEventListener('click', () => this.openBatch())
    getElement('btn-close-batch').addEventListener('click', () => this.closeBatch())
    getElement('btn-cancel-batch').addEventListener('click', () => this.closeBatch())
    getElement('btn-confirm-batch').addEventListener('click', () => this.confirmBatch())
    getElement('btn-cancel-manual-move').addEventListener('click', () => this.cancelManualMove())
    getElement('btn-confirm-manual-move').addEventListener('click', () => this.confirmManualMove())
    getElement('btn-release-freeze').addEventListener('click', () => this.releaseFreeze())
    const reasonModal = getElement('queue-reason-modal')
    getElement('btn-close-queue-reason').addEventListener('click', () => this.closeQueueReason())
    reasonModal.addEventListener('click', event => {
      if (event.target === reasonModal) this.closeQueueReason()
    })
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !reasonModal.classList.contains('hidden')) this.closeQueueReason()
    })
    const manualMoveModal = getElement('manual-move-modal')
    manualMoveModal.addEventListener('click', event => {
      if (event.target === manualMoveModal) this.cancelManualMove()
    })
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !manualMoveModal.classList.contains('hidden')) this.cancelManualMove()
    })
    getElement('btn-add-batch-row').addEventListener('click', () => {
      this.addBatchRow()
      const rows = document.querySelectorAll('.batch-row')
      rows[rows.length - 1].querySelector<HTMLInputElement>('.b-name')?.focus()
    })
    getElement('queue-list').addEventListener('dragover', event => this.dragOverQueueList(event as DragEvent))
    getElement('queue-list').addEventListener('drop', event => this.dropInQueueList(event as DragEvent))
    document.addEventListener('click', event => {
      if (!(event.target as Element | null)?.closest('.queue-action-menu, .queue-action-menu-popover.is-open')) this.closeQueueMenus()
    })
    document.addEventListener('click', event => {
      const target = event.target as Element | null
      if (!target?.closest('.singer-autocomplete, .source-selector')) this.closeSingerSuggestions()
    })
    document.addEventListener('keydown', event => this.handleQueueMenuKeydown(event))
  }

  private bindSingerAutocomplete(): void {
    const name = getInput('input-name')
    const table = getInput('input-table')
    const wrapper = getElement('singer-autocomplete')
    name.setAttribute('aria-autocomplete', 'list')
    name.setAttribute('aria-controls', 'singer-suggestions')
    name.setAttribute('aria-expanded', 'false')
    name.addEventListener('input', () => this.renderSingerSuggestions())
    name.addEventListener('focus', () => {
      if (name.value.trim()) this.renderSingerSuggestions()
    })
    name.addEventListener('keydown', event => {
      if (event.key === 'Escape' && this.visibleSingerSuggestions.length > 0) {
        event.preventDefault()
        this.closeSingerSuggestions()
        return
      }
      if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && this.visibleSingerSuggestions.length > 0) {
        event.preventDefault()
        const direction = event.key === 'ArrowDown' ? 1 : -1
        if (this.activeSingerSuggestionIndex < 0) {
          this.activeSingerSuggestionIndex = direction > 0 ? 0 : this.visibleSingerSuggestions.length - 1
        } else {
          this.activeSingerSuggestionIndex = (this.activeSingerSuggestionIndex + direction + this.visibleSingerSuggestions.length)
            % this.visibleSingerSuggestions.length
        }
        this.updateActiveSingerSuggestion()
        return
      }
      if (event.key === 'Enter' && this.visibleSingerSuggestions.length > 0) {
        event.preventDefault()
        event.stopPropagation()
        const selectedIndex = this.activeSingerSuggestionIndex >= 0 ? this.activeSingerSuggestionIndex : 0
        this.selectSingerSuggestion(this.visibleSingerSuggestions[selectedIndex])
      }
    })
    table.addEventListener('input', () => {
      this.closeSingerSuggestions()
      if (document.activeElement === name && name.value.trim()) this.renderSingerSuggestions()
    })
    wrapper.addEventListener('focusout', event => {
      const nextTarget = event.relatedTarget as Element | null
      if (!wrapper.contains(nextTarget) && !nextTarget?.closest('.source-selector')) this.closeSingerSuggestions()
    })
  }

  private bindSourceSelection(): void {
    const selector = getElement('source-selector')
    const trigger = getElement('source-trigger') as HTMLButtonElement
    const menu = getElement('source-menu')
    const options = [...menu.querySelectorAll<HTMLButtonElement>('.source-menu-option')]

    const enabledOptions = () => options.filter(option => !option.disabled)
    const selectedIndex = () => Math.max(0, enabledOptions().findIndex(option => option.dataset.source === this.selectedMusicSource))
    const closeMenu = (restoreFocus = false) => {
      menu.hidden = true
      trigger.setAttribute('aria-expanded', 'false')
      if (restoreFocus) trigger.focus()
    }
    const openMenu = (index = selectedIndex()) => {
      menu.hidden = false
      trigger.setAttribute('aria-expanded', 'true')
      const available = enabledOptions()
      available[Math.min(Math.max(index, 0), available.length - 1)]?.focus()
    }
    const selectOption = (option: HTMLButtonElement) => {
      const source = option.dataset.source
      if (option.disabled || source !== 'local' && source !== 'youtube') return
      this.selectedMusicSource = source
      selector.dataset.selectedSource = source
      options.forEach(candidate => candidate.setAttribute('aria-checked', String(candidate === option)))
      closeMenu(true)
    }

    trigger.addEventListener('click', () => {
      if (menu.hidden) openMenu()
      else closeMenu(true)
    })
    trigger.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        openMenu()
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        openMenu(options.length - 1)
      }
    })
    enabledOptions().forEach((option, index) => {
      option.addEventListener('click', () => selectOption(option))
      option.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          closeMenu(true)
          return
        }
        let nextIndex: number | null = null
        if (event.key === 'ArrowDown') nextIndex = (index + 1) % options.length
        else if (event.key === 'ArrowUp') nextIndex = (index - 1 + options.length) % options.length
        else if (event.key === 'Home') nextIndex = 0
        else if (event.key === 'End') nextIndex = options.length - 1
        if (nextIndex !== null) {
          event.preventDefault()
          options[nextIndex]?.focus()
        }
      })
    })
    document.addEventListener('click', event => {
      if (!selector.contains(event.target as Node)) closeMenu()
    })
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !menu.hidden) {
        event.preventDefault()
        closeMenu(true)
      }
    })
    selector.addEventListener('focusout', event => {
      const nextTarget = event.relatedTarget as Node | null
      if (!selector.contains(nextTarget) && (nextTarget !== null || !selector.matches(':hover'))) closeMenu()
    })
  }

  private renderSingerSuggestions(): void {
    const input = getInput('input-name')
    const list = getElement('singer-suggestions')
    const state = this.getState()
    this.visibleSingerSuggestions = singerSuggestions(state.queue, state.history, state.currentSessionId,
      getInput('input-table').value, input.value, 6)
    this.activeSingerSuggestionIndex = -1
    list.replaceChildren()
    if (this.visibleSingerSuggestions.length === 0) {
      list.hidden = true
      input.setAttribute('aria-expanded', 'false')
      input.removeAttribute('aria-activedescendant')
      return
    }

    this.visibleSingerSuggestions.forEach((suggestion, index) => {
      const option = document.createElement('div')
      option.id = `singer-suggestion-${index}`
      option.className = 'singer-suggestion-option'
      option.setAttribute('role', 'option')
      option.setAttribute('aria-selected', 'false')
      option.textContent = suggestion.name
      option.addEventListener('mousedown', event => event.preventDefault())
      option.addEventListener('click', () => this.selectSingerSuggestion(suggestion))
      list.appendChild(option)
    })
    list.hidden = false
    input.setAttribute('aria-expanded', 'true')
    input.removeAttribute('aria-activedescendant')
  }

  private updateActiveSingerSuggestion(): void {
    const options = [...document.querySelectorAll<HTMLElement>('#singer-suggestions [role="option"]')]
    options.forEach((option, index) => {
      const active = index === this.activeSingerSuggestionIndex
      option.classList.toggle('is-active', active)
      option.setAttribute('aria-selected', String(active))
    })
    const active = options[this.activeSingerSuggestionIndex]
    if (active) {
      getInput('input-name').setAttribute('aria-activedescendant', active.id)
      active.scrollIntoView({ block: 'nearest' })
    }
  }

  private selectSingerSuggestion(suggestion: SingerSuggestion): void {
    const input = getInput('input-name')
    input.value = suggestion.name
    this.closeSingerSuggestions()
    input.focus()
  }

  private closeSingerSuggestions(): void {
    const list = document.getElementById('singer-suggestions')
    const input = document.getElementById('input-name')
    this.visibleSingerSuggestions = []
    this.activeSingerSuggestionIndex = -1
    if (list) {
      list.hidden = true
      list.replaceChildren()
    }
    input?.setAttribute('aria-expanded', 'false')
    input?.removeAttribute('aria-activedescendant')
  }

  private toggleQueueMenu(event: Event, button: HTMLElement): void {
    event.preventDefault()
    const menu = button.closest<HTMLElement>('.queue-action-menu')
    if (!menu) return
    const wasOpen = menu.classList.contains('is-open')
    this.closeQueueMenus()
    if (!wasOpen) {
      menu.classList.add('is-open')
      button.setAttribute('aria-expanded', 'true')
      const owner = menu.closest<HTMLElement>('.queue-card, .now-card')
      owner?.classList.add('queue-menu-open')
      const popover = menu.querySelector<HTMLElement>('.queue-action-menu-popover')
      if (!popover || !owner) return
      popover.classList.add('is-open')
      document.body.append(popover)
      this.openQueueMenuOwner = menu
      this.openQueueMenuButton = button
      this.openQueueMenuPopover = popover
      if (!this.positionQueueMenu(button, popover)) this.closeQueueMenus()
    }
  }

  private visibleQueueMenuAnchor(button: HTMLElement): { top: number; bottom: number; left: number; right: number } | null {
    const rect = button.getBoundingClientRect()
    const visible = { top: Math.max(0, rect.top), bottom: Math.min(window.innerHeight, rect.bottom),
      left: Math.max(0, rect.left), right: Math.min(window.innerWidth, rect.right) }
    for (let parent = button.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
      const style = getComputedStyle(parent)
      const clipsX = style.overflowX !== 'visible'
      const clipsY = style.overflowY !== 'visible'
      if (!clipsX && !clipsY) continue
      const bounds = parent.getBoundingClientRect()
      const clipLeft = bounds.left + parent.clientLeft
      const clipTop = bounds.top + parent.clientTop
      if (clipsX) {
        visible.left = Math.max(visible.left, clipLeft)
        visible.right = Math.min(visible.right, clipLeft + parent.clientWidth)
      }
      if (clipsY) {
        visible.top = Math.max(visible.top, clipTop)
        visible.bottom = Math.min(visible.bottom, clipTop + parent.clientHeight)
      }
    }
    return visible.right > visible.left && visible.bottom > visible.top ? visible : null
  }

  private positionQueueMenu(button: HTMLElement, popover: HTMLElement): boolean {
    popover.style.maxHeight = 'none'
    popover.style.maxWidth = `calc(100vw - ${QUEUE_MENU_VIEWPORT_MARGIN * 2}px)`
    const buttonRect = this.visibleQueueMenuAnchor(button)
    if (!buttonRect) return false
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth
    const viewportHeight = document.documentElement.clientHeight || window.innerHeight
    const margin = QUEUE_MENU_VIEWPORT_MARGIN
    const availableBelow = Math.max(0, viewportHeight - margin - buttonRect.bottom - QUEUE_MENU_GAP)
    const availableAbove = Math.max(0, buttonRect.top - margin - QUEUE_MENU_GAP)
    const naturalHeight = popover.scrollHeight
    const opensDown = naturalHeight <= availableBelow ||
      (naturalHeight > availableAbove && availableBelow >= availableAbove)
    const available = opensDown ? availableBelow : availableAbove

    popover.style.maxHeight = `${Math.max(0, available)}px`
    popover.dataset.placement = opensDown ? 'down' : 'up'
    const menuRect = popover.getBoundingClientRect()
    const left = Math.min(Math.max(margin, buttonRect.right - menuRect.width),
      Math.max(margin, viewportWidth - margin - menuRect.width))
    const top = opensDown
      ? Math.min(viewportHeight - margin - menuRect.height, buttonRect.bottom + QUEUE_MENU_GAP)
      : Math.max(margin, buttonRect.top - QUEUE_MENU_GAP - menuRect.height)
    popover.style.left = `${left}px`
    popover.style.top = `${top}px`
    return true
  }

  private closeQueueMenus(returnFocus = false): void {
    const menu = this.openQueueMenuOwner
    const button = this.openQueueMenuButton
    const popover = this.openQueueMenuPopover
    if (!menu || !button || !popover) return
    menu.classList.remove('is-open')
    menu.closest<HTMLElement>('.queue-card, .now-card')?.classList.remove('queue-menu-open')
    button.setAttribute('aria-expanded', 'false')
    popover.classList.remove('is-open')
    popover.style.left = ''
    popover.style.top = ''
    popover.style.maxHeight = ''
    popover.style.maxWidth = ''
    delete popover.dataset.placement
    if (menu.isConnected) menu.append(popover)
    else popover.remove()
    this.openQueueMenuOwner = null
    this.openQueueMenuButton = null
    this.openQueueMenuPopover = null
    if (returnFocus && button.isConnected) button.focus()
  }

  private explainQueuePosition(id: string): void {
    const state = this.getState()
    const entry = state.queue.find(item => item.id === id)
    if (!entry) return
    const order = this.application.getPlayOrder()
    const reason = queuePositionReason(id, order, state.queue, state.history, state.currentSessionId,
      state.currentTurnId, state.frozenTurnIds, state.fixedTurnPositions, state.priorityIds, state.nextTurnId)
    if (!reason) return

    this.closeQueueMenus()
    this.queueReasonReturnFocus = document.activeElement as HTMLElement | null
    const position = getElement('queue-reason-position')
    const title = getElement('queue-reason-title')
    const description = getElement('queue-reason-description')
    const content: Record<typeof reason.kind, { label: string; description: string }> = {
      current: {
        label: 'Vez atual',
        description: 'Esta apresentação está selecionada para cantar agora. Isso não indica que a reprodução já começou.'
      },
      frozen: {
        label: `Congelada · ${reason.position}º na fila`,
        description: 'O operador protegeu esta sequência. A ordem congelada prevalece sobre o rodízio automático.'
      },
      manual: {
        label: `Fixada · ${reason.position}º na fila`,
        description: 'Esta posição foi definida por uma intervenção manual do operador e prevalece sobre a ordem automática.'
      },
      debut: {
        label: `Estreia · ${reason.position}º na fila`,
        description: 'É o primeiro turno pendente de uma mesa sem apresentações concluídas nesta sessão. O rodízio intercala até dois turnos regulares antes de uma oportunidade de estreia.'
      },
      regular: {
        label: `${reason.position}º na fila`,
        description: 'Segue o rodízio regular, que considera apresentações concluídas recentes, pedidos anteriores da mesma mesa, ordem de chegada e alternância entre mesas quando há alternativas.'
      }
    }
    title.textContent = `Por que ${entry.name} está nesta posição?`
    position.textContent = content[reason.kind].label
    description.textContent = content[reason.kind].description
    this.modals.show('queue-reason-modal')
    getElement('btn-close-queue-reason').focus()
  }

  private closeQueueReason(): void {
    this.modals.hide('queue-reason-modal')
    if (this.queueReasonReturnFocus?.isConnected) this.queueReasonReturnFocus.focus()
    this.queueReasonReturnFocus = null
  }

  private handleQueueMenuKeydown(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null
    const toggle = target?.closest<HTMLElement>('.queue-action-menu-toggle')
    if (toggle && (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ')) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        this.toggleQueueMenu(event, toggle)
        this.openQueueMenuPopover?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
      }
      return
    }
    const menu = target?.closest<HTMLElement>('.queue-action-menu-popover.is-open')
    if (!menu) return
    if (event.key === 'Escape') {
      event.preventDefault()
      this.closeQueueMenus(true)
      return
    }
    const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    const index = items.indexOf(target!)
    if (index < 0) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
      items[next]?.focus()
    }
  }

  async addEntry(name: string, songNumber: string, songNumber2: string, table: string): Promise<boolean> {
    const operationKey = 'addEntry:' + JSON.stringify([name, songNumber, songNumber2, table])
    if (this.saving.has(operationKey)) return false
    this.saving.add(operationKey)
    try {
      const [entry] = await this.application.addEntries([{ name, songNumber, songNumber2, table }], true)
      this.queueView.render()
      this.historyView.render()
      showToast(`${entry.name} adicionado(a) à fila!`)
      return true

    } catch (error) {
      if (error instanceof PersistenceError && error.outcome === 'uncertain')
        this.uncertainFormValues = JSON.stringify([name, songNumber, songNumber2, table])
      reportPersistenceFailure(error)
      return false
    } finally { this.saving.delete(operationKey) }
  }

  private bindNumericFields(selector: string): void {
    document.querySelectorAll<HTMLInputElement>(selector).forEach(input => {
      input.addEventListener('keypress', event => {
        if (!/[0-9]/.test(event.key)) event.preventDefault()
      })
      input.addEventListener('input', () => { input.value = input.value.replace(/[^0-9]/g, '') })
    })
  }

  private openEdit(id: string): void {
    this.closeQueueMenus()
    const entry = this.getState().queue.find(item => item.id === id)
    if (!entry) return
    if (this.getState().frozenTurnIds.includes(id) &&
        !confirm(`${entry.name} está em uma sequência congelada. Editar esta apresentação pode divergir do que já foi preparado no player. Continuar?`)) return
    getInput('edit-id').value = entry.id
    getInput('edit-name').value = entry.name
    getInput('edit-song').value = entry.songNumber
    getInput('edit-song2').value = entry.songNumber2 || ''
    getInput('edit-table').value = entry.table
    this.modals.show('edit-modal')
    getInput('edit-name').focus()
  }

  private closeEdit(): void { this.modals.hide('edit-modal') }

  private async saveEdit(): Promise<void> {
    const operationKey = 'saveEdit'
    if (this.saving.has(operationKey)) return
    this.saving.add(operationKey)
    try {
      const id = getInput('edit-id').value
      const name = getInput('edit-name').value.trim()
      const song = getInput('edit-song').value.trim()
      const song2 = getInput('edit-song2').value.trim()
      const table = getInput('edit-table').value.trim()
      if (!name || !song || !table) {
        showToast('Preencha nome, 1ª música e mesa.')
        return
      }
      const entry = this.getState().queue.find(item => item.id === id)
      if (!entry || !(await this.application.editEntry(id, { name, songNumber: song, songNumber2: song2, table }))) return
      this.queueView.render()
      this.historyView.render()
      this.closeEdit()
      showToast('Registro atualizado!')

    } catch (error) {
      reportPersistenceFailure(error)
      return
    } finally { this.saving.delete(operationKey) }
  }

  private async cancelEntry(id: string): Promise<void> {
    const operationKey = 'cancelEntry' + ':' + id
    if (this.saving.has(operationKey)) return
    this.saving.add(operationKey)
    try {
      this.closeQueueMenus()
      const entry = this.getState().queue.find(item => item.id === id)
      if (!entry) return
      const frozenNotice = this.getState().frozenTurnIds.includes(id)
        ? ' Esta apresentação está congelada e pode já estar preparada no player.' : ''
      if (!confirm(`Cancelar ${entry.name} (Mesa ${entry.table})? A entrada sai da fila e fica registrada como cancelada.${frozenNotice}`)) return
      const cancelled = (await this.application.cancelAndAdvance(id))
      if (!cancelled) return
      this.queueView.clearBoostState(id)
      this.queueView.render()
      this.historyView.render()
      showToast(`${cancelled.name} (Mesa ${cancelled.table}) cancelado(a).`)

    } catch (error) {
      reportPersistenceFailure(error)
      return
    } finally { this.saving.delete(operationKey) }
  }

  private async markDone(id: string): Promise<void> {
    const operationKey = 'markDone' + ':' + id
    if (this.saving.has(operationKey)) return
    this.saving.add(operationKey)
    try {
      const entry = (await this.application.completeAndAdvance(id))
      if (!entry) return
      this.queueView.clearBoostState(id)
      this.queueView.render()
      this.historyView.render()
      showToast(`${entry.name} (Mesa ${entry.table}) marcado como cantado!`)

    } catch (error) {
      reportPersistenceFailure(error)
      return
    } finally { this.saving.delete(operationKey) }
  }

  async pinNext(id: string): Promise<boolean | undefined> {
    const operationKey = 'pinNext' + ':' + id
    if (this.saving.has(operationKey)) return false
    this.saving.add(operationKey)
    try {
      if (this.getState().frozenTurnIds.includes(id)) return false
      const moved = (await this.application.moveTurn(id, this.getState().frozenTurnIds.length + 1))
      return moved

    } catch (error) {
      reportPersistenceFailure(error)
      return undefined
    } finally { this.saving.delete(operationKey) }
  }

  private async unpin(id: string): Promise<void> {
    const operationKey = 'unpin' + ':' + id
    if (this.saving.has(operationKey)) return
    this.saving.add(operationKey)
    try {
      await this.application.unpin(id)
      this.queueView.render()

    } catch (error) {
      reportPersistenceFailure(error)
      return
    } finally { this.saving.delete(operationKey) }
  }

  private async freezeThrough(id: string): Promise<void> {
    const operationKey = 'freezeThrough' + ':' + id
    if (this.saving.has(operationKey)) return
    this.saving.add(operationKey)
    try {
      const state = this.getState()
      const entry = state.queue.find(item => item.id === id)
      if (!entry || id === state.currentTurnId) return
      const order = this.application.getPlayOrder().filter(item => item.id !== state.currentTurnId)
      const index = order.findIndex(item => item.id === id)
      if (index < state.frozenTurnIds.length) return
      const count = index + 1
      const action = state.frozenTurnIds.length ? 'Estender' : 'Congelar'
      if (!confirm(`${action} ${count} apresentação(ões) até ${entry.name} (Mesa ${entry.table})? A sequência será mantida nesta ordem e não será reorganizada automaticamente. Novas solicitações ficarão fora do bloco congelado.`)) return
      if (!(await this.application.freezeThrough(id))) return
      this.queueView.render()
      showToast(`${count} apresentação(ões) congeladas na fila.`)

    } catch (error) {
      reportPersistenceFailure(error)
      return
    } finally { this.saving.delete(operationKey) }
  }

  private async releaseFreeze(): Promise<void> {
    const operationKey = 'releaseFreeze'
    if (this.saving.has(operationKey)) return
    this.saving.add(operationKey)
    try {
      const count = this.getState().frozenTurnIds.length
      if (!count) return
      if (!confirm(`Liberar as ${count} apresentações congeladas? A sequência poderá ser reorganizada pelas fixações individuais e pelo rodízio automático.`)) return
      if (!(await this.application.releaseFreeze())) return
      this.queueView.render()
      showToast('Congelamento liberado. A fila voltou à ordenação automática.')

    } catch (error) {
      reportPersistenceFailure(error)
      return
    } finally { this.saving.delete(operationKey) }
  }

  private dragStart(event: DragEvent, id: string): void {
    if ((event.target as Element | null)?.closest('button')) {
      event.preventDefault()
      return
    }
    if (this.getState().frozenTurnIds.includes(id)) {
      event.preventDefault()
      showToast('Este turno está congelado. Libere o bloco antes de movimentá-lo.')
      return
    }
    const source = (event.currentTarget as HTMLElement | null)?.closest<HTMLElement>('.queue-card')
    const list = getElement('queue-list')
    if (!source || !list || !list.contains(source)) return
    const sourceBounds = source.getBoundingClientRect()
    this.draggedId = id
    this.dragSource = source
    this.dragOriginalChildren = [...list.children] as HTMLElement[]
    this.dragOriginalIds = [...list.querySelectorAll<HTMLElement>('.queue-card[data-id]')].map(card => card.dataset.id!).filter(Boolean)
    this.dragPreviewOrder = [...this.dragOriginalIds]
    this.dragAwaitingConfirmation = false
    const placeholder = document.createElement('div')
    placeholder.className = 'queue-drop-placeholder'
    placeholder.setAttribute('aria-hidden', 'true')
    placeholder.style.height = `${sourceBounds.height}px`
    placeholder.addEventListener('dragover', dragEvent => dragEvent.preventDefault())
    placeholder.addEventListener('drop', dragEvent => {
      dragEvent.preventDefault()
      this.finishQueueDrop(dragEvent)
    })
    this.dragPlaceholder = placeholder
    list.insertBefore(placeholder, source)
    source.classList.add('drag-source')
    this.queueView.beginDragPreview()
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.setData('text/plain', id)
      const ghost = source.cloneNode(true) as HTMLElement
      ghost.classList.remove('drag-source', 'dragging')
      ghost.classList.add('queue-card-drag-image')
      ghost.querySelectorAll('button').forEach(button => button.remove())
      ghost.querySelectorAll<HTMLElement>('[id]').forEach(element => element.removeAttribute('id'))
      ghost.style.width = `${sourceBounds.width}px`
      document.body.appendChild(ghost)
      event.dataTransfer.setDragImage(ghost, Math.max(0, event.clientX - sourceBounds.left), Math.max(0, event.clientY - sourceBounds.top))
      setTimeout(() => ghost.remove(), 0)
    }
    source.classList.add('dragging')
  }

  private dragEnd(event: DragEvent): void {
    this.clearDropIndicators()
    if (!this.dragAwaitingConfirmation && this.draggedId && event.dataTransfer?.dropEffect === 'move') {
      this.finishQueueDrop(event)
    }
    if (!this.dragAwaitingConfirmation) this.restoreDragPreview()
    this.draggedId = null
  }

  private autoScrollDuringDrag(event: DragEvent): void {
    if (!this.draggedId) return
    const container = document.querySelector<HTMLElement>('.app-main')
    if (!container) return
    const bounds = container.getBoundingClientRect()
    let scrollDelta = 0
    if (event.clientY < bounds.top + DRAG_SCROLL_EDGE) {
      scrollDelta = -Math.ceil((bounds.top + DRAG_SCROLL_EDGE - event.clientY) / DRAG_SCROLL_EDGE * DRAG_SCROLL_MAX_SPEED)
    } else if (event.clientY > bounds.bottom - DRAG_SCROLL_EDGE) {
      scrollDelta = Math.ceil((event.clientY - (bounds.bottom - DRAG_SCROLL_EDGE)) / DRAG_SCROLL_EDGE * DRAG_SCROLL_MAX_SPEED)
    }
    if (scrollDelta) container.scrollTop += scrollDelta
  }

  private dragOverTarget(event: DragEvent): void {
    event.preventDefault()
    this.clearDropIndicators()
    ;(event.currentTarget as Element).classList.add('drag-over')
  }

  private dragOverQueue(event: DragEvent, targetId: string): void {
    event.preventDefault()
    if (!this.draggedId || this.draggedId === targetId || !this.dragPlaceholder) return
    const card = event.currentTarget as HTMLElement
    const after = event.clientY > card.getBoundingClientRect().top + card.offsetHeight / 2
    this.moveDragPlaceholder(card, after)
  }

  private dragOverQueueList(event: DragEvent): void {
    if (!this.draggedId || !this.dragPlaceholder) return
    event.preventDefault()
    this.autoScrollDuringDrag(event)
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
    const list = getElement('queue-list')
    const target = (event.target as Element | null)?.closest<HTMLElement>('.queue-card[data-id]')
    if (target && target !== this.dragSource) {
      const after = event.clientY > target.getBoundingClientRect().top + target.offsetHeight / 2
      this.moveDragPlaceholder(target, after)
      return
    }
    const cards = [...list.querySelectorAll<HTMLElement>('.queue-card[data-id]:not(.drag-source)')]
    const following = cards.find(card => event.clientY < card.getBoundingClientRect().top + card.offsetHeight / 2)
    if (following) this.moveDragPlaceholder(following, false)
    else if (cards.length) this.moveDragPlaceholder(cards[cards.length - 1], true)
  }

  private moveDragPlaceholder(target: HTMLElement, after: boolean): void {
    const placeholder = this.dragPlaceholder
    const list = getElement('queue-list')
    if (!placeholder || !list || target === placeholder || target.parentElement !== list) return
    const beforeRects = new Map([...list.querySelectorAll<HTMLElement>('.queue-card[data-id]:not(.drag-source)')]
      .map(card => [card, card.getBoundingClientRect()] as const))
    const reference = after ? target.nextElementSibling : target
    if (reference === placeholder) return
    const adjustedReference = after && reference?.classList.contains('queue-section-heading--dynamic')
      ? reference.nextElementSibling
      : reference
    list.insertBefore(placeholder, adjustedReference)
    const cards = [...list.querySelectorAll<HTMLElement>('.queue-card[data-id]:not(.drag-source)')]
    const newOrder = cards.map(card => card.dataset.id!).filter(Boolean)
    let insertion = 0
    for (const child of [...list.children]) {
      if (child === placeholder) break
      if (child !== this.dragSource && (child as HTMLElement).matches?.('.queue-card[data-id]')) insertion++
    }
    const dragged = this.draggedId
    if (dragged && insertion >= 0) newOrder.splice(insertion, 0, dragged)
    const orderChanged = newOrder.some((id, index) => id !== this.dragPreviewOrder[index])
    this.dragPreviewOrder = newOrder
    if (!orderChanged) return
    for (const [card, before] of beforeRects) {
      const afterRect = card.getBoundingClientRect()
      const dy = before.top - afterRect.top
      if (Math.abs(dy) < 1) continue
      card.animate([{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' }], {
        duration: 160, easing: 'cubic-bezier(.2,.75,.25,1)'
      })
    }
  }

  private dropOnQueueCard(event: DragEvent, targetId: string): void {
    event.preventDefault()
    this.finishQueueDrop(event, targetId)
  }

  private dropInQueueList(event: DragEvent): void {
    if (!this.draggedId) return
    event.preventDefault()
    this.finishQueueDrop(event)
  }

  private finishQueueDrop(event: DragEvent, targetId?: string): void {
    this.clearDropIndicators()
    const dragged = this.draggedId
    const state = this.getState()
    if (!dragged || dragged === state.currentTurnId || dragged === targetId ||
        !state.queue.some(entry => entry.id === dragged) ||
        (targetId !== undefined && !state.queue.some(entry => entry.id === targetId))) return

    const order = this.application.getPlayOrder().filter(entry => entry.id !== state.currentTurnId)
    const fromIndex = order.findIndex(entry => entry.id === dragged)
    const targetIndex = targetId === undefined ? 0 : order.findIndex(entry => entry.id === targetId)
    if (fromIndex < 0 || targetIndex < 0) return
    const position = this.dragPreviewOrder.indexOf(dragged) + 1
    if (position === fromIndex + 1) return
    if (position < 1) return
    if (state.frozenTurnIds.includes(dragged) || position <= state.frozenTurnIds.length) {
      showToast('Movimentação bloqueada: essa posição pertence ao bloco congelado.')
      return
    }

    const sessionId = state.currentSessionId
    if (!sessionId) return
    this.pendingManualMove = { id: dragged, position, sessionId }
    this.dragAwaitingConfirmation = true
    this.draggedId = null
    if (localStorage.getItem(this.manualMoveNoticeKey(sessionId)) === 'dismissed') {
      this.applyManualMove(false)
      return
    }
    getInput('manual-move-dismiss').checked = false
    this.modals.show('manual-move-modal')
  }

  private manualMoveNoticeKey(sessionId: string): string { return `kqueue-manual-move-notice:${sessionId}` }

  private cancelManualMove(): void {
    this.pendingManualMove = null
    this.modals.hide('manual-move-modal')
    this.restoreDragPreview()
  }

  private confirmManualMove(): void {
    this.applyManualMove(getInput('manual-move-dismiss').checked)
  }

  private async applyManualMove(dismissNotice: boolean): Promise<void> {
    const operationKey = 'applyManualMove'
    if (this.saving.has(operationKey)) return
    this.saving.add(operationKey)
    try {
      const pending = this.pendingManualMove
      this.pendingManualMove = null
      this.modals.hide('manual-move-modal')
      if (!pending || !(await this.application.moveTurn(pending.id, pending.position))) {
        this.restoreDragPreview()
        return
      }
      if (dismissNotice) localStorage.setItem(this.manualMoveNoticeKey(pending.sessionId), 'dismissed')
      this.queueView.clearBoostState(pending.id)
      this.finishDragPreview()
      this.queueView.render()
      const entry = this.getState().queue.find(item => item.id === pending.id)
      if (entry) showToast(`${entry.name} fixado(a) na posição ${pending.position} da fila.`)

    } catch (error) {
      this.restoreDragPreview()
      reportPersistenceFailure(error)
      return
    } finally { this.saving.delete(operationKey) }
  }

  private clearDropIndicators(): void {
    document.querySelectorAll('.drag-over, .drop-before, .drop-after').forEach(element => {
      element.classList.remove('drag-over', 'drop-before', 'drop-after')
    })
  }

  private restoreDragPreview(): void {
    if (!this.dragSource && !this.dragPlaceholder) return
    const list = getElement('queue-list')
    const source = this.dragSource
    const placeholder = this.dragPlaceholder
    placeholder?.remove()
    if (source) {
      source.classList.remove('drag-source', 'dragging')
      const currentCards = new Map([...list.querySelectorAll<HTMLElement>('.queue-card[data-id]')]
        .map(card => [card.dataset.id!, card] as const))
      const originalChildren = this.dragOriginalChildren.map(child =>
        child.classList.contains('queue-card') && child.dataset.id === source.dataset.id
          ? source
          : child.classList.contains('queue-card') && child.dataset.id
            ? currentCards.get(child.dataset.id) ?? child
            : child
      )
      originalChildren.forEach(child => list.appendChild(child))
    }
    this.resetDragPreviewState()
    const renderDeferred = this.queueView.endDragPreview()
    if (renderDeferred) this.queueView.render()
  }

  private finishDragPreview(): void {
    this.dragPlaceholder?.remove()
    this.dragSource?.classList.remove('drag-source', 'dragging')
    this.resetDragPreviewState()
    this.queueView.endDragPreview()
  }

  private resetDragPreviewState(): void {
    this.dragSource = null
    this.dragPlaceholder = null
    this.dragOriginalIds = []
    this.dragOriginalChildren = []
    this.dragPreviewOrder = []
    this.dragAwaitingConfirmation = false
  }

  private async dropOnCurrent(event: DragEvent): Promise<void> {
    const operationKey = 'dropOnCurrent'
    if (this.saving.has(operationKey)) return
    this.saving.add(operationKey)
    try {
      event.preventDefault()
      this.clearDropIndicators()
      const dragged = this.draggedId
      this.draggedId = null
      if (!dragged || dragged === this.getState().currentTurnId) { this.restoreDragPreview(); return }
      if (this.getState().frozenTurnIds.includes(dragged)) {
        showToast('Este turno está congelado e não pode ser promovido para a Vez atual.')
        this.restoreDragPreview()
        return
      }
      if (!this.getState().queue.some(entry => entry.id === dragged)) { this.restoreDragPreview(); return }
      if (!confirm(PROMOTE_TO_CURRENT_MSG)) { this.restoreDragPreview(); return }
      if (!(await this.application.promoteToCurrent(dragged))) { this.restoreDragPreview(); return }
      this.queueView.clearBoostState(dragged)
      this.finishDragPreview()
      this.queueView.render()

    } catch (error) {
      this.restoreDragPreview()
      reportPersistenceFailure(error)
      return
    } finally { this.saving.delete(operationKey) }
  }

  private openBatch(): void {
    this.batchRowCount = 0
    getElement('batch-rows').innerHTML = ''
    this.modals.show('batch-modal')
    this.addBatchRow(); this.addBatchRow(); this.addBatchRow()
    document.querySelector<HTMLInputElement>('.batch-row .b-name')?.focus()
  }

  private closeBatch(): void { this.modals.hide('batch-modal') }

  private addBatchRow(): void {
    const row = document.createElement('div')
    row.className = 'batch-row'
    row.dataset.idx = String(this.batchRowCount++)
    row.innerHTML = `
    <input type="text" placeholder="Nome do cantor" class="b-name" />
    <input type="text" inputmode="numeric" pattern="[0-9]*" placeholder="Ex: 1234" class="b-song" />
    <input type="text" inputmode="numeric" pattern="[0-9]*" placeholder="Ex: 5678" class="b-song2" />
    <input type="number" placeholder="Mesa" min="1" class="b-table" />
    <button type="button" class="btn-batch-remove" onclick="removeBatchRow(this)" title="Remover linha">✕</button>`
    row.querySelectorAll<HTMLInputElement>('.b-song, .b-song2').forEach(input => {
      input.addEventListener('keypress', event => { if (!/[0-9]/.test(event.key)) event.preventDefault() })
      input.addEventListener('input', () => { input.value = input.value.replace(/[^0-9]/g, '') })
    })
    row.querySelectorAll<HTMLInputElement>('input').forEach(input => input.addEventListener('input', () => this.updateBatchCount()))
    getElement('batch-rows').appendChild(row)
    this.updateBatchCount()
  }

  private removeBatchRow(button: HTMLButtonElement): void {
    const row = button.closest('.batch-row')
    if (!row || document.querySelectorAll('.batch-row').length === 1) return
    row.remove()
    this.updateBatchCount()
  }

  private completeBatchRows(): HTMLElement[] {
    return [...document.querySelectorAll<HTMLElement>('.batch-row')].filter(row => {
      const name = row.querySelector<HTMLInputElement>('.b-name')?.value.trim() ?? ''
      const song = row.querySelector<HTMLInputElement>('.b-song')?.value.trim() ?? ''
      const table = row.querySelector<HTMLInputElement>('.b-table')?.value.trim() ?? ''
      return name && song && table
    })
  }

  private updateBatchCount(): void {
    const count = this.completeBatchRows().length
    const label = getElement('batch-count-label')
    label.textContent = `${count} entrada${count !== 1 ? 's' : ''} pronta${count !== 1 ? 's' : ''}`
    label.style.color = count > 0 ? 'var(--success)' : 'var(--text-dim)'
  }

  private async confirmBatch(): Promise<void> {
    const operationKey = 'confirmBatch'
    if (this.saving.has(operationKey)) return
    this.saving.add(operationKey)
    try {
      const complete = this.completeBatchRows()
      if (complete.length === 0) {
        showToast('Nenhuma entrada completa para adicionar.')
        return
      }
      await this.application.addEntries(complete.map(row => ({
        name: row.querySelector<HTMLInputElement>('.b-name')?.value.trim() ?? '',
        songNumber: row.querySelector<HTMLInputElement>('.b-song')?.value.trim() ?? '',
        songNumber2: row.querySelector<HTMLInputElement>('.b-song2')?.value.trim() ?? '',
        table: row.querySelector<HTMLInputElement>('.b-table')?.value.trim() ?? ''
      })), true)
      this.queueView.render()
      this.historyView.render()
      this.closeBatch()
      showToast(`${complete.length} entrada${complete.length !== 1 ? 's' : ''} adicionada${complete.length !== 1 ? 's' : ''} à fila!`)

    } catch (error) {
      if (error instanceof PersistenceError && error.outcome === 'uncertain') this.uncertainBatch = true
      reportPersistenceFailure(error)
      return
    } finally { this.saving.delete(operationKey) }
  }
}
