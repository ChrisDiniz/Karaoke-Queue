import { contextBridge, ipcRenderer } from 'electron'
import type { PlayerPlaybackHostCommand, PlayerPlaybackHostEvent, PlayerPlaybackMediaObservation } from './src/player-playback-contracts'

interface RendererPlaybackEvent {
  attemptId: string
  sequenceNumber: number
  observation: PlayerPlaybackMediaObservation
}

const api = Object.freeze({
  onCommand(listener: (command: PlayerPlaybackHostCommand) => void): void {
    ipcRenderer.on('player-playback:command', (_event, payload: unknown) => {
      if (payload && typeof payload === 'object') listener(payload as PlayerPlaybackHostCommand)
    })
  },
  sendEvent(event: RendererPlaybackEvent): void {
    ipcRenderer.send('player-playback:event', event)
  },
  async acknowledge(commandId: string, attemptId: string, accepted: boolean): Promise<void> {
    await ipcRenderer.invoke('player-playback:acknowledge', { commandId, attemptId, accepted })
  },
  async ready(): Promise<void> {
    await ipcRenderer.invoke('player-playback:ready')
  },
  async toggleFullScreen(): Promise<boolean> {
    return await ipcRenderer.invoke('player-video:set-fullscreen', 'toggle') as boolean
  },
  async exitFullScreen(): Promise<boolean> {
    return await ipcRenderer.invoke('player-video:set-fullscreen', 'exit') as boolean
  },
  async dismissWindowTip(permanentlyDismissed: boolean): Promise<boolean> {
    return await ipcRenderer.invoke('player-video:window-tip-dismissed', permanentlyDismissed) as boolean
  },
  onWindowTipState(listener: (visible: boolean) => void): void {
    ipcRenderer.on('player-playback:window-tip', (_event, visible: unknown) => {
      if (typeof visible === 'boolean') listener(visible)
    })
  },
  onDisplayStatus(listener: (status: 'idle' | 'loading' | 'playing' | 'paused' | 'failed' | 'uncertain') => void): void {
    ipcRenderer.on('player-playback:display-status', (_event, status: unknown) => {
      if (['idle', 'loading', 'playing', 'paused', 'failed', 'uncertain'].includes(String(status))) {
        listener(status as 'idle' | 'loading' | 'playing' | 'paused' | 'failed' | 'uncertain')
      }
    })
  },
  onDisplayLocation(listener: (location: 'inline' | 'window') => void): void {
    ipcRenderer.on('player-playback:display-location', (_event, location: unknown) => {
      if (location === 'inline' || location === 'window') listener(location)
    })
  },
  onFullscreenChange(listener: (fullScreen: boolean) => void): void {
    ipcRenderer.on('player-playback:fullscreen', (_event, fullScreen: unknown) => {
      if (typeof fullScreen === 'boolean') listener(fullScreen)
    })
  }
})

contextBridge.exposeInMainWorld('playerPlayback', api)

export type PlayerPlaybackRendererBridge = typeof api
