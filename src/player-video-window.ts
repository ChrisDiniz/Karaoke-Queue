import { BrowserWindow, WebContentsView, type IpcMain, type WebContents } from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { ChromiumPlaybackHost } from './chromium-playback-host'
import type { PlayerPlaybackService } from './player-playback-service'

export type PlayerVideoLocation = 'hidden' | 'inline' | 'window'

export interface PlayerVideoBounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface PlayerVideoWindowSnapshot {
  readonly open: boolean
  readonly fullScreen: boolean
  readonly ready: boolean
  readonly location: PlayerVideoLocation
  /** Changes on each inline owner-window fullscreen transition. */
  readonly inlineLayoutRevision: number
  /** Monotonic signal for output-window X closing and returning this surface inline. */
  readonly returnToInlineRevision: number
}

export interface PlayerVideoWindowOptions {
  readonly ipcMain: IpcMain
  readonly playback: PlayerPlaybackService
  readonly getControlWindow: () => BrowserWindow | undefined
  readonly onChange?: () => void
  readonly preloadPath?: string
  readonly documentPath?: string
}

/** Owns one Chromium media view that can be embedded or detached without replacing its playback host. */
export class PlayerVideoWindow {
  private view: WebContentsView | undefined
  private host: ChromiumPlaybackHost | undefined
  private controlWebContents: WebContents | undefined
  private viewCreation: Promise<WebContentsView> | undefined
  private readonly hostReleasePromises = new WeakMap<ChromiumPlaybackHost, Promise<void>>()
  private hostRelease: Promise<void> = Promise.resolve()
  private mode: PlayerVideoLocation = 'hidden'
  private ownerWindow: BrowserWindow | undefined
  private outputWindow: BrowserWindow | undefined
  private allowClose = false
  private movingView = false
  private ready = false
  private disposed = false
  private inlineBounds: PlayerVideoBounds | undefined
  private inlineBoundsRevision = -1
  private inlineLayoutRevision = 0
  private focusAfterInlineLayoutRevision: number | undefined
  private inlineVisible = false
  private windowTipRequested = false
  private windowTipDismissedForRun = false
  private locationRevision = 0
  private returnToInlineRevision = 0
  private readonly observedWindows = new WeakSet<BrowserWindow>()
  private disposePromise: Promise<void> | undefined

  constructor(private readonly options: PlayerVideoWindowOptions) {}

  getSnapshot(): PlayerVideoWindowSnapshot {
    const window = this.ownerWindow
    const webContents = this.getPlaybackWebContents()
    const alive = Boolean(webContents && !webContents.isDestroyed() && !webContents.isCrashed())
    return {
      open: alive && this.mode !== 'hidden',
      fullScreen: Boolean(window && !window.isDestroyed() && window.isFullScreen()),
      ready: this.ready && alive,
      location: alive ? this.mode : 'hidden',
      inlineLayoutRevision: this.inlineLayoutRevision,
      returnToInlineRevision: this.returnToInlineRevision
    }
  }

  /** Attaches the existing media host to the Standalone document so video and approved overlays share one compositor. */
  async attachControlWindow(window: BrowserWindow, allowedDocumentUrl: string): Promise<void> {
    this.ensureNotDisposed()
    if (window.isDestroyed() || window.webContents.isDestroyed()) throw new Error('HOST_UNAVAILABLE')
    if (this.host || this.view || this.controlWebContents) throw new Error('HOST_ALREADY_ATTACHED')

    const webContents = window.webContents
    const host = new ChromiumPlaybackHost(this.options.ipcMain, webContents, allowedDocumentUrl)
    this.host = host
    this.controlWebContents = webContents
    this.ownerWindow = window
    this.mode = 'inline'
    this.inlineVisible = true
    this.observeWindow(window)
    const markRendererUnavailable = (): void => {
      if (this.controlWebContents !== webContents) return
      this.ready = false
      this.mode = 'hidden'
      this.inlineVisible = false
      this.options.onChange?.()
    }
    webContents.once('render-process-gone', markRendererUnavailable)
    webContents.once('destroyed', markRendererUnavailable)
    try {
      this.options.playback.attachHost(host)
    } catch (error) {
      this.host = undefined
      this.controlWebContents = undefined
      this.ownerWindow = undefined
      this.mode = 'hidden'
      host.dispose()
      throw error
    }

    await host.ready
    this.ensureNotDisposed()
    if (this.host !== host || webContents.isDestroyed()) throw new Error('HOST_TERMINATED')
    this.ready = true
    this.publishDisplayLocation('inline')
    this.publishFullscreenState(window.isFullScreen())
    this.options.onChange?.()
  }

