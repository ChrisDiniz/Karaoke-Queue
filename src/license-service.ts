import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { calculateLicenseStatus, normalizeActivationToken, type LicenseStatus } from './licensing'

const POLICY_VERSION = 1
const ACTIVATION_TOKEN_SHA256 = '28f78bf44c95b9d8429ff2fef1cd768d3a8ebf09ad6046d227b3ed1b32079761'

interface PersistedLicense {
  policyVersion: number
  trialStartedAt: number
  activated: boolean
}

export interface LicenseServiceOptions {
  now?: () => number
  writeAtomic?: (filePath: string, value: PersistedLicense) => void
}

function writeAtomically(filePath: string, value: PersistedLicense): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.${process.pid}.tmp`
  const descriptor = fs.openSync(temporaryPath, 'w', 0o600)
  try {
    fs.writeFileSync(descriptor, JSON.stringify(value), 'utf8')
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
  fs.renameSync(temporaryPath, filePath)
}

export class LocalLicenseService {
  private state: PersistedLicense
  private readonly now: () => number
  private readonly writeAtomic: (filePath: string, value: PersistedLicense) => void

  constructor(private readonly filePath: string, options: LicenseServiceOptions = {}) {
    this.now = options.now ?? Date.now
    this.writeAtomic = options.writeAtomic ?? writeAtomically
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<PersistedLicense>
      if (parsed.policyVersion !== POLICY_VERSION || !Number.isFinite(parsed.trialStartedAt) ||
          typeof parsed.activated !== 'boolean') {
        throw new Error('Local license state is invalid; refusing to restart the trial.')
      }
      this.state = { policyVersion: POLICY_VERSION, trialStartedAt: parsed.trialStartedAt!, activated: parsed.activated }
    } else {
      this.state = { policyVersion: POLICY_VERSION, trialStartedAt: this.now(), activated: false }
      this.writeAtomic(this.filePath, this.state)
    }
  }

  getStatus(): LicenseStatus {
    return calculateLicenseStatus(this.state.trialStartedAt, this.state.activated, this.now())
  }

  isOperationallyAllowed(): boolean {
    return !this.getStatus().expired
  }

  activate(token: unknown): LicenseStatus {
    const normalized = normalizeActivationToken(token)
    if (normalized.length !== 20 || !/^[A-Z0-9]{20}$/.test(normalized)) {
      throw new Error('INVALID_ACTIVATION_TOKEN')
    }
    const candidate = crypto.createHash('sha256').update(normalized, 'utf8').digest()
    const expected = Buffer.from(ACTIVATION_TOKEN_SHA256, 'hex')
    if (candidate.length !== expected.length || !crypto.timingSafeEqual(candidate, expected)) {
      throw new Error('INVALID_ACTIVATION_TOKEN')
    }

    const next = { ...this.state, activated: true }
    this.writeAtomic(this.filePath, next)
    this.state = next
    return this.getStatus()
  }
}
