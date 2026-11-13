/** Main-only SQLite journal for the future paired Player protocol. This module never executes playback. */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { OPERATIONAL_LIMITS } from './operational-protocol-contracts'
import type { JournalEvent, OperationalMessage, OperationalTarget } from './operational-protocol-contracts'
import { parseOperationalMessageObject } from './operational-protocol-validation'
import { operationalCommandFingerprint } from './operational-command-fingerprint'

type CommandEnvelope = Extract<OperationalMessage, { kind: 'command' }>
type EventEnvelope = Extract<OperationalMessage, { kind: 'event' }>
type ResponseEnvelope = Extract<OperationalMessage, { kind: 'response' }>

export const PLAYER_OPERATIONAL_DATABASE_FILENAME = 'player-operational.sqlite'
export const PLAYER_OPERATIONAL_STORE_SCHEMA_VERSION = 1
export const PLAYER_OPERATIONAL_DEFAULT_LIMITS = Object.freeze({ maxLogicalBytes: 256 * 1024 * 1024, maxRecords: 1_000_000 })
export const PLAYER_OPERATIONAL_MAX_PENDING_EVENTS = 8
const APP_ID = 0x4b514f50 // KQOP
const IDENTITY_INITIALIZING = 'player-operational.identity.initializing.json'
const IDENTITY_READY = 'player-operational.identity.ready.json'
const RECOVERY_REQUIRED = 'player-operational.recovery-required.json'
const BACKUP_DIRECTORY = 'player-operational-backups'
const MAX_CHECKPOINT_BYTES = OPERATIONAL_LIMITS.maxEnvelopeBytes
const MAX_BACKUP_BYTES = 2 * 1024 * 1024 * 1024

export type PlayerOperationalStatus = 'accepted' | 'completed' | 'rejected' | 'unknown'
export type PlayerOperationalStoreErrorCode =
  | 'STORE_ARGUMENTS_INVALID' | 'STORE_NOT_INITIALIZED' | 'STORE_MISSING' | 'STORE_IN_USE'
  | 'STORE_IDENTITY_MISMATCH' | 'STORE_SCHEMA_UNSUPPORTED' | 'STORE_CORRUPT' | 'RECOVERY_REQUIRED'
  | 'OPERATION_INVALID' | 'OPERATION_ID_CONFLICT' | 'OPERATION_NOT_FOUND' | 'OPERATION_ALREADY_TERMINAL'
  | 'EVENT_INVALID' | 'EVENT_CONFLICT' | 'SEQUENCE_EXHAUSTED' | 'QUOTA_EXCEEDED' | 'RESERVATION_EXHAUSTED'
  | 'CURSOR_INVALID' | 'CURSOR_GAP' | 'REPLAY_COMPACTED' | 'CHECKPOINT_CONFLICT' | 'CONSUMER_REVOKED'
  | 'STORE_WRITE_FAILED' | 'RESULT_UNCERTAIN' | 'BACKUP_INVALID' | 'BACKUP_EXISTS' | 'RESTORE_DESTINATION_EXISTS'

export class PlayerOperationalStoreError extends Error {
  constructor(readonly code: PlayerOperationalStoreErrorCode, message = code, options?: ErrorOptions) {
    super(message, options)
    this.name = 'PlayerOperationalStoreError'
  }
}

type WithoutJournalPosition<T> = T extends unknown ? Omit<T, 'journalId' | 'eventSequence'> : never
export type OperationalEventDraft = WithoutJournalPosition<JournalEvent>

export interface PlayerOperationalStoreOptions {
  readonly userDataDirectory: string
  /** Stable identity supplied by the owning Main runtime; this store never invents a replacement after loss. */
  readonly journalId: string
  readonly deviceId: string
  /** Explicit one-time bootstrap permission. It is ignored when either identity marker already exists. */
  readonly initializeIfMissing?: boolean
  readonly maxLogicalBytes?: number
  readonly maxRecords?: number
  readonly busyTimeoutMs?: number
  /** Native SQLite page cap used only by focused failure tests; no production default is imposed. */
  readonly maxDatabasePages?: number
  /** Internal deterministic failure seams for store tests; never populated from a renderer or network. */
  readonly testHooks?: {
    afterCommit?(operationId: string, writeKind: 'accept' | 'finish' | 'append-event' | 'reject' | 'checkpoint' | 'revoke' | 'ack' | 'compact'): void
    failReadback?(writeKind: 'accept' | 'finish' | 'append-event' | 'reject' | 'checkpoint' | 'revoke' | 'ack' | 'compact'): void
  }
}

export interface PlayerOperationReceipt {
  readonly journalId: string
  readonly controllerId: string
  readonly operationId: string
  readonly fingerprint: string
  readonly status: PlayerOperationalStatus
  readonly acceptedEventSequence: number
  readonly terminalEventSequence: number | null
  readonly duplicate: boolean
}

export interface PlayerOperationRecord extends PlayerOperationReceipt {
  readonly command: CommandEnvelope['body'] | null
  readonly compacted: boolean
}

export interface PlayerOperationalMetadata {
  readonly journalId: string
  readonly deviceId: string
  readonly schemaVersion: number
  readonly nextSequence: number
  readonly highWatermark: number
  readonly compactedThrough: number
  readonly logicalBytes: number
  readonly recordCount: number
  readonly reservedBytes: number
  readonly reservedRecords: number
  readonly recoveryRequired: boolean
}

export interface PlayerJournalPage {
  readonly journalId: string
  readonly events: readonly JournalEvent[]
  readonly throughSequence: number
  readonly highWatermark: number
  readonly hasMore: boolean
  readonly compactedThrough: number
}

export interface PlayerConsumerCursor {
  readonly journalId: string
  readonly consumerId: string
  readonly throughSequence: number
  readonly revokedAt: string | null
  readonly duplicate: boolean
}

export interface PlayerJournalCompactionResult {
  readonly journalId: string
  readonly compactedThrough: number
  readonly highWatermark: number
  readonly eventsDeleted: number
  readonly operationsDeleted: number
  readonly checkpointsDeleted: number
  readonly logicalBytesReleased: number
  readonly recordsReleased: number
}

export interface PlayerOperationalBackupManifest {
  readonly formatVersion: 1
  readonly databaseFile: string
  readonly schemaVersion: number
  readonly journalId: string
  readonly deviceId: string
  readonly highWatermark: number
  readonly logicalBytes: number
  readonly recordCount: number
  readonly createdAt: string
  readonly backupFile: string
  readonly sha256: string
}

export interface PlayerOperationalRecoveryMarker {
  readonly formatVersion: 1
  readonly code: string
  readonly journalId: string | null
  readonly createdAt: string
  readonly externalCursor?: { readonly journalId: string; readonly throughSequence: number }
}

