import { timingSafeEqual } from 'node:crypto'
import type { RemoteAuthorizationPort, RemoteAuthorizedPeer } from './remote-contracts'
import { decodeBase64Url, encodeBase64Url, sha256 } from './pairing-crypto'
import { PairingStore } from './pairing-store'

/** G2 grants only the technical scope G1 requires to complete transport hello; no business routes are registered. */
export class PairingAuthorizationAdapter implements RemoteAuthorizationPort {
  private locallyFenced = false

  constructor(private readonly store: PairingStore) {}

  fenceImmediately(): void { this.locallyFenced = true }

  async revokeLocally(): Promise<void> {
    this.fenceImmediately()
    await this.store.transact(state => {
      const authority = state.playerAuthority
      if (!authority || authority.phase !== 'active') throw new Error('PAIRING_NOT_ACTIVE')
      state.authorityRevision++
      authority.phase = 'revoked'
      authority.credentialGeneration = state.authorityRevision
      authority.authorityRevision = state.authorityRevision
      // Uncommitted staging can be discarded; promotion journals must survive identity recovery.
      if (state.renewal?.phase === 'staged') state.renewal = null
      for (const journal of state.journals) {
        if (journal.role === 'player' && journal.pairingId === authority.pairingId) journal.phase = 'revoked'
      }
    })
  }

  async authorizeBearer(token: string, _connectionId: string, signal: AbortSignal): Promise<RemoteAuthorizedPeer | null> {
    if (this.locallyFenced || signal.aborted) return null
    let tokenBytes: Buffer
    try { tokenBytes = decodeBase64Url(token, 32) } catch { return null }
    try {
      const state = await this.store.read()
      if (this.locallyFenced || signal.aborted) return null
      const authority = state.playerAuthority
      if (!authority || authority.phase !== 'active' || authority.scopes.length !== 1 || authority.scopes[0] !== 'transport:control') return null
      await this.validateSecrets(authority)
      if ((await this.store.read()).storeRevision !== state.storeRevision) return null
      if (this.locallyFenced || signal.aborted) return null
      const expected = decodeBase64Url(authority.tokenHash, 32)
      const actual = sha256(tokenBytes)
      if (!timingSafeEqual(expected, actual)) return null
      return { controllerId: authority.controllerId, credentialGeneration: authority.credentialGeneration,
        scopes: ['transport:control'] }
    } catch { return null }
    finally { tokenBytes.fill(0) }
  }

  async isCurrent(peer: RemoteAuthorizedPeer, _connectionId: string, signal: AbortSignal): Promise<boolean> {
    if (this.locallyFenced || signal.aborted) return false
    try {
      const state = await this.store.read()
      if (this.locallyFenced || signal.aborted) return false
      const authority = state.playerAuthority
      if (authority) await this.validateSecrets(authority)
      if ((await this.store.read()).storeRevision !== state.storeRevision) return false
      if (this.locallyFenced || signal.aborted) return false
      return Boolean(authority && authority.phase === 'active' && authority.controllerId === peer.controllerId &&
        authority.credentialGeneration === peer.credentialGeneration && authority.scopes.length === 1 &&
        authority.scopes[0] === 'transport:control' && peer.scopes.length === 1 && peer.scopes[0] === 'transport:control')
    } catch { return false }
  }

  private async validateSecrets(authority: { encryptedToken: string; encryptedRecoveryRoot: string; tokenHash: string }): Promise<void> {
    const token = await this.store.decryptSecret(authority.encryptedToken)
    try {
      const root = await this.store.decryptSecret(authority.encryptedRecoveryRoot)
      try {
        if (token.length !== 32 || root.length !== 32 ||
            !timingSafeEqual(sha256(token), decodeBase64Url(authority.tokenHash, 32))) throw new Error('PAIRING_SECRET_INVALID')
      } finally { root.fill(0) }
    } finally { token.fill(0) }
  }
}

export function tokenHash(token: Uint8Array): string {
  if (token.byteLength !== 32) throw new Error('PAIRING_TOKEN_INVALID')
  return encodeBase64Url(sha256(token))
}
