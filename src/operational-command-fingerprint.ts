import { createHash } from 'node:crypto'
import type { OperationalCommandBody } from './operational-protocol-contracts'

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    return Object.fromEntries(Object.keys(record).sort().map(key => [key, canonical(record[key])]))
  }
  return value
}

/** Shared semantic digest; operationId is the lookup key, type/target/payload define the intent. */
export function operationalCommandFingerprint(command: OperationalCommandBody): string {
  const semantic = { protocolVersion: 1, schemaVersion: 1, type: command.type,
    target: command.target, payload: command.payload }
  return createHash('sha256').update(JSON.stringify(canonical(semantic)), 'utf8').digest('hex')
}