function fail(code: PlayerOperationalStoreErrorCode, cause?: unknown): never {
  throw new PlayerOperationalStoreError(code, code, cause === undefined ? undefined : { cause })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null))
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 128 && /^[\x21-\x7e]+$/.test(value)
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (isRecord(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  return value
}

function stableJson(value: unknown): string {
  return JSON.stringify(canonical(value))
}

function sha256(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function syncDirectory(directory: string): void {
  try {
    const fd = fs.openSync(directory, fs.constants.O_RDONLY)
    try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  } catch (error) {
    if (process.platform !== 'win32') throw error
  }
}

function assertRegularDirectory(directory: string): void {
  if (!path.isAbsolute(directory)) fail('STORE_ARGUMENTS_INVALID')
  let stat: fs.Stats
  try { stat = fs.lstatSync(directory) } catch (error) { fail('STORE_ARGUMENTS_INVALID', error) }
  if (!stat!.isDirectory() || stat!.isSymbolicLink()) fail('STORE_ARGUMENTS_INVALID')
}

function assertSafeFileIfPresent(filePath: string): boolean {
  try {
    const stat = fs.lstatSync(filePath)
    if (!stat.isFile() || stat.isSymbolicLink()) fail('STORE_CORRUPT')
    return true
  } catch (error) {
    if (error instanceof PlayerOperationalStoreError) throw error
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    fail('STORE_CORRUPT', error)
  }
}

function readStrictJson(filePath: string, maxBytes = 4096): Record<string, unknown> {
  if (!assertSafeFileIfPresent(filePath)) fail('STORE_CORRUPT')
  const stat = fs.statSync(filePath)
  if (stat.size < 1 || stat.size > maxBytes) fail('STORE_CORRUPT')
  let value: unknown
  try { value = JSON.parse(fs.readFileSync(filePath, 'utf8')) } catch (error) { fail('STORE_CORRUPT', error) }
  if (!isRecord(value)) fail('STORE_CORRUPT')
  return value
}

function writeExclusiveJson(filePath: string, value: unknown): void {
  const temporary = filePath + '.' + crypto.randomUUID() + '.tmp'
  let fd: number | undefined
  try {
    fd = fs.openSync(temporary, 'wx', 0o600)
    fs.writeFileSync(fd, JSON.stringify(value) + '\n', 'utf8')
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = undefined
    fs.linkSync(temporary, filePath)
    fs.unlinkSync(temporary)
    syncDirectory(path.dirname(filePath))
  } catch (error) {
    if (fd !== undefined) try { fs.closeSync(fd) } catch {}
    try { fs.unlinkSync(temporary) } catch {}
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return
    throw error
  }
}

function validateIdentityMarker(value: Record<string, unknown>, journalId: string, deviceId: string): void {
  const keys = Object.keys(value).sort().join(',')
  if (keys !== 'deviceId,formatVersion,journalId' || value.formatVersion !== 1 ||
      value.journalId !== journalId || value.deviceId !== deviceId) fail('STORE_IDENTITY_MISMATCH')
}

function readSqlNumber(value: unknown, code: PlayerOperationalStoreErrorCode): number {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0) fail(code)
  return number
}

function verifyAccounting(database: DatabaseSync, metadata: PlayerOperationalMetadata): void {
  const op = database.prepare(`SELECT COALESCE(SUM(length(CAST(command_json AS BLOB)) + length(CAST(controller_id AS BLOB)) +
    length(CAST(operation_id AS BLOB)) + length(CAST(fingerprint AS BLOB)) + length(CAST(status AS BLOB)) +
    COALESCE(length(CAST(terminal_fingerprint AS BLOB)), 0)), 0) AS bytes, COUNT(*) AS records,
    COALESCE(SUM(reserved_bytes), 0) AS reserved_bytes, COALESCE(SUM(reserved_records), 0) AS reserved_records
    FROM operations`).get() as Record<string, unknown>
  const tombstone = database.prepare(`SELECT COALESCE(SUM(length(CAST(controller_id AS BLOB)) + length(CAST(operation_id AS BLOB)) +
    length(CAST(fingerprint AS BLOB)) + length(CAST(status AS BLOB)) + length(CAST(receipt_json AS BLOB))), 0) AS bytes,
    COUNT(*) AS records FROM operation_tombstones`).get() as Record<string, unknown>
  const event = database.prepare(`SELECT COALESCE(SUM(length(CAST(event_json AS BLOB)) + length(CAST(controller_id AS BLOB)) +
    length(CAST(operation_id AS BLOB))), 0) AS bytes, COUNT(*) AS records FROM events`).get() as Record<string, unknown>
  const checkpoint = database.prepare(`SELECT COALESCE(SUM(length(CAST(checkpoint_json AS BLOB)) +
    length(CAST(checkpoint_fingerprint AS BLOB))), 0) AS bytes, COUNT(*) AS records FROM checkpoints`).get() as Record<string, unknown>
  const actualBytes = Number(op.bytes) + Number(tombstone.bytes) + Number(event.bytes) + Number(checkpoint.bytes)
  const actualRecords = Number(op.records) + Number(tombstone.records) + Number(event.records) + Number(checkpoint.records)
  const sequences = database.prepare('SELECT COUNT(*) AS count, COALESCE(MIN(event_sequence),0) AS first, COALESCE(MAX(event_sequence),0) AS last FROM events')
    .get() as Record<string, unknown>
  const inconsistentTombstones = Number(database.prepare(`SELECT COUNT(*) AS count FROM operation_tombstones t LEFT JOIN operations o
    ON o.journal_id=t.journal_id AND o.controller_id=t.controller_id AND o.operation_id=t.operation_id
    WHERE (o.operation_id IS NULL AND (t.status IN ('accepted','unknown') OR t.terminal_sequence IS NULL OR t.terminal_sequence>?)) OR
    (o.operation_id IS NOT NULL AND (o.fingerprint<>t.fingerprint OR o.status<>t.status OR
    COALESCE(o.terminal_sequence,-1)<>COALESCE(t.terminal_sequence,-1)))`).get(metadata.compactedThrough)?.count ?? -1)
  if (actualBytes !== metadata.logicalBytes || actualRecords !== metadata.recordCount ||
      Number(op.reserved_bytes) !== metadata.reservedBytes || Number(op.reserved_records) !== metadata.reservedRecords ||
      Number(sequences.count) !== metadata.highWatermark - metadata.compactedThrough ||
      (metadata.highWatermark > metadata.compactedThrough &&
        (Number(sequences.first) !== metadata.compactedThrough + 1 || Number(sequences.last) !== metadata.highWatermark)) ||
      inconsistentTombstones !== 0) fail('STORE_CORRUPT')
}

function sqliteErrorIsBusy(error: unknown): boolean {
  const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : ''
  return /BUSY|LOCKED/.test(code) || /database (?:is )?locked/i.test(String(error))
}

function schemaSql(): string {
  return `
    CREATE TABLE journal_meta (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      journal_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      schema_version INTEGER NOT NULL CHECK (schema_version = ${PLAYER_OPERATIONAL_STORE_SCHEMA_VERSION}),
      next_sequence INTEGER NOT NULL CHECK (next_sequence BETWEEN 1 AND 9007199254740991),
      high_watermark INTEGER NOT NULL CHECK (high_watermark BETWEEN 0 AND 9007199254740991),
      compacted_through INTEGER NOT NULL CHECK (compacted_through BETWEEN 0 AND high_watermark),
      logical_bytes INTEGER NOT NULL CHECK (logical_bytes >= 0),
      record_count INTEGER NOT NULL CHECK (record_count >= 0),
      reserved_bytes INTEGER NOT NULL CHECK (reserved_bytes >= 0),
      reserved_records INTEGER NOT NULL CHECK (reserved_records >= 0),
      recovery_required INTEGER NOT NULL DEFAULT 0 CHECK (recovery_required IN (0, 1)),
      recovery_code TEXT
    ) STRICT;
    CREATE TABLE operation_tombstones (
      journal_id TEXT NOT NULL,
      controller_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64),
      status TEXT NOT NULL CHECK (status IN ('accepted', 'completed', 'rejected', 'unknown')),
      accepted_sequence INTEGER NOT NULL CHECK (accepted_sequence BETWEEN 1 AND 9007199254740991),
      terminal_sequence INTEGER CHECK (terminal_sequence IS NULL OR terminal_sequence BETWEEN 1 AND 9007199254740991),
      receipt_json TEXT NOT NULL,
      PRIMARY KEY (journal_id, controller_id, operation_id)
    ) STRICT;
    CREATE TRIGGER operation_tombstones_no_delete BEFORE DELETE ON operation_tombstones
      BEGIN SELECT RAISE(ABORT, 'OPERATION_TOMBSTONE_IMMUTABLE'); END;
    CREATE TABLE operations (
      journal_id TEXT NOT NULL,
      controller_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64),
      command_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('accepted', 'completed', 'rejected', 'unknown')),
      accepted_sequence INTEGER NOT NULL CHECK (accepted_sequence BETWEEN 1 AND 9007199254740991),
      terminal_sequence INTEGER CHECK (terminal_sequence IS NULL OR terminal_sequence BETWEEN 1 AND 9007199254740991),
      terminal_fingerprint TEXT,
      reserved_bytes INTEGER NOT NULL CHECK (reserved_bytes >= 0),
      reserved_records INTEGER NOT NULL CHECK (reserved_records >= 0),
      created_at INTEGER NOT NULL,
      PRIMARY KEY (journal_id, controller_id, operation_id),
      FOREIGN KEY (journal_id, controller_id, operation_id)
        REFERENCES operation_tombstones(journal_id, controller_id, operation_id) ON DELETE RESTRICT
    ) STRICT;
    CREATE INDEX operations_status_sequence ON operations(status, accepted_sequence);
    CREATE TABLE events (
      journal_id TEXT NOT NULL,
      event_sequence INTEGER NOT NULL CHECK (event_sequence BETWEEN 1 AND 9007199254740991),
      controller_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      event_json TEXT NOT NULL,
      byte_length INTEGER NOT NULL CHECK (byte_length > 0),
      PRIMARY KEY (journal_id, event_sequence),
      FOREIGN KEY (journal_id, controller_id, operation_id)
        REFERENCES operation_tombstones(journal_id, controller_id, operation_id) ON DELETE RESTRICT
    ) STRICT;
    CREATE INDEX events_causation ON events(journal_id, controller_id, operation_id, event_sequence);
    CREATE TABLE consumer_cursors (
      journal_id TEXT NOT NULL,
      consumer_id TEXT NOT NULL,
      through_sequence INTEGER NOT NULL CHECK (through_sequence BETWEEN 0 AND 9007199254740991),
      revoked_at TEXT,
      PRIMARY KEY (journal_id, consumer_id)
    ) STRICT;
    CREATE TABLE checkpoints (
      journal_id TEXT NOT NULL,
      checkpoint_sequence INTEGER NOT NULL CHECK (checkpoint_sequence BETWEEN 0 AND 9007199254740991),
      checkpoint_json TEXT NOT NULL,
      checkpoint_fingerprint TEXT NOT NULL CHECK (length(checkpoint_fingerprint) = 64),
      PRIMARY KEY (journal_id, checkpoint_sequence)
    ) STRICT;
  `
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

function validateBackupManifest(value: unknown): PlayerOperationalBackupManifest {
  const keys = ['formatVersion', 'databaseFile', 'schemaVersion', 'journalId', 'deviceId', 'highWatermark',
    'logicalBytes', 'recordCount', 'createdAt', 'backupFile', 'sha256']
  if (!isRecord(value) || !exactKeys(value, keys) || value.formatVersion !== 1 ||
      value.databaseFile !== PLAYER_OPERATIONAL_DATABASE_FILENAME || value.schemaVersion !== PLAYER_OPERATIONAL_STORE_SCHEMA_VERSION ||
      !isId(value.journalId) || !isId(value.deviceId) || !Number.isSafeInteger(value.highWatermark) ||
      Number(value.highWatermark) < 0 || !Number.isSafeInteger(value.logicalBytes) || Number(value.logicalBytes) < 0 ||
      !Number.isSafeInteger(value.recordCount) || Number(value.recordCount) < 0 ||
      typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) ||
      typeof value.backupFile !== 'string' || !/^player-operational\.schema-1\.[0-9]{8}T[0-9]{9}Z\.[0-9a-f-]{36}\.sqlite$/.test(value.backupFile) ||
      typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.sha256)) fail('BACKUP_INVALID')
  return value as unknown as PlayerOperationalBackupManifest
}

function fileSha256(filePath: string): string {
  const hash = crypto.createHash('sha256')
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY)
  const chunk = Buffer.allocUnsafe(1024 * 1024)
  try {
    let count: number
    while ((count = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0) hash.update(chunk.subarray(0, count))
  } finally { fs.closeSync(fd) }
  return hash.digest('hex')
}

function verifyDatabaseFile(filePath: string, manifest?: PlayerOperationalBackupManifest): PlayerOperationalMetadata {
  if (!assertSafeFileIfPresent(filePath)) fail('STORE_MISSING')
  const database = new DatabaseSync(filePath, { readOnly: true })
  try {
    const integrity = database.prepare('PRAGMA integrity_check').get() as { integrity_check?: unknown } | undefined
    const foreignKeyErrors = database.prepare('PRAGMA foreign_key_check').all()
    const schemaVersion = Number(database.prepare('PRAGMA user_version').get()?.user_version ?? -1)
    const applicationId = Number(database.prepare('PRAGMA application_id').get()?.application_id ?? -1)
    if (integrity?.integrity_check !== 'ok' || foreignKeyErrors.length !== 0 ||
        schemaVersion !== PLAYER_OPERATIONAL_STORE_SCHEMA_VERSION || applicationId !== APP_ID) fail('STORE_CORRUPT')
    const meta = database.prepare('SELECT * FROM journal_meta WHERE singleton = 1').get() as Record<string, unknown> | undefined
    if (!meta || Number(meta.schema_version) !== schemaVersion) fail('STORE_CORRUPT')
    const result: PlayerOperationalMetadata = {
      journalId: String(meta.journal_id), deviceId: String(meta.device_id), schemaVersion,
      nextSequence: readSqlNumber(meta.next_sequence, 'STORE_CORRUPT'),
      highWatermark: readSqlNumber(meta.high_watermark, 'STORE_CORRUPT'),
      compactedThrough: readSqlNumber(meta.compacted_through, 'STORE_CORRUPT'),
      logicalBytes: readSqlNumber(meta.logical_bytes, 'STORE_CORRUPT'),
      recordCount: readSqlNumber(meta.record_count, 'STORE_CORRUPT'),
      reservedBytes: readSqlNumber(meta.reserved_bytes, 'STORE_CORRUPT'),
      reservedRecords: readSqlNumber(meta.reserved_records, 'STORE_CORRUPT'),
      recoveryRequired: meta.recovery_required === 1
    }
    verifyAccounting(database, result)
    if (manifest && (manifest.journalId !== result.journalId || manifest.deviceId !== result.deviceId ||
        manifest.highWatermark !== result.highWatermark || manifest.logicalBytes !== result.logicalBytes ||
        manifest.recordCount !== result.recordCount)) fail('BACKUP_INVALID')
    return result
  } finally { database.close() }
}

/** Verify backup checksum, SQLite integrity, application/schema version, and journal metadata. */
export function verifyPlayerOperationalBackup(userDataDirectory: string, manifestFile: string): {
  readonly manifest: PlayerOperationalBackupManifest
  readonly backupPath: string
} {
  assertRegularDirectory(userDataDirectory)
  if (path.basename(manifestFile) !== manifestFile || !manifestFile.endsWith('.json')) fail('BACKUP_INVALID')
  const directory = path.join(userDataDirectory, BACKUP_DIRECTORY)
  assertRegularDirectory(directory)
  const manifestPath = path.join(directory, manifestFile)
  const manifest = validateBackupManifest(readStrictJson(manifestPath))
  const backupPath = path.join(directory, manifest.backupFile)
  const stat = fs.lstatSync(backupPath)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_BACKUP_BYTES ||
      fileSha256(backupPath) !== manifest.sha256) fail('BACKUP_INVALID')
  verifyDatabaseFile(backupPath, manifest)
  return { manifest, backupPath }
}

export function readPlayerOperationalRecoveryMarker(userDataDirectory: string): PlayerOperationalRecoveryMarker | null {
  assertRegularDirectory(userDataDirectory)
  const markerPath = path.join(userDataDirectory, RECOVERY_REQUIRED)
  if (!assertSafeFileIfPresent(markerPath)) return null
  const value = readStrictJson(markerPath)
  const keys = ['formatVersion', 'code', 'journalId', 'createdAt']
  const actual = Object.keys(value).sort().join(',')
  const base = keys.sort().join(',')
  const optional = actual === [...keys, 'externalCursor'].sort().join(',')
  if ((!optional && actual !== base) || value.formatVersion !== 1 || typeof value.code !== 'string' ||
      !/^[a-z0-9-]{1,64}$/.test(value.code) || !(value.journalId === null || isId(value.journalId)) ||
      typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) fail('STORE_CORRUPT')
  if (value.externalCursor !== undefined && (!isRecord(value.externalCursor) ||
      !exactKeys(value.externalCursor, ['journalId', 'throughSequence']) || !isId(value.externalCursor.journalId) ||
      !Number.isSafeInteger(value.externalCursor.throughSequence) || Number(value.externalCursor.throughSequence) < 0)) fail('STORE_CORRUPT')
  return value as unknown as PlayerOperationalRecoveryMarker
}

