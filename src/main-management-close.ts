import type { FileLogger } from './logging'

export interface ManagementCloseSummary {
  sessionActive: boolean
  uncompletedCount: number
  sessionId: string | null
}

/** Explicit local ports for the Main-owned Management host and window lifecycle. */
export interface ManagementClosePort {
  prepareToClose(): Promise<unknown>
  closeSummary(): Promise<ManagementCloseSummary>
  flushState(): Promise<unknown>
  endSessionAndArchive(): Promise<unknown>
  cancelClose(): Promise<unknown>
}

export interface MainManagementCloseDependencies {
  getPort(): ManagementClosePort
  isWindowDestroyed(): boolean
  showMessageBox(options: Electron.MessageBoxOptions): Promise<Electron.MessageBoxReturnValue>
  isStartupComplete(): boolean
  isLicenseOperationallyAllowed(): boolean
  closeWindow(): void
  logger: Pick<FileLogger, 'info' | 'error'>
}

/** Coordinates the existing close decisions; it neither owns the window nor the application state. */
export class MainManagementCloseCoordinator {
  private closeFlowRunning = false
  private allowWindowClose = false

  constructor(private readonly deps: MainManagementCloseDependencies) {}

  handleClose(event: Electron.Event): void {
    if (this.allowWindowClose) return
    if (!this.deps.isStartupComplete()) {
      this.allowWindowClose = true
      return
    }
    event.preventDefault()
    if (this.closeFlowRunning) return
    this.closeFlowRunning = true
    this.deps.logger.info('main', 'APP_CLOSE_REQUESTED', 'O operador solicitou o fechamento do aplicativo.')

    void (async () => {
      const port = this.deps.getPort()
      await port.prepareToClose()
      const closeSummary = await port.closeSummary()
      if (!this.deps.isLicenseOperationallyAllowed()) {
        await port.flushState()
        this.deps.logger.info('main', 'APP_CLOSE_DECISION', 'O aplicativo expirado foi fechado sem encerrar nem modificar a sessão.', {
          sessionId: closeSummary.sessionId, sessionRemainsOpen: closeSummary.sessionActive
        })
        this.closeAfterPersisting()
        return
      }
      if (!closeSummary.sessionActive) {
        await port.flushState()
        this.deps.logger.info('main', 'APP_CLOSE_DECISION', 'O aplicativo foi fechado sem sessão ativa.')
        this.closeAfterPersisting()
        return
      }

      const { response } = await this.deps.showMessageBox({
        type: 'question',
        title: 'Karaoke Queue',
        message: 'Como deseja fechar o aplicativo?',
        buttons: ['Encerrar sessão e sair', 'Sair sem encerrar sessão', 'Cancelar'],
        defaultId: 2,
        cancelId: 2
      })
      if (response === 2) {
        this.deps.logger.info('main', 'APP_CLOSE_CANCELLED', 'O operador cancelou o fechamento do aplicativo.')
        return
      }

      if (response === 0) {
        this.deps.logger.info('session', 'SESSION_CLOSE_REQUESTED', 'O operador solicitou o encerramento da sessão.', {
          sessionId: closeSummary.sessionId
        })
        if (closeSummary.uncompletedCount > 0) {
          const count = closeSummary.uncompletedCount
          const label = count === 1 ? 'apresentação não concluída' : 'apresentações não concluídas'
          const confirmation = await this.deps.showMessageBox({
            type: 'warning',
            title: 'Confirmar encerramento da sessão',
            message: `Há ${count} ${label}, incluindo a Vez atual se estiver selecionada.`,
            detail: 'Elas serão arquivadas como pendentes no histórico da sessão. A nova sessão não herdará essa fila.',
            buttons: ['Encerrar e arquivar pendências', 'Voltar ao aplicativo'],
            defaultId: 1,
            cancelId: 1
          })
          if (confirmation.response !== 0) {
            this.deps.logger.info('session', 'SESSION_CLOSE_CANCELLED', 'O operador cancelou a confirmação de encerramento.', {
              sessionId: closeSummary.sessionId
            })
            return
          }
        }
        const ended = await port.endSessionAndArchive()
        if (ended !== true) throw new Error('A sessão ativa não foi encerrada.')
        this.deps.logger.info('session', 'SESSION_ENDED', 'A sessão foi encerrada e arquivada.', { sessionId: closeSummary.sessionId })
        this.deps.logger.info('session', 'SESSION_PERSISTED', 'O encerramento da sessão foi confirmado no banco.', { sessionId: closeSummary.sessionId })
      } else {
        await port.flushState()
        this.deps.logger.info('main', 'APP_CLOSE_DECISION', 'O operador saiu sem encerrar a sessão.', {
          sessionId: closeSummary.sessionId, sessionRemainsOpen: closeSummary.sessionActive
        })
      }

      this.closeAfterPersisting()
    })().catch(error => this.showCloseError(error)).finally(() => {
      this.closeFlowRunning = false
      if (!this.allowWindowClose && !this.deps.isWindowDestroyed()) {
        void this.deps.getPort().cancelClose().catch(() => undefined)
      }
    })
  }

  private closeAfterPersisting(): void {
    this.allowWindowClose = true
    this.deps.closeWindow()
  }

  private async showCloseError(error: unknown): Promise<void> {
    this.deps.logger.error('main', 'APP_CLOSE_FLOW_FAILED', 'Falha durante o fluxo de fechamento.', error)
    this.deps.logger.error('main', 'APP_CLOSE_PERSISTENCE_FAILED', 'O aplicativo não fechou porque a persistência falhou.', error)
    if (this.deps.isWindowDestroyed()) return
    const detail = error instanceof Error ? error.message : String(error)
    await this.deps.showMessageBox({
      type: 'error', title: 'Não foi possível fechar o Karaoke Queue',
      message: 'Os dados da sessão não foram confirmados no banco.',
      detail: `${detail}\n\nO aplicativo permanecerá aberto para proteger a sessão.`,
      buttons: ['Voltar ao aplicativo'], defaultId: 0
    }).catch(() => undefined)
  }
}
