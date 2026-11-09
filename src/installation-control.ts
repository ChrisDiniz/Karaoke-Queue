import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { TextDecoder } from 'node:util'

export type InstalledRole = 'player' | 'combined'
export type InstallationStatus = 'unconfigured' | 'ready' | 'pending' | 'repairRequired'
export interface PendingInitialRole { operationId: string; kind: 'confirm-initial'; baseGeneration: number; role: InstalledRole }
export interface PendingRoleChange { operationId: string; kind: 'change-role'; baseGeneration: number; previousRole: InstalledRole; role: InstalledRole }
export interface PendingInstallationUpdate { operationId: string; kind: 'prepare-update'; baseGeneration: number; role: InstalledRole | null }
export interface PendingInstallationUninstall { operationId: string; kind: 'uninstall'; baseGeneration: number; role: InstalledRole | null }
export type PendingInstallationOperation = PendingInitialRole | PendingRoleChange | PendingInstallationUpdate | PendingInstallationUninstall
export interface CompletedInitialRoleOperation { operationId: string; kind: 'confirm-initial'; generation: number; role: InstalledRole }
export interface CompletedRoleChangeOperation { operationId: string; kind: 'change-role'; generation: number; previousRole: InstalledRole; role: InstalledRole }
export interface CompletedInstallationUpdate { operationId: string; kind: 'prepare-update'; generation: number; role: InstalledRole | null }
export interface CompletedInstallationRestore { operationId: string; kind: 'restore-installation'; generation: number; role: InstalledRole | null }
export type CompletedInstallationOperation = CompletedInitialRoleOperation | CompletedRoleChangeOperation | CompletedInstallationUpdate | CompletedInstallationRestore
export interface InstallationManifest {
  formatVersion: 1
  installationId: string
  generation: number
  role: InstalledRole | null
  status: InstallationStatus
  identityRevision: number
  pending: PendingInstallationOperation | null
  lastCompletedOperation: CompletedInstallationOperation | null
}

export class InstallationControlError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'InstallationControlError' }
}

export const INSTALLATION_MANIFEST_FILENAME = 'installation.json'
export const INSTALLATION_MANIFEST_MAX_BYTES = 16 * 1024
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ROLE_VALUES = new Set<InstalledRole>(['player', 'combined'])

function invalid(message: string): never { throw new InstallationControlError('MANIFEST_INVALID', message) }
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function isRole(value: unknown): value is InstalledRole { return typeof value === 'string' && ROLE_VALUES.has(value as InstalledRole) }
function safeGeneration(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0 }

function parsePending(value: unknown): PendingInstallationOperation | null {
  if (value === null) return null
  if (!isRecord(value) || !UUID_PATTERN.test(String(value.operationId)) || !safeGeneration(value.baseGeneration)) {
    invalid('A operação pendente do manifesto é inválida.')
  }
  if (value.kind === 'prepare-update' && Object.keys(value).length === 4 && (value.role === null || isRole(value.role))) {
    return value as unknown as PendingInstallationUpdate
  }
  if (value.kind === 'uninstall' && Object.keys(value).length === 4 && (value.role === null || isRole(value.role))) {
    return value as unknown as PendingInstallationUninstall
  }
  if (!isRole(value.role)) invalid('A operação pendente do manifesto é inválida.')
  if (value.kind === 'confirm-initial' && Object.keys(value).length === 4) {
    return value as unknown as PendingInitialRole
  }
  if (value.kind === 'change-role' && Object.keys(value).length === 5 && isRole(value.previousRole) && value.previousRole !== value.role) {
    return value as unknown as PendingRoleChange
  }
  invalid('A operação pendente do manifesto é inválida.')
}