/** Restore is always fenced for explicit reconciliation; it never overwrites an existing path. */
export function restorePlayerOperationalBackup(options: {
  readonly sourceUserDataDirectory: string
  readonly manifestFile: string
  readonly destinationUserDataDirectory: string
  readonly externalCursor?: { readonly journalId: string; readonly throughSequence: number }
}): { readonly databasePath: string; readonly recoveryRequired: true; readonly reason: string } {
  assertRegularDirectory(options.destinationUserDataDirectory)
  const verified = verifyPlayerOperationalBackup(options.sourceUserDataDirectory, options.manifestFile)
  const databasePath = path.join(options.destinationUserDataDirectory, PLAYER_OPERATIONAL_DATABASE_FILENAME)
  const initPath = path.join(options.destinationUserDataDirectory, IDENTITY_INITIALIZING)
  const readyPath = path.join(options.destinationUserDataDirectory, IDENTITY_READY)
  const markerPath = path.join(options.destinationUserDataDirectory, RECOVERY_REQUIRED)
  if (assertSafeFileIfPresent(databasePath) || fs.existsSync(initPath) || fs.existsSync(readyPath) || fs.existsSync(markerPath)) {
    fail('RESTORE_DESTINATION_EXISTS')
  }
  const identity = { formatVersion: 1, journalId: verified.manifest.journalId, deviceId: verified.manifest.deviceId }
  writeExclusiveJson(initPath, identity)
  let copied = false
  try {
    fs.copyFileSync(verified.backupPath, databasePath, fs.constants.COPYFILE_EXCL)
    copied = true
    const fd = fs.openSync(databasePath, fs.constants.O_RDWR)
    try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    const actual = verifyDatabaseFile(databasePath)
    if (actual.journalId !== verified.manifest.journalId || actual.deviceId !== verified.manifest.deviceId) fail('BACKUP_INVALID')
    const database = new DatabaseSync(databasePath)
    try {
      database.exec('PRAGMA busy_timeout = 3000; PRAGMA locking_mode = EXCLUSIVE; PRAGMA foreign_keys = ON;')
      database.exec('BEGIN IMMEDIATE')
      database.prepare('UPDATE journal_meta SET recovery_required = 1, recovery_code = ? WHERE singleton = 1')
        .run('restore-requires-reconciliation')
      database.exec('COMMIT')
    } finally { database.close() }
    const external = options.externalCursor
    if (external && (!isId(external.journalId) || !Number.isSafeInteger(external.throughSequence) || external.throughSequence < 0)) {
      fail('CURSOR_INVALID')
    }
    const ahead = Boolean(external && (external.journalId !== verified.manifest.journalId ||
      external.throughSequence > verified.manifest.highWatermark))
    const recovery: PlayerOperationalRecoveryMarker = {
      formatVersion: 1, code: ahead ? 'restore-external-cursor-ahead' : 'restore-requires-reconciliation',
      journalId: verified.manifest.journalId, createdAt: new Date().toISOString(),
      ...(external ? { externalCursor: external } : {})
    }
    writeExclusiveJson(markerPath, recovery)
    writeExclusiveJson(readyPath, identity)
    try { fs.unlinkSync(initPath) } catch {}
    syncDirectory(options.destinationUserDataDirectory)
    return { databasePath, recoveryRequired: true, reason: recovery.code }
  } catch (error) {
    if (copied) {
      try {
        writeExclusiveJson(markerPath, { formatVersion: 1, code: 'restore-incomplete', journalId: verified.manifest.journalId,
          createdAt: new Date().toISOString() })
      } catch {}
    }
    throw error
  }
}

export class PlayerOperationalStore {
  readonly databasePath: string
  readonly identityPath: string
  readonly recoveryPath: string
  private readonly options: Required<Pick<PlayerOperationalStoreOptions,
    'maxLogicalBytes' | 'maxRecords' | 'busyTimeoutMs'>> & PlayerOperationalStoreOptions
  private database: DatabaseSync
  private closed = false
  private blocked = false

  constructor(options: PlayerOperationalStoreOptions) {
    if (!options || !isId(options.journalId) || !isId(options.deviceId) || !path.isAbsolute(options.userDataDirectory)) {
      fail('STORE_ARGUMENTS_INVALID')
    }
    assertRegularDirectory(options.userDataDirectory)
    const maxLogicalBytes = options.maxLogicalBytes ?? PLAYER_OPERATIONAL_DEFAULT_LIMITS.maxLogicalBytes
    const maxRecords = options.maxRecords ?? PLAYER_OPERATIONAL_DEFAULT_LIMITS.maxRecords
    const busyTimeoutMs = options.busyTimeoutMs ?? 3000
    if (!Number.isSafeInteger(maxLogicalBytes) || maxLogicalBytes < 1024 ||
        !Number.isSafeInteger(maxRecords) || maxRecords < 16 || !Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0 ||
        options.maxDatabasePages !== undefined && (!Number.isSafeInteger(options.maxDatabasePages) || options.maxDatabasePages < 1)) {
      fail('STORE_ARGUMENTS_INVALID')
    }
    this.options = { ...options, maxLogicalBytes, maxRecords, busyTimeoutMs }
    this.databasePath = path.join(options.userDataDirectory, PLAYER_OPERATIONAL_DATABASE_FILENAME)
    this.identityPath = path.join(options.userDataDirectory, IDENTITY_READY)
    this.recoveryPath = path.join(options.userDataDirectory, RECOVERY_REQUIRED)
    this.database = undefined as unknown as DatabaseSync

    if (readPlayerOperationalRecoveryMarker(options.userDataDirectory)) fail('RECOVERY_REQUIRED')
    let readyExists = assertSafeFileIfPresent(this.identityPath)
    const initializingPath = path.join(options.userDataDirectory, IDENTITY_INITIALIZING)
    let initializingExists = assertSafeFileIfPresent(initializingPath)
    const databaseExists = assertSafeFileIfPresent(this.databasePath)
    if (readyExists) validateIdentityMarker(readStrictJson(this.identityPath), options.journalId, options.deviceId)
    if (initializingExists) validateIdentityMarker(readStrictJson(initializingPath), options.journalId, options.deviceId)
    if (readyExists && !databaseExists) {
      this.writeRecoveryMarker('store-missing', options.journalId)
      fail('STORE_MISSING')
    }
    if (!readyExists && !initializingExists) {
      if (databaseExists) {
        this.writeRecoveryMarker('identity-marker-missing', options.journalId)
        fail('STORE_CORRUPT')
      }
      if (!options.initializeIfMissing) fail('STORE_NOT_INITIALIZED')
      writeExclusiveJson(initializingPath, { formatVersion: 1, journalId: options.journalId, deviceId: options.deviceId })
      initializingExists = true
    }
    if (!databaseExists && readyExists) {
      this.writeRecoveryMarker('store-missing', options.journalId)
      fail('STORE_MISSING')
    }

    try {
      this.database = new DatabaseSync(this.databasePath)
      this.database.exec('PRAGMA busy_timeout = ' + busyTimeoutMs + '; PRAGMA foreign_keys = ON; PRAGMA trusted_schema = OFF;')
      this.database.exec('PRAGMA locking_mode = EXCLUSIVE')
      if ((this.database.prepare('PRAGMA locking_mode').get() as { locking_mode?: unknown }).locking_mode !== 'exclusive') {
        fail('STORE_IN_USE')
      }
      const integrity = this.database.prepare('PRAGMA integrity_check').get() as { integrity_check?: unknown } | undefined
      if (integrity?.integrity_check !== 'ok' || this.database.prepare('PRAGMA foreign_key_check').all().length !== 0) {
        fail('STORE_CORRUPT')
      }
      const userVersion = Number((this.database.prepare('PRAGMA user_version').get() as { user_version?: unknown }).user_version ?? -1)
      const applicationId = Number((this.database.prepare('PRAGMA application_id').get() as { application_id?: unknown }).application_id ?? 0)
      if (userVersion === 0 && !readyExists && initializingExists) {
        this.initializeSchema(options.journalId, options.deviceId)
      } else if (userVersion !== PLAYER_OPERATIONAL_STORE_SCHEMA_VERSION || applicationId !== APP_ID) {
        this.writeRecoveryMarker('unsupported-schema', options.journalId)
        fail('STORE_SCHEMA_UNSUPPORTED')
      }
      this.configureDatabase()
      if (options.maxDatabasePages !== undefined) {
        this.database.prepare('PRAGMA max_page_count = ' + options.maxDatabasePages).get()
      }
      const metadata = this.metadataFromDatabase()
      if (metadata.journalId !== options.journalId || metadata.deviceId !== options.deviceId) fail('STORE_IDENTITY_MISMATCH')
      this.assertAccounting()
      if (metadata.recoveryRequired) {
        this.writeRecoveryMarker('database-recovery-required', metadata.journalId)
        fail('RECOVERY_REQUIRED')
      }
      if (!readyExists) {
        if (metadata.recordCount !== 0 || metadata.highWatermark !== 0) {
          this.writeRecoveryMarker('initialization-state-ambiguous', metadata.journalId)
          fail('RECOVERY_REQUIRED')
        }
        writeExclusiveJson(this.identityPath, { formatVersion: 1, journalId: options.journalId, deviceId: options.deviceId })
      }
      if (initializingExists) try { fs.unlinkSync(initializingPath) } catch {}
      this.recoverAcceptedOperations()
    } catch (error) {
      if (this.database) {
        try { this.database.close() } catch {}
      }
      if (error instanceof PlayerOperationalStoreError) {
        if (['STORE_CORRUPT', 'STORE_SCHEMA_UNSUPPORTED', 'STORE_MISSING', 'RECOVERY_REQUIRED'].includes(error.code)) {
          try { this.writeRecoveryMarker(error.code.toLowerCase().replaceAll('_', '-'), options.journalId) } catch {}
        }
        throw error
      }
      if (sqliteErrorIsBusy(error)) fail('STORE_IN_USE', error)
      try { this.writeRecoveryMarker('store-corrupt', options.journalId) } catch {}
      fail('STORE_CORRUPT', error)
    }
  }

  private initializeSchema(journalId: string, deviceId: string): void {
    this.database.exec('PRAGMA page_size = 4096; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA application_id = ' + APP_ID)
    this.database.exec('BEGIN IMMEDIATE')
    try {
      this.database.exec(schemaSql())
      this.database.prepare(`INSERT INTO journal_meta(singleton, journal_id, device_id, schema_version, next_sequence,
        high_watermark, compacted_through, logical_bytes, record_count, reserved_bytes, reserved_records,
        recovery_required, recovery_code) VALUES (1, ?, ?, ?, 1, 0, 0, 0, 0, 0, 0, 0, NULL)`)
        .run(journalId, deviceId, PLAYER_OPERATIONAL_STORE_SCHEMA_VERSION)
      this.database.exec('PRAGMA user_version = ' + PLAYER_OPERATIONAL_STORE_SCHEMA_VERSION)
      this.database.exec('COMMIT')
    } catch (error) {
      if (this.database.isTransaction) try { this.database.exec('ROLLBACK') } catch {}
      throw error
    }
  }

  private configureDatabase(): void {
    const mode = String((this.database.prepare('PRAGMA journal_mode = WAL').get() as { journal_mode?: unknown }).journal_mode ?? '')
    if (mode.toLowerCase() !== 'wal') fail('STORE_CORRUPT')
    this.database.exec('PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA trusted_schema = OFF; PRAGMA wal_autocheckpoint = 1000;')
  }

