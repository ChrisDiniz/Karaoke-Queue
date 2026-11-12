import type { safeStorage } from 'electron'

export interface DecryptedSecret {
  plaintext: string
  ciphertext: Uint8Array
  shouldReEncrypt: boolean
}

export interface SecretProtector {
  assertAvailable(): Promise<void>
  encrypt(plaintext: string): Promise<Uint8Array>
  decrypt(ciphertext: Uint8Array): Promise<DecryptedSecret>
}

export interface SafeStoragePort {
  isAsyncEncryptionAvailable(): Promise<boolean>
  isEncryptionAvailable(): boolean
  getSelectedStorageBackend(): string
  encryptStringAsync(value: string): Promise<Buffer>
  decryptStringAsync(value: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

const SECURE_LINUX_BACKENDS = new Set(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'])

/** Uses the platform's native safeStorage APIs; there is deliberately no plaintext fallback. */
export class ElectronSafeStorageSecretProtector implements SecretProtector {
  constructor(
    private readonly storage: SafeStoragePort = require('electron').safeStorage as typeof safeStorage,
    private readonly platform: NodeJS.Platform = process.platform
  ) {}

  async assertAvailable(): Promise<void> {
    if (this.platform === 'win32') {
      if (!(await this.storage.isAsyncEncryptionAvailable())) throw new Error('SECRET_STORAGE_UNAVAILABLE')
      return
    }
    if (this.platform === 'linux') {
      if (!SECURE_LINUX_BACKENDS.has(this.storage.getSelectedStorageBackend()) ||
          !this.storage.isEncryptionAvailable()) {
        throw new Error('SECRET_STORAGE_UNAVAILABLE')
      }
      return
    }
    throw new Error('SECRET_STORAGE_UNSUPPORTED')
  }

  async encrypt(plaintext: string): Promise<Uint8Array> {
    await this.assertAvailable()
    if (this.platform === 'win32') return this.storage.encryptStringAsync(plaintext)
    return this.storage.encryptString(plaintext)
  }

  async decrypt(ciphertext: Uint8Array): Promise<DecryptedSecret> {
    await this.assertAvailable()
    const encrypted = Buffer.from(ciphertext)
    if (this.platform === 'win32') {
      const result = await this.storage.decryptStringAsync(encrypted)
      if (typeof result.result !== 'string' || typeof result.shouldReEncrypt !== 'boolean') {
        throw new Error('SECRET_STORAGE_RESULT_INVALID')
      }
      if (!result.shouldReEncrypt) return { plaintext: result.result, ciphertext: encrypted, shouldReEncrypt: false }
      return {
        plaintext: result.result,
        ciphertext: await this.storage.encryptStringAsync(result.result),
        shouldReEncrypt: true
      }
    }
    return { plaintext: this.storage.decryptString(encrypted), ciphertext: encrypted, shouldReEncrypt: false }
  }
}