  async showInline(bounds?: PlayerVideoBounds, focus = true): Promise<PlayerVideoWindowSnapshot> {
    const revision = ++this.locationRevision
    if (bounds) {
      this.inlineBounds = normalizeBounds(bounds)
      this.inlineBoundsRevision = this.inlineLayoutRevision
    }
    if (this.controlWebContents) {
      const controlWindow = this.options.getControlWindow()
      if (!controlWindow || controlWindow.isDestroyed() || controlWindow.webContents !== this.controlWebContents) {
        throw new Error('HOST_UNAVAILABLE')
      }
      if (revision !== this.locationRevision) return this.getSnapshot()
      this.ownerWindow = controlWindow
      this.mode = 'inline'
      this.inlineVisible = true
      this.publishDisplayLocation('inline')
      this.publishFullscreenState(controlWindow.isFullScreen())
      if (focus) {
        if (controlWindow.isMinimized()) controlWindow.restore()
        controlWindow.show()
        controlWindow.focus()
      }
      await this.host?.ready
      this.ensureNotDisposed()
      if (revision !== this.locationRevision) return this.getSnapshot()
      if (this.controlWebContents.isDestroyed() || this.controlWebContents.isCrashed()) throw new Error('HOST_TERMINATED')
      this.publishWindowTipState()
      this.options.onChange?.()
      return this.getSnapshot()
    }

    const view = await this.ensureView()
    this.ensureNotDisposed()
    if (revision !== this.locationRevision) return this.getSnapshot()
    const controlWindow = this.options.getControlWindow()
    if (!controlWindow || controlWindow.isDestroyed()) throw new Error('HOST_UNAVAILABLE')
    this.mode = 'inline'
    this.inlineVisible = true
    this.moveViewTo(controlWindow)
    this.applyInlineBounds()
    this.publishDisplayLocation('inline')
    this.publishFullscreenState(controlWindow.isFullScreen())
    if (focus) {
      if (controlWindow.isMinimized()) controlWindow.restore()
      controlWindow.show()
      controlWindow.focus()
    }
    await this.host?.ready
    this.ensureNotDisposed()
    if (revision !== this.locationRevision) return this.getSnapshot()
    if (view.webContents.isDestroyed()) throw new Error('HOST_TERMINATED')
    this.publishWindowTipState()
    this.options.onChange?.()
    return this.getSnapshot()
  }

  async setInlineBounds(bounds: PlayerVideoBounds, layoutRevision: number): Promise<boolean> {
    if (!Number.isSafeInteger(layoutRevision) || layoutRevision < 0 || layoutRevision !== this.inlineLayoutRevision) return false
    this.inlineBounds = normalizeBounds(bounds)
    this.inlineBoundsRevision = layoutRevision
    if (this.controlWebContents) {
      this.focusAfterInlineLayoutRevision = undefined
      return !this.controlWebContents.isDestroyed()
    }
    if (this.mode === 'inline') this.applyInlineBounds()
    if (this.mode === 'inline' && this.focusAfterInlineLayoutRevision === layoutRevision) {
      const owner = this.ownerWindow
      const view = this.view
      if (owner && !owner.isDestroyed() && view && !view.webContents.isDestroyed() && this.inlineVisible) {
        if (owner.isMinimized()) owner.restore()
        owner.focus()
        view.webContents.focus()
      }
      this.focusAfterInlineLayoutRevision = undefined
    }
    return true
  }

  /** Detaches the exact same media WebContents so playback is neither duplicated nor restarted. */
  async show(focus = true): Promise<PlayerVideoWindowSnapshot> {
    if (this.controlWebContents) return this.showInline(undefined, focus)
    const revision = ++this.locationRevision
    const view = await this.ensureView()
    this.ensureNotDisposed()
    if (revision !== this.locationRevision) return this.getSnapshot()
    await this.host?.ready
    this.ensureNotDisposed()
    if (revision !== this.locationRevision) return this.getSnapshot()
    if (view.webContents.isDestroyed()) throw new Error('HOST_TERMINATED')
    let window = this.outputWindow
    if (!window || window.isDestroyed()) window = this.createOutputWindow()
    this.mode = 'window'
    this.inlineVisible = false
    this.moveViewTo(window)
    this.fitOutputWindow()
    this.publishDisplayLocation('window')
    this.publishFullscreenState(window.isFullScreen())
    this.publishWindowTipState()
    if (window.isMinimized()) window.restore()
    if (!window.isVisible()) {
      if (focus) window.show()
      else window.showInactive()
    }
    if (focus) window.focus()
    this.options.onChange?.()
    return this.getSnapshot()
  }