  private metadataFromDatabase(): PlayerOperationalMetadata {
    const row = this.database.prepare('SELECT * FROM journal_meta WHERE singleton = 1').get() as Record<string, unknown> | undefined
    if (!row || Number(row.schema_version) !== PLAYER_OPERATIONAL_STORE_SCHEMA_VERSION ||
        Number(row.next_sequence) !== Number(row.high_watermark) + 1 ||
        Number(row.compacted_through) > Number(row.high_watermark)) fail('STORE_CORRUPT')
    return {
      journalId: String(row.journal_id), deviceId: String(row.device_id), schemaVersion: Number(row.schema_version),
      nextSequence: readSqlNumber(row.next_sequence, 'STORE_CORRUPT'),
      highWatermark: readSqlNumber(row.high_watermark, 'STORE_CORRUPT'),
      compactedThrough: readSqlNumber(row.compacted_through, 'STORE_CORRUPT'),
      logicalBytes: readSqlNumber(row.logical_bytes, 'STORE_CORRUPT'),
      recordCount: readSqlNumber(row.record_count, 'STORE_CORRUPT'),
      reservedBytes: readSqlNumber(row.reserved_bytes, 'STORE_CORRUPT'),
      reservedRecords: readSqlNumber(row.reserved_records, 'STORE_CORRUPT'),
      recoveryRequired: row.recovery_required === 1
    }
  }

  private assertAccounting(): void {
    verifyAccounting(this.database, this.metadataFromDatabase())
  }

  private ensureOpen(): void {
    if (this.closed) fail('STORE_NOT_INITIALIZED')
    if (this.blocked || fs.existsSync(this.recoveryPath)) fail('RECOVERY_REQUIRED')
  }

  private writeRecoveryMarker(code: string, journalId: string | null): void {
    this.blocked = true
    const safeCode = /^[a-z0-9-]{1,64}$/.test(code) ? code : 'recovery-required'
    const marker: PlayerOperationalRecoveryMarker = { formatVersion: 1, code: safeCode, journalId, createdAt: new Date().toISOString() }
    try { writeExclusiveJson(this.recoveryPath, marker) } catch { /* in-memory fail-closed remains active */ }
  }

  private transaction<T>(action: () => T): T {
    this.ensureOpen()
    this.database.exec('BEGIN IMMEDIATE')
    let result: T
    try { result = action() } catch (error) {
      if (this.database.isTransaction) try { this.database.exec('ROLLBACK') } catch {}
      throw error
    }
    try { this.database.exec('COMMIT') } catch (error) {
      if (this.database.isTransaction) try { this.database.exec('ROLLBACK') } catch {}
      throw error
    }
    return result!
  }

  private getMetaRow(): Record<string, unknown> {
    const row = this.database.prepare('SELECT * FROM journal_meta WHERE singleton = 1').get() as Record<string, unknown> | undefined
    if (!row) fail('STORE_CORRUPT')
    return row!
  }

  private reserveSlots(command: CommandEnvelope['body']): number {
    return command.type === 'activate-turn' ? PLAYER_OPERATIONAL_MAX_PENDING_EVENTS : 2
  }

  private operationFingerprint(command: CommandEnvelope['body']): string {
    return operationalCommandFingerprint(command)
  }

  private parseCommand(input: unknown, controllerId: string): CommandEnvelope {
    if (!isId(controllerId)) fail('OPERATION_INVALID')
    try { parseOperationalMessageObject(input) } catch (error) { fail('OPERATION_INVALID', error) }
    const message = input as OperationalMessage
    if (message.kind !== 'command' || message.deviceId !== this.options.deviceId || message.controllerId !== controllerId) {
      fail('OPERATION_INVALID')
    }
    return message as CommandEnvelope
  }

  private commandTarget(command: CommandEnvelope['body']): OperationalTarget {
    return command.target
  }