function parseCompleted(value: unknown): CompletedInstallationOperation | null {
  if (value === null) return null
  if (!isRecord(value) || !UUID_PATTERN.test(String(value.operationId)) || !safeGeneration(value.generation)) {
    invalid('A última operação confirmada é inválida.')
  }
  if (value.kind === 'prepare-update' && Object.keys(value).length === 4 && (value.role === null || isRole(value.role))) {
    return value as unknown as CompletedInstallationUpdate
  }
  if (value.kind === 'restore-installation' && Object.keys(value).length === 4 && (value.role === null || isRole(value.role))) {
    return value as unknown as CompletedInstallationRestore
  }
  if (!isRole(value.role)) invalid('A última operação confirmada é inválida.')
  if (value.kind === 'confirm-initial' && Object.keys(value).length === 4) {
    return value as unknown as CompletedInitialRoleOperation
  }
  if (value.kind === 'change-role' && Object.keys(value).length === 5 && isRole(value.previousRole) && value.previousRole !== value.role) {
    return value as unknown as CompletedRoleChangeOperation
  }
  invalid('A última operação confirmada é inválida.')
}

export function parseInstallationManifest(value: unknown): InstallationManifest {
  if (!isRecord(value)) invalid('O manifesto de instalação deve ser um objeto JSON.')
  const keys = ['formatVersion', 'installationId', 'generation', 'role', 'status', 'identityRevision', 'pending', 'lastCompletedOperation']
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) invalid('O manifesto contém campos ausentes ou inesperados.')
  if (value.formatVersion !== 1 || !UUID_PATTERN.test(String(value.installationId)) || !safeGeneration(value.generation) ||
      !(value.role === null || isRole(value.role)) || !['unconfigured', 'ready', 'pending', 'repairRequired'].includes(String(value.status)) ||
      !safeGeneration(value.identityRevision)) invalid('A versão ou os campos do manifesto são incompatíveis.')
  const pending = parsePending(value.pending)
  const lastCompletedOperation = parseCompleted(value.lastCompletedOperation)
  if ((value.status === 'unconfigured' && (value.role !== null || pending !== null)) ||
      (value.status === 'ready' && (value.role === null || pending !== null)) ||
      ((value.status === 'pending' || value.status === 'repairRequired') && pending === null) ||
      (pending?.kind === 'confirm-initial' && value.role !== null) ||
      (pending?.kind === 'change-role' && value.role !== pending.previousRole) ||
      ((pending?.kind === 'prepare-update' || pending?.kind === 'uninstall') && value.role !== pending.role)) {
    invalid('O estado do manifesto não corresponde aos campos confirmados e pendentes.')
  }
  return { formatVersion: 1, installationId: value.installationId as string, generation: value.generation as number,
    role: value.role as InstalledRole | null, status: value.status as InstallationStatus,
    identityRevision: value.identityRevision as number, pending, lastCompletedOperation }
}

export function createUnconfiguredManifest(installationId = crypto.randomUUID()): InstallationManifest {
  if (!UUID_PATTERN.test(installationId)) throw new InstallationControlError('INSTALLATION_ID_INVALID', 'O identificador da instalação é inválido.')
  return { formatVersion: 1, installationId, generation: 0, role: null, status: 'unconfigured', identityRevision: 0, pending: null, lastCompletedOperation: null }
}

export class InstallationControlStore {
  private readonly filePath: string
  constructor(readonly directory: string) {
    if (!path.isAbsolute(directory)) throw new InstallationControlError('INSTALLATION_PATH_INVALID', 'O diretório precisa ser absoluto.')
    this.filePath = path.join(directory, INSTALLATION_MANIFEST_FILENAME)
  }

