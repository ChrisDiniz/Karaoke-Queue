import { getElement } from './dom'

type GroupConfig = {
  triggerId: string
  panelId: string
  mainPage?: () => void
}

/** Owns transient navigation presentation state; business state remains in the application. */
export class Navigation {
  private expanded = false
  private expandedGroups = new Set<string>()
  private openFlyoutId: string | null = null
  private flyoutOpenedByFocus = false
  private suppressFocusOpen = false
  private closeTimer: ReturnType<typeof setTimeout> | null = null
  private bound = false

  constructor(
    private readonly openHistory: () => void,
    private readonly closeHistory: () => void,
    private readonly openSettings: () => void,
    private readonly closeSettings: () => void,
    private readonly openPreviousSessions: () => void,
    private readonly closePreviousSessions: () => void
  ) {}

  bind(): void {
    if (this.bound) return
    this.bound = true
    const sidebar = getElement('app-sidebar')
    const toggle = getElement<HTMLButtonElement>('btn-sidebar-toggle')

    const groups = this.groupConfigs()

    toggle.addEventListener('click', () => this.setExpanded(!this.expanded))
    for (const group of groups) this.bindGroup(group)

    getElement('nav-queue-current').addEventListener('click', () => this.openQueue())
    getElement('nav-current-session').addEventListener('click', () => this.openCurrentSession())
    getElement('nav-previous-sessions').addEventListener('click', () => this.openPreviousSessionList())
    getElement('nav-settings').addEventListener('click', () => {
      this.closeAllFlyouts()
      this.setActive('nav-settings')
      this.closeHistory()
      this.closePreviousSessions()
      this.openSettings()
      this.setExpanded(false)
    })

    document.addEventListener('pointerdown', event => {
      if (this.openFlyoutId) {
        const group = groups.find(item => item.triggerId === this.openFlyoutId)
        if (group && !getElement(group.triggerId).contains(event.target as Node)
          && !getElement(group.panelId).contains(event.target as Node)) this.closeFlyout(group)
      }
      if (this.expanded && !sidebar.contains(event.target as Node)) this.setExpanded(false)
    })
    document.addEventListener('focusin', event => {
      if (!this.openFlyoutId) return
      const group = groups.find(item => item.triggerId === this.openFlyoutId)
      if (group && !getElement(group.triggerId).contains(event.target as Node)
        && !getElement(group.panelId).contains(event.target as Node)) this.closeFlyout(group)
    })
    document.addEventListener('pointerover', event => {
      if (!this.openFlyoutId) return
      const target = event.target as Element
      if (!target.closest('.sidebar-item')) return
      const activeGroup = groups.find(item => item.triggerId === this.openFlyoutId)
      if (!activeGroup) return
      const inActiveRegion = getElement(activeGroup.triggerId).contains(target)
        || getElement(activeGroup.panelId).contains(target)
      if (inActiveRegion) return
      const inOtherGroup = groups.some(item => getElement(item.triggerId).contains(target)
        || getElement(item.panelId).contains(target))
      if (!inOtherGroup) this.closeFlyout(activeGroup)
    })
    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return
      if (this.openFlyoutId) {
        const group = groups.find(item => item.triggerId === this.openFlyoutId)
        if (!group) return
        event.preventDefault()
        this.closeFlyout(group)
        this.suppressFocusOpen = true
        getElement<HTMLButtonElement>(group.triggerId).focus()
        this.suppressFocusOpen = false
      } else if (this.expanded) this.setExpanded(false)
    })
    window.addEventListener('resize', () => {
      if (!this.openFlyoutId) return
      const group = groups.find(item => item.triggerId === this.openFlyoutId)
      if (group) this.positionFlyout(group)
    })
  }

  private bindGroup(group: GroupConfig): void {
    const trigger = getElement<HTMLButtonElement>(group.triggerId)
    const panel = getElement(group.panelId)
    const enabled = () => !this.expanded && !this.suppressFocusOpen
    trigger.addEventListener('pointerenter', () => { if (enabled()) this.openFlyout(group, false) })
    trigger.addEventListener('pointerleave', event => {
      if (!panel.contains(event.relatedTarget as Node | null)) this.scheduleClose(group)
    })
    trigger.addEventListener('focus', () => { if (enabled()) this.openFlyout(group, true) })
    trigger.addEventListener('click', event => {
      if (!this.expanded) {
        // The collapsed icon is always a direct route, even while its hover flyout is open.
        if (group.mainPage) {
          this.closeFlyout(group)
          group.mainPage()
        }
        return
      }
      const target = event.target as Element
      if (target.closest('.sidebar-chevron') || !target.closest('svg')) {
        this.setGroupExpanded(group.triggerId, !this.expandedGroups.has(group.triggerId))
      } else group.mainPage?.()
    })
    trigger.addEventListener('keydown', event => {
      if (!this.expanded && event.key === 'ArrowDown') {
        event.preventDefault()
        this.openFlyout(group, true)
        const first = panel.querySelector<HTMLButtonElement>('button:not(:disabled)')
        first?.focus()
      }
    })
    panel.addEventListener('pointerenter', () => this.cancelClose())
    panel.addEventListener('pointerleave', event => {
      if (!trigger.contains(event.relatedTarget as Node | null)) this.scheduleClose(group)
    })
    panel.addEventListener('keydown', event => this.navigateFlyoutByKeyboard(event, panel))
  }

  private openQueue(): void {
    this.closeAllFlyouts()
    this.setActive('nav-dashboard')
    this.closeHistory()
    this.closePreviousSessions()
    this.closeSettings()
    this.setExpanded(false)
  }

  private openCurrentSession(): void {
    this.closeAllFlyouts()
    this.setActive('nav-current-session')
    this.closeSettings()
    this.closePreviousSessions()
    this.openHistory()
    this.setExpanded(false)
  }

  private openPreviousSessionList(): void {
    this.closeAllFlyouts()
    this.setActive('nav-previous-sessions')
    this.closeHistory()
    this.closeSettings()
    this.openPreviousSessions()
    this.setExpanded(false)
  }

  activatePreviousSessions(): void {
    this.closeAllFlyouts()
    this.setActive('nav-previous-sessions')
  }

  private setExpanded(expanded: boolean): void {
    this.expanded = expanded
    const sidebar = getElement('app-sidebar')
    const toggle = getElement<HTMLButtonElement>('btn-sidebar-toggle')
    sidebar.classList.toggle('is-expanded', expanded)
    toggle.setAttribute('aria-expanded', String(expanded))
    toggle.setAttribute('aria-label', expanded ? 'Recolher menu' : 'Expandir menu')
    toggle.title = expanded ? 'Recolher menu' : 'Expandir menu'
    if (!expanded) this.expandedGroups.clear()
    this.closeAllFlyouts()
    for (const id of this.groupIds()) {
      const group = this.groupConfig(id)
      if (group) this.syncGroup(group)
    }
  }

  private setGroupExpanded(triggerId: string, expanded: boolean): void {
    if (expanded) this.expandedGroups.add(triggerId)
    else this.expandedGroups.delete(triggerId)
    const group = this.groupConfig(triggerId)
    if (group) {
      this.closeFlyout(group)
      this.syncGroup(group)
    }
  }

  private groupConfigs(): GroupConfig[] {
    return [
      { triggerId: 'nav-dashboard', panelId: 'sidebar-queue-submenu', mainPage: () => this.openQueue() },
      { triggerId: 'nav-playback', panelId: 'sidebar-playback-submenu' },
      { triggerId: 'nav-history', panelId: 'sidebar-history-submenu', mainPage: () => this.openCurrentSession() }
    ]
  }

  private groupIds(): string[] { return this.groupConfigs().map(group => group.triggerId) }
  private groupConfig(triggerId: string): GroupConfig | undefined {
    return this.groupConfigs().find(group => group.triggerId === triggerId)
  }

  private openFlyout(group: GroupConfig, openedByFocus: boolean): void {
    if (this.expanded) return
    this.cancelClose()
    if (this.openFlyoutId !== group.triggerId) this.flyoutOpenedByFocus = openedByFocus
    this.openFlyoutId = group.triggerId
    this.syncAllGroups()
    this.positionFlyout(group)
  }

  private closeFlyout(group: GroupConfig): void {
    this.cancelClose()
    if (this.openFlyoutId === group.triggerId) this.openFlyoutId = null
    this.syncGroup(group)
  }

  private closeAllFlyouts(): void {
    this.cancelClose()
    this.openFlyoutId = null
    this.syncAllGroups()
  }

  private syncAllGroups(): void {
    for (const id of this.groupIds()) {
      const group = this.groupConfig(id)
      if (group) this.syncGroup(group)
    }
  }

  private syncGroup(group: GroupConfig): void {
    const trigger = getElement<HTMLButtonElement>(group.triggerId)
    const panel = getElement(group.panelId)
    const visible = this.expanded ? this.expandedGroups.has(group.triggerId) : this.openFlyoutId === group.triggerId
    trigger.setAttribute('aria-expanded', String(visible))
    panel.hidden = !visible
    panel.setAttribute('aria-hidden', String(!visible))
  }

  private scheduleClose(group: GroupConfig): void {
    this.cancelClose()
    this.closeTimer = setTimeout(() => {
      this.closeTimer = null
      const active = document.activeElement
      const trigger = getElement(group.triggerId)
      const panel = getElement(group.panelId)
      if (panel.contains(active) || (this.flyoutOpenedByFocus && trigger.contains(active))) return
      this.closeFlyout(group)
    }, 180)
  }

  private cancelClose(): void {
    if (this.closeTimer === null) return
    clearTimeout(this.closeTimer)
    this.closeTimer = null
  }

  private positionFlyout(group: GroupConfig): void {
    const trigger = getElement(group.triggerId)
    const panel = getElement(group.panelId)
    const anchor = trigger.getBoundingClientRect()
    const bounds = panel.getBoundingClientRect()
    const gap = 8, margin = 8
    panel.style.left = `${Math.max(margin, Math.min(anchor.right + gap, window.innerWidth - bounds.width - margin))}px`
    panel.style.top = `${Math.max(margin, Math.min(anchor.top, window.innerHeight - bounds.height - margin))}px`
  }

  private navigateFlyoutByKeyboard(event: KeyboardEvent, panel: HTMLElement): void {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const items = [...panel.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
    if (!items.length) return
    const current = items.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : event.key === 'ArrowDown' ? (current + 1) % items.length : (current <= 0 ? items.length - 1 : current - 1)
    event.preventDefault()
    items[next].focus()
  }

  private setActive(id: 'nav-dashboard' | 'nav-current-session' | 'nav-previous-sessions' | 'nav-settings'): void {
    for (const item of document.querySelectorAll('.sidebar-item')) {
      item.classList.remove('is-active')
      item.removeAttribute('aria-current')
    }
    const selected = getElement(id)
    selected.classList.add('is-active')
    selected.setAttribute('aria-current', 'page')
    if (id === 'nav-dashboard') {
      const group = getElement('nav-dashboard')
      group.classList.add('is-active')
      group.setAttribute('aria-current', 'true')
      getElement('nav-queue-current').classList.add('is-active')
      getElement('nav-queue-current').setAttribute('aria-current', 'page')
    } else if (id === 'nav-current-session' || id === 'nav-previous-sessions') {
      getElement('nav-history').classList.add('is-active')
      getElement('nav-history').setAttribute('aria-current', 'true')
    }
  }
}