  /** Prepares the trusted media WebContents without showing a video window or changing navigation. */
  async preparePlaybackHost(): Promise<void> {
    if (this.controlWebContents) {
      await this.host?.ready
      this.ensureNotDisposed()
      if (this.controlWebContents.isDestroyed() || this.controlWebContents.isCrashed() || !this.host) throw new Error('HOST_TERMINATED')
      return
    }
    const view = await this.ensureView()
    await this.host?.ready
    this.ensureNotDisposed()
    if (view.webContents.isDestroyed() || this.view !== view) throw new Error('HOST_TERMINATED')
  }

  /** Hides only an idle inline view; active media must remain visible in some window. */
  hideInline(): boolean {
    if (this.controlWebContents) {
      if (['playing', 'paused', 'loading', 'starting', 'ready', 'stopping'].includes(this.options.playback.getState().status)) return false
      this.mode = 'hidden'
      this.inlineVisible = false
      this.options.onChange?.()
      return true
    }
    if (this.mode !== 'inline' || !this.view) return true
    if (['playing', 'paused', 'loading', 'starting', 'ready', 'stopping'].includes(this.options.playback.getState().status)) return false
    this.locationRevision++
    const owner = this.ownerWindow
    if (owner && !owner.isDestroyed()) owner.contentView.removeChildView(this.view)
    this.view.setVisible(false)
    this.inlineVisible = false
    this.ownerWindow = undefined
    this.mode = 'hidden'
    this.options.onChange?.()
    return true
  }

  /** Hides only the inline surface while the operator uses the manual controls; media state is untouched. */
  setInlineVisible(visible: boolean): boolean {
    if (this.controlWebContents) {
      // The video is part of the Standalone document; panels must not hide its media layer.
      this.inlineVisible = true
      return !this.controlWebContents.isDestroyed() && !this.controlWebContents.isCrashed()
    }
    if (!visible) {
      this.locationRevision++
      this.inlineVisible = false
      if (this.mode !== 'inline' || !this.view || this.view.webContents.isDestroyed()) return true
      this.view.setVisible(false)
      this.options.onChange?.()
      return true
    }
    if (this.mode !== 'inline' || !this.view || this.view.webContents.isDestroyed()) return false
    this.inlineVisible = visible
    this.applyInlineBounds()
    this.options.onChange?.()
    return true
  }

  setFullScreen(sender: WebContents, action: unknown): boolean {
    const owner = this.ownerWindow
    if (!owner || owner.isDestroyed() || sender !== this.getPlaybackWebContents() || !['toggle', 'exit'].includes(String(action))) return false
    const value = action === 'toggle' ? !owner.isFullScreen() : false
    owner.setFullScreen(value)
    return owner.isFullScreen() === value
  }

  toggleFullScreenFromControl(): boolean {
    const owner = this.ownerWindow
    if (!owner || owner.isDestroyed()) return false
    owner.setFullScreen(!owner.isFullScreen())
    this.publishWindowTipState()
    this.options.onChange?.()
    return owner.isFullScreen()
  }

  exitFullScreenFromControl(): boolean {
    const owner = this.ownerWindow
    if (!owner || owner.isDestroyed()) return false
    owner.setFullScreen(false)
    this.publishWindowTipState()
    this.options.onChange?.()
    return !owner.isFullScreen()
  }

  allowWindowClose(): void { this.allowClose = true }

  publishDisplayStatus(status: 'idle' | 'loading' | 'playing' | 'paused' | 'failed' | 'uncertain'): void {
    const webContents = this.getPlaybackWebContents()
    if (!webContents || webContents.isDestroyed()) return
    webContents.send('player-playback:display-status', status)
  }

  setWindowTipVisible(visible: boolean): boolean {
    this.windowTipRequested = visible && !this.windowTipDismissedForRun
    this.publishWindowTipState()
    return true
  }