  read(): InstallationManifest | null {
    let descriptor: number
    try {
      const stat = fs.lstatSync(this.filePath)
      if (!stat.isFile() || stat.isSymbolicLink()) throw new InstallationControlError('MANIFEST_PATH_INVALID', 'O manifesto não é um arquivo regular.')
      descriptor = fs.openSync(this.filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      if (error instanceof InstallationControlError) throw error
      throw new InstallationControlError('MANIFEST_READ_FAILED', 'Não foi possível ler o manifesto de instalação.')
    }
    try {
      const stat = fs.fstatSync(descriptor)
      if (!stat.isFile() || stat.size > INSTALLATION_MANIFEST_MAX_BYTES) invalid('O manifesto não é regular ou excede o tamanho permitido.')
      const bytes = fs.readFileSync(descriptor)
      if (bytes.byteLength > INSTALLATION_MANIFEST_MAX_BYTES) invalid('O manifesto excede o tamanho permitido.')
      let decoded: string
      try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
      catch { invalid('O manifesto não contém UTF-8 válido; o original foi preservado.') }
      let json: unknown
      try { json = JSON.parse(decoded!) } catch { invalid('O manifesto contém JSON inválido; o original foi preservado.') }
      return parseInstallationManifest(json)
    } finally { fs.closeSync(descriptor) }
  }

  initialize(manifest = createUnconfiguredManifest()): InstallationManifest {
    if (this.read()) throw new InstallationControlError('MANIFEST_ALREADY_INITIALIZED', 'O manifesto já existe.')
    const parsed = parseInstallationManifest(manifest)
    if (parsed.status !== 'unconfigured' || parsed.generation !== 0 || parsed.role !== null) throw new InstallationControlError('INITIAL_STATE_INVALID', 'Apenas estado inicial não configurado pode ser criado.')
    this.writeAtomic(parsed, false)
    return parsed
  }

  beginInitialRole(operationId: string, expectedGeneration: number, role: InstalledRole): InstallationManifest {
    if (!UUID_PATTERN.test(operationId) || !safeGeneration(expectedGeneration) || !isRole(role)) throw new InstallationControlError('OPERATION_ARGUMENT_INVALID', 'Os argumentos da confirmação inicial são inválidos.')
    const current = this.requireCurrent()
    if (current.lastCompletedOperation?.operationId === operationId) {
      if (current.lastCompletedOperation.role !== role) throw new InstallationControlError('OPERATION_REUSE_CONFLICT', 'operationId já foi confirmado com outra função.')
      return current
    }
    if (current.pending) {
      if (current.pending.kind === 'confirm-initial' && current.pending.operationId === operationId &&
          current.pending.role === role && current.pending.baseGeneration === expectedGeneration) return current
      throw new InstallationControlError('OPERATION_PENDING', 'Há uma operação pendente que exige reconciliação explícita.')
    }
    if (current.status !== 'unconfigured' || current.role !== null) throw new InstallationControlError('ROLE_ALREADY_CONFIGURED', 'A função inicial já foi confirmada; alteração exige manutenção.')
    if (current.generation !== expectedGeneration) throw new InstallationControlError('GENERATION_CONFLICT', 'O manifesto mudou; nenhuma operação foi aplicada.')
    const next: InstallationManifest = { ...current, status: 'pending', pending: { operationId, kind: 'confirm-initial', baseGeneration: expectedGeneration, role } }
    this.writeAtomic(next, true)
    return next
  }

  commitInitialRole(operationId: string): InstallationManifest {
    if (!UUID_PATTERN.test(operationId)) throw new InstallationControlError('OPERATION_ARGUMENT_INVALID', 'operationId inválido.')
    const current = this.requireCurrent()
    if (current.lastCompletedOperation?.operationId === operationId) {
      if (current.lastCompletedOperation.kind !== 'confirm-initial') {
        throw new InstallationControlError('OPERATION_REUSE_CONFLICT', 'operationId pertence a outra operação.')
      }
      return current
    }
    const pending = current.pending
    if (!pending || pending.kind !== 'confirm-initial' || pending.operationId !== operationId ||
        !['pending', 'repairRequired'].includes(current.status) || current.generation !== pending.baseGeneration || current.role !== null) {
      throw new InstallationControlError('PENDING_OPERATION_MISMATCH', 'A operação pendente não corresponde ao manifesto.')
    }
    if (current.generation >= Number.MAX_SAFE_INTEGER) throw new InstallationControlError('GENERATION_EXHAUSTED', 'A geração não pode avançar com segurança.')
    if (current.identityRevision >= Number.MAX_SAFE_INTEGER) throw new InstallationControlError('IDENTITY_REVISION_EXHAUSTED', 'A revisão de identidade não pode avançar com segurança.')
    const generation = current.generation + 1
    const next: InstallationManifest = { ...current, generation, role: pending.role, status: 'ready', pending: null,
      identityRevision: current.identityRevision + 1,
      lastCompletedOperation: { operationId, kind: 'confirm-initial', generation, role: pending.role } }
    this.writeAtomic(next, true)
    return next
  }

  beginRoleChange(operationId: string, expectedGeneration: number, role: InstalledRole): InstallationManifest {
    if (!UUID_PATTERN.test(operationId) || !safeGeneration(expectedGeneration) || !isRole(role)) {
      throw new InstallationControlError('OPERATION_ARGUMENT_INVALID', 'Os argumentos da alteração de função são inválidos.')
    }
    const current = this.requireCurrent()
    const completed = current.lastCompletedOperation
    if (completed?.operationId === operationId) {
      if (completed.kind !== 'change-role' || completed.role !== role) {
        throw new InstallationControlError('OPERATION_REUSE_CONFLICT', 'operationId já foi usado em outra operação.')
      }
      return current
    }
    if (current.pending) {
      if (current.pending.kind === 'change-role' && current.pending.operationId === operationId &&
          current.pending.role === role && current.pending.baseGeneration === expectedGeneration) return current
      throw new InstallationControlError('OPERATION_PENDING', 'Há uma operação pendente que exige reconciliação explícita.')
    }
    if (current.status !== 'ready' || !current.role) {
      throw new InstallationControlError('INSTALLATION_NOT_READY', 'A instalação não está pronta para alterar a função.')
    }
    if (current.role === role) throw new InstallationControlError('ROLE_CHANGE_NOOP', 'A função solicitada já está confirmada.')
    if (current.generation !== expectedGeneration) {
      throw new InstallationControlError('GENERATION_CONFLICT', 'O manifesto mudou; nenhuma operação foi aplicada.')
    }
    const next: InstallationManifest = {
      ...current,
      status: 'pending',
      pending: { operationId, kind: 'change-role', baseGeneration: expectedGeneration, previousRole: current.role, role }
    }
    this.writeAtomic(next, true)
    return next
  }

  commitRoleChange(operationId: string): InstallationManifest {
    if (!UUID_PATTERN.test(operationId)) throw new InstallationControlError('OPERATION_ARGUMENT_INVALID', 'operationId inválido.')
    const current = this.requireCurrent()
    if (current.lastCompletedOperation?.operationId === operationId) {
      if (current.lastCompletedOperation.kind !== 'change-role') {
        throw new InstallationControlError('OPERATION_REUSE_CONFLICT', 'operationId pertence a outra operação.')
      }
      return current
    }
    const pending = current.pending
    if (!pending || pending.kind !== 'change-role' || pending.operationId !== operationId || !['pending', 'repairRequired'].includes(current.status) ||
        current.generation !== pending.baseGeneration || current.role !== pending.previousRole) {
      throw new InstallationControlError('PENDING_OPERATION_MISMATCH', 'A operação pendente não corresponde ao manifesto.')
    }
    if (current.generation >= Number.MAX_SAFE_INTEGER) throw new InstallationControlError('GENERATION_EXHAUSTED', 'A geração não pode avançar com segurança.')
    if (current.identityRevision >= Number.MAX_SAFE_INTEGER) throw new InstallationControlError('IDENTITY_REVISION_EXHAUSTED', 'A revisão de identidade não pode avançar com segurança.')
    const generation = current.generation + 1
    const next: InstallationManifest = {
      ...current,
      generation,
      role: pending.role,
      status: 'ready',
      pending: null,
      identityRevision: current.identityRevision + 1,
      lastCompletedOperation: {
        operationId,
        kind: 'change-role',
        generation,
        previousRole: pending.previousRole,
        role: pending.role
      }
    }
    this.writeAtomic(next, true)
    return next
  }

  beginInstallationUpdate(operationId: string, expectedGeneration: number): InstallationManifest {
    if (!UUID_PATTERN.test(operationId) || !safeGeneration(expectedGeneration)) {
      throw new InstallationControlError('OPERATION_ARGUMENT_INVALID', 'Os argumentos da atualização são inválidos.')
    }
    const current = this.requireCurrent()
    if (current.lastCompletedOperation?.operationId === operationId) {
      if (current.lastCompletedOperation.kind !== 'prepare-update') {
        throw new InstallationControlError('OPERATION_REUSE_CONFLICT', 'operationId pertence a outra operação.')
      }
      return current
    }
    if (current.pending) {
      if (current.pending.kind === 'prepare-update' && current.pending.operationId === operationId &&
          current.pending.baseGeneration === expectedGeneration && current.pending.role === current.role) return current
      throw new InstallationControlError('OPERATION_PENDING', 'Há uma operação pendente que exige reconciliação explícita.')
    }
    if ((current.status !== 'ready' && current.status !== 'unconfigured') || current.generation !== expectedGeneration) {
      throw new InstallationControlError('GENERATION_CONFLICT', 'A instalação mudou; a atualização foi interrompida.')
    }
    const next: InstallationManifest = { ...current, status: 'pending',
      pending: { operationId, kind: 'prepare-update', baseGeneration: expectedGeneration, role: current.role } }
    this.writeAtomic(next, true)
    return next
  }

  commitInstallationUpdate(operationId: string): InstallationManifest {
    if (!UUID_PATTERN.test(operationId)) throw new InstallationControlError('OPERATION_ARGUMENT_INVALID', 'operationId inválido.')
    const current = this.requireCurrent()
    if (current.lastCompletedOperation?.operationId === operationId) {
      if (current.lastCompletedOperation.kind !== 'prepare-update') {
        throw new InstallationControlError('OPERATION_REUSE_CONFLICT', 'operationId pertence a outra operação.')
      }
      return current
    }
    const pending = current.pending
    if (!pending || pending.kind !== 'prepare-update' || pending.operationId !== operationId ||
        !['pending', 'repairRequired'].includes(current.status) || current.generation !== pending.baseGeneration ||
        current.role !== pending.role) {
      throw new InstallationControlError('PENDING_OPERATION_MISMATCH', 'A atualização pendente não corresponde ao manifesto.')
    }
    if (current.generation >= Number.MAX_SAFE_INTEGER) throw new InstallationControlError('GENERATION_EXHAUSTED', 'A geração não pode avançar com segurança.')
    const generation = current.generation + 1
    const next: InstallationManifest = { ...current, generation, status: current.role === null ? 'unconfigured' : 'ready',
      pending: null, lastCompletedOperation: { operationId, kind: 'prepare-update', generation, role: current.role } }
    this.writeAtomic(next, true)
    return next
  }

  beginInstallationUninstall(operationId: string, expectedGeneration: number): InstallationManifest {
    if (!UUID_PATTERN.test(operationId) || !safeGeneration(expectedGeneration)) {
      throw new InstallationControlError('OPERATION_ARGUMENT_INVALID', 'Os argumentos da desinstalação são inválidos.')
    }
    const current = this.requireCurrent()
    if (current.pending) {
      if (current.pending.kind === 'uninstall' && current.pending.operationId === operationId &&
          current.pending.baseGeneration === expectedGeneration && current.pending.role === current.role) return current
      throw new InstallationControlError('OPERATION_PENDING', 'Há uma operação pendente que exige reconciliação explícita.')
    }
    if (current.lastCompletedOperation?.operationId === operationId) {
      throw new InstallationControlError('OPERATION_REUSE_CONFLICT', 'operationId pertence a outra operação.')
    }
    if ((current.status !== 'ready' && current.status !== 'unconfigured') || current.generation !== expectedGeneration) {
      throw new InstallationControlError('GENERATION_CONFLICT', 'A instalação mudou; a desinstalação foi interrompida.')
    }
    const next: InstallationManifest = { ...current, status: 'pending',
      pending: { operationId, kind: 'uninstall', baseGeneration: expectedGeneration, role: current.role } }
    this.writeAtomic(next, true)
    return next
  }

  restoreInstallationAfterUninstall(operationId: string): InstallationManifest {
    if (!UUID_PATTERN.test(operationId)) throw new InstallationControlError('OPERATION_ARGUMENT_INVALID', 'operationId inválido.')
    const current = this.requireCurrent()
    if (current.lastCompletedOperation?.operationId === operationId) {
      if (current.lastCompletedOperation.kind !== 'restore-installation') {
        throw new InstallationControlError('OPERATION_REUSE_CONFLICT', 'operationId pertence a outra operação.')
      }
      return current
    }
    const pending = current.pending
    if (!pending || pending.kind !== 'uninstall' || pending.operationId !== operationId ||
        !['pending', 'repairRequired'].includes(current.status) || current.generation !== pending.baseGeneration ||
        current.role !== pending.role) {
      throw new InstallationControlError('PENDING_OPERATION_MISMATCH', 'A intenção de reinstalação não corresponde ao manifesto.')
    }
    if (current.generation >= Number.MAX_SAFE_INTEGER) throw new InstallationControlError('GENERATION_EXHAUSTED', 'A geração não pode avançar com segurança.')
    const generation = current.generation + 1
    const next: InstallationManifest = { ...current, generation, status: current.role === null ? 'unconfigured' : 'ready',
      pending: null, lastCompletedOperation: { operationId, kind: 'restore-installation', generation, role: current.role } }
    this.writeAtomic(next, true)
    return next
  }

  private requireCurrent(): InstallationManifest {
    const current = this.read()
    if (!current) throw new InstallationControlError('MANIFEST_MISSING', 'O manifesto não foi inicializado pelo instalador.')
    return current
  }

  private writeAtomic(manifest: InstallationManifest, mustExist: boolean): void {
    const directoryStat = fs.lstatSync(this.directory)
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new InstallationControlError('INSTALLATION_DIRECTORY_INVALID', 'O diretório não é regular.')
    const temporaryPath = path.join(this.directory, `.installation.${process.pid}.${crypto.randomUUID()}.tmp`)
    let descriptor: number | undefined
    let moved = false
    try {
      descriptor = fs.openSync(temporaryPath, 'wx', 0o600)
      fs.writeFileSync(descriptor, `${JSON.stringify(parseInstallationManifest(manifest), null, 2)}\n`, 'utf8')
      fs.fsyncSync(descriptor)
      fs.closeSync(descriptor); descriptor = undefined
      if (mustExist && !this.read()) throw new InstallationControlError('MANIFEST_MISSING', 'O manifesto desapareceu antes da publicação.')
      if (!mustExist && this.read()) throw new InstallationControlError('GENERATION_CONFLICT', 'Outro processo inicializou o manifesto primeiro.')
      fs.renameSync(temporaryPath, this.filePath); moved = true
      try {
        const directoryDescriptor = fs.openSync(this.directory, fs.constants.O_RDONLY)
        try { fs.fsyncSync(directoryDescriptor) } finally { fs.closeSync(directoryDescriptor) }
      } catch (error) { if (process.platform !== 'win32') throw error }
    } catch (error) {
      if (error instanceof InstallationControlError) throw error
      throw new InstallationControlError('MANIFEST_WRITE_FAILED', 'Não foi possível publicar o manifesto; a operação não foi confirmada.')
    } finally {
      if (descriptor !== undefined) try { fs.closeSync(descriptor) } catch {}
      if (!moved) try { fs.unlinkSync(temporaryPath) } catch {}
    }
  }
}
