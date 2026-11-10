export interface MainIpcPolicyOptions {
  getExpectedWebContents(): Electron.WebContents | null | undefined
  getExpectedDocumentUrl(): string
  isEnabled(): boolean
  forbiddenCode: string
}

export type MainIpcEvent = Electron.IpcMainEvent | Electron.IpcMainInvokeEvent

/** Validates the live owner, main frame, and exact document before a Main IPC operation. */
export function createMainIpcPolicy(options: MainIpcPolicyOptions): (event: MainIpcEvent) => void {
  return event => {
    const expectedContents = options.getExpectedWebContents()
    const frame = event.senderFrame
    if (!options.isEnabled() || !expectedContents || expectedContents.isDestroyed() ||
        event.sender !== expectedContents || event.sender.isDestroyed() ||
        !frame || frame !== event.sender.mainFrame || frame.url !== options.getExpectedDocumentUrl()) {
      throw new Error(options.forbiddenCode)
    }
  }
}