  dismissWindowTip(sender: WebContents): boolean {
    const webContents = this.getPlaybackWebContents()
    if (!webContents || webContents.isDestroyed() || sender !== webContents) return false
    this.windowTipRequested = false
    this.windowTipDismissedForRun = true
    this.publishWindowTipState()
    return true
  }

  private publishFullscreenState(fullScreen: boolean): void {
    const webContents = this.getPlaybackWebContents()
    if (webContents && !webContents.isDestroyed()) webContents.send('player-playback:fullscreen', fullScreen)
  }

  private publishWindowTipState(): void {
    const webContents = this.getPlaybackWebContents()
    if (!webContents || webContents.isDestroyed()) return
    const owner = this.ownerWindow
    const visible = this.windowTipRequested && this.mode === 'inline' &&
      Boolean(owner && !owner.isDestroyed() && !owner.isFullScreen())
    webContents.send('player-playback:window-tip', visible)
  }

  private publishDisplayLocation(location: Exclude<PlayerVideoLocation, 'hidden'>): void {
    const webContents = this.getPlaybackWebContents()
    if (webContents && !webContents.isDestroyed()) webContents.send('player-playback:display-location', location)
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise
    this.locationRevision++
    this.disposed = true
    this.viewCreation = undefined
    this.allowClose = true
    const host = this.host
    this.host = undefined
    const release = host ? this.releaseHost(host) : this.hostRelease
    const view = this.view
    this.view = undefined
    this.controlWebContents = undefined
    const owner = this.ownerWindow
    this.ownerWindow = undefined
    this.mode = 'hidden'
    this.inlineVisible = false
    if (owner && !owner.isDestroyed() && view) owner.contentView.removeChildView(view)
    if (view && !view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false })
    const output = this.outputWindow
    this.outputWindow = undefined
    if (output && !output.isDestroyed()) output.destroy()
    this.disposePromise = release
    return this.disposePromise
  }

  private ensureView(): Promise<WebContentsView> {
    if (this.disposed) return Promise.reject(new Error('HOST_UNAVAILABLE'))
    if (this.controlWebContents) return Promise.reject(new Error('INLINE_CONTROL_HOST_ACTIVE'))
    const currentView = this.view
    if (currentView && !currentView.webContents.isDestroyed() && !currentView.webContents.isCrashed()) {
      return this.hostRelease.then(() => {
        if (this.view === currentView && !currentView.webContents.isDestroyed() && !currentView.webContents.isCrashed()) {
          return currentView
        }
        return this.ensureView()
      })
    }
    if (this.viewCreation) return this.viewCreation

    const creation = this.createView()
    this.viewCreation = creation
    void creation.then(
      () => { if (this.viewCreation === creation) this.viewCreation = undefined },
      () => { if (this.viewCreation === creation) this.viewCreation = undefined }
    )
    return creation
  }

  private async createView(): Promise<WebContentsView> {
    const staleView = this.view
    const staleHost = this.host
    this.view = undefined
    this.host = undefined
    this.ready = false
    this.inlineVisible = false
    if (staleView) {
      const owner = this.ownerWindow
      if (owner && !owner.isDestroyed()) owner.contentView.removeChildView(staleView)
      if (!staleView.webContents.isDestroyed()) staleView.webContents.close({ waitForBeforeUnload: false })
    }
    this.ownerWindow = undefined
    if (staleHost) await this.releaseHost(staleHost)
    await this.hostRelease
    this.ensureNotDisposed()

    const documentPath = this.options.documentPath ?? path.join(__dirname, 'player-playback.html')
    const preloadPath = this.options.preloadPath ?? path.join(__dirname, '..', 'player-preload.js')
    const allowedDocumentUrl = pathToFileURL(documentPath).href
    const view = new WebContentsView({
      webPreferences: {
        preload: preloadPath,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true
      }
    })
    view.setBackgroundColor('#000000')
    view.setVisible(false)
    this.view = view
    this.ready = false
    let host: ChromiumPlaybackHost | undefined
    try {
      host = new ChromiumPlaybackHost(this.options.ipcMain, view.webContents, allowedDocumentUrl, async () => {
        return closePlaybackWebContents(view.webContents)
      })
      this.host = host
      this.options.playback.attachHost(host)
    } catch (error) {
      if (this.host === host) this.host = undefined
      if (host) void this.releaseHost(host).catch(() => undefined)
      if (this.view === view) this.view = undefined
      if (!view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false })
      throw error
    }
    view.webContents.on('render-process-gone', () => {
      this.ready = false
      if (this.host === host) this.host = undefined
      const owner = this.ownerWindow
      if (owner && !owner.isDestroyed()) owner.contentView.removeChildView(view)
      this.ownerWindow = undefined
      this.mode = 'hidden'
      this.inlineVisible = false
      const output = this.outputWindow
      if (output && !output.isDestroyed()) {
        this.allowClose = true
        output.close()
        this.allowClose = false
      }
      void this.releaseHost(host).catch(() => undefined)
      this.options.onChange?.()
    })
    view.webContents.once('destroyed', () => {
      this.ready = false
      if (this.view === view) this.view = undefined
      if (this.host === host) this.host = undefined
      void this.releaseHost(host).catch(() => undefined)
      this.options.onChange?.()
    })
    void view.webContents.loadFile(documentPath).catch(() => this.options.onChange?.())
    void host.ready.then(() => {
      if (this.view === view && !view.webContents.isDestroyed()) {
        this.ready = true
        if (this.mode === 'inline') this.applyInlineBounds()
        else if (this.mode === 'window') this.fitOutputWindow()
        this.options.onChange?.()
      }
    }, () => this.options.onChange?.())
    return view
  }

  private getPlaybackWebContents(): WebContents | undefined {
    const webContents = this.controlWebContents ?? this.view?.webContents
    return webContents && !webContents.isDestroyed() && !webContents.isCrashed() ? webContents : undefined
  }

  private ensureNotDisposed(): void {
    if (this.disposed) throw new Error('HOST_UNAVAILABLE')
  }

  private moveViewTo(window: BrowserWindow): void {
    const view = this.view
    if (!view) throw new Error('HOST_UNAVAILABLE')
    this.observeWindow(window)
    const previous = this.ownerWindow
    if (previous && !previous.isDestroyed() && previous !== window) previous.contentView.removeChildView(view)
    if (previous !== window || !window.contentView.children.includes(view)) window.contentView.addChildView(view)
    this.ownerWindow = window
    view.setVisible(true)
    if (previous && previous === this.outputWindow && previous !== window && !previous.isDestroyed()) {
      this.movingView = true
      previous.close()
      this.movingView = false
    }
  }

  private createOutputWindow(): BrowserWindow {
    const window = new BrowserWindow({
      width: 1280,
      height: 720,
      minWidth: 720,
      minHeight: 405,
      show: false,
      backgroundColor: '#000000',
      title: 'Karaoke Queue · Player',
      autoHideMenuBar: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true }
    })
    this.outputWindow = window
    this.observeWindow(window)
    window.on('close', event => {
      if (this.allowClose || this.movingView) return
      const view = this.view
      const controlWindow = this.options.getControlWindow()
      if (view && !view.webContents.isDestroyed() && controlWindow && !controlWindow.isDestroyed()) {
        event.preventDefault()
        this.returnOutputToInline(window, controlWindow, view)
        return
      }
      event.preventDefault()
      this.closeUnavailableOutput(window, view)
    })
    window.once('closed', () => {
      if (this.outputWindow === window) this.outputWindow = undefined
      this.options.onChange?.()
    })
    return window
  }

  private readonly fitOutputWindow = (): void => {
    const window = this.outputWindow
    const view = this.view
    if (!window || window.isDestroyed() || !view) return
    const bounds = window.getContentBounds()
    view.setBounds({ x: 0, y: 0, width: Math.max(1, bounds.width), height: Math.max(1, bounds.height) })
  }

  private returnOutputToInline(window: BrowserWindow, controlWindow: BrowserWindow, view: WebContentsView): void {
    this.locationRevision++
    this.returnToInlineRevision++
    this.movingView = true
    try {
      if (window.isFullScreen()) window.setFullScreen(false)
      if (window.contentView.children.includes(view)) window.contentView.removeChildView(view)
      controlWindow.contentView.addChildView(view)
      this.ownerWindow = controlWindow
      this.mode = 'inline'
      // Keep the view hidden until the control Renderer switches back to the Player area
      // and sends fresh inline bounds. The same WebContents and media attempt remain alive.
      this.inlineVisible = false
      view.setVisible(false)
      if (controlWindow.isMinimized()) controlWindow.restore()
      controlWindow.show()
      controlWindow.focus()
      this.publishDisplayLocation('inline')
      this.publishWindowTipState()
      this.options.onChange?.()
      window.destroy()
    } finally {
      this.movingView = false
    }
  }

  private closeUnavailableOutput(window: BrowserWindow, view: WebContentsView | undefined): void {
    this.locationRevision++
    if (view && !view.webContents.isDestroyed()) {
      if (window.contentView.children.includes(view)) window.contentView.removeChildView(view)
      view.setVisible(false)
      if (this.view === view) this.view = undefined
      if (this.ownerWindow === window) this.ownerWindow = undefined
      this.ready = false
      this.inlineVisible = false
      const host = this.host
      if (host) {
        this.host = undefined
        void this.releaseHost(host).catch(() => undefined)
      }
      view.webContents.close({ waitForBeforeUnload: false })
    }
    if (this.ownerWindow === window) this.ownerWindow = undefined
    this.mode = 'hidden'
    window.destroy()
    this.options.onChange?.()
  }

  private observeWindow(window: BrowserWindow): void {
    if (this.observedWindows.has(window)) return
    this.observedWindows.add(window)
    const updateOwner = (): void => {
      if (this.ownerWindow !== window || window.isDestroyed()) return
      if (this.mode === 'inline') this.applyInlineBounds()
      else if (this.mode === 'window') this.fitOutputWindow()
      this.options.onChange?.()
    }
    const updateFullscreenOwner = (): void => {
      if (this.ownerWindow !== window || window.isDestroyed()) return
      this.publishFullscreenState(window.isFullScreen())
      this.publishWindowTipState()
      if (this.mode === 'inline') {
        this.inlineLayoutRevision++
        this.inlineBoundsRevision = -1
        this.focusAfterInlineLayoutRevision = this.inlineLayoutRevision
        this.view?.setVisible(false)
      } else if (this.mode === 'window') {
        this.fitOutputWindow()
      }
      this.options.onChange?.()
    }
    window.on('resize', updateOwner)
    window.on('maximize', updateOwner)
    window.on('unmaximize', updateOwner)
    window.on('enter-full-screen', updateFullscreenOwner)
    window.on('leave-full-screen', updateFullscreenOwner)
  }

  private applyInlineBounds(): void {
    const view = this.view
    const owner = this.ownerWindow
    if (!view || !owner || owner.isDestroyed() || this.mode !== 'inline') return
    const bounds = this.inlineBounds
    if (!bounds || this.inlineBoundsRevision !== this.inlineLayoutRevision || bounds.width < 1 || bounds.height < 1) {
      view.setVisible(false)
      return
    }
    const zoomFactor = owner.webContents.getZoomFactor()
    view.setBounds({
      x: Math.round(bounds.x * zoomFactor),
      y: Math.round(bounds.y * zoomFactor),
      width: Math.round(bounds.width * zoomFactor),
      height: Math.round(bounds.height * zoomFactor)
    })
    view.setVisible(this.inlineVisible)
  }

  private releaseHost(host: ChromiumPlaybackHost): Promise<void> {
    let release = this.hostReleasePromises.get(host)
    if (!release) {
      host.dispose()
      release = this.options.playback.releaseHost(host.hostEpoch)
      this.hostReleasePromises.set(host, release)
    }
    this.hostRelease = release
    return release
  }
}

function closePlaybackWebContents(webContents: WebContents): Promise<boolean> {
  if (webContents.isDestroyed()) return Promise.resolve(true)
  return new Promise(resolve => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      webContents.removeListener('destroyed', finish)
      resolve(webContents.isDestroyed())
    }
    const timer = setTimeout(finish, 2500)
    timer.unref()
    webContents.once('destroyed', finish)
    webContents.close({ waitForBeforeUnload: false })
    if (webContents.isDestroyed()) finish()
  })
}

function normalizeBounds(value: PlayerVideoBounds): PlayerVideoBounds {
  if (!value || !Number.isFinite(value.x) || !Number.isFinite(value.y) ||
      !Number.isFinite(value.width) || !Number.isFinite(value.height) ||
      Math.abs(value.x) > 10000 || Math.abs(value.y) > 10000 ||
      value.width < 0 || value.width > 10000 || value.height < 0 || value.height > 10000) {
    throw new Error('INVALID_PLAYER_VIEW_BOUNDS')
  }
  return { x: Math.round(value.x), y: Math.round(value.y), width: Math.round(value.width), height: Math.round(value.height) }
}
