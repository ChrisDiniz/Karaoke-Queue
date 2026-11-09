export interface RuntimeGateNative {
  acquireRuntime(): { status: string; code: number }
  releaseRuntime(): { status: string; code: number }
}

/** Owns the fixed process-wide mutex on the calling Electron Main thread. */
export class InstallationRuntimeGate {
  private held = true

  private constructor(private readonly native: RuntimeGateNative) {}

  static acquire(native: RuntimeGateNative): InstallationRuntimeGate {
    const result = native.acquireRuntime()
    if (result.status === 'abandoned') throw new Error('INSTALLATION_RUNTIME_RECOVERY_REQUIRED')
    if (result.status !== 'acquired') {
      throw new Error(`INSTALLATION_RUNTIME_LOCK_${result.status.toUpperCase()}:${result.code}`)
    }
    return new InstallationRuntimeGate(native)
  }

  release(): void {
    if (!this.held) return
    const result = this.native.releaseRuntime()
    if (result.status !== 'released') {
      throw new Error(`INSTALLATION_RUNTIME_RELEASE_${result.status.toUpperCase()}:${result.code}`)
    }
    this.held = false
  }
}
