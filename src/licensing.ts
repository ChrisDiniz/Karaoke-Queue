export const TRIAL_DURATION_MS = 15 * 24 * 60 * 60 * 1000
export const DAY_MS = 24 * 60 * 60 * 1000

export interface LicenseStatus {
  activated: boolean
  expired: boolean
  remainingMs: number
  checkedAt: number
}

export function calculateLicenseStatus(startedAt: number, activated: boolean, now: number): LicenseStatus {
  const elapsed = Math.max(0, now - startedAt)
  const remainingMs = activated ? 0 : Math.max(0, TRIAL_DURATION_MS - elapsed)
  return {
    activated,
    expired: !activated && remainingMs === 0,
    remainingMs,
    checkedAt: now
  }
}

export function normalizeActivationToken(value: unknown): string {
  return typeof value === 'string' ? value.trim().toUpperCase() : ''
}

export function trialLabel(status: LicenseStatus): string {
  if (status.expired) return 'Teste expirado'
  if (status.remainingMs < DAY_MS) return 'Teste · Menos de 1 dia'
  const days = Math.ceil(status.remainingMs / DAY_MS)
  return `Teste · ${days} ${days === 1 ? 'dia restante' : 'dias restantes'}`
}
