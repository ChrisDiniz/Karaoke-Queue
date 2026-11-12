import { createHash, createPrivateKey, createPublicKey, X509Certificate } from 'node:crypto'
import https from 'node:https'
import tls from 'node:tls'
import { generate } from 'selfsigned'

const DAY_MS = 24 * 60 * 60 * 1000
const SAN_PREFIX = 'player-'
const SAN_SUFFIX = '.karaoke.invalid'

export interface PlayerCertificateBundle {
  privateKeyPem: string
  certificatePem: string
  fingerprintSha256: string
  serverName: string
  serialNumber: string
}

export interface PinnedCertificate {
  certificatePem: string
  fingerprintSha256: string
  serverName: string
}

function fingerprintDer(der: Uint8Array): string {
  return createHash('sha256').update(der).digest('hex')
}

function parseCertificate(certificatePem: string): X509Certificate {
  try { return new X509Certificate(certificatePem) }
  catch { throw new Error('REMOTE_CERTIFICATE_INVALID') }
}

function certificateServerName(certificate: X509Certificate): string {
  const names = certificate.subjectAltName?.split(/,\s*/) ?? []
  const dnsNames = names.filter(value => value.startsWith('DNS:')).map(value => value.slice(4))
  if (dnsNames.length !== 1 || !/^player-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.karaoke\.invalid$/i.test(dnsNames[0])) {
    throw new Error('REMOTE_CERTIFICATE_SAN_INVALID')
  }
  return dnsNames[0]
}

export function validatePlayerCertificate(
  certificatePem: string,
  privateKeyPem?: string,
  expectedDeviceId?: string,
  now = new Date(),
  allowExpiredForLocalRenewal = false
): PinnedCertificate & { serialNumber: string } {
  const certificate = parseCertificate(certificatePem)
  const serialHex = certificate.serialNumber.replace(/:/g, '')
  if (!/^[0-9a-f]+$/i.test(serialHex) || BigInt(`0x${serialHex}`) <= 0n) {
    throw new Error('REMOTE_CERTIFICATE_SERIAL_INVALID')
  }
  if (certificate.ca || certificate.publicKey.asymmetricKeyType !== 'rsa' ||
      certificate.publicKey.asymmetricKeyDetails?.modulusLength !== 2048) {
    throw new Error('REMOTE_CERTIFICATE_KEY_INVALID')
  }
  if (!certificate.verify(certificate.publicKey)) throw new Error('REMOTE_CERTIFICATE_SIGNATURE_INVALID')
  if (certificate.signatureAlgorithm !== 'sha256WithRSAEncryption') {
    throw new Error('REMOTE_CERTIFICATE_ALGORITHM_INVALID')
  }
  const validFrom = new Date(certificate.validFrom)
  const validTo = new Date(certificate.validTo)
  if (!Number.isFinite(validFrom.valueOf()) || !Number.isFinite(validTo.valueOf()) || validTo.valueOf() <= validFrom.valueOf() ||
      validFrom.valueOf() > now.valueOf() + 5 * 60 * 1000 ||
      (!allowExpiredForLocalRenewal && validTo.valueOf() <= now.valueOf()) ||
      validTo.valueOf() - validFrom.valueOf() > 365 * DAY_MS + 5 * 60 * 1000) {
    throw new Error('REMOTE_CERTIFICATE_EXPIRED_OR_INVALID')
  }
  const serverName = certificateServerName(certificate)
  if (expectedDeviceId && serverName !== `${SAN_PREFIX}${expectedDeviceId}${SAN_SUFFIX}`) {
    throw new Error('REMOTE_CERTIFICATE_IDENTITY_MISMATCH')
  }
  if (privateKeyPem) {
    let privateKey
    try { privateKey = createPrivateKey(privateKeyPem) }
    catch { throw new Error('REMOTE_PRIVATE_KEY_INVALID') }
    const privatePublic = createPublicKey(privateKey).export({ type: 'spki', format: 'der' })
    const certificatePublic = certificate.publicKey.export({ type: 'spki', format: 'der' })
    if (!Buffer.from(privatePublic).equals(Buffer.from(certificatePublic))) {
      throw new Error('REMOTE_CERTIFICATE_KEY_MISMATCH')
    }
  }
  return {
    certificatePem,
    fingerprintSha256: fingerprintDer(certificate.raw),
    serverName,
    serialNumber: serialHex.toUpperCase()
  }
}

