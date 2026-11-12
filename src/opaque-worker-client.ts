import { Worker } from 'node:worker_threads'
import path from 'node:path'

export type OpaqueWorkerOperation = 'player-register' | 'player-start' | 'player-finish' |
  'controller-start' | 'controller-finish' | 'controller-confirm-player-bind' | 'player-confirm-controller-bind'

export interface OpaqueWorkerRequest {
  operation: OpaqueWorkerOperation
  password?: string
  context?: unknown
  userIdentifier?: string
  ke1?: string
  ke2?: string
  ke3?: string
  playerBind?: string
  controllerBind?: string
}

export interface OpaqueWorkerPort {
  run<T>(request: OpaqueWorkerRequest): Promise<T>
  close(): Promise<void>
}

interface WorkerReply { id: number; result?: unknown; error?: string }

/** One Main-owned worker per attempt. Killing it fences late callbacks and discards OPAQUE state. */
export class MainOpaqueWorker implements OpaqueWorkerPort {
  private worker: Worker | undefined
  private requestId = 0
  private generation = 0
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  private closeTask: Promise<void> | undefined

  constructor(private readonly workerPath = path.join(__dirname, 'opaque-pairing-worker.js')) {}

  run<T>(request: OpaqueWorkerRequest): Promise<T> {
    if (this.closeTask) return Promise.reject(new Error('OPAQUE_WORKER_CLOSED'))
    const worker = this.ensureWorker()
    const id = ++this.requestId
    const generation = this.generation
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: value => generation === this.generation ? resolve(value as T) : reject(new Error('OPAQUE_WORKER_CANCELLED')),
        reject
      })
      try { worker.postMessage({ ...request, id }) }
      catch (error) { this.pending.delete(id); reject(error instanceof Error ? error : new Error('OPAQUE_WORKER_SEND_FAILED')) }
    })
  }

  async cancel(): Promise<void> {
    this.generation++
    const worker = this.worker
    this.worker = undefined
    for (const pending of this.pending.values()) pending.reject(new Error('OPAQUE_WORKER_CANCELLED'))
    this.pending.clear()
    if (worker) await worker.terminate()
  }

  close(): Promise<void> {
    if (!this.closeTask) this.closeTask = this.cancel()
    return this.closeTask
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker
    const worker = new Worker(this.workerPath, {
      name: 'kq-opaque-pairing',
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32 }
    })
    this.worker = worker
    const rejectAll = (code: string): void => {
      if (this.worker === worker) this.worker = undefined
      for (const pending of this.pending.values()) pending.reject(new Error(code))
      this.pending.clear()
    }
    worker.on('message', (message: WorkerReply) => {
      if (!message || !Number.isSafeInteger(message.id)) return
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (typeof message.error === 'string') pending.reject(new Error(message.error))
      else pending.resolve(message.result)
    })
    worker.once('error', () => rejectAll('OPAQUE_WORKER_FAILED'))
    worker.once('exit', code => {
      if (this.worker === worker) this.worker = undefined
      if (code !== 0) rejectAll('OPAQUE_WORKER_EXITED')
    })
    return worker
  }
}
