import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'FATAL'
export type RunStatus = 'running' | 'normal' | 'failed'

export interface LogRecord {
  timestamp: string
  level: LogLevel
  origin: string
  event: string
  message: string
  runId: string
  stack?: string
  details?: Record<string, string | number | boolean | null>
}

export interface LoggerOptions {
  logsDirectory: string
  userDataDirectory?: string
  runId?: string
  maxFileBytes?: number
  maxBackups?: number
}

export interface FileLogger {
  readonly runId: string
  readonly logsDirectory: string
  readonly crashesDirectory: string
  info(origin: string, event: string, message: string, details?: LogRecord['details']): void
  warn(origin: string, event: string, message: string, error?: unknown, details?: LogRecord['details']): void
  error(origin: string, event: string, message: string, error?: unknown, details?: LogRecord['details']): void
  fatal(origin: string, event: string, message: string, error?: unknown, details?: LogRecord['details']): void
  startRun(): { previousRunId: string | null; previousStatus: RunStatus | null }
  finishRun(status?: Exclude<RunStatus, 'running'>): void
  pruneCrashDumps(maxFiles?: number, maxBytes?: number): void
}

interface RunMarker {
  runId: string
  startedAt: string
  finishedAt?: string
  status: RunStatus
}

const SECRET_PATTERN = /\b(password|passwd|token|secret|authorization|cookie|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi
const MAX_MESSAGE_LENGTH = 12000

function getErrorParts(value: unknown): { message: string; stack?: string } {
  if (value instanceof Error) return { message: value.message, stack: value.stack }
  if (value === undefined || value === null) return { message: '' }
  if (typeof value === 'string') return { message: value }
  try { return { message: JSON.stringify(value) } } catch { return { message: String(value) } }
}

export function createFileLogger(options: LoggerOptions): FileLogger {
  const logsDirectory = options.logsDirectory
  const crashesDirectory = path.join(logsDirectory, 'crashes')
  const markerPath = path.join(logsDirectory, 'run-state.json')
  const runId = options.runId ?? crypto.randomUUID()
  const maxFileBytes = Math.max(1024, options.maxFileBytes ?? 4 * 1024 * 1024)
  const maxBackups = Math.max(1, Math.trunc(options.maxBackups ?? 5))
  const replacements: Array<[string, string]> = []
  if (options.userDataDirectory) replacements.push([options.userDataDirectory, '<userData>'])
  const home = os.homedir()
  if (home) replacements.push([home, '<home>'])
  replacements.sort((a, b) => b[0].length - a[0].length)

  const sanitize = (value: string): string => {
    let result = value.slice(0, MAX_MESSAGE_LENGTH)
    for (const [sensitivePath, replacement] of replacements) {
      result = result.replaceAll(sensitivePath, replacement)
      result = result.replaceAll(sensitivePath.replaceAll(path.sep, path.sep === '/' ? '\\' : '/'), replacement)
    }
    return result.replace(SECRET_PATTERN, '$1=<redacted>')
  }

  const safeMkdir = (): boolean => {
    try {
      fs.mkdirSync(logsDirectory, { recursive: true })
      fs.mkdirSync(crashesDirectory, { recursive: true })
      return true
    } catch {
      return false
    }
  }

  const rotate = (filePath: string, incomingBytes: number): void => {
    try {
      if (!fs.existsSync(filePath)) return
      if (fs.statSync(filePath).size + incomingBytes <= maxFileBytes) return
      const oldest = `${filePath}.${maxBackups}`
      try { fs.rmSync(oldest, { force: true }) } catch {}
      for (let index = maxBackups - 1; index >= 1; index--) {
        const source = `${filePath}.${index}`
        if (fs.existsSync(source)) fs.renameSync(source, `${filePath}.${index + 1}`)
      }
      fs.renameSync(filePath, `${filePath}.1`)
    } catch {
      // Logging must never take down the application.
    }
  }

  const write = (record: LogRecord): void => {
    try {
      if (!safeMkdir()) return
      const line = `${JSON.stringify(record)}\n`
      const bytes = Buffer.byteLength(line, 'utf8')
      const appLog = path.join(logsDirectory, 'app.log')
      rotate(appLog, bytes)
      fs.appendFileSync(appLog, line, { encoding: 'utf8', mode: 0o600 })
      if (record.level === 'WARN' || record.level === 'ERROR' || record.level === 'FATAL') {
        const errorLog = path.join(logsDirectory, 'error.log')
        rotate(errorLog, bytes)
        fs.appendFileSync(errorLog, line, { encoding: 'utf8', mode: 0o600 })
      }
    } catch (error) {
      // Best-effort stderr fallback, with no recursive logger call.
      try { fs.writeSync(2, `Karaoke Queue logger write failed: ${String(error)}\n`) } catch {}
    }
  }

  const emit = (level: LogLevel, origin: string, event: string, message: string, error?: unknown,
    details?: LogRecord['details']): void => {
    const parts = getErrorParts(error)
    const stack = parts.stack ? sanitize(parts.stack) : undefined
    const record: LogRecord = {
      timestamp: new Date().toISOString(), level, origin: sanitize(origin), event: sanitize(event),
      message: sanitize([message, parts.message].filter(Boolean).join(': ')), runId,
      ...(stack ? { stack } : {}),
      ...(details ? { details: Object.fromEntries(Object.entries(details).map(([key, value]) => [sanitize(key),
        typeof value === 'string' ? sanitize(value) : value])) } : {})
    }
    write(record)
  }

  const readMarker = (): RunMarker | null => {
    try { return JSON.parse(fs.readFileSync(markerPath, 'utf8')) as RunMarker } catch { return null }
  }
  const writeMarker = (marker: RunMarker): void => {
    try {
      if (!safeMkdir()) return
      const temporaryPath = `${markerPath}.tmp`
      fs.writeFileSync(temporaryPath, JSON.stringify(marker), { encoding: 'utf8', mode: 0o600 })
      fs.renameSync(temporaryPath, markerPath)
    } catch (error) {
      try { fs.writeSync(2, `Karaoke Queue run marker write failed: ${String(error)}\n`) } catch {}
    }
  }

  return {
    runId,
    logsDirectory,
    crashesDirectory,
    info: (origin, event, message, details) => emit('INFO', origin, event, message, undefined, details),
    warn: (origin, event, message, error, details) => emit('WARN', origin, event, message, error, details),
    error: (origin, event, message, error, details) => emit('ERROR', origin, event, message, error, details),
    fatal: (origin, event, message, error, details) => emit('FATAL', origin, event, message, error, details),
    startRun() {
      const previous = readMarker()
      const result = { previousRunId: previous?.runId ?? null, previousStatus: previous?.status ?? null }
      if (previous?.status === 'running') {
        emit('ERROR', 'main', 'APP_UNEXPECTED_TERMINATION_DETECTED', 'A execução anterior não confirmou saída normal.', undefined,
          { previousRunId: previous.runId, previousStartedAt: previous.startedAt })
      } else if (previous?.status === 'failed') {
        emit('WARN', 'main', 'APP_PREVIOUS_RUN_FAILED', 'A execução anterior terminou durante uma falha.', undefined,
          { previousRunId: previous.runId, previousStartedAt: previous.startedAt })
      }
      writeMarker({ runId, startedAt: new Date().toISOString(), status: 'running' })
      emit('INFO', 'main', 'APP_STARTING', 'Inicialização do aplicativo iniciada.')
      return result
    },
    finishRun(status = 'normal') {
      const marker = readMarker()
      if (!marker || marker.runId !== runId) return
      const finishedAt = new Date().toISOString()
      writeMarker({ ...marker, status, finishedAt })
      if (status === 'normal') emit('INFO', 'main', 'APP_EXIT_NORMAL', 'Execução encerrada normalmente.')
      else emit('FATAL', 'main', 'APP_EXIT_FAILED', 'Execução encerrada após falha.')
    },
    pruneCrashDumps(maxFiles = 10, maxBytes = 100 * 1024 * 1024) {
      try {
        if (!safeMkdir()) return
        const entries = fs.readdirSync(crashesDirectory, { withFileTypes: true })
          .filter(entry => entry.isFile())
          .map(entry => {
            const filePath = path.join(crashesDirectory, entry.name)
            const stat = fs.statSync(filePath)
            return { path: filePath, mtime: stat.mtimeMs, size: stat.size }
          }).sort((a, b) => a.mtime - b.mtime)
        let totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0)
        while (entries.length > maxFiles || totalBytes > maxBytes) {
          const oldest = entries.shift()
          if (!oldest) break
          fs.rmSync(oldest.path, { force: true })
          totalBytes -= oldest.size
        }
      } catch {
        // Crash dump cleanup is best effort; never block startup.
      }
    }
  }
}

