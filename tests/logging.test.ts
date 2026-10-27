import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createFileLogger } from '../src/logging'

function temporaryDirectory(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

test('writes structured levels, UTC timestamps, run ID, stacks and sanitizes secrets/paths', () => {
  const root = temporaryDirectory('kqueue-logger-record-')
  const logs = path.join(root, 'logs')
  const logger = createFileLogger({ logsDirectory: logs, userDataDirectory: root, runId: 'run-test-1' })
  try {
    logger.info('main', 'APP_READY', 'ready')
    logger.warn('sqlite', 'DB_BUSY', 'database retry', new Error(`failed at ${root}/karaoke.sqlite`))
    logger.error('renderer', 'RENDERER_UNCAUGHT_EXCEPTION', 'token=secret123 failed')
    logger.fatal('main', 'MAIN_UNCAUGHT_EXCEPTION', 'fatal', new Error('fatal stack'))

    const appLines = fs.readFileSync(path.join(logs, 'app.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    const errorLines = fs.readFileSync(path.join(logs, 'error.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.deepEqual(appLines.map(record => record.level), ['INFO', 'WARN', 'ERROR', 'FATAL'])
    assert.ok(appLines.every(record => record.runId === 'run-test-1'))
    assert.ok(appLines.every(record => /^\d{4}-\d\d-\d\dT.*Z$/.test(record.timestamp)))
    assert.equal(appLines[1].stack.includes('<userData>'), true)
    assert.match(appLines[2].message, /token=<redacted>/)
    assert.deepEqual(errorLines.map(record => record.level), ['WARN', 'ERROR', 'FATAL'])
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('rotates log files and retains only configured backups', () => {
  const root = temporaryDirectory('kqueue-logger-rotate-')
  const logs = path.join(root, 'logs')
  const logger = createFileLogger({ logsDirectory: logs, maxFileBytes: 1024, maxBackups: 2 })
  try {
    for (let index = 0; index < 30; index++) logger.info('test', 'ROTATION', `line-${index}-${'x'.repeat(140)}`)
    const files = fs.readdirSync(logs).filter(name => /^app\.log(?:\.\d+)?$/.test(name)).sort()
    assert.deepEqual(files, ['app.log', 'app.log.1', 'app.log.2'])
    assert.ok(files.every(name => fs.statSync(path.join(logs, name)).size <= 1024))
    assert.ok(fs.readFileSync(path.join(logs, 'app.log'), 'utf8').includes('line-29-'))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('run marker detects unconfirmed previous execution and records normal exit', () => {
  const root = temporaryDirectory('kqueue-logger-run-')
  const logs = path.join(root, 'logs')
  try {
    const first = createFileLogger({ logsDirectory: logs, runId: 'run-one' })
    assert.deepEqual(first.startRun(), { previousRunId: null, previousStatus: null })
    // Intentionally leave run-one active to simulate force termination.
    const second = createFileLogger({ logsDirectory: logs, runId: 'run-two' })
    assert.deepEqual(second.startRun(), { previousRunId: 'run-one', previousStatus: 'running' })
    second.finishRun('normal')
    const third = createFileLogger({ logsDirectory: logs, runId: 'run-three' })
    assert.deepEqual(third.startRun(), { previousRunId: 'run-two', previousStatus: 'normal' })
    const records = fs.readFileSync(path.join(logs, 'app.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.ok(records.some(record => record.event === 'APP_UNEXPECTED_TERMINATION_DETECTED' && record.details.previousRunId === 'run-one'))
    assert.ok(records.some(record => record.event === 'APP_EXIT_NORMAL' && record.runId === 'run-two'))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('log write failures never throw into application code', () => {
  const root = temporaryDirectory('kqueue-logger-unwritable-')
  const blockedPath = path.join(root, 'not-a-directory')
  fs.writeFileSync(blockedPath, 'file')
  const logger = createFileLogger({ logsDirectory: blockedPath })
  try {
    assert.doesNotThrow(() => logger.startRun())
    assert.doesNotThrow(() => logger.error('test', 'WRITE_FAILED', 'diagnostic unavailable'))
    assert.doesNotThrow(() => logger.finishRun())
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