  private buildEvent(draft: OperationalEventDraft, sequence: number, controllerId: string): JournalEvent {
    const meta = this.metadataFromDatabase()
    if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > Number.MAX_SAFE_INTEGER) fail('SEQUENCE_EXHAUSTED')
    const body = { ...draft, journalId: meta.journalId, eventSequence: sequence }
    const envelope = { protocolVersion: 1, schemaVersion: 1, kind: 'event', messageId: 'event-' + sequence,
      deviceId: meta.deviceId, controllerId, body }
    try { parseOperationalMessageObject(envelope) } catch (error) { fail('EVENT_INVALID', error) }
    return (envelope as EventEnvelope).body
  }

  private acceptanceEvent(command: CommandEnvelope, sequence: number): JournalEvent {
    const target = command.body.target
    return this.buildEvent({ schemaVersion: 1, causationOperationId: command.body.operationId,
      sessionId: target.sessionId, turnId: target.turnId,
      ...('occurrenceId' in target ? { occurrenceId: target.occurrenceId, attemptId: target.attemptId } : {}),
      stateRevision: target.stateRevision, origin: 'remote',
      type: 'operation-result', payload: { operationId: command.body.operationId, status: 'accepted' }
    }, sequence, command.controllerId)
  }

  private eventBytes(event: JournalEvent, controllerId: string, operationId: string): number {
    return Buffer.byteLength(stableJson(event), 'utf8') + Buffer.byteLength(controllerId, 'utf8') + Buffer.byteLength(operationId, 'utf8')
  }

  private storedOperationBytes(commandJson: string, fingerprint: string, controllerId: string, operationId: string,
    status: string, terminalFingerprint: string | null): number {
    return Buffer.byteLength(commandJson) + Buffer.byteLength(fingerprint) + Buffer.byteLength(controllerId) +
      Buffer.byteLength(operationId) + Buffer.byteLength(status) + (terminalFingerprint ? Buffer.byteLength(terminalFingerprint) : 0)
  }

  private storedTombstoneBytes(fingerprint: string, controllerId: string, operationId: string, status: string, receiptJson: string): number {
    return Buffer.byteLength(fingerprint) + Buffer.byteLength(controllerId) + Buffer.byteLength(operationId) +
      Buffer.byteLength(status) + Buffer.byteLength(receiptJson)
  }

  private updateMeta(logicalBytesDelta: number, recordDelta: number, reservedBytesDelta = 0, reservedRecordsDelta = 0,
    highWatermark?: number): void {
    const meta = this.getMetaRow()
    const logicalBytes = Number(meta.logical_bytes) + logicalBytesDelta
    const recordCount = Number(meta.record_count) + recordDelta
    const reservedBytes = Number(meta.reserved_bytes) + reservedBytesDelta
    const reservedRecords = Number(meta.reserved_records) + reservedRecordsDelta
    const currentHigh = Number(meta.high_watermark)
    const next = highWatermark === undefined ? currentHigh : highWatermark
    if (!Number.isSafeInteger(logicalBytes) || logicalBytes < 0 || !Number.isSafeInteger(recordCount) || recordCount < 0 ||
        !Number.isSafeInteger(reservedBytes) || reservedBytes < 0 || !Number.isSafeInteger(reservedRecords) || reservedRecords < 0 ||
        next < currentHigh || next > Number.MAX_SAFE_INTEGER) fail('STORE_CORRUPT')
    this.database.prepare(`UPDATE journal_meta SET logical_bytes = ?, record_count = ?, reserved_bytes = ?, reserved_records = ?,
      high_watermark = ?, next_sequence = ? WHERE singleton = 1`)
      .run(logicalBytes, recordCount, reservedBytes, reservedRecords, next, next + 1)
  }

  private checkCapacity(meta: Record<string, unknown>, addBytes: number, addRecords: number): void {
    const logicalBytes = Number(meta.logical_bytes) + Number(meta.reserved_bytes) + addBytes
    const records = Number(meta.record_count) + Number(meta.reserved_records) + addRecords
    if (!Number.isSafeInteger(logicalBytes) || !Number.isSafeInteger(records) ||
        logicalBytes > this.options.maxLogicalBytes || records > this.options.maxRecords) fail('QUOTA_EXCEEDED')
  }

  private receiptFromRow(row: Record<string, unknown>, duplicate: boolean): PlayerOperationReceipt {
    return { journalId: String(row.journal_id), controllerId: String(row.controller_id), operationId: String(row.operation_id),
      fingerprint: String(row.fingerprint), status: String(row.status) as PlayerOperationalStatus,
      acceptedEventSequence: readSqlNumber(row.accepted_sequence, 'STORE_CORRUPT'),
      terminalEventSequence: row.terminal_sequence === null ? null : readSqlNumber(row.terminal_sequence, 'STORE_CORRUPT'), duplicate }
  }

  private findOperation(controllerId: string, operationId: string): Record<string, unknown> | undefined {
    return this.database.prepare(`SELECT t.journal_id, t.controller_id, t.operation_id, t.fingerprint, t.status,
      t.accepted_sequence, t.terminal_sequence, t.receipt_json, o.command_json, o.terminal_fingerprint,
      o.reserved_bytes, o.reserved_records FROM operation_tombstones t LEFT JOIN operations o
      ON o.journal_id=t.journal_id AND o.controller_id=t.controller_id AND o.operation_id=t.operation_id
      WHERE t.journal_id=? AND t.controller_id=? AND t.operation_id=?`)
      .get(this.options.journalId, controllerId, operationId) as Record<string, unknown> | undefined
  }

  private readbackOperation(controllerId: string, operationId: string, fingerprint: string,
    writeKind: 'accept' | 'finish' | 'append-event' | 'reject' | 'checkpoint' | 'revoke'): PlayerOperationReceipt | null {
    this.options.testHooks?.failReadback?.(writeKind)
    const row = this.findOperation(controllerId, operationId)
    if (!row) return null
    if (row.fingerprint !== fingerprint) fail('OPERATION_ID_CONFLICT')
    return this.receiptFromRow(row, true)
  }

  private resolveWriteFailure<T>(operationId: string, controllerId: string, fingerprint: string,
    expectedTerminalFingerprint: string | null, error: unknown, writeKind: 'accept' | 'finish' | 'reject'): T {
    if (sqliteErrorIsBusy(error)) fail('STORE_IN_USE', error)
    let existing: PlayerOperationReceipt | null
    try { existing = this.readbackOperation(controllerId, operationId, fingerprint, writeKind) } catch (readError) {
      this.writeRecoveryMarker('write-readback-unavailable', this.options.journalId)
      fail('RESULT_UNCERTAIN', readError)
    }
    if (existing) {
      if (expectedTerminalFingerprint) {
        const row = this.findOperation(controllerId, operationId)
        if (row?.terminal_fingerprint !== expectedTerminalFingerprint) {
          if (row?.status === 'accepted') fail('STORE_WRITE_FAILED', error)
          fail('OPERATION_ALREADY_TERMINAL')
        }
      }
      return existing as T
    }
    fail('STORE_WRITE_FAILED', error)
  }

  private insertEvent(event: JournalEvent, controllerId: string, operationId: string): number {
    const json = stableJson(event)
    const byteLength = Buffer.byteLength(json, 'utf8')
    if (byteLength > OPERATIONAL_LIMITS.maxRecordBytes) fail('EVENT_INVALID')
    this.database.prepare(`INSERT INTO events(journal_id,event_sequence,controller_id,operation_id,event_json,byte_length)
      VALUES(?,?,?,?,?,?)`).run(this.options.journalId, event.eventSequence, controllerId, operationId, json, byteLength)
    return this.eventBytes(event, controllerId, operationId)
  }

  private findMatchingEvent(controllerId: string, operationId: string, draft: OperationalEventDraft): JournalEvent | null {
    const rows = this.database.prepare(`SELECT event_json FROM events WHERE journal_id=? AND controller_id=? AND operation_id=?
      ORDER BY event_sequence`).all(this.options.journalId, controllerId, operationId) as Array<{ event_json: string }>
    const expected = stableJson(draft)
    for (const row of rows) {
      let event: JournalEvent
      try { event = JSON.parse(row.event_json) as JournalEvent } catch (error) {
        this.writeRecoveryMarker('stored-event-invalid', this.options.journalId)
        fail('STORE_CORRUPT', error)
      }
      const { journalId: _journalId, eventSequence: _eventSequence, ...withoutPosition } = event
      if (stableJson(withoutPosition) === expected) return event
    }
    return null
  }

  /** Persist acceptance and its first event before a caller may expose acceptance or perform an effect. */
  acceptOperation(input: { readonly controllerId: string; readonly command: unknown }): PlayerOperationReceipt {
    this.ensureOpen()
    const command = this.parseCommand(input.command, input.controllerId)
    const body = command.body
    const operationId = body.operationId
    const fingerprint = this.operationFingerprint(body)
    const existing = this.findOperation(input.controllerId, operationId)
    if (existing) {
      if (existing.fingerprint !== fingerprint) fail('OPERATION_ID_CONFLICT')
      return this.receiptFromRow(existing, true)
    }
    const commandJson = stableJson(body)
    const reserveEvents = this.reserveSlots(body)
    const reserveBytes = reserveEvents * OPERATIONAL_LIMITS.maxRecordBytes + 512
    try {
      const receipt = this.transaction(() => {
        const meta = this.getMetaRow()
        const duplicate = this.findOperation(input.controllerId, operationId)
        if (duplicate) {
          if (duplicate.fingerprint !== fingerprint) fail('OPERATION_ID_CONFLICT')
          return this.receiptFromRow(duplicate, true)
        }
        const sequence = Number(meta.next_sequence)
        if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence >= Number.MAX_SAFE_INTEGER) fail('SEQUENCE_EXHAUSTED')
        if (sequence + reserveEvents >= Number.MAX_SAFE_INTEGER) fail('SEQUENCE_EXHAUSTED')
        const event = this.acceptanceEvent(command, sequence)
        const eventJson = stableJson(event)
        const receiptJson = stableJson({ status: 'accepted', acceptedEventSequence: sequence, terminalEventSequence: null })
        const opBytes = this.storedOperationBytes(commandJson, fingerprint, input.controllerId, operationId, 'accepted', null)
        const tombstoneBytes = this.storedTombstoneBytes(fingerprint, input.controllerId, operationId, 'accepted', receiptJson)
        const eventBytes = this.eventBytes(event, input.controllerId, operationId)
        this.checkCapacity(meta, opBytes + tombstoneBytes + eventBytes + reserveBytes, 3 + reserveEvents)
        const createdAt = Date.now()
        this.database.prepare(`INSERT INTO operation_tombstones(journal_id,controller_id,operation_id,fingerprint,status,
          accepted_sequence,terminal_sequence,receipt_json) VALUES(?,?,?,?,?,?,NULL,?)`)
          .run(this.options.journalId, input.controllerId, operationId, fingerprint, 'accepted', sequence, receiptJson)
        this.database.prepare(`INSERT INTO operations(journal_id,controller_id,operation_id,fingerprint,command_json,status,
          accepted_sequence,terminal_sequence,terminal_fingerprint,reserved_bytes,reserved_records,created_at)
          VALUES(?,?,?,?,?,'accepted',?,NULL,NULL,?,?,?)`)
          .run(this.options.journalId, input.controllerId, operationId, fingerprint, commandJson, sequence, reserveBytes, reserveEvents, createdAt)
        this.insertEvent(event, input.controllerId, operationId)
        this.updateMeta(opBytes + tombstoneBytes + eventBytes, 3, reserveBytes, reserveEvents, sequence)
        return this.receiptFromRow({ journal_id: this.options.journalId, controller_id: input.controllerId, operation_id: operationId,
          fingerprint, status: 'accepted', accepted_sequence: sequence, terminal_sequence: null }, false)
      })
      this.options.testHooks?.afterCommit?.(operationId, 'accept')
      return receipt
    } catch (error) {
      if (error instanceof PlayerOperationalStoreError) throw error
      return this.resolveWriteFailure<PlayerOperationReceipt>(operationId, input.controllerId, fingerprint, null, error, 'accept')
    }
  }

  /** Add a durable event while spending one reserved slot belonging to its accepted operation. */
  appendEvent(input: { readonly controllerId: string; readonly operationId: string; readonly event: OperationalEventDraft }): JournalEvent {
    this.ensureOpen()
    if (!isId(input.controllerId) || !isId(input.operationId)) fail('EVENT_INVALID')
    const existing = this.findMatchingEvent(input.controllerId, input.operationId, input.event)
    if (existing) return existing
    const expectedSequence = this.metadataFromDatabase().nextSequence
    const expectedEvent = this.buildEvent(input.event, expectedSequence, input.controllerId)
    if (expectedEvent.causationOperationId !== input.operationId) fail('EVENT_INVALID')
    try {
      const event = this.transaction(() => {
        const operation = this.findOperation(input.controllerId, input.operationId)
        if (!operation) fail('OPERATION_NOT_FOUND')
        if (operation.status !== 'accepted' || operation.command_json === null) fail('OPERATION_ALREADY_TERMINAL')
        const sequence = Number(this.getMetaRow().next_sequence)
        if (!Number.isSafeInteger(sequence) || sequence + Number(operation.reserved_records) > Number.MAX_SAFE_INTEGER) {
          fail('SEQUENCE_EXHAUSTED')
        }
        if (sequence !== expectedSequence) fail('STORE_WRITE_FAILED')
        const built = this.buildEvent(input.event, sequence, input.controllerId)
        const reservedBytes = Number(operation.reserved_bytes)
        const reservedRecords = Number(operation.reserved_records)
        if (reservedRecords < 1 || reservedBytes < OPERATIONAL_LIMITS.maxRecordBytes + 512) fail('RESERVATION_EXHAUSTED')
        const eventBytes = this.insertEvent(built, input.controllerId, input.operationId)
        const remainingReservedBytes = reservedBytes - OPERATIONAL_LIMITS.maxRecordBytes
        const remainingReservedRecords = reservedRecords - 1
        this.database.prepare(`UPDATE operations SET reserved_bytes=?,reserved_records=? WHERE journal_id=? AND controller_id=? AND operation_id=?`)
          .run(remainingReservedBytes, remainingReservedRecords, this.options.journalId, input.controllerId, input.operationId)
        this.database.prepare(`UPDATE journal_meta SET logical_bytes=logical_bytes+?,record_count=record_count+1,
          reserved_bytes=reserved_bytes-?,reserved_records=reserved_records-1,high_watermark=?,next_sequence=? WHERE singleton=1`)
          .run(eventBytes, OPERATIONAL_LIMITS.maxRecordBytes, sequence, sequence + 1)
        return built
      })
      this.options.testHooks?.afterCommit?.(input.operationId, 'append-event')
      return event
    } catch (error) {
      if (error instanceof PlayerOperationalStoreError) throw error
      if (sqliteErrorIsBusy(error)) fail('STORE_IN_USE', error)
      try {
        this.options.testHooks?.failReadback?.('append-event')
        const row = this.database.prepare(`SELECT event_json FROM events WHERE journal_id=? AND event_sequence=? AND
          controller_id=? AND operation_id=?`).get(this.options.journalId, expectedSequence, input.controllerId,
          input.operationId) as { event_json?: string } | undefined
        if (row && stableJson(JSON.parse(row.event_json!)) === stableJson(expectedEvent)) return expectedEvent
        if (row) {
          this.writeRecoveryMarker('event-readback-mismatch', this.options.journalId)
          fail('RESULT_UNCERTAIN')
        }
        fail('STORE_WRITE_FAILED', error)
      } catch (readError) {
        if (readError instanceof PlayerOperationalStoreError && readError.code === 'STORE_WRITE_FAILED') throw readError
        this.writeRecoveryMarker('event-readback-unavailable', this.options.journalId)
        fail('RESULT_UNCERTAIN', readError)
      }
    }
  }

  /** Finalize a stored intent with one or more typed events; the last event is its durable operation-result. */
  finishOperation(input: { readonly controllerId: string; readonly operationId: string; readonly status: Exclude<PlayerOperationalStatus, 'accepted'>;
    readonly events: readonly OperationalEventDraft[] }): PlayerOperationReceipt {
    this.ensureOpen()
    if (!isId(input.controllerId) || !isId(input.operationId) || !Array.isArray(input.events) || input.events.length < 1) fail('EVENT_INVALID')
    const original = this.findOperation(input.controllerId, input.operationId)
    if (!original) fail('OPERATION_NOT_FOUND')
    const operationFingerprint = String(original.fingerprint)
    const terminalFingerprint = sha256(stableJson({ status: input.status, events: input.events }))
    try {
      const receipt = this.transaction(() => {
        const operation = this.findOperation(input.controllerId, input.operationId)
        if (!operation) fail('OPERATION_NOT_FOUND')
        if (operation.status !== 'accepted') {
          if (operation.terminal_fingerprint === terminalFingerprint) return this.receiptFromRow(operation, true)
          fail('OPERATION_ALREADY_TERMINAL')
        }
        const reservedEvents = Number(operation.reserved_records)
        const reservedBytes = Number(operation.reserved_bytes)
        if (input.events.length > reservedEvents || input.events.length * OPERATIONAL_LIMITS.maxRecordBytes + 512 > reservedBytes) {
          fail('RESERVATION_EXHAUSTED')
        }
        const firstSequence = Number(this.getMetaRow().next_sequence)
        if (!Number.isSafeInteger(firstSequence) || firstSequence + input.events.length > Number.MAX_SAFE_INTEGER) fail('SEQUENCE_EXHAUSTED')
        const builtEvents = input.events.map((draft, index) => this.buildEvent(draft, firstSequence + index, input.controllerId))
        if (builtEvents.some(event => event.causationOperationId !== input.operationId)) fail('EVENT_INVALID')
        const final = builtEvents[builtEvents.length - 1]
        if (final.type !== 'operation-result' || final.payload.operationId !== input.operationId ||
            final.payload.status !== input.status) fail('EVENT_INVALID')
        const terminalEventSequence = builtEvents[builtEvents.length - 1].eventSequence
        let addedEventBytes = 0
        for (const event of builtEvents) addedEventBytes += this.insertEvent(event, input.controllerId, input.operationId)
        const commandJson = String(operation.command_json)
        const oldOpBytes = this.storedOperationBytes(commandJson, String(operation.fingerprint), input.controllerId,
          input.operationId, 'accepted', null)
        const newOpBytes = this.storedOperationBytes(commandJson, String(operation.fingerprint), input.controllerId,
          input.operationId, input.status, terminalFingerprint)
        const oldReceipt = stableJson({ status: 'accepted', acceptedEventSequence: Number(operation.accepted_sequence), terminalEventSequence: null })
        const newReceipt = stableJson({ status: input.status, acceptedEventSequence: Number(operation.accepted_sequence), terminalEventSequence })
        const oldTombstoneBytes = this.storedTombstoneBytes(String(operation.fingerprint), input.controllerId, input.operationId, 'accepted', oldReceipt)
        const newTombstoneBytes = this.storedTombstoneBytes(String(operation.fingerprint), input.controllerId, input.operationId, input.status, newReceipt)
        const metadataDelta = (newOpBytes - oldOpBytes) + (newTombstoneBytes - oldTombstoneBytes)
        this.database.prepare(`UPDATE operations SET status=?,terminal_sequence=?,terminal_fingerprint=?,reserved_bytes=0,reserved_records=0
          WHERE journal_id=? AND controller_id=? AND operation_id=?`)
          .run(input.status, terminalEventSequence, terminalFingerprint, this.options.journalId, input.controllerId, input.operationId)
        this.database.prepare(`UPDATE operation_tombstones SET status=?,terminal_sequence=?,receipt_json=?
          WHERE journal_id=? AND controller_id=? AND operation_id=?`)
          .run(input.status, terminalEventSequence, newReceipt, this.options.journalId, input.controllerId, input.operationId)
        this.updateMeta(metadataDelta + addedEventBytes, builtEvents.length, -reservedBytes, -reservedEvents, terminalEventSequence)
        const updated = this.findOperation(input.controllerId, input.operationId)!
        return this.receiptFromRow(updated, false)
      })
      this.options.testHooks?.afterCommit?.(input.operationId, 'finish')
      return receipt
    } catch (error) {
      if (error instanceof PlayerOperationalStoreError) throw error
      return this.resolveWriteFailure<PlayerOperationReceipt>(input.operationId, input.controllerId,
        operationFingerprint, terminalFingerprint, error, 'finish')
    }
  }

  /** Record a valid but semantically rejected command without reserving any future effect capacity. */
  recordRejectedOperation(input: { readonly controllerId: string; readonly command: unknown; readonly state: string }): PlayerOperationReceipt {
    this.ensureOpen()
    const command = this.parseCommand(input.command, input.controllerId)
    if (typeof input.state !== 'string' || input.state.length > 64 || /[\x00-\x1f\x7f]/.test(input.state)) fail('OPERATION_INVALID')
    const operationId = command.body.operationId
    const fingerprint = this.operationFingerprint(command.body)
    const existing = this.findOperation(input.controllerId, operationId)
    if (existing) {
      if (existing.fingerprint !== fingerprint) fail('OPERATION_ID_CONFLICT')
      return this.receiptFromRow(existing, true)
    }
    const commandJson = stableJson(command.body)
    try {
      const receipt = this.transaction(() => {
        const meta = this.getMetaRow()
        const duplicate = this.findOperation(input.controllerId, operationId)
        if (duplicate) {
          if (duplicate.fingerprint !== fingerprint) fail('OPERATION_ID_CONFLICT')
          return this.receiptFromRow(duplicate, true)
        }
        const sequence = Number(meta.next_sequence)
        if (!Number.isSafeInteger(sequence) || sequence + 1 > Number.MAX_SAFE_INTEGER) fail('SEQUENCE_EXHAUSTED')
        const target = this.commandTarget(command.body)
        const event = this.buildEvent({ schemaVersion: 1, causationOperationId: operationId,
          sessionId: target.sessionId, turnId: target.turnId,
          ...('occurrenceId' in target ? { occurrenceId: target.occurrenceId, attemptId: target.attemptId } : {}),
          stateRevision: target.stateRevision, origin: 'remote',
          type: 'operation-result', payload: { operationId, status: 'rejected' }
        }, sequence, input.controllerId)
        const eventBytes = this.eventBytes(event, input.controllerId, operationId)
        const receiptJson = stableJson({ status: 'rejected', acceptedEventSequence: sequence, terminalEventSequence: sequence, state: input.state })
        const opBytes = this.storedOperationBytes(commandJson, fingerprint, input.controllerId, operationId, 'rejected', null)
        const tombstoneBytes = this.storedTombstoneBytes(fingerprint, input.controllerId, operationId, 'rejected', receiptJson)
        this.checkCapacity(meta, opBytes + tombstoneBytes + eventBytes, 3)
        this.database.prepare(`INSERT INTO operation_tombstones(journal_id,controller_id,operation_id,fingerprint,status,
          accepted_sequence,terminal_sequence,receipt_json) VALUES(?,?,?,?,?,?,?,?)`)
          .run(this.options.journalId, input.controllerId, operationId, fingerprint, 'rejected', sequence, sequence, receiptJson)
        this.database.prepare(`INSERT INTO operations(journal_id,controller_id,operation_id,fingerprint,command_json,status,
          accepted_sequence,terminal_sequence,terminal_fingerprint,reserved_bytes,reserved_records,created_at)
          VALUES(?,?,?,?,?,'rejected',?,?,NULL,0,0,?)`)
          .run(this.options.journalId, input.controllerId, operationId, fingerprint, commandJson, sequence, sequence, Date.now())
        this.insertEvent(event, input.controllerId, operationId)
        this.updateMeta(opBytes + tombstoneBytes + eventBytes, 3, 0, 0, sequence)
        return this.receiptFromRow({ journal_id: this.options.journalId, controller_id: input.controllerId,
          operation_id: operationId, fingerprint, status: 'rejected', accepted_sequence: sequence,
          terminal_sequence: sequence }, false)
      })
      this.options.testHooks?.afterCommit?.(operationId, 'reject')
      return receipt
    } catch (error) {
      if (error instanceof PlayerOperationalStoreError) throw error
      return this.resolveWriteFailure<PlayerOperationReceipt>(operationId, input.controllerId, fingerprint, null, error, 'reject')
    }
  }

  lookupOperation(controllerId: string, operationId: string): PlayerOperationRecord | null {
    this.ensureOpen()
    if (!isId(controllerId) || !isId(operationId)) fail('OPERATION_INVALID')
    const row = this.findOperation(controllerId, operationId)
    if (!row) return null
    let command: CommandEnvelope['body'] | null = null
    if (row.command_json !== null) {
      try {
        command = JSON.parse(String(row.command_json)) as CommandEnvelope['body']
        const envelope = { protocolVersion: 1, schemaVersion: 1, kind: 'command', messageId: 'stored-command',
          deviceId: this.options.deviceId, controllerId, body: command }
        parseOperationalMessageObject(envelope)
        if (command.operationId !== operationId) fail('STORE_CORRUPT')
      } catch (error) {
        this.writeRecoveryMarker('stored-operation-invalid', this.options.journalId)
        fail('STORE_CORRUPT', error)
      }
    }
    return { ...this.receiptFromRow(row, false), command, compacted: command === null }
  }

  getMetadata(): PlayerOperationalMetadata {
    this.ensureOpen()
    return this.metadataFromDatabase()
  }

  getOperationStatus(input: { readonly controllerId: string; readonly operationId: string }): {
    readonly operationId: string; readonly fingerprint: string; readonly status: PlayerOperationalStatus;
    readonly result: Record<string, unknown> | null; readonly eventSequence: number | null
  } | null {
    const record = this.lookupOperation(input.controllerId, input.operationId)
    if (!record) return null
    const latest = this.database.prepare(`SELECT event_json FROM events WHERE journal_id=? AND controller_id=? AND operation_id=?
      ORDER BY event_sequence DESC LIMIT 1`).get(this.options.journalId, input.controllerId, input.operationId) as { event_json?: string } | undefined
    let result: Record<string, unknown> | null = null
    if (latest?.event_json) {
      let event: JournalEvent
      try { event = JSON.parse(latest.event_json) as JournalEvent } catch (error) {
        this.writeRecoveryMarker('stored-event-invalid', this.options.journalId)
        fail('STORE_CORRUPT', error)
      }
      try {
        parseOperationalMessageObject({ protocolVersion: 1, schemaVersion: 1, kind: 'event', messageId: 'status-event',
          deviceId: this.options.deviceId, controllerId: input.controllerId, body: event })
      } catch (error) {
        this.writeRecoveryMarker('stored-event-invalid', this.options.journalId)
        fail('STORE_CORRUPT', error)
      }
      if (event.type === 'operation-result') result = { status: event.payload.status }
    } else if (record.compacted) result = { status: record.status }
    return { operationId: input.operationId, fingerprint: record.fingerprint, status: record.status,
      result, eventSequence: record.terminalEventSequence ?? record.acceptedEventSequence }
  }

  readPage(input: { readonly controllerId: string; readonly correlationId: string; readonly afterSequence: number; readonly limit: number }): PlayerJournalPage {
    this.ensureOpen()
    if (!isId(input.controllerId) || !isId(input.correlationId) || !Number.isSafeInteger(input.afterSequence) ||
        input.afterSequence < 0 || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > OPERATIONAL_LIMITS.maxPageEvents) {
      fail('CURSOR_INVALID')
    }
    const meta = this.metadataFromDatabase()
    if (input.afterSequence < meta.compactedThrough) fail('REPLAY_COMPACTED')
    if (input.afterSequence > meta.highWatermark) fail('CURSOR_INVALID')
    const rows = this.database.prepare(`SELECT event_sequence,controller_id,operation_id,event_json FROM events
      WHERE journal_id=? AND event_sequence>? ORDER BY event_sequence LIMIT ?`)
      .all(this.options.journalId, input.afterSequence, input.limit + 1) as Array<Record<string, unknown>>
    if (rows.length === 0 && input.afterSequence < meta.highWatermark) {
      this.writeRecoveryMarker('journal-sequence-gap', meta.journalId)
      fail('CURSOR_GAP')
    }
    const events: JournalEvent[] = []
    let expected = input.afterSequence + 1
    let hasMore = false
    for (const row of rows) {
      const sequence = readSqlNumber(row.event_sequence, 'STORE_CORRUPT')
      if (sequence !== expected) {
        this.writeRecoveryMarker('journal-sequence-gap', meta.journalId)
        fail('CURSOR_GAP')
      }
      expected++
      if (events.length >= input.limit) { hasMore = true; break }
      let event: JournalEvent
      try {
        event = JSON.parse(String(row.event_json)) as JournalEvent
        const envelope = { protocolVersion: 1, schemaVersion: 1, kind: 'event', messageId: 'event-' + sequence,
          deviceId: meta.deviceId, controllerId: String(row.controller_id), body: event }
        parseOperationalMessageObject(envelope)
        if (event.eventSequence !== sequence || event.journalId !== meta.journalId ||
            event.causationOperationId !== row.operation_id) fail('STORE_CORRUPT')
      } catch (error) {
        this.writeRecoveryMarker('stored-event-invalid', meta.journalId)
        fail('STORE_CORRUPT', error)
      }
      const candidate = [...events, event]
      const payload = { journalId: meta.journalId, events: candidate, throughSequence: sequence,
        highWatermark: meta.highWatermark, hasMore: false, compactedThrough: meta.compactedThrough }
      const response = { protocolVersion: 1, schemaVersion: 1, kind: 'response', messageId: 'page-response',
        deviceId: meta.deviceId, controllerId: input.controllerId,
        body: { correlationId: input.correlationId, type: 'journal-page', payload } }
      let size: number
      try { parseOperationalMessageObject(response); size = Buffer.byteLength(JSON.stringify(response), 'utf8') }
      catch (error) {
        if (events.length === 0) fail('EVENT_INVALID', error)
        hasMore = true
        break
      }
      if (size > OPERATIONAL_LIMITS.maxEnvelopeBytes) {
        hasMore = true
        break
      }
      events.push(event)
    }
    if (!hasMore && rows.length > events.length) hasMore = true
    const throughSequence = events.length ? events[events.length - 1].eventSequence : input.afterSequence
    return { journalId: meta.journalId, events, throughSequence, highWatermark: meta.highWatermark, hasMore,
      compactedThrough: meta.compactedThrough }
  }

  /** Persist a consumer's durable, monotonically increasing application cursor. */
  ackConsumed(input: { readonly controllerId: string; readonly journalId: string; readonly consumerId: string;
    readonly throughSequence: number }): PlayerConsumerCursor {
    this.ensureOpen()
    if (!isId(input.controllerId) || !isId(input.consumerId) || input.consumerId !== input.controllerId ||
        input.journalId !== this.options.journalId || !Number.isSafeInteger(input.throughSequence) || input.throughSequence < 0) {
      fail(input.journalId !== this.options.journalId ? 'CURSOR_INVALID' : 'OPERATION_INVALID')
    }
    try {
      const result = this.transaction(() => {
        const meta = this.getMetaRow()
        if (input.throughSequence > Number(meta.high_watermark)) fail('CURSOR_INVALID')
        const current = this.database.prepare(`SELECT through_sequence,revoked_at FROM consumer_cursors
          WHERE journal_id=? AND consumer_id=?`).get(this.options.journalId, input.consumerId) as Record<string, unknown> | undefined
        if (current?.revoked_at != null) fail('CONSUMER_REVOKED')
        const oldSequence = current ? readSqlNumber(current.through_sequence, 'STORE_CORRUPT') : 0
        if (current && input.throughSequence <= oldSequence) {
          return { journalId: this.options.journalId, consumerId: input.consumerId,
            throughSequence: oldSequence, revokedAt: null, duplicate: true }
        }
        this.database.prepare(`INSERT INTO consumer_cursors(journal_id,consumer_id,through_sequence,revoked_at)
          VALUES(?,?,?,NULL) ON CONFLICT(journal_id,consumer_id) DO UPDATE SET through_sequence=excluded.through_sequence
          WHERE consumer_cursors.revoked_at IS NULL`)
          .run(this.options.journalId, input.consumerId, input.throughSequence)
        return { journalId: this.options.journalId, consumerId: input.consumerId,
          throughSequence: input.throughSequence, revokedAt: null, duplicate: false }
      })
      this.options.testHooks?.afterCommit?.(input.consumerId, 'ack')
      return result
    } catch (error) {
      if (error instanceof PlayerOperationalStoreError) throw error
      if (sqliteErrorIsBusy(error)) fail('STORE_IN_USE', error)
      try {
        this.options.testHooks?.failReadback?.('ack')
        const row = this.database.prepare(`SELECT through_sequence,revoked_at FROM consumer_cursors
          WHERE journal_id=? AND consumer_id=?`).get(this.options.journalId, input.consumerId) as Record<string, unknown> | undefined
        if (row?.revoked_at != null) fail('CONSUMER_REVOKED')
        if (row && Number(row.through_sequence) >= input.throughSequence) {
          return { journalId: this.options.journalId, consumerId: input.consumerId,
            throughSequence: readSqlNumber(row.through_sequence, 'STORE_CORRUPT'), revokedAt: null, duplicate: true }
        }
        fail('STORE_WRITE_FAILED', error)
      } catch (readError) {
        if (readError instanceof PlayerOperationalStoreError && readError.code === 'STORE_WRITE_FAILED') throw readError
        this.writeRecoveryMarker('consumer-cursor-readback-unavailable', this.options.journalId)
        fail('RESULT_UNCERTAIN', readError)
      }
    }
  }

  getConsumerCursor(consumerId: string): PlayerConsumerCursor | null {
    this.ensureOpen()
    if (!isId(consumerId)) fail('OPERATION_INVALID')
    const row = this.database.prepare(`SELECT through_sequence,revoked_at FROM consumer_cursors
      WHERE journal_id=? AND consumer_id=?`).get(this.options.journalId, consumerId) as Record<string, unknown> | undefined
    return row ? { journalId: this.options.journalId, consumerId,
      throughSequence: readSqlNumber(row.through_sequence, 'STORE_CORRUPT'),
      revokedAt: row.revoked_at == null ? null : String(row.revoked_at), duplicate: false } : null
  }

  /** Compact only the prefix both durably consumed and covered by a snapshot. Tombstones are immutable. */
  compactJournal(): PlayerJournalCompactionResult {
    this.ensureOpen()
    const before = this.metadataFromDatabase()
    let attempted: PlayerJournalCompactionResult | null = null
    try {
      const result = this.transaction(() => {
        const meta = this.getMetaRow()
        const highWatermark = Number(meta.high_watermark)
        const compactedThrough = Number(meta.compacted_through)
        const cursorRow = this.database.prepare(`SELECT MIN(through_sequence) AS through_sequence FROM consumer_cursors
          WHERE journal_id=?`).get(this.options.journalId) as { through_sequence?: number | null }
        const checkpoint = this.database.prepare(`SELECT checkpoint_sequence FROM checkpoints WHERE journal_id=?
          ORDER BY checkpoint_sequence DESC LIMIT 1`).get(this.options.journalId) as { checkpoint_sequence?: number } | undefined
        if (cursorRow.through_sequence == null || !checkpoint) {
          attempted = { journalId: this.options.journalId, compactedThrough, highWatermark,
            eventsDeleted: 0, operationsDeleted: 0, checkpointsDeleted: 0, logicalBytesReleased: 0, recordsReleased: 0 }
          return attempted
        }
        const checkpointSequence = readSqlNumber(checkpoint.checkpoint_sequence, 'STORE_CORRUPT')
        if (checkpointSequence < compactedThrough) {
          this.writeRecoveryMarker('checkpoint-behind-compacted-cursor', this.options.journalId)
          fail('RECOVERY_REQUIRED')
        }
        let safeThrough = Math.min(readSqlNumber(cursorRow.through_sequence, 'STORE_CORRUPT'), checkpointSequence, highWatermark)
        const uncertain = this.database.prepare(`SELECT MIN(accepted_sequence) AS sequence FROM operations
          WHERE journal_id=? AND status IN ('accepted','unknown')`).get(this.options.journalId) as { sequence?: number | null }
        if (uncertain.sequence != null) safeThrough = Math.min(safeThrough, readSqlNumber(uncertain.sequence, 'STORE_CORRUPT') - 1)
        if (safeThrough <= compactedThrough) {
          attempted = { journalId: this.options.journalId, compactedThrough, highWatermark,
            eventsDeleted: 0, operationsDeleted: 0, checkpointsDeleted: 0, logicalBytesReleased: 0, recordsReleased: 0 }
          return attempted
        }

        const eventRows = this.database.prepare(`SELECT event_json,controller_id,operation_id FROM events
          WHERE journal_id=? AND event_sequence<=? ORDER BY event_sequence`).all(this.options.journalId, safeThrough) as Array<Record<string, unknown>>
        let logicalBytesReleased = 0
        for (const row of eventRows) logicalBytesReleased += Buffer.byteLength(String(row.event_json), 'utf8') +
          Buffer.byteLength(String(row.controller_id), 'utf8') + Buffer.byteLength(String(row.operation_id), 'utf8')
        const operationRows = this.database.prepare(`SELECT controller_id,operation_id,fingerprint,command_json,status,terminal_fingerprint
          FROM operations WHERE journal_id=? AND status IN ('completed','rejected') AND terminal_sequence<=?`)
          .all(this.options.journalId, safeThrough) as Array<Record<string, unknown>>
        for (const row of operationRows) logicalBytesReleased += this.storedOperationBytes(String(row.command_json),
          String(row.fingerprint), String(row.controller_id), String(row.operation_id), String(row.status),
          row.terminal_fingerprint == null ? null : String(row.terminal_fingerprint))
        const oldCheckpoints = this.database.prepare(`SELECT checkpoint_json,checkpoint_fingerprint FROM checkpoints
          WHERE journal_id=? AND checkpoint_sequence<?`).all(this.options.journalId, checkpointSequence) as Array<Record<string, unknown>>
        for (const row of oldCheckpoints) logicalBytesReleased += Buffer.byteLength(String(row.checkpoint_json), 'utf8') +
          Buffer.byteLength(String(row.checkpoint_fingerprint), 'utf8')

        this.database.prepare('DELETE FROM events WHERE journal_id=? AND event_sequence<=?')
          .run(this.options.journalId, safeThrough)
        for (const row of operationRows) this.database.prepare(`DELETE FROM operations WHERE journal_id=? AND controller_id=? AND operation_id=?`)
          .run(this.options.journalId, String(row.controller_id), String(row.operation_id))
        this.database.prepare(`DELETE FROM checkpoints WHERE journal_id=? AND checkpoint_sequence<?`)
          .run(this.options.journalId, checkpointSequence)
        const recordsReleased = eventRows.length + operationRows.length + oldCheckpoints.length
        this.database.prepare(`UPDATE journal_meta SET compacted_through=?,logical_bytes=logical_bytes-?,record_count=record_count-?
          WHERE singleton=1`).run(safeThrough, logicalBytesReleased, recordsReleased)
        attempted = { journalId: this.options.journalId, compactedThrough: safeThrough, highWatermark,
          eventsDeleted: eventRows.length, operationsDeleted: operationRows.length,
          checkpointsDeleted: oldCheckpoints.length, logicalBytesReleased, recordsReleased }
        return attempted
      })
      this.options.testHooks?.afterCommit?.(String(result.compactedThrough), 'compact')
      this.assertAccounting()
      return result
    } catch (error) {
      if (error instanceof PlayerOperationalStoreError) throw error
      if (sqliteErrorIsBusy(error)) fail('STORE_IN_USE', error)
      const readbackPlan = attempted as unknown as PlayerJournalCompactionResult | null
      if (readbackPlan) {
        try {
          this.options.testHooks?.failReadback?.('compact')
          const current = this.metadataFromDatabase()
          this.assertAccounting()
          const committed = current.compactedThrough === readbackPlan.compactedThrough &&
            current.logicalBytes === before.logicalBytes - readbackPlan.logicalBytesReleased &&
            current.recordCount === before.recordCount - readbackPlan.recordsReleased &&
            current.highWatermark === before.highWatermark
          if (committed) return readbackPlan
          const unchanged = current.compactedThrough === before.compactedThrough &&
            current.logicalBytes === before.logicalBytes && current.recordCount === before.recordCount &&
            current.highWatermark === before.highWatermark
          if (unchanged) fail('STORE_WRITE_FAILED', error)
        } catch (readError) {
          if (readError instanceof PlayerOperationalStoreError && readError.code === 'STORE_WRITE_FAILED') throw readError
          this.writeRecoveryMarker('journal-compaction-readback-unavailable', this.options.journalId)
          fail('RESULT_UNCERTAIN', readError)
        }
      }
      this.writeRecoveryMarker('journal-compaction-failed', this.options.journalId)
      fail('RESULT_UNCERTAIN', error)
    }
  }

  /** Persist the exact Player snapshot used as a possible replay/compaction base. */
  saveCheckpoint(input: { readonly controllerId: string; readonly correlationId: string; readonly snapshot: unknown }): {
    readonly sequence: number; readonly fingerprint: string; readonly duplicate: boolean
  } {
    this.ensureOpen()
    if (!isId(input.controllerId) || !isId(input.correlationId)) fail('EVENT_INVALID')
    try { parseOperationalMessageObject(input.snapshot) } catch (error) { fail('EVENT_INVALID', error) }
    const snapshot = input.snapshot as OperationalMessage
    if (snapshot.kind !== 'response' || snapshot.body.type !== 'snapshot' || snapshot.deviceId !== this.options.deviceId ||
        snapshot.controllerId !== input.controllerId || snapshot.body.correlationId !== input.correlationId ||
        snapshot.body.payload.deviceId !== this.options.deviceId || snapshot.body.payload.journalId !== this.options.journalId) fail('EVENT_INVALID')
    const sequence = Number(snapshot.body.payload.highWatermark)
    if (!Number.isSafeInteger(sequence) || sequence < 0) fail('CURSOR_INVALID')
    const durableSnapshot: ResponseEnvelope = { ...snapshot, messageId: `checkpoint-${sequence}`,
      body: { ...snapshot.body, correlationId: `checkpoint-${sequence}` } }
    const json = stableJson(durableSnapshot)
    if (Buffer.byteLength(json, 'utf8') > MAX_CHECKPOINT_BYTES) fail('EVENT_INVALID')
    const fingerprint = sha256(json)
    try {
      const result = this.transaction(() => {
        const meta = this.getMetaRow()
        if (sequence !== Number(meta.high_watermark) || Number(snapshot.body.payload.compactedThrough) !== Number(meta.compacted_through)) {
          fail('CURSOR_INVALID')
        }
        const existing = this.database.prepare('SELECT checkpoint_fingerprint FROM checkpoints WHERE journal_id=? AND checkpoint_sequence=?')
          .get(this.options.journalId, sequence) as { checkpoint_fingerprint?: string } | undefined
        if (existing) {
          if (existing.checkpoint_fingerprint !== fingerprint) fail('CHECKPOINT_CONFLICT')
          return { sequence, fingerprint, duplicate: true }
        }
        const bytes = Buffer.byteLength(json) + Buffer.byteLength(fingerprint)
        this.checkCapacity(meta, bytes, 1)
        this.database.prepare('INSERT INTO checkpoints VALUES(?,?,?,?)').run(this.options.journalId, sequence, json, fingerprint)
        this.updateMeta(bytes, 1)
        return { sequence, fingerprint, duplicate: false }
      })
      this.options.testHooks?.afterCommit?.(input.correlationId, 'checkpoint')
      return result
    } catch (error) {
      if (error instanceof PlayerOperationalStoreError) throw error
      if (sqliteErrorIsBusy(error)) fail('STORE_IN_USE', error)
      try {
        this.options.testHooks?.failReadback?.('checkpoint')
        const row = this.database.prepare('SELECT checkpoint_fingerprint FROM checkpoints WHERE journal_id=? AND checkpoint_sequence=?')
          .get(this.options.journalId, sequence) as { checkpoint_fingerprint?: string } | undefined
        if (row?.checkpoint_fingerprint === fingerprint) return { sequence, fingerprint, duplicate: true }
        if (row) { this.writeRecoveryMarker('checkpoint-readback-mismatch', this.options.journalId); fail('RESULT_UNCERTAIN') }
        fail('STORE_WRITE_FAILED', error)
      } catch (readError) {
        if (readError instanceof PlayerOperationalStoreError && readError.code === 'STORE_WRITE_FAILED') throw readError
        this.writeRecoveryMarker('checkpoint-readback-unavailable', this.options.journalId)
        fail('RESULT_UNCERTAIN', readError)
      }
    }
  }

  getLatestCheckpoint(): { readonly sequence: number; readonly snapshot: ResponseEnvelope } | null {
    this.ensureOpen()
    const row = this.database.prepare(`SELECT checkpoint_sequence,checkpoint_json,checkpoint_fingerprint FROM checkpoints
      WHERE journal_id=? ORDER BY checkpoint_sequence DESC LIMIT 1`).get(this.options.journalId) as Record<string, unknown> | undefined
    if (!row) return null
    const json = String(row.checkpoint_json)
    if (sha256(json) !== row.checkpoint_fingerprint) {
      this.writeRecoveryMarker('checkpoint-fingerprint-mismatch', this.options.journalId)
      fail('STORE_CORRUPT')
    }
    let snapshot: ResponseEnvelope
    try {
      snapshot = JSON.parse(json) as ResponseEnvelope
      parseOperationalMessageObject(snapshot)
    } catch (error) {
      this.writeRecoveryMarker('checkpoint-invalid', this.options.journalId)
      fail('STORE_CORRUPT', error)
    }
    const sequence = readSqlNumber(row.checkpoint_sequence, 'STORE_CORRUPT')
    if (snapshot.kind !== 'response' || snapshot.body.type !== 'snapshot' || snapshot.deviceId !== this.options.deviceId ||
        snapshot.body.payload.journalId !== this.options.journalId || Number(snapshot.body.payload.highWatermark) !== sequence ||
        Number(snapshot.body.payload.compactedThrough) > sequence) {
      this.writeRecoveryMarker('checkpoint-lineage-invalid', this.options.journalId)
      fail('STORE_CORRUPT')
    }
    return { sequence, snapshot }
  }

  /** Historical marker only. G2 remains the sole authority for whether a controller is currently authorized. */
  markConsumerRevoked(controllerId: string, revokedAt = new Date().toISOString()): void {
    this.ensureOpen()
    if (!isId(controllerId) || !Number.isFinite(Date.parse(revokedAt)) || revokedAt.length > 40) fail('OPERATION_INVALID')
    try {
      this.transaction(() => {
        this.database.prepare(`INSERT INTO consumer_cursors(journal_id,consumer_id,through_sequence,revoked_at) VALUES(?,?,0,?)
          ON CONFLICT(journal_id,consumer_id) DO UPDATE SET revoked_at=excluded.revoked_at`)
          .run(this.options.journalId, controllerId, revokedAt)
      })
      this.options.testHooks?.afterCommit?.(controllerId, 'revoke')
    } catch (error) {
      if (error instanceof PlayerOperationalStoreError) throw error
      if (sqliteErrorIsBusy(error)) fail('STORE_IN_USE', error)
      try {
        this.options.testHooks?.failReadback?.('revoke')
        const row = this.database.prepare('SELECT revoked_at FROM consumer_cursors WHERE journal_id=? AND consumer_id=?')
          .get(this.options.journalId, controllerId) as { revoked_at?: string | null } | undefined
        if (row?.revoked_at === revokedAt) return
        if (row?.revoked_at !== undefined) { this.writeRecoveryMarker('revocation-readback-mismatch', this.options.journalId); fail('RESULT_UNCERTAIN') }
        fail('STORE_WRITE_FAILED', error)
      } catch (readError) {
        if (readError instanceof PlayerOperationalStoreError && readError.code === 'STORE_WRITE_FAILED') throw readError
        this.writeRecoveryMarker('revocation-readback-unavailable', this.options.journalId)
        fail('RESULT_UNCERTAIN', readError)
      }
    }
  }

  getConsumerRevocation(controllerId: string): string | null {
    this.ensureOpen()
    if (!isId(controllerId)) fail('OPERATION_INVALID')
    const row = this.database.prepare('SELECT revoked_at FROM consumer_cursors WHERE journal_id=? AND consumer_id=?')
      .get(this.options.journalId, controllerId) as { revoked_at?: string | null } | undefined
    return row?.revoked_at ?? null
  }

  private recoverAcceptedOperations(): void {
    while (true) {
      const rows = this.database.prepare(`SELECT controller_id,operation_id,command_json,reserved_bytes,reserved_records
        FROM operations WHERE journal_id=? AND status='accepted' ORDER BY accepted_sequence LIMIT 32`)
        .all(this.options.journalId) as Array<Record<string, unknown>>
      if (rows.length === 0) return
      try {
        this.transaction(() => {
          for (const row of rows) {
            const controllerId = String(row.controller_id)
            const operationId = String(row.operation_id)
            const command = JSON.parse(String(row.command_json)) as CommandEnvelope['body']
            const target = command.target
            const first = Number(this.getMetaRow().next_sequence)
            const drafts: OperationalEventDraft[] = [
              { schemaVersion: 1, causationOperationId: operationId, sessionId: target.sessionId, turnId: target.turnId,
                ...('occurrenceId' in target ? { occurrenceId: target.occurrenceId, attemptId: target.attemptId } : {}),
                stateRevision: target.stateRevision, origin: 'remote', type: 'uncertain',
                payload: { reason: 'process-restarted' } },
              { schemaVersion: 1, causationOperationId: operationId, sessionId: target.sessionId, turnId: target.turnId,
                ...('occurrenceId' in target ? { occurrenceId: target.occurrenceId, attemptId: target.attemptId } : {}),
                stateRevision: target.stateRevision, origin: 'remote', type: 'operation-result',
                payload: { operationId, status: 'unknown' } }
            ]
            const built = drafts.map((draft, index) => this.buildEvent(draft, first + index, controllerId))
            const reservedBytes = Number(row.reserved_bytes)
            const reservedRecords = Number(row.reserved_records)
            if (reservedRecords < built.length || reservedBytes < built.length * OPERATIONAL_LIMITS.maxRecordBytes + 512) {
              this.writeRecoveryMarker('accepted-operation-reservation-invalid', this.options.journalId)
              fail('RECOVERY_REQUIRED')
            }
            let eventBytes = 0
            for (const event of built) eventBytes += this.insertEvent(event, controllerId, operationId)
            const operation = this.findOperation(controllerId, operationId)!
            const status = 'unknown'
            const terminalFingerprint = sha256(stableJson({ status, events: drafts }))
            const commandJson = String(operation.command_json)
            const oldOpBytes = this.storedOperationBytes(commandJson, String(operation.fingerprint), controllerId, operationId, 'accepted', null)
            const newOpBytes = this.storedOperationBytes(commandJson, String(operation.fingerprint), controllerId, operationId, status, terminalFingerprint)
            const oldReceipt = stableJson({ status: 'accepted', acceptedEventSequence: Number(operation.accepted_sequence), terminalEventSequence: null })
            const newReceipt = stableJson({ status, acceptedEventSequence: Number(operation.accepted_sequence), terminalEventSequence: built[1].eventSequence })
            const oldTombstoneBytes = this.storedTombstoneBytes(String(operation.fingerprint), controllerId, operationId, 'accepted', oldReceipt)
            const newTombstoneBytes = this.storedTombstoneBytes(String(operation.fingerprint), controllerId, operationId, status, newReceipt)
            this.database.prepare(`UPDATE operations SET status='unknown',terminal_sequence=?,terminal_fingerprint=?,reserved_bytes=0,reserved_records=0
              WHERE journal_id=? AND controller_id=? AND operation_id=?`)
              .run(built[1].eventSequence, terminalFingerprint, this.options.journalId, controllerId, operationId)
            this.database.prepare(`UPDATE operation_tombstones SET status='unknown',terminal_sequence=?,receipt_json=?
              WHERE journal_id=? AND controller_id=? AND operation_id=?`)
              .run(built[1].eventSequence, newReceipt, this.options.journalId, controllerId, operationId)
            this.updateMeta(newOpBytes - oldOpBytes + newTombstoneBytes - oldTombstoneBytes + eventBytes,
              built.length, -reservedBytes, -reservedRecords, built[1].eventSequence)
          }
        })
      } catch (error) {
        this.writeRecoveryMarker('startup-recovery-incomplete', this.options.journalId)
        if (error instanceof PlayerOperationalStoreError) throw error
        fail('RESULT_UNCERTAIN', error)
      }
    }
  }

  /** SQLite checkpoint only. It never advances journal cursors or compacts events/tombstones. */
  checkpointWal(): { readonly busy: number; readonly logFrames: number; readonly checkpointedFrames: number } {
    this.ensureOpen()
    const row = this.database.prepare('PRAGMA wal_checkpoint(PASSIVE)').get() as Record<string, unknown> | undefined
    if (!row) fail('STORE_WRITE_FAILED')
    return { busy: readSqlNumber(row.busy, 'STORE_CORRUPT'), logFrames: readSqlNumber(row.log, 'STORE_CORRUPT'),
      checkpointedFrames: readSqlNumber(row.checkpointed, 'STORE_CORRUPT') }
  }

  createBackup(): { readonly manifest: PlayerOperationalBackupManifest; readonly manifestFile: string; readonly backupPath: string } {
    this.ensureOpen()
    const metadata = this.metadataFromDatabase()
    const directory = path.join(this.options.userDataDirectory, BACKUP_DIRECTORY)
    if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: false, mode: 0o700 })
    assertRegularDirectory(directory)
    const createdAt = new Date().toISOString()
    const stamp = createdAt.replace(/[-:.]/g, '')
    const stem = 'player-operational.schema-1.' + stamp + '.' + crypto.randomUUID()
    const backupFile = stem + '.sqlite'
    const manifestFile = stem + '.json'
    const temporaryDatabase = path.join(directory, '.' + stem + '.tmp.sqlite')
    const temporaryManifest = path.join(directory, '.' + stem + '.tmp.json')
    const backupPath = path.join(directory, backupFile)
    const manifestPath = path.join(directory, manifestFile)
    try {
      this.database.prepare('VACUUM INTO ?').run(temporaryDatabase)
      const stat = fs.lstatSync(temporaryDatabase)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_BACKUP_BYTES) fail('BACKUP_INVALID')
      fs.chmodSync(temporaryDatabase, 0o600)
      const checksum = fileSha256(temporaryDatabase)
      const manifest: PlayerOperationalBackupManifest = {
        formatVersion: 1, databaseFile: PLAYER_OPERATIONAL_DATABASE_FILENAME,
        schemaVersion: PLAYER_OPERATIONAL_STORE_SCHEMA_VERSION, journalId: metadata.journalId, deviceId: metadata.deviceId,
        highWatermark: metadata.highWatermark, logicalBytes: metadata.logicalBytes, recordCount: metadata.recordCount,
        createdAt, backupFile, sha256: checksum
      }
      verifyDatabaseFile(temporaryDatabase, manifest)
      const manifestFd = fs.openSync(temporaryManifest, 'wx', 0o600)
      try { fs.writeFileSync(manifestFd, JSON.stringify(manifest, null, 2) + '\n', 'utf8'); fs.fsyncSync(manifestFd) }
      finally { fs.closeSync(manifestFd) }
      fs.renameSync(temporaryDatabase, backupPath)
      fs.renameSync(temporaryManifest, manifestPath)
      syncDirectory(directory)
      return { manifest, manifestFile, backupPath }
    } catch (error) {
      for (const file of [temporaryDatabase, temporaryManifest]) try { fs.unlinkSync(file) } catch {}
      if (error instanceof PlayerOperationalStoreError) throw error
      fail('BACKUP_INVALID', error)
    }
  }

  close(): void {
    if (this.closed) return
    try {
      if (!this.blocked) this.database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
    } finally {
      this.database.close()
      this.closed = true
    }
  }
}