export async function generatePlayerCertificate(
  deviceId: string,
  now = new Date()
): Promise<PlayerCertificateBundle> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(deviceId)) {
    throw new Error('REMOTE_DEVICE_ID_INVALID')
  }
  const serverName = `${SAN_PREFIX}${deviceId}${SAN_SUFFIX}`
  const result = await generate([{ name: 'commonName', value: serverName }], {
    keyType: 'rsa', keySize: 2048, algorithm: 'sha256',
    notBeforeDate: new Date(now.valueOf() - 5 * 60 * 1000),
    notAfterDate: new Date(now.valueOf() + 365 * DAY_MS),
    extensions: [
      { name: 'basicConstraints', cA: false, critical: true },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames: [{ type: 2, value: serverName }] }
    ]
  })
  const verified = validatePlayerCertificate(result.cert, result.private, deviceId, now)
  return {
    privateKeyPem: result.private,
    certificatePem: result.cert,
    fingerprintSha256: verified.fingerprintSha256,
    serverName: verified.serverName,
    serialNumber: verified.serialNumber
  }
}

export function verifyPinnedPeerCertificate(
  certificate: tls.PeerCertificate,
  pin: PinnedCertificate,
  hostname = pin.serverName
): Error | undefined {
  if (!certificate.raw) return new Error('REMOTE_CERTIFICATE_MISSING')
  const nodeNameError = tls.checkServerIdentity(hostname, certificate)
  if (nodeNameError) return nodeNameError
  const actualFingerprint = fingerprintDer(certificate.raw)
  if (actualFingerprint !== pin.fingerprintSha256) return new Error('REMOTE_CERTIFICATE_PIN_MISMATCH')
  return undefined
}

export function createPinnedHttpsAgent(pin: PinnedCertificate): https.Agent {
  const validated = validatePlayerCertificate(pin.certificatePem)
  if (validated.fingerprintSha256 !== pin.fingerprintSha256 || validated.serverName !== pin.serverName) {
    throw new Error('REMOTE_PIN_CONFIGURATION_INVALID')
  }
  return new https.Agent({
    ca: pin.certificatePem,
    rejectUnauthorized: true,
    servername: pin.serverName,
    minVersion: 'TLSv1.2',
    maxVersion: 'TLSv1.3',
    maxCachedSessions: 0,
    checkServerIdentity: (hostname, certificate) => verifyPinnedPeerCertificate(certificate, pin, hostname)
  })
}

export interface BootstrapCertificateCandidate extends PinnedCertificate {
  deviceIdClaim: string | null
}

/** The one intentional unauthenticated TLS probe: it sends no HTTP or application bytes. */
export function probeBootstrapCertificate(
  host: string,
  port: number,
  options: { timeoutMs?: number; connect?: typeof tls.connect } = {}
): Promise<BootstrapCertificateCandidate> {
  if (!isPrivateIpv4(host) || !Number.isInteger(port) || port < 1024 || port > 65535) {
    return Promise.reject(new Error('REMOTE_ENDPOINT_INVALID'))
  }
  const connect = options.connect ?? tls.connect
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port, rejectUnauthorized: false, minVersion: 'TLSv1.2', maxVersion: 'TLSv1.3' })
    const timeout = setTimeout(() => socket.destroy(new Error('REMOTE_TLS_PROBE_TIMEOUT')), options.timeoutMs ?? 5000)
    timeout.unref()
    const finish = (error?: Error, value?: BootstrapCertificateCandidate): void => {
      clearTimeout(timeout)
      socket.removeAllListeners('secureConnect')
      socket.removeAllListeners('error')
      socket.destroy()
      if (error) reject(error)
      else if (value) resolve(value)
    }
    socket.once('error', error => finish(error instanceof Error ? error : new Error('REMOTE_TLS_PROBE_FAILED')))
    socket.once('secureConnect', () => {
      const peer = socket.getPeerCertificate(true)
      if (!peer.raw) return finish(new Error('REMOTE_CERTIFICATE_MISSING'))
      try {
        const certificatePem = new X509Certificate(peer.raw).toString()
        const certificate = parseCertificate(certificatePem)
        const validated = validatePlayerCertificate(certificatePem)
        const deviceClaim = /^player-(.+)\.karaoke\.invalid$/.exec(validated.serverName)?.[1] ?? null
        finish(undefined, { ...validated, deviceIdClaim: deviceClaim })
      } catch (error) {
        finish(error instanceof Error ? error : new Error('REMOTE_CERTIFICATE_INVALID'))
      }
    })
  })
}

export function isPrivateIpv4(address: string, allowLoopback = false): boolean {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return false
  if (allowLoopback && parts[0] === 127) return true
  return parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168)
}
