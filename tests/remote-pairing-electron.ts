// @ts-nocheck
export {}

// Real G5 pairing UI across two independent production Main/Preload processes.
const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { _electron: electron } = require('playwright')
const { prepareControllerModeProfile } = require('./electron-test-profile')
const { closeElectronTestAppNormally, createElectronTestTempRoot, runWithElectronTestCleanup,
  terminateElectronTestHarnessAfterCleanupFailure, withElectronTestDeadline } = require('./electron-test-lifecycle')
const { createKaraokeDatabase } = require('../database')
const { ManagementRemoteOutbox } = require('../src/management-remote-outbox')
const { PlayerOperationalStore } = require('../src/player-operational-store')
const { probeBootstrapCertificate } = require('../src/remote-tls')
const { waitForPageCondition } = require('./async-page-polling')

const projectRoot = path.resolve(__dirname, '../..')
const profileRoot = createElectronTestTempRoot('karaoke-g5-pairing-electron')

function profileEnvironment(name) {
  const root = path.join(profileRoot, name)
  const userData = path.join(root, 'user-data')
  fs.mkdirSync(userData, { recursive: true })
  return {
    role: name,
    root,
    userData,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: path.join(root, 'config'),
      XDG_CACHE_HOME: path.join(root, 'cache'),
      XDG_DATA_HOME: path.join(root, 'data')
    }
  }
}

let currentStage = 'profile-setup'
let temporaryCodeForLogRedaction
let lockoutAttemptTrace = []
function diagnosticPrefix() {
  const root = process.env.KARAOKE_TEST_TEMP_ROOT
  return path.basename(root ? path.resolve(root) : profileRoot)
}

function stageDiagnosticPath() {
  return path.join(os.tmpdir(), `${diagnosticPrefix()}-g5-stage.json`)
}

function markStage(stage) {
  currentStage = stage
  try {
    fs.writeFileSync(stageDiagnosticPath(), JSON.stringify({
      stage, updatedAt: new Date().toISOString()
    }) + '\n', { flag: 'w' })
  } catch { /* stage diagnostics never alter a functional assertion */ }
}

function preserveSanitizedFailureLogs(player, management) {
  const logRoot = path.join(os.tmpdir(), `${diagnosticPrefix()}-logs`)
  let copied = 0
  for (const [role, profile] of [['player', player], ['management', management]]) {
    const source = path.join(profile.userData, 'logs')
    if (!fs.existsSync(source)) continue
    for (const name of ['app.log', 'error.log']) {
      const input = path.join(source, name)
      if (!fs.existsSync(input)) continue
      let content = fs.readFileSync(input, 'utf8')
      if (temporaryCodeForLogRedaction) {
        content = content.replaceAll(temporaryCodeForLogRedaction, '[TEMP_CODE_REDACTED]')
        content = content.replaceAll(temporaryCodeForLogRedaction.replace(' ', ''), '[TEMP_CODE_REDACTED]')
      }
      content = content.replace(/\b\d{8}\b/g, '[8_DIGIT_VALUE_REDACTED]')
      fs.mkdirSync(logRoot, { recursive: true })
      fs.writeFileSync(path.join(logRoot, `${role}-${name}`), content, { flag: 'w' })
      copied++
    }
  }
  if (copied) {
    fs.writeFileSync(path.join(logRoot, 'manifest.json'), JSON.stringify({
      stage: currentStage, copiedLogCount: copied, temporaryCodesRedacted: true
    }) + '\n', { flag: 'w' })
  }
}

function safeAssertionValue(value) {
  if (typeof value !== 'string') return value === null || typeof value === 'number' || typeof value === 'boolean'
    ? value : undefined
  return value.replace(/\b\d{4} \d{4}\b/g, '[TEMP_CODE_REDACTED]')
    .replace(/\b\d{8}\b/g, '[TEMP_CODE_REDACTED]')
    .replace(/\b[a-f0-9]{8}-[a-f0-9-]{27,}\b/gi, '[TEST_ID_REDACTED]')
    .replace(/(?:\d{1,3}\.){3}\d{1,3}/g, '[ADDRESS]')
    .replace(/[A-Z]:\\[^\s"']+/gi, '[PATH]')
    .slice(0, 180)
}

function applyAutomationDeadlines(app, role) {
  app.context().setDefaultTimeout(15_000)
  app.context().setDefaultNavigationTimeout(30_000)
  const appEvaluate = app.evaluate.bind(app)
  let appEvaluationCount = 0
  app.evaluate = (...args) => withElectronTestDeadline(appEvaluate(...args),
    `${role}:app.evaluate#${++appEvaluationCount}`)
  const firstWindow = app.firstWindow.bind(app)
  app.firstWindow = async (...args) => {
    const page = await withElectronTestDeadline(firstWindow(...args), `${role}:first-window`, 10_000)
    page.setDefaultTimeout(15_000)
    page.setDefaultNavigationTimeout(30_000)
    const pageEvaluate = page.evaluate.bind(page)
    let pageEvaluationCount = 0
    page.evaluate = (...evaluateArgs) => withElectronTestDeadline(pageEvaluate(...evaluateArgs),
      `${role}:page.evaluate#${++pageEvaluationCount}`)
    return page
  }
  return app
}

async function launch(profile) {
  const app = await electron.launch({
    executablePath: require('electron'),
    args: [projectRoot, `--user-data-dir=${profile.userData}`],
    env: profile.env,
    timeout: 30000
  })
  return applyAutomationDeadlines(app, profile.role)
}

async function dismissPairingDialogsBeforeExit(playerPage, managementPage) {
  const clickIfVisible = async locator => {
    if (!locator || !await locator.isVisible().catch(() => false)) return false
    return locator.click({ timeout: 2000 }).then(() => true).catch(() => false)
  }
  let cleanupActionStarted = false
  if (managementPage) {
    cleanupActionStarted = await clickIfVisible(managementPage.locator(
      '#remote-devices-root .remote-pairing-dialog [data-action="cancel-pairing"]')) || cleanupActionStarted
  }
  if (playerPage) {
    cleanupActionStarted = await clickIfVisible(playerPage.getByRole('dialog', { name: 'Permitir esta Gestão?' })
      .getByRole('button', { name: /Rejeitar/ })) || cleanupActionStarted
    cleanupActionStarted = await clickIfVisible(playerPage.getByRole('dialog', { name: 'Confirme o pareamento' })
      .getByRole('button', { name: 'Cancelar solicitação · Esc' })) || cleanupActionStarted
    const closeResult = playerPage.getByRole('alertdialog')
      .getByRole('button', { name: 'Fechar · Enter' })
    if (cleanupActionStarted) await closeResult.waitFor({ state: 'visible', timeout: 3000 }).catch(() => undefined)
    await clickIfVisible(closeResult)
  }
}

function readLockoutAttemptLedger(userDataDirectory) {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(userDataDirectory, 'remote-authorization.json'), 'utf8'))
    return {
      storeRevision: Number.isSafeInteger(state.storeRevision) ? state.storeRevision : null,
      reservedAttemptCount: Array.isArray(state.attempts) ? state.attempts.length : null
    }
  } catch { return { storeRevision: null, reservedAttemptCount: null } }
}

async function readLockoutUiObservation(playerPage, managementPage, expectedRequestId,
  playerUserData, managementUserData) {
  const [player, management] = await Promise.all([
    playerPage.evaluate(async () => {
      const snapshot = await window.karaokeRemotePlayer.getSnapshot().catch(() => null)
      const heading = document.querySelector('[role="dialog"] h1, [role="alertdialog"] h1')
      return {
        revision: snapshot?.revision ?? null,
        pairing: snapshot?.playerPairing ?? null,
        listener: snapshot?.listener ?? null,
        temporaryCodeVisible: Boolean(document.querySelector('.remote-player-temporary-code')),
        consentVisible: Boolean([...document.querySelectorAll('[role="dialog"] h1')]
          .some(value => value.textContent?.includes('Permitir'))),
        pairingDialogVisible: Boolean([...document.querySelectorAll('[role="dialog"] h1')]
          .some(value => value.textContent?.includes('Confirme o pareamento'))),
        heading: heading?.textContent?.trim() ?? null,
        authorizedControllerCount: snapshot?.connections.filter(item =>
          item.deviceRole === 'controller' && item.state === 'authorized').length ?? null
      }
    }).catch(() => null),
    managementPage.evaluate(async expectedId => {
      const snapshot = await window.karaokeRemoteManagement.getSnapshot().catch(() => null)
      const root = document.querySelector('#remote-devices-root')
      const dialog = root?.querySelector('.remote-pairing-dialog')
      const input = root?.querySelector('#remote-pairing-code')
      const waiting = root?.querySelector('.remote-pairing-dialog .remote-waiting')
      const error = root?.querySelector('[data-error-code]')
      return {
        revision: snapshot?.revision ?? null,
        snapshotErrorCode: snapshot?.errorCode ?? null,
        errorCode: error?.getAttribute('data-error-code') ?? null,
        errorText: error?.textContent?.trim() ?? null,
        pairingDialogVisible: Boolean(dialog?.getClientRects().length),
        pairingHeading: dialog?.querySelector('h1')?.textContent?.trim() ?? null,
        waitingVisible: Boolean(waiting?.getClientRects().length),
        waitingText: waiting?.textContent?.trim() ?? null,
        codeInputVisible: Boolean(input?.getClientRects().length),
        codeInputRequestMatches: Boolean(input && input.dataset.requestId === expectedId),
        initialCandidateCount: root?.querySelectorAll('[data-purpose="initial"]').length ?? null,
        activeSavedDeviceCount: snapshot?.savedDevices.filter(device => device.status === 'active').length ?? null
      }
    }, expectedRequestId).catch(() => null)
  ])
  return {
    observedAt: new Date().toISOString(), player, management,
    attemptLedgers: {
      player: readLockoutAttemptLedger(playerUserData),
      management: readLockoutAttemptLedger(managementUserData)
    }
  }
}

function waitForProcessExit(app, timeoutMs = 30000) {
  const child = app.process()
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode })
  }
  return new Promise((resolve, reject) => {
    let timer
    const onExit = (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal })
    }
    timer = setTimeout(() => {
      child.off('exit', onExit)
      reject(new Error('PLAYER_EXIT_CONFIRMATION_TIMEOUT'))
    }, timeoutMs)
    child.once('exit', onExit)
  })
}

/** Test-only opaque TCP forwarder, created in the existing Electron Main process.
 * It can sever live WSS sockets while both applications and their durable intents remain active.
 */
async function startTransportFaultProxy(managementApp, endpoint, requestedPort = 0) {
  return managementApp.evaluate(({ app: electronApp }, input) => {
    const { endpoint: target, requestedPort } = input
    const net = process.getBuiltinModule('node:net')
    const connections = new Set()
    const diagnostics = { accepted: 0, closed: 0, closureEvents: [], lifecycleEvents: [] }
    const bufferedDownstream = []
    const downstreamBufferWaiters = new Set()
    let downstreamPaused = false
    let targetEndpoint = { address: target.address, port: target.port }
    const recordLifecycle = (event, details = {}) => {
      diagnostics.lifecycleEvents.push({ event, at: Date.now(), ...details })
      if (diagnostics.lifecycleEvents.length > 12) diagnostics.lifecycleEvents.shift()
    }
    const record = (side, event, socket, hadError = false) => {
      diagnostics.closureEvents.push({ connection: socket.id, side, event, hadError,
        at: Date.now(),
        code: null,
        clientBytesRead: socket.client?.bytesRead ?? 0, clientBytesWritten: socket.client?.bytesWritten ?? 0,
        upstreamBytesRead: socket.upstream?.bytesRead ?? 0, upstreamBytesWritten: socket.upstream?.bytesWritten ?? 0 })
      if (diagnostics.closureEvents.length > 12) diagnostics.closureEvents.shift()
      if (event === 'close') diagnostics.closed++
    }
    let paused = false
    const server = net.createServer(client => {
      if (paused) { client.destroy(); return }
      diagnostics.accepted++
      const upstream = net.createConnection({ host: targetEndpoint.address, port: targetEndpoint.port })
      const sockets = { client, upstream, id: diagnostics.accepted }
      connections.add(client)
      connections.add(upstream)
      client.on('error', () => undefined)
      upstream.on('error', error => {
        const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,32}$/.test(error.code) ? error.code : null
        record('upstream', 'error', sockets)
        diagnostics.closureEvents.at(-1).code = code
        client.destroy()
      })
      client.once('end', () => record('client', 'end', sockets))
      upstream.once('end', () => record('upstream', 'end', sockets))
      client.once('close', hadError => { record('client', 'close', sockets, hadError); connections.delete(client); upstream.destroy() })
      upstream.once('close', hadError => { record('upstream', 'close', sockets, hadError); connections.delete(upstream); client.destroy() })
      client.pipe(upstream)
      upstream.on('data', chunk => {
        if (downstreamPaused) {
          bufferedDownstream.push({ client, chunk: Buffer.from(chunk) })
          for (const resolve of downstreamBufferWaiters) resolve(bufferedDownstream.reduce((total, frame) => total + frame.chunk.length, 0))
          downstreamBufferWaiters.clear()
        }
        else client.write(chunk)
      })
    })
    const handle = {
      dropTransport() {
        paused = true
        recordLifecycle('transport-dropped')
        for (const socket of [...connections]) socket.destroy()
      },
      restoreTransport() { paused = false; recordLifecycle('transport-restored') },
      pauseDownstream() {
        downstreamPaused = true
        recordLifecycle('downstream-paused')
      },
      resumeDownstream() {
        downstreamPaused = false
        for (const frame of bufferedDownstream.splice(0)) {
          if (!frame.client.destroyed) frame.client.write(frame.chunk)
        }
        recordLifecycle('downstream-resumed')
      },
      waitForDownstreamBuffer(timeoutMs) {
        const bufferedBytes = bufferedDownstream.reduce((total, frame) => total + frame.chunk.length, 0)
        if (bufferedBytes > 0) return Promise.resolve(bufferedBytes)
        return new Promise(resolve => {
          const finish = value => { clearTimeout(timer); downstreamBufferWaiters.delete(finish); resolve(value) }
          const timer = setTimeout(() => finish(0), timeoutMs)
          downstreamBufferWaiters.add(finish)
        })
      },
      setTarget(endpoint) {
        if (!endpoint || net.isIP(endpoint.address) !== 4 || !Number.isInteger(endpoint.port) ||
            endpoint.port < 1024 || endpoint.port > 65535) throw new Error('G5_TEST_PROXY_TARGET_INVALID')
        targetEndpoint = { address: endpoint.address, port: endpoint.port }
        recordLifecycle('target-updated', { port: endpoint.port })
      },
      getDiagnostics() { return { ...diagnostics, paused, active: connections.size / 2,
        downstreamPaused, bufferedDownstreamBytes: bufferedDownstream.reduce((total, frame) => total + frame.chunk.length, 0),
        targetPort: targetEndpoint.port,
        closureEvents: diagnostics.closureEvents.map(item => ({ ...item })),
        lifecycleEvents: diagnostics.lifecycleEvents.map(item => ({ ...item })) } },
      close() {
        this.dropTransport()
        return new Promise(resolve => {
          if (!server.listening) { resolve(); return }
          server.close(() => resolve())
        })
      }
    }
    globalThis.__kqG5TransportFaultProxy = handle
    return new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(requestedPort, target.address, () => {
        server.removeListener('error', reject)
        const address = server.address()
        if (!address || typeof address === 'string') { reject(new Error('G5_TEST_PROXY_ADDRESS_INVALID')); return }
        resolve(address.port)
      })
    })
  }, { endpoint, requestedPort })
}

async function updateTransportProxyTarget(managementApp, playerPage) {
  const endpoint = await playerPage.evaluate(async () => window.karaokeRemotePlayer.getSnapshot()
    .then(snapshot => snapshot.listenerEndpoint))
  assert.ok(endpoint && Number.isInteger(endpoint.port), 'the restarted Player Main publishes its real listening endpoint')
  await managementApp.evaluate(({ app: electronApp }, currentEndpoint) => {
    globalThis.__kqG5TransportFaultProxy.setTarget(currentEndpoint)
  }, endpoint)
}

async function installOperationStatusResponseHold(managementApp, operationId) {
  await managementApp.evaluate(({ app: electronApp }, id) => {
    const moduleApi = process.getBuiltinModule('node:module')
    const pathApi = process.getBuiltinModule('node:path')
    const requireFromApp = moduleApi.createRequire(pathApi.join(electronApp.getAppPath(), 'package.json'))
    const WebSocket = requireFromApp('ws')
    const prototype = WebSocket.prototype
    const originalOwnEmit = Object.hasOwn(prototype, 'emit') ? prototype.emit : undefined
    const originalEmit = originalOwnEmit ?? Object.getPrototypeOf(prototype).emit
    if (typeof originalEmit !== 'function' || globalThis.__kqG5OperationResponseHold) {
      throw new Error('G5_OPERATION_RESPONSE_HOLD_UNAVAILABLE')
    }
    const held = []
    const waiters = new Set()
    let enabled = true
    prototype.emit = function (event, ...args) {
      if (enabled && event === 'message' && args[1] !== true) {
        try {
          const raw = Array.isArray(args[0]) ? Buffer.concat(args[0]) : Buffer.from(args[0])
          const message = JSON.parse(raw.toString('utf8'))
          if (message.kind === 'response' && message.body?.type === 'operation-status' &&
              message.body.payload?.operationId === id) {
            held.push({ socket: this, args })
            for (const resolve of waiters) resolve(held.length)
            waiters.clear()
            return true
          }
        } catch { /* Other valid message events continue to the original WebSocket dispatcher. */ }
      }
      return originalEmit.call(this, event, ...args)
    }
    globalThis.__kqG5OperationResponseHold = {
      getDiagnostics() {
        return { enabled, matchingResponsesReceived: held.length,
          pendingResponse: held.length > 0, operationId: id }
      },
      waitForMatchingResponse(timeoutMs) {
        if (held.length > 0) return Promise.resolve(held.length)
        return new Promise(resolve => {
          let timer
          const finish = count => { clearTimeout(timer); waiters.delete(finish); resolve(count) }
          timer = setTimeout(() => finish(0), timeoutMs)
          waiters.add(finish)
        })
      },
      release() {
        if (!globalThis.__kqG5OperationResponseHold) return { released: 0 }
        enabled = false
        if (originalOwnEmit) prototype.emit = originalOwnEmit
        else delete prototype.emit
        const responses = held.splice(0)
        for (const response of responses) originalEmit.apply(response.socket, ['message', ...response.args])
        delete globalThis.__kqG5OperationResponseHold
        return { released: responses.length }
      }
    }
  }, operationId)
}

async function installPlayerPreparedPairingResponseHold(playerApp) {
  await playerApp.evaluate(({ app: electronApp }) => {
    const moduleApi = process.getBuiltinModule('node:module')
    const pathApi = process.getBuiltinModule('node:path')
    const requireFromApp = moduleApi.createRequire(pathApi.join(electronApp.getAppPath(), 'package.json'))
    const { PairingBootstrapService } = requireFromApp('./build/src/pairing-bootstrap.js')
    const { parsePairingEnvelope } = requireFromApp('./build/src/pairing-wire.js')
    const prototype = PairingBootstrapService.prototype
    const original = prototype.handle
    if (typeof original !== 'function' || globalThis.__kqG5PreparedPairingResponseHold) {
      throw new Error('G5_PAIRING_PREPARED_RESPONSE_HOLD_UNAVAILABLE')
    }
    let releaseGate
    const gate = new Promise(resolve => { releaseGate = resolve })
    let signalPrepared
    const prepared = new Promise(resolve => { signalPrepared = resolve })
    let matchingResponses = 0
    let released = false
    prototype.handle = async function (context) {
      const response = await original.call(this, context)
      try {
        const envelope = parsePairingEnvelope(response.body)
        if (response.statusCode === 200 && envelope.type === 'response/prepare' && !released) {
          matchingResponses++
          signalPrepared(matchingResponses)
          await gate
        }
      } catch { /* Ignore non-pairing and non-prepare replies; never record their bodies. */ }
      return response
    }
    globalThis.__kqG5PreparedPairingResponseHold = {
      getDiagnostics() { return { matchingResponses, released } },
      waitForPrepared(timeoutMs) {
        if (matchingResponses) return Promise.resolve(matchingResponses)
        return Promise.race([prepared, new Promise(resolve => setTimeout(() => resolve(0), timeoutMs))])
      },
      release() {
        if (released) return { released: 0 }
        released = true
        prototype.handle = original
        releaseGate()
        delete globalThis.__kqG5PreparedPairingResponseHold
        return { released: matchingResponses }
      }
    }
  })
}

async function observePlayerCommandForOperation(playerApp, operationId) {
  await playerApp.evaluate(({ app: electronApp }, id) => {
    const moduleApi = process.getBuiltinModule('node:module')
    const pathApi = process.getBuiltinModule('node:path')
    const requireFromApp = moduleApi.createRequire(pathApi.join(electronApp.getAppPath(), 'package.json'))
    const { OperationalProtocolService } = requireFromApp(pathApi.join(electronApp.getAppPath(),
      'build', 'src', 'operational-protocol-service.js'))
    const prototype = OperationalProtocolService.prototype
    const original = prototype.onMessage
    if (typeof original !== 'function' || globalThis.__kqG5CommandObservation) {
      throw new Error('G5_OPERATION_COMMAND_OBSERVATION_UNAVAILABLE')
    }
    const operationIds = []
    prototype.onMessage = function (context) {
      const message = context?.payload
      if (message?.kind === 'command' && message.body?.operationId === id) operationIds.push(id)
      return original.call(this, context)
    }
    globalThis.__kqG5CommandObservation = { operationIds, count: () => operationIds.length }
  }, operationId)
}

async function installManagementCloseChoice(managementApp) {
  await managementApp.evaluate(({ dialog }) => {
    const original = dialog.showMessageBox
    let resolveDecision
    const decision = new Promise(resolve => { resolveDecision = resolve })
    const observation = { selectedButton: null, title: null }
    dialog.showMessageBox = function (...args) {
      const options = args[args.length - 1]
      const buttonIndex = options?.buttons?.indexOf('Sair sem encerrar sessão') ?? -1
      if (buttonIndex >= 0) {
        observation.selectedButton = options.buttons[buttonIndex]
        observation.title = options.title ?? null
        resolveDecision({ ...observation, response: buttonIndex })
        return Promise.resolve({ response: buttonIndex, checkboxChecked: false })
      }
      return original.apply(this, args)
    }
    globalThis.__kqG5ManagementCloseChoice = {
      waitForDecision(timeoutMs) {
        return Promise.race([decision, new Promise(resolve => setTimeout(() => resolve(null), timeoutMs))])
      },
      getObservation() { return { ...observation } }
    }
  })
}

function readManagementCloseDecision(userDataDirectory) {
  const logPath = path.join(userDataDirectory, 'logs', 'app.log')
  if (!fs.existsSync(logPath)) return null
  for (const line of fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean).reverse()) {
    try {
      const record = JSON.parse(line)
      if (record.event === 'APP_CLOSE_DECISION') return record.details ?? null
    } catch { /* Continue to the last parseable close decision. */ }
  }
  return null
}

function windowsListenerOwnership(endpoint, expectedPlayerPid) {
  if (process.platform !== 'win32' || !endpoint || !Number.isInteger(endpoint.port)) return 'NOT_AVAILABLE'
  const netstat = childProcess.spawnSync('netstat.exe', ['-ano', '-p', 'tcp'], {
    encoding: 'utf8', windowsHide: true, timeout: 2000
  })
  if (netstat.error || netstat.status !== 0 || typeof netstat.stdout !== 'string') return 'NOT_AVAILABLE'
  const wantedAddress = String(endpoint.address).replace(/^\[|\]$/g, '').toLowerCase()
  const listeners = netstat.stdout.split(/\r?\n/).flatMap(line => {
    const match = line.match(/^\s*TCP\s+(\S+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i)
    if (!match) return []
    const local = match[1]
    const separator = local.lastIndexOf(':')
    if (separator < 0 || Number(local.slice(separator + 1)) !== endpoint.port) return []
    const address = local.slice(0, separator).replace(/^\[|\]$/g, '').toLowerCase()
    if (![wantedAddress, '0.0.0.0', '::', ':::'].includes(address)) return []
    return [{ pid: Number(match[2]), addressScope: address === wantedAddress ? 'exact' : 'wildcard' }]
  })
  if (!listeners.length) return []
  const pids = [...new Set(listeners.map(item => item.pid))].filter(Number.isInteger)
  const pidList = pids.join(',')
  const encodedRunMarker = Buffer.from(diagnosticPrefix(), 'utf8').toString('base64')
  const script = `$ids=@(${pidList}); $marker=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedRunMarker}')); $items=@(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { ($ids -contains $_.ProcessId) -or ($_.CommandLine -and $_.CommandLine.Contains($marker)) } | ForEach-Object { $line=$_.CommandLine; $type=if($line -match '(?i)--type=([^\\s]+)'){$matches[1]}else{'main'}; [pscustomobject]@{pid=$_.ProcessId;parentPid=$_.ParentProcessId;name=$_.Name;processType=$type;isKaraokePath=($_.ExecutablePath -match '(?i)KaraokeQueue|karaoke-queue');isCurrentRunProfile=($line -and $line.Contains($marker));isPairingHarness=($line -match '(?i)remote-pairing-electron');isUserDataFlag=($line -match '(?i)user-data-dir')} }); ConvertTo-Json -InputObject $items -Compress`
  const processQuery = childProcess.spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', windowsHide: true, timeout: 2500
  })
  let details = []
  if (!processQuery.error && processQuery.status === 0 && processQuery.stdout.trim()) {
    try {
      const parsed = JSON.parse(processQuery.stdout)
      details = Array.isArray(parsed) ? parsed : [parsed]
    } catch { /* Listener owner PIDs remain useful without process metadata. */ }
  }
  const endpointListeners = listeners.map(listener => ({ ...listener, pid: listener.pid,
    sameAsTestPlayer: listener.pid === expectedPlayerPid }))
  return { endpointListeners, currentProfileProcesses: details }
}

function operationalCommand(controllerId, playerId, operationId) {
  const command = JSON.parse(fs.readFileSync(path.join(projectRoot,
    'tests/fixtures/operational-v1/valid-messages.json'), 'utf8'))
    .find(message => message.kind === 'command')
  assert.ok(command, 'the G3 command fixture exists for isolated status-query coverage')
  command.deviceId = playerId
  command.controllerId = controllerId
  command.body.operationId = operationId
  return command
}

function seedUncertainOutbox(userDataDirectory, controllerId, playerId, operationId = randomUUID()) {
  const command = operationalCommand(controllerId, playerId, operationId)
  const database = createKaraokeDatabase(userDataDirectory)
  try {
    const outbox = new ManagementRemoteOutbox(database, { deviceId: controllerId, controllerId })
    outbox.prepare(playerId, command)
    database.remoteOutbox.markTransmissionStarted(playerId, controllerId, operationId)
  } finally {
    database.close()
  }
  return operationId
}

function seedPlayerOperationStatuses(userDataDirectory, controllerId, playerId, operationStatuses) {
  const store = new PlayerOperationalStore({ userDataDirectory, journalId: `journal-${playerId}`,
    deviceId: playerId, initializeIfMissing: true })
  try {
    for (const [operationId, status] of Object.entries(operationStatuses)) {
      const command = operationalCommand(controllerId, playerId, operationId)
      store.acceptOperation({ controllerId, command })
      if (status === 'accepted') continue
      const target = command.body.target
      store.finishOperation({ controllerId, operationId, status, events: [{ schemaVersion: 1,
        causationOperationId: operationId, sessionId: target.sessionId, turnId: target.turnId,
        stateRevision: target.stateRevision, origin: 'remote', type: 'operation-result',
        payload: { operationId, status } }] })
    }
  } finally { store.close() }
}

function readPairingRenewalPersistence(playerUserData, managementUserData, playerId) {
  const playerIdentity = JSON.parse(fs.readFileSync(path.join(playerUserData, 'remote-player-identity.json'), 'utf8'))
  const playerStore = JSON.parse(fs.readFileSync(path.join(playerUserData, 'remote-authorization.json'), 'utf8'))
  const managementStore = JSON.parse(fs.readFileSync(path.join(managementUserData, 'remote-authorization.json'), 'utf8'))
  const controllerAuthority = managementStore.controllerAuthorities?.[playerId]
  return {
    playerId: playerIdentity.deviceId,
    identityFingerprint: playerIdentity.certificateFingerprintSha256,
    playerAuthority: playerStore.playerAuthority && {
      phase: playerStore.playerAuthority.phase,
      credentialGeneration: playerStore.playerAuthority.credentialGeneration,
      certificateFingerprintSha256: playerStore.playerAuthority.certificateFingerprintSha256
    },
    renewal: playerStore.renewal && {
      phase: playerStore.renewal.phase,
      oldFingerprint: playerStore.renewal.oldFingerprint,
      newFingerprint: playerStore.renewal.newFingerprint
    },
    controllerAuthority: controllerAuthority && {
      phase: controllerAuthority.phase,
      credentialGeneration: controllerAuthority.credentialGeneration,
      certificateFingerprintSha256: controllerAuthority.certificateFingerprintSha256
    }
  }
}

function classifyRenewalConnectionError(value) {
  if (typeof value !== 'string' || !value) return 'NO_ERROR_RECORDED'
  if (/^[A-Z][A-Z0-9_]{1,63}$/.test(value)) return value
  const knownCode = value.match(/\b(ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|ERR_TLS_[A-Z_]+|ERR_SSL_[A-Z_]+|CERT_[A-Z_]+)\b/)
  if (knownCode) return knownCode[1]
  if (/hostname\/ip.*does not match/i.test(value)) return 'TLS_HOSTNAME_MISMATCH'
  if (/self[- ]signed certificate/i.test(value)) return 'TLS_SELF_SIGNED_CERTIFICATE'
  if (/certificate has expired/i.test(value)) return 'TLS_CERTIFICATE_EXPIRED'
  if (/certificate signature failure/i.test(value)) return 'TLS_CERTIFICATE_SIGNATURE_FAILURE'
  if (/unable to verify|unable to get local issuer/i.test(value)) return 'TLS_CERTIFICATE_UNTRUSTED'
  return 'NON_MACHINE_ERROR'
}

function readRenewalReconnectLogSummary(profile, playerId) {
  const file = path.join(profile.userData, 'logs', 'app.log')
  if (!fs.existsSync(file)) return []
  const records = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
  return records.flatMap(line => {
    try {
      const record = JSON.parse(line)
      if (record.event !== 'REMOTE_RECONNECTION_STATE' || record.details?.playerId !== playerId) return []
      return [{ at: record.timestamp, state: record.details.state,
        reasonClass: classifyRenewalConnectionError(record.details.reason),
        synchronized: record.details.synchronized === true }]
    } catch { return [] }
  }).slice(-30)
}

async function observeRenewalFailure(expectedPlayerId, playerPage, managementPage, playerUserData, managementUserData) {
  const playerIdentity = JSON.parse(fs.readFileSync(path.join(playerUserData, 'remote-player-identity.json'), 'utf8'))
  const playerId = expectedPlayerId
  const persistence = readPairingRenewalPersistence(playerUserData, managementUserData, playerId)
  const [player, management] = await Promise.all([
    playerPage.evaluate(async () => {
      const snapshot = await window.karaokeRemotePlayer.getSnapshot().catch(() => null)
      return { revision: snapshot?.revision ?? null, intent: snapshot?.intent ?? null,
        listener: snapshot?.listener ?? null, pairing: snapshot?.playerPairing ?? null,
        endpoint: snapshot?.listenerEndpoint ? { port: snapshot.listenerEndpoint.port,
          hasAddress: Boolean(snapshot.listenerEndpoint.address) } : null,
        errorCode: snapshot?.errorCode ?? null }
    }).catch(() => null),
    managementPage.evaluate(async expectedPlayerId => {
      const snapshot = await window.karaokeRemoteManagement.getSnapshot().catch(() => null)
      if (!snapshot) return null
      const connection = snapshot.connections.find(item => item.deviceRole === 'player' && item.deviceId === expectedPlayerId)
      const candidates = snapshot.candidates.filter(item => item.claimedDeviceId === expectedPlayerId)
      const savedCard = document.querySelector(`#remote-devices-root [data-saved-player-id="${expectedPlayerId}"]`)
      const badge = savedCard?.querySelector('[data-connection-state]')
      const candidateById = new Map(snapshot.candidates.map(item => [item.candidateId, item]))
      const candidateActions = [...document.querySelectorAll('#remote-devices-root [data-candidate-id]')]
      const candidateSummaries = snapshot.candidates.slice(0, 12).map(item => {
        const action = candidateActions.find(button => button.getAttribute('data-candidate-id') === item.candidateId)
        const candidateConnection = snapshot.connections.find(value => value.deviceRole === 'player' &&
          value.deviceId === item.claimedDeviceId)
        const candidateSaved = snapshot.savedDevices.find(device => device.playerId === item.claimedDeviceId)
        return { candidateIdPresent: Boolean(item.candidateId), claimedPeerMatchesExpected: item.claimedDeviceId === expectedPlayerId,
          savedPeerPresent: Boolean(candidateSaved), savedPeerActive: candidateSaved?.status === 'active',
          savedPeerRecoveryRequired: candidateSaved?.recoveryRequired ?? null,
          connectionState: candidateConnection?.state ?? null, connectionReason: candidateConnection?.reason ?? null,
          candidateActionPurpose: action?.getAttribute('data-purpose') ?? null,
          actionPlayerMatchesClaim: action?.getAttribute('data-player-id') === item.claimedDeviceId,
          actionCandidateMatchesCard: action?.closest('article')?.querySelector('[data-candidate-id]')?.getAttribute('data-candidate-id') === item.candidateId }
      })
      return { revision: snapshot.revision,
        connection: connection ? { state: connection.state, reason: connection.reason,
          reconciled: connection.reconciled } : null,
        savedDevices: snapshot.savedDevices.map(device => ({ belongsToExpectedPeer: device.playerId === expectedPlayerId,
          status: device.status, recoveryRequired: device.recoveryRequired, recoveryActionAvailable: device.recoveryActionAvailable })),
        candidateCount: candidates.length,
        candidates: candidateSummaries,
        expectedCandidates: candidates.slice(0, 4).map(item => ({ candidateIdPresent: Boolean(item.candidateId),
          claimedPeerMatches: item.claimedDeviceId === expectedPlayerId, port: item.port,
          addressCount: item.addresses.length })),
        probeEndpoints: candidates.slice(0, 4).flatMap(item => item.addresses.slice(0, 4)
          .map(address => ({ address, port: item.port, claimedPeerMatches: item.claimedDeviceId === expectedPlayerId }))),
        savedCard: savedCard ? { count: 1, badgeState: badge?.getAttribute('data-connection-state') ?? null,
          badgeText: badge?.textContent?.trim() ?? null } : { count: 0, badgeState: null, badgeText: null },
        renewalButtons: [...document.querySelectorAll('#remote-devices-root [data-purpose="renewal"]')]
          .map(button => ({ belongsToExpectedPeer: button.getAttribute('data-player-id') === expectedPlayerId,
            candidateIdPresent: Boolean(button.getAttribute('data-candidate-id')),
            candidateClaimsExpectedPeer: candidateById.get(button.getAttribute('data-candidate-id'))?.claimedDeviceId === expectedPlayerId })),
        trace: (window.__kqG5ConnectionTrace ?? []).flatMap(item => (item.connections ?? [])
          .filter(value => value.deviceId === expectedPlayerId)
          .map(value => ({ at: item.at, revision: item.revision, state: value.state,
            reason: value.reason, reconciled: value.reconciled }))).slice(-30)
      }
    }, playerId).catch(() => null)
  ])
  const oldFingerprint = persistence.controllerAuthority?.certificateFingerprintSha256
  const stagedFingerprint = persistence.renewal?.newFingerprint
  const probes = []
  for (const candidate of management?.probeEndpoints ?? []) {
      const { address, port, claimedPeerMatches } = candidate
      if (probes.length >= 8) break
      try {
        const certificate = await probeBootstrapCertificate(address, port, { timeoutMs: 3000 })
        probes.push({ claimedPeerMatches,
          certificatePeerMatches: certificate.deviceIdClaim === playerId,
          certificateMatchesOldPin: certificate.fingerprintSha256 === oldFingerprint,
          certificateMatchesStagedRenewal: certificate.fingerprintSha256 === stagedFingerprint })
      } catch (error) {
        probes.push({ claimedPeerMatches,
          probeError: classifyRenewalConnectionError(error?.code || error?.message) })
      }
    if (probes.length >= 8) break
  }
  const { probeEndpoints: _probeEndpoints, ...managementObservation } = management ?? {}
  return {
    persistence: { renewalPhase: persistence.renewal?.phase ?? null,
      playerIdentityMatchesOldAuthority: persistence.identityFingerprint === persistence.playerAuthority?.certificateFingerprintSha256,
      managementStillPinsOldAuthority: oldFingerprint === persistence.renewal?.oldFingerprint,
      stagedCertificateDiffersFromOld: Boolean(stagedFingerprint && oldFingerprint && stagedFingerprint !== oldFingerprint),
      playerIdMatchesExpected: persistence.playerId === playerId },
    player, management: { ...managementObservation, identityMatchesExpected: playerIdentity.deviceId === playerId },
    certificateProbes: probes,
    mainReconnectLog: readRenewalReconnectLogSummary({ userData: managementUserData }, playerId)
  }
}

async function run() {
  markStage('profile-setup')
  const player = profileEnvironment('player')
  const management = profileEnvironment('management')
  fs.writeFileSync(path.join(player.userData, 'operating-mode.json'), '{"version":1,"mode":"player"}\n')
  fs.writeFileSync(path.join(player.userData, 'video-library.json'), '{"version":1,"roots":[]}\n')
  prepareControllerModeProfile(management.userData)
  const controllerId = randomUUID()
  fs.writeFileSync(path.join(management.userData, 'remote-controller-identity.json'), JSON.stringify({
    schemaVersion: 1, role: 'controller', deviceId: controllerId, createdAt: new Date().toISOString()
  }) + '\n')

  let playerApp
  let managementApp
  let playerPage
  let managementPage
  let operationId
  let reconnectBaseline
  let reconnectWaitEvidence
  let activeLockoutRequestId
  let faultProxyStarted = false
  let faultProxyPort
  let faultProxyOwner
  await runWithElectronTestCleanup(async () => {
    try {
    markStage('player-startup')
    playerApp = await launch(player)
    playerPage = await playerApp.firstWindow()
    await playerPage.waitForLoadState('domcontentloaded', { timeout: 20000 })
    await playerPage.waitForFunction(() => Boolean(window.karaokeRemotePlayer), undefined, { timeout: 20000 })
    try {
      await playerPage.waitForFunction(() => {
        const description = document.querySelector('#remote-player-connection-description')?.textContent?.trim()
        return Boolean(description && description !== 'Sem controlador remoto')
      }, undefined, { timeout: 20000 })
    } catch (error) {
      const state = await playerPage.evaluate(async () => {
        const safe = value => value instanceof Error
          ? value.name + ': ' + value.message.slice(0, 180)
            .replace(/[A-Za-z]:[\\/][^\s]*/g, '[path]')
            .replace(/\/(?:[^\s/]+\/)*[^\s]*/g, '[path]')
          : null
        const available = await window.karaokeRemotePlayer.isAvailable().then(value => ({ value })).catch(error => ({ error: safe(error) }))
        const snapshot = await window.karaokeRemotePlayer.getSnapshot().then(value => ({
          role: value.role, revision: value.revision, intent: value.intent, listener: value.listener,
          playerPairing: value.playerPairing, errorCode: value.errorCode
        })).catch(error => ({ error: safe(error) }))
        return {
          available, snapshot,
          description: document.querySelector('#remote-player-connection-description')?.textContent?.trim() ?? null,
          viewMounted: Boolean(document.querySelector('#remote-player-pairing-root'))
        }
      })
      console.error('Sanitized Player startup diagnostics:', JSON.stringify(state))
      throw error
    }

    markStage('management-startup')
    managementApp = await launch(management)
    managementPage = await managementApp.firstWindow()
    await managementPage.waitForLoadState('domcontentloaded', { timeout: 20000 })
    await managementPage.waitForFunction(() => Boolean(window.karaokeRemoteManagement), undefined, { timeout: 20000 })
    await managementPage.evaluate(() => {
      window.__kqG5ConnectionTrace = []
      window.__kqG5ConnectionTraceUnsubscribe = window.karaokeRemoteManagement.onSnapshot(snapshot => {
        const trace = window.__kqG5ConnectionTrace
        const expectedOperation = window.__kqG5ExpectedOperation
        const operation = expectedOperation && snapshot.operations.find(item =>
          item.operationId === expectedOperation.operationId && item.playerId === expectedOperation.playerId)
        trace.push({ at: Math.round(performance.now()), revision: snapshot.revision,
          connections: snapshot.connections.filter(item => item.deviceRole === 'player')
            .map(item => ({ deviceId: item.deviceId, state: item.state, reconciled: item.reconciled, reason: item.reason })),
          ...(expectedOperation ? { expectedOperation: operation ? { present: true, status: operation.status,
            playerMatches: operation.playerId === expectedOperation.playerId } : { present: false } } : {}) })
        if (trace.length > 80) trace.shift()
      })
    })
    await playerPage.evaluate(() => {
      window.__kqG5ConnectionTrace = []
      window.__kqG5ConnectionTraceUnsubscribe = window.karaokeRemotePlayer.onSnapshot(snapshot => {
        const trace = window.__kqG5ConnectionTrace
        trace.push({ at: Math.round(performance.now()), revision: snapshot.revision,
          connections: snapshot.connections.filter(item => item.deviceRole === 'controller')
            .map(item => ({ deviceId: item.deviceId, state: item.state, reconciled: item.reconciled, reason: item.reason })) })
        if (trace.length > 80) trace.shift()
      })
    })
    const continueButton = managementPage.locator('#btn-startup-primary')
    if (await continueButton.isVisible().catch(() => false)) await continueButton.click()
    await managementPage.locator('#form-entry').waitFor({ state: 'visible', timeout: 20000 })

    markStage('player-discovery-consent')
    await playerPage.locator('#remote-player-enable').click()
    const networkDialog = playerPage.getByRole('dialog', { name: 'Permitir descoberta nesta rede?' })
    await networkDialog.waitFor({ state: 'visible', timeout: 10000 })
    const interfaces = await playerPage.evaluate(() => window.karaokeRemotePlayer.getNetworkInterfaces())
    assert.ok(interfaces.length > 0, 'Player consent flow requires a real available local interface')
    await networkDialog.getByRole('button', { name: 'Permitir descoberta' }).click()

    try {
      await playerPage.waitForFunction(() =>
        document.querySelector('#remote-player-connection-description')?.textContent?.includes('Endereço local:') === true,
      undefined, { timeout: 30000 })
    } catch (error) {
      const state = await playerPage.evaluate(async () => {
        const snapshot = await window.karaokeRemotePlayer.getSnapshot().catch(() => null)
        return {
          status: document.querySelector('#remote-player-connection-status')?.textContent?.trim() ?? null,
          description: document.querySelector('#remote-player-connection-description')?.textContent?.trim() ?? null,
          actionStatus: document.querySelector('#remote-player-action-status')?.textContent?.trim() ?? null,
          actionCode: document.querySelector('#remote-player-action-status')?.getAttribute('data-error-code') ?? null,
          snapshot: snapshot ? {
            intent: snapshot.intent, listener: snapshot.listener,
            playerPairing: snapshot.playerPairing, errorCode: snapshot.errorCode
          } : null
        }
      })
      console.error('Sanitized Player discovery diagnostics:', JSON.stringify(state))
      throw error
    }
    const endpoint = await playerPage.evaluate(() => {
      const text = document.querySelector('#remote-player-connection-description')?.textContent ?? ''
      const match = text.match(/Endereço local:\s*((?:\d{1,3}\.){3}\d{1,3}):(\d+)/)
      return match ? { address: match[1], port: Number(match[2]) } : null
    })
    assert.ok(endpoint?.address && endpoint.port > 0, 'Player displays the actual listener endpoint without persisting it in UI state')

    await managementPage.locator('#btn-devices').click()
    let devicesPanel = managementPage.getByRole('dialog', { name: 'Dispositivos' })
    await devicesPanel.waitFor({ state: 'visible', timeout: 10000 })
    const discoveredCandidate = managementPage.locator('#remote-devices-root [data-candidate-index]').first()
    await discoveredCandidate.waitFor({ state: 'visible', timeout: 30000 })
    const candidateId = await discoveredCandidate.getAttribute('data-candidate-id')
    const claimedPlayerId = await managementPage.evaluate(async id => {
      const snapshot = await window.karaokeRemoteManagement.getSnapshot()
      return snapshot.candidates.find(candidate => candidate.candidateId === id)?.claimedDeviceId ?? null
    }, candidateId)
    assert.match(claimedPlayerId ?? '', /^[0-9a-f-]{36}$/i,
      'the observed mDNS claim is only a candidate hint before OPAQUE authentication')
    const candidateCardText = await withElectronTestDeadline(
      discoveredCandidate.evaluate(element => element.closest('article')?.innerText ?? ''),
      'management:candidate-card-evaluate'
    )
    assert.match(candidateCardText, /AINDA NÃO VERIFICADO/i,
      'the real mDNS candidate stays unverified until G2 completes')
    markStage('secure-vault-unavailable-ui')
    await managementApp.evaluate(async ({ app }) => {
      const moduleApi = process.getBuiltinModule('node:module')
      const pathApi = process.getBuiltinModule('node:path')
      const req = moduleApi.createRequire(pathApi.join(app.getAppPath(), 'package.json'))
      const proto = req('./build/src/remote-secret-protector.js').ElectronSafeStorageSecretProtector.prototype
      const original = proto.assertAvailable
      proto.assertAvailable = async function () { throw new Error('SECRET_STORAGE_UNAVAILABLE') }
      globalThis.__kqRestoreVault = () => { proto.assertAvailable = original }
    })
    await discoveredCandidate.click()
    await managementPage.getByText(/O cofre seguro não está disponível/).waitFor({ state: 'visible', timeout: 10000 })
    assert.equal(await playerPage.getByRole('dialog', { name: 'Permitir esta Gestão?' }).count(), 0,
      'vault failure before G2 admission never opens a remote consent session')
    assert.equal((await managementPage.evaluate(() => window.karaokeRemoteManagement.getSnapshot())).savedDevices.length,
      0, 'vault failure never publishes a confirmed binding')
    await managementApp.evaluate(() => globalThis.__kqRestoreVault())
    markStage('pairing-consent-rejection')
    await discoveredCandidate.click()
    await managementPage.getByRole('dialog', { name: 'Confirme no Player' }).waitFor({ state: 'visible', timeout: 10000 })
    await playerPage.getByRole('dialog', { name: 'Permitir esta Gestão?' }).waitFor({ state: 'visible', timeout: 30000 })
    const rejectConsent = playerPage.getByRole('button', { name: /Rejeitar/ })
    const acceptConsent = playerPage.getByRole('button', { name: 'Permitir neste Player' })
    assert.equal(await rejectConsent.evaluate(element => element === document.activeElement), true,
      'Player consent dialog places initial focus on the safe rejection action')
    await playerPage.keyboard.press('Control+r')
    assert.equal(await playerPage.evaluate(() => Boolean(window.karaokeRemotePlayer)), true,
      'Ctrl+R cannot reload the Player while the G5 consent dialog owns focus')
    await playerPage.getByRole('dialog', { name: 'Permitir esta Gestão?' }).waitFor({ state: 'visible' })
    await playerPage.keyboard.press('Shift+Tab')
    assert.equal(await acceptConsent.evaluate(element => element === document.activeElement), true,
      'Shift+Tab wraps focus to the last consent action')
    await playerPage.keyboard.press('Tab')
    assert.equal(await rejectConsent.evaluate(element => element === document.activeElement), true,
      'Tab wraps focus to the first consent action without escaping the modal')
    await playerPage.keyboard.press('Escape')
    await playerPage.getByRole('alertdialog', { name: 'Pedido recusado' }).waitFor({ state: 'visible', timeout: 10000 })
    await managementPage.locator('#remote-pairing-heading').waitFor({ state: 'hidden', timeout: 20000 })

    markStage('pairing-three-attempt-lockout-ui')
    await devicesPanel.getByRole('button', { name: 'Atualizar busca' }).click()
    const lockoutCandidateId = await waitForPageCondition(managementPage, async playerId => {
      const snapshot = await window.karaokeRemoteManagement.getSnapshot()
      const candidate = snapshot.candidates.find(item => item.claimedDeviceId === playerId)
      const initialAction = candidate && [...document.querySelectorAll('#remote-devices-root [data-purpose="initial"]')]
        .some(button => button.getAttribute('data-candidate-id') === candidate.candidateId)
      return candidate && initialAction ? candidate.candidateId : false
    }, claimedPlayerId, { timeout: 15000, label: 'unpaired-player-is-discoverable-for-lockout-regression' })
    const lockoutCandidate = managementPage.locator('#remote-devices-root [data-purpose="initial"]' +
      `[data-candidate-id="${lockoutCandidateId}"]`)
    assert.equal(await lockoutCandidate.count(), 1,
      'lockout regression selects the same real mDNS Player claim from the unpaired state')
    assert.equal(await managementPage.evaluate(async ({ candidateId, playerId }) => {
      const snapshot = await window.karaokeRemoteManagement.getSnapshot()
      return snapshot.candidates.find(candidate => candidate.candidateId === candidateId)?.claimedDeviceId === playerId
    }, { candidateId: lockoutCandidateId, playerId: claimedPlayerId }), true,
    'the lockout request is tied to the expected Player claim before authenticated pairing')

    // Exercise cancellation from the real Management dialog after the Player
    // has emitted its ephemeral code but before any OPAQUE proof or durable
    // attempt reservation is submitted. The Player result dialog is explicitly
    // dismissed here so a failed test cannot leave a test-owned modal behind.
    markStage('pairing-ui-cancel-before-first-durable-admission')
    await lockoutCandidate.click()
    await managementPage.getByRole('dialog', { name: 'Confirme no Player' }).waitFor({ state: 'visible', timeout: 10000 })
    await playerPage.getByRole('dialog', { name: 'Permitir esta Gestão?' }).waitFor({ state: 'visible', timeout: 30000 })
    await playerPage.getByRole('button', { name: 'Permitir neste Player' }).click()
    await playerPage.getByRole('dialog', { name: 'Confirme o pareamento' }).waitFor({ state: 'visible', timeout: 30000 })
    const cancellationCodeInput = managementPage.locator('#remote-pairing-code')
    await cancellationCodeInput.waitFor({ state: 'visible', timeout: 30000 })
    const cancellationRequestId = await cancellationCodeInput.getAttribute('data-request-id')
    assert.ok(cancellationRequestId, 'the Management code dialog is bound to the current opaque request')
    await managementPage.getByRole('button', { name: 'Cancelar · Esc' }).click()
    await managementPage.locator('#remote-pairing-heading').waitFor({ state: 'hidden', timeout: 15000 })
    await playerPage.getByRole('alertdialog', { name: 'Pareamento cancelado' }).waitFor({ state: 'visible', timeout: 15000 })
    assert.equal(await playerPage.locator('.remote-player-temporary-code').count(), 0,
      'confirmed pre-admission cancellation removes the ephemeral Player code')
    const playerAfterUiCancellation = await playerPage.evaluate(() => window.karaokeRemotePlayer.getSnapshot())
    assert.equal(playerAfterUiCancellation.playerPairing, 'unpaired',
      'cancelling before an OPAQUE proof creates no Player authority')
    assert.equal(playerAfterUiCancellation.listener, 'advertising',
      'cancelling before durable admission leaves Player discovery available')
    const managementAfterUiCancellation = await managementPage.evaluate(() => window.karaokeRemoteManagement.getSnapshot())
    assert.equal(managementAfterUiCancellation.savedDevices.some(device =>
      device.playerId === claimedPlayerId && device.status === 'active'), false,
    'confirmed UI cancellation creates no saved Management binding')
    await playerPage.getByRole('button', { name: 'Fechar · Enter' }).click()
    await playerPage.getByRole('alertdialog', { name: 'Pareamento cancelado' }).waitFor({ state: 'detached', timeout: 10000 })

    // A discovery observation is a short-lived mDNS candidate, not persisted
    // identity. Refresh through the real UI before asking for a new request.
    await devicesPanel.getByRole('button', { name: 'Atualizar busca' }).click()
    let refreshedLockoutCandidateId
    try {
      refreshedLockoutCandidateId = await waitForPageCondition(managementPage, async playerId => {
        const snapshot = await window.karaokeRemoteManagement.getSnapshot()
        const candidate = snapshot.candidates.find(item => item.claimedDeviceId === playerId)
        return candidate && [...document.querySelectorAll('#remote-devices-root [data-purpose="initial"]')]
          .some(button => button.getAttribute('data-candidate-id') === candidate.candidateId)
          ? candidate.candidateId : false
      }, claimedPlayerId, { timeout: 15000, label: 'same-player-discovery-after-ui-cancellation' })
    } catch (error) {
      const observation = await managementPage.evaluate(async expectedPlayerId => {
        const snapshot = await window.karaokeRemoteManagement.getSnapshot()
        const candidates = snapshot.candidates.filter(candidate => candidate.claimedDeviceId === expectedPlayerId)
        return {
          revision: snapshot.revision,
          discovery: snapshot.discovery,
          candidateCount: snapshot.candidates.length,
          matchingClaimCount: candidates.length,
          matchingCandidateIds: candidates.map(candidate => candidate.candidateId),
          initialActionCount: [...document.querySelectorAll('#remote-devices-root [data-purpose="initial"]')]
            .filter(button => candidates.some(candidate => candidate.candidateId === button.getAttribute('data-candidate-id'))).length
        }
      }, claimedPlayerId)
      console.error('Sanitized post-cancellation discovery observation:', JSON.stringify(observation))
      throw error
    }
    const retryLockoutCandidate = managementPage.locator('#remote-devices-root [data-purpose="initial"]' +
      `[data-candidate-id="${refreshedLockoutCandidateId}"]`)
    assert.equal(await retryLockoutCandidate.count(), 1,
      'the same real Player remains selectable after a pre-admission UI cancellation')

    markStage('pairing-three-attempt-lockout-ui')
    await retryLockoutCandidate.click()
    await managementPage.getByRole('dialog', { name: 'Confirme no Player' }).waitFor({ state: 'visible', timeout: 10000 })
    await playerPage.getByRole('dialog', { name: 'Permitir esta Gestão?' }).waitFor({ state: 'visible', timeout: 30000 })
    await playerPage.getByRole('button', { name: 'Permitir neste Player' }).click()
    await playerPage.getByRole('dialog', { name: 'Confirme o pareamento' }).waitFor({ state: 'visible', timeout: 30000 })
    const lockoutCode = (await playerPage.locator('.remote-player-temporary-code').textContent()).trim()
    temporaryCodeForLogRedaction = lockoutCode
    assert.match(lockoutCode, /^\d{4} \d{4}$/, 'the lockout scenario uses only the real ephemeral Player code')
    const lockoutInput = managementPage.locator('#remote-pairing-code')
    await lockoutInput.waitFor({ state: 'visible', timeout: 30000 })
    const lockoutRequestId = await lockoutInput.getAttribute('data-request-id')
    activeLockoutRequestId = lockoutRequestId
    const lockoutValidCode = lockoutCode.replace(' ', '')
    const lockoutWrongCode = lockoutValidCode === '99999999' ? '99999998' : '99999999'
    lockoutAttemptTrace = []
    for (let attempt = 1; attempt <= 3; attempt++) {
      markStage(`pairing-three-attempt-lockout-ui-attempt-${attempt}`)
      const attemptStartedAt = Date.now()
      await managementPage.locator('#remote-pairing-code').fill(lockoutWrongCode)
      await managementPage.getByRole('button', { name: 'Verificar código' }).click()
      lockoutAttemptTrace.push({ attempt, submittedAt: new Date().toISOString(),
        afterSubmit: await readLockoutUiObservation(playerPage, managementPage, lockoutRequestId,
          player.userData, management.userData) })
      if (attempt < 3) {
        await waitForPageCondition(managementPage, requestId => {
          const input = document.querySelector('#remote-pairing-code')
          const waiting = document.querySelector('.remote-pairing-dialog .remote-waiting')
          return Promise.resolve(input instanceof HTMLInputElement && input.dataset.requestId === requestId && !waiting)
        }, lockoutRequestId, { timeout: 15000, label: `wrong-pairing-code-retry-${attempt}` })
        lockoutAttemptTrace.at(-1).retryReadyAt = new Date().toISOString()
        lockoutAttemptTrace.at(-1).elapsedMs = Date.now() - attemptStartedAt
        lockoutAttemptTrace.at(-1).retryReady = await readLockoutUiObservation(
          playerPage, managementPage, lockoutRequestId, player.userData, management.userData)
        assert.equal(await playerPage.locator('.remote-player-temporary-code').count(), 1,
          `the Player retains the temporary code while ${3 - attempt} authenticated attempts remain`)
      }
    }
    const exhaustedMessage = managementPage.locator(
      '#remote-devices-root [role="status"][data-error-code="PAIRING_ATTEMPTS_EXHAUSTED"]')
    try {
      // The real OPAQUE proof can outlast the UI's 20-second pending-result warning on Windows.
      // Keep the exact lockout assertion, while allowing the bounded protocol/UI completion window.
      await exhaustedMessage.waitFor({ state: 'visible', timeout: 35000 })
      lockoutAttemptTrace.at(-1).terminalAt = new Date().toISOString()
      lockoutAttemptTrace.at(-1).terminal = await readLockoutUiObservation(
        playerPage, managementPage, lockoutRequestId, player.userData, management.userData)
    } catch (error) {
      lockoutAttemptTrace.at(-1).terminalTimeoutAt = new Date().toISOString()
      lockoutAttemptTrace.at(-1).elapsedMs = Date.now() - Date.parse(lockoutAttemptTrace.at(-1).submittedAt)
      lockoutAttemptTrace.at(-1).terminalTimeout = await readLockoutUiObservation(
        playerPage, managementPage, lockoutRequestId, player.userData, management.userData)
      throw error
    }
    assert.equal((await exhaustedMessage.innerText()).trim(),
      'As tentativas desta solicitação foram esgotadas. Aguarde o bloqueio e inicie um novo pedido depois.',
      'Management reports exhausted attempts instead of describing the final proof as an ordinary wrong code')
    await playerPage.locator('.remote-player-temporary-code').waitFor({ state: 'detached', timeout: 10000 })
    await playerPage.getByRole('dialog', { name: 'Confirme o pareamento' }).waitFor({ state: 'detached', timeout: 10000 })
    const playerAfterLockout = await playerPage.evaluate(() => window.karaokeRemotePlayer.getSnapshot())
    assert.equal(playerAfterLockout.playerPairing, 'unpaired',
      'exhausting an uncommitted pairing session does not create Player authority')
    assert.equal(playerAfterLockout.listener, 'advertising',
      'cancelling the exhausted pairing session leaves Player discovery available')
    assert.equal(playerAfterLockout.connections.some(item => item.deviceRole === 'controller' && item.state === 'authorized'), false,
      'the failed lockout flow does not authorize a controller')
    const managementAfterLockout = await managementPage.evaluate(() => window.karaokeRemoteManagement.getSnapshot())
    assert.equal(managementAfterLockout.savedDevices.some(device =>
      device.playerId === claimedPlayerId && device.status === 'active'), false,
    'exhausted proof attempts do not create a saved Management binding')

    await devicesPanel.getByRole('button', { name: /Configuração avançada/ }).click()
    const manualDialog = managementPage.getByRole('dialog', { name: 'Adicionar endereço manual' })
    await manualDialog.waitFor({ state: 'visible', timeout: 10000 })
    faultProxyPort = await startTransportFaultProxy(managementApp, endpoint)
    faultProxyOwner = managementApp
    faultProxyStarted = true
    markStage('pairing-opaque-confirmation')
    await managementPage.locator('#remote-manual-address').fill(endpoint.address)
    await managementPage.locator('#remote-manual-port').fill(String(faultProxyPort))
    await managementPage.evaluate(() => window.karaokeRemoteManagement.refreshDiscovery())
    assert.equal(await managementPage.locator('#remote-manual-address').inputValue(), endpoint.address,
      'Main snapshot updates preserve the unfocused manual address')
    assert.equal(await managementPage.locator('#remote-manual-port').inputValue(), String(faultProxyPort),
      'Main snapshot updates preserve the focused manual port')
    await manualDialog.getByRole('button', { name: 'Verificar endereço' }).click()

    try {
      await playerPage.getByRole('dialog', { name: 'Permitir esta Gestão?' }).waitFor({ state: 'visible', timeout: 30000 })
    } catch (error) {
      const state = await Promise.all([
        playerPage.evaluate(async () => {
          const snapshot = await window.karaokeRemotePlayer.getSnapshot().catch(() => null)
          return {
            status: document.querySelector('#remote-player-connection-status')?.textContent?.trim() ?? null,
            actionStatus: document.querySelector('#remote-player-action-status')?.textContent?.trim() ?? null,
            actionCode: document.querySelector('#remote-player-action-status')?.getAttribute('data-error-code') ?? null,
            pairing: snapshot?.playerPairing ?? null, listener: snapshot?.listener ?? null,
            errorCode: snapshot?.errorCode ?? null
          }
        }),
        managementPage.evaluate(async () => {
          const snapshot = await window.karaokeRemoteManagement.getSnapshot().catch(() => null)
          const text = document.querySelector('#remote-devices-root')?.innerText?.slice(0, 1200) ?? null
          return {
            text: text?.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[address]') ?? null,
            actionCode: document.querySelector('#remote-devices-root [data-error-code]')?.getAttribute('data-error-code') ?? null,
            discovery: snapshot?.discovery ?? null, candidateCount: snapshot?.candidates?.length ?? null,
            connectionStates: snapshot?.connections?.map(item => item.state) ?? null,
            errorCode: snapshot?.errorCode ?? null
          }
        })
      ])
      console.error('Sanitized pairing request diagnostics:', JSON.stringify({ player: state[0], management: state[1] }))
      throw error
    }
    assert.match(await playerPage.locator('.remote-player-requester').innerText(), /ainda não verificado/i,
      'the display name is not treated as a verified identity')
    await playerPage.getByRole('button', { name: 'Permitir neste Player' }).click()

    try {
      await playerPage.getByRole('dialog', { name: 'Confirme o pareamento' }).waitFor({ state: 'visible', timeout: 30000 })
    } catch (error) {
      const state = await Promise.all([
        playerPage.evaluate(async () => {
          const snapshot = await window.karaokeRemotePlayer.getSnapshot().catch(() => null)
          return {
            status: document.querySelector('#remote-player-connection-status')?.textContent?.trim() ?? null,
            actionStatus: document.querySelector('#remote-player-action-status')?.textContent?.trim() ?? null,
            actionCode: document.querySelector('#remote-player-action-status')?.getAttribute('data-error-code') ?? null,
            pairing: snapshot?.playerPairing ?? null, errorCode: snapshot?.errorCode ?? null,
            consentVisible: Boolean(document.querySelector('[role="dialog"] h1')?.textContent?.includes('Permitir')),
            temporaryCodeVisible: Boolean(document.querySelector('.remote-player-temporary-code'))
          }
        }),
        managementPage.evaluate(() => ({
          text: document.querySelector('#remote-devices-root')?.innerText?.slice(0, 1000) ?? null,
          actionCode: document.querySelector('#remote-devices-root [data-error-code]')?.getAttribute('data-error-code') ?? null
        }))
      ])
      console.error('Sanitized post-consent diagnostics:', JSON.stringify({ player: state[0], management: state[1] }))
      throw error
    }
    markStage('pairing-code-entry')
    await playerPage.keyboard.press('7')
    assert.equal(await playerPage.locator('#idle-code-digits').getAttribute('aria-label'), 'Nenhum código digitado',
      'a digit pressed while the Player pairing overlay is active never reaches the standalone music-entry shortcut')
    const groupedCode = (await playerPage.locator('.remote-player-temporary-code').textContent()).trim()
    temporaryCodeForLogRedaction = groupedCode
    assert.match(groupedCode, /^\d{4} \d{4}$/, 'the Player presents the temporary eight-digit code as 4–4')

    const codeInput = managementPage.locator('#remote-pairing-code')
    await codeInput.waitFor({ state: 'visible', timeout: 30000 })
    markStage('pairing-wrong-code-retry')
    const validCode = groupedCode.replace(' ', '')
    const wrongCode = validCode === '00000000' ? '00000001' : '00000000'
    const originalPairingRequestId = await codeInput.getAttribute('data-request-id')
    await codeInput.fill(wrongCode)
    await managementPage.getByRole('button', { name: 'Verificar código' }).click()

    // A wrong OPAQUE proof must consume an attempt but leave the same consented
    // pairing request available for a fresh proof. Wait for the UI's actual
    // code-entry state to return; do not infer retry readiness from a delay.
    await managementPage.waitForFunction(requestId => {
      const input = document.querySelector('#remote-pairing-code')
      const waiting = document.querySelector('.remote-pairing-dialog .remote-waiting')
      return input instanceof HTMLInputElement && input.dataset.requestId === requestId && !waiting
    }, originalPairingRequestId, { timeout: 15000 })
    assert.equal(await playerPage.getByRole('alertdialog', { name: 'Vínculo confirmado' }).count(), 0,
      'an incorrect temporary code does not confirm a pairing')
    assert.equal((await playerPage.evaluate(() => window.karaokeRemotePlayer.getSnapshot())).playerPairing,
      'unpaired', 'the Player has not persisted authority after a wrong OPAQUE proof')
    const retryInput = managementPage.locator('#remote-pairing-code')
    if (process.env.KQ_G5_JOURNAL_ONLY === '1') await installPlayerPreparedPairingResponseHold(playerApp)
    await retryInput.fill(validCode)
    await retryInput.press('Enter')

    if (process.env.KQ_G5_JOURNAL_ONLY === '1') {
    markStage('initial-journal-only-restart')
    await waitForPageCondition(managementPage, async playerId => {
      const snapshot = await window.karaokeRemoteManagement.getSnapshot()
      return snapshot.pairingRecoveries.some(item => item.playerId === playerId)
    }, claimedPlayerId, { timeout: 60000, label: 'initial-g2-journal-durably-admitted' })
    assert.equal(await playerApp.evaluate(() => globalThis.__kqG5PreparedPairingResponseHold.waitForPrepared(60000)), 1)
    const admittedInitial = JSON.parse(fs.readFileSync(path.join(management.userData, 'remote-authorization.json'), 'utf8'))
    const initialJournal = admittedInitial.journals.find(item => item.role === 'controller' && item.phase === 'bound')
    assert.ok(initialJournal, 'first pairing is durably admitted before restart')
    assert.equal(Object.keys(admittedInitial.controllerAuthorities).length, 0,
      'journal-only recovery starts without any saved Management authority')
    await managementPage.getByRole('button', { name: 'Cancelar · Esc' }).click()
    await managementPage.locator('#remote-pairing-heading').waitFor({ state: 'hidden', timeout: 15000 })
    await playerApp.evaluate(() => globalThis.__kqG5PreparedPairingResponseHold.release())
    await closeElectronTestAppNormally(managementApp, 'management')
    managementApp = await launch(management)
    managementPage = await managementApp.firstWindow()
    await managementPage.waitForLoadState('domcontentloaded')
    await managementPage.waitForFunction(() => Boolean(window.karaokeRemoteManagement))
    const continueInitialRecovery = managementPage.locator('#btn-startup-primary')
    if (await continueInitialRecovery.isVisible().catch(() => false)) await continueInitialRecovery.click()
    await managementPage.locator('#form-entry').waitFor({ state: 'visible' })
    faultProxyPort = await startTransportFaultProxy(managementApp, endpoint, faultProxyPort)
    faultProxyOwner = managementApp
    await managementPage.evaluate(() => {
      window.__kqG5ConnectionTrace = []
      window.karaokeRemoteManagement.onSnapshot(snapshot => {
        const expected = window.__kqG5ExpectedOperation
        const operation = expected && snapshot.operations.find(item => item.operationId === expected.operationId)
        window.__kqG5ConnectionTrace.push({ revision: snapshot.revision,
          connections: snapshot.connections.map(item => ({ ...item })),
          expectedOperation: operation ? { present: true, status: operation.status,
            playerMatches: operation.playerId === expected.playerId } : { present: false } })
      })
    })
    await managementPage.locator('#btn-devices').click()
    devicesPanel = managementPage.getByRole('dialog', { name: 'Dispositivos' })
    await devicesPanel.getByRole('button', { name: 'Atualizar busca' }).click()
    const initialRecovery = managementPage.locator(`[data-purpose="recovery"][data-player-id="${claimedPlayerId}"]`)
    await initialRecovery.waitFor({ state: 'visible', timeout: 30000 })
    const journalOnlySnapshot = await managementPage.evaluate(() => window.karaokeRemoteManagement.getSnapshot())
    assert.equal(journalOnlySnapshot.savedDevices.length, 0)
    assert.ok(journalOnlySnapshot.pairingRecoveries.some(item => item.playerId === claimedPlayerId))
    await initialRecovery.click()
    assert.equal(await managementPage.locator('#remote-pairing-code').count(), 0,
      'restart recovers original G2 journal without another OPAQUE code')
    }

    await playerPage.getByRole('alertdialog', { name: 'Vínculo confirmado' }).waitFor({ state: 'visible', timeout: 60000 })
    await managementPage.getByText(/Vínculo salvo\./).waitFor({ state: 'visible', timeout: 60000 })
    await waitForPageCondition(playerPage, async () => {
      const snapshot = await window.karaokeRemotePlayer.getSnapshot()
      return snapshot.playerPairing === 'active'
    }, undefined, { timeout: 30000 })
    markStage('pairing-durable-read-management-snapshot')
    const managementSnapshot = await managementPage.evaluate(() => window.karaokeRemoteManagement.getSnapshot())
    const pairedPlayer = managementSnapshot.savedDevices.find(device => device.status === 'active')
    assert.ok(pairedPlayer,
      'Management persists the newly established pairing')
    assert.equal(pairedPlayer.playerId, claimedPlayerId,
      'the candidate claim matches the Player identity only after successful OPAQUE binding')
    if (process.env.KQ_G5_G4_RECOVERY_ONLY === '1') {
      markStage('g4-durable-inbox-marker-restart')
      await waitForPageCondition(managementPage, async playerId => {
        const snapshot = await window.karaokeRemoteManagement.getSnapshot()
        return snapshot.connections.some(item => item.deviceId === playerId && item.reconciled)
      }, pairedPlayer.playerId, { timeout: 60000, label: 'valid-g4-baseline-before-compaction-gap' })
      const { ManagementRemoteJournalInbox } = require('../src/management-remote-journal')
      // Fixture models a legitimate missed replay window. Use the real validated store path,
      // never SQL UPDATE or a synthetic UI state, to create the durable marker.
      const db = createKaraokeDatabase(management.userData)
      let marker
      let gapSnapshot
      try {
        const inbox = new ManagementRemoteJournalInbox(db, { controllerId })
        const before = inbox.cursor(pairedPlayer.playerId)
        assert.ok(before && !before.recoveryRequired)
        gapSnapshot = structuredClone(inbox.latestSnapshot(pairedPlayer.playerId))
        assert.ok(gapSnapshot)
        gapSnapshot.body.payload.highWatermark = Math.max(before.highWatermark, before.throughSequence) + 1
        gapSnapshot.body.payload.compactedThrough = gapSnapshot.body.payload.highWatermark
        marker = inbox.persistSnapshot(pairedPlayer.playerId, gapSnapshot)
        assert.equal(marker.recoveryRequired, true)
        assert.equal(marker.throughSequence, before.throughSequence,
          'a compacted snapshot cannot pretend missing events were received')
        assert.throws(() => inbox.readEvents(pairedPlayer.playerId, 0, 1), /RECOVERY_REQUIRED/)
      } finally { db.close() }
      await closeElectronTestAppNormally(managementApp, 'management')
      // The test proxy belongs to the old Main. Rehost its saved port in Player before restart.
      await startTransportFaultProxy(playerApp, endpoint, faultProxyPort)
      faultProxyOwner = playerApp
      managementApp = await launch(management)
      managementPage = await managementApp.firstWindow()
      await managementPage.waitForFunction(() => Boolean(window.karaokeRemoteManagement))
      const startup = managementPage.locator('#btn-startup-primary')
      if (await startup.isVisible().catch(() => false)) await startup.click()
      await managementPage.locator('#form-entry').waitFor({ state: 'visible' })
      await managementPage.locator('#btn-devices').click()
      const assertRecoveryUi = async () => {
        await waitForPageCondition(managementPage, async playerId => {
          const snapshot = await window.karaokeRemoteManagement.getSnapshot()
          const connection = snapshot.connections.find(item => item.deviceId === playerId)
          const card = document.querySelector(`[data-saved-player-id="${playerId}"]`)
          return connection?.state === 'recovery_required' && !connection.reconciled &&
            connection.reason === 'MANAGEMENT_REMOTE_JOURNAL_RECOVERY_REQUIRED' &&
            card?.querySelector('[data-connection-state]')?.getAttribute('data-connection-state') === 'recovery_required' &&
            card.textContent.includes('Recuperação necessária')
        }, pairedPlayer.playerId, { timeout: 60000, label: 'durable-g4-marker-main-ipc-renderer-dom' })
      }
      await assertRecoveryUi()
      const denied = await managementPage.evaluate(({ playerId, operationId }) =>
        window.karaokeRemoteManagement.queryOperation(playerId, operationId),
      { playerId: pairedPlayer.playerId, operationId: randomUUID() })
      assert.deepEqual(denied, { outcome: 'failed', code: 'REMOTE_PLAYER_RECOVERY_REQUIRED' },
        'Main rejects a direct restricted-IPC query before dispatch while durable recovery is pending')
      const logs = fs.readFileSync(path.join(management.userData, 'logs', 'app.log'), 'utf8')
        .split(/\r?\n/).filter(Boolean).map(line => { try { return JSON.parse(line) } catch { return null } })
      assert.ok(logs.some(item => item?.event === 'REMOTE_RECONNECTION_STATE' &&
        item.details?.playerId === pairedPlayer.playerId && item.details?.state === 'recovery_required' &&
        item.details?.reason === 'MANAGEMENT_REMOTE_JOURNAL_RECOVERY_REQUIRED'),
        'Main itself reports the persisted G4 marker for the exact peer')
      for (let refresh = 0; refresh < 2; refresh++) {
        await managementPage.evaluate(() => window.karaokeRemoteManagement.refreshDiscovery())
        await assertRecoveryUi()
      }
      const reopenedDb = createKaraokeDatabase(management.userData)
      try {
        const inbox = new ManagementRemoteJournalInbox(reopenedDb, { controllerId })
        assert.equal(inbox.cursor(pairedPlayer.playerId).recoveryRequired, true)
        assert.equal(inbox.persistSnapshot(pairedPlayer.playerId, gapSnapshot).recoveryRequired, true,
          'even a valid repeated snapshot cannot clear a durable recovery marker')
        assert.equal(inbox.cursor(pairedPlayer.playerId).throughSequence, marker.throughSequence)
      } finally { reopenedDb.close() }
      const snapshot = await managementPage.evaluate(() => window.karaokeRemoteManagement.getSnapshot())
      assert.equal(snapshot.savedDevices.find(item => item.playerId === pairedPlayer.playerId)?.status, 'active',
        'G4 recovery fences synchronization without deleting valid G2 authority')
      assert.equal(snapshot.connections.some(item => item.deviceId === pairedPlayer.playerId && item.reconciled), false)
      assert.equal(await managementPage.locator(`[data-saved-player-id="${pairedPlayer.playerId}"]`).count(), 1)
      console.log('PASS G5.1 real SQLite G4 recovery marker persists across Main restart and refresh; exact peer DOM remains fenced')
      return
    }
    if (process.env.KQ_G5_JOURNAL_ONLY === '1') {
      console.log('PASS G5 initial journal-only recovery after Management restart; no new code or authority before recovery')
      return
    }
    markStage('operation-query-seed-management-outbox')
    operationId = seedUncertainOutbox(management.userData, controllerId, pairedPlayer.playerId)
    const operationQueryIds = { unknown: operationId, rejected: randomUUID(), completed: randomUUID() }
    // The fixture commits through a second SQLite connection, outside the Main outbox owner.
    // Refresh discovery asks the existing Main facade to publish a fresh sanitized snapshot;
    // normal product writes publish directly from their owning Main path.
    markStage('operation-query-refresh-management-snapshot')
    const refreshedAfterOutboxSeed = await managementPage.evaluate(() =>
      window.karaokeRemoteManagement.refreshDiscovery())
    assert.equal(refreshedAfterOutboxSeed.outcome, 'started',
      'a fresh Main-owned snapshot is requested after the isolated fixture commits the outbox record')
    markStage('operation-query-await-outbox-visible')
    await waitForPageCondition(managementPage, async id => {
      const snapshot = await window.karaokeRemoteManagement.getSnapshot()
      return snapshot.operations.some(operation => operation.operationId === id && operation.status === 'unknown')
    }, operationQueryIds.unknown, { timeout: 10000 })
    assert.equal(await playerPage.locator('.remote-player-temporary-code').count(), 0,
      'the temporary code is removed after pairing completes')
    try {
      markStage('pairing-await-player-authorization')
      await waitForPageCondition(playerPage, async () => {
        const snapshot = await window.karaokeRemotePlayer.getSnapshot()
        const connection = snapshot.connections.find(item => item.deviceRole === 'controller' && item.state === 'authorized')
        return Boolean(connection && connection.reconciled === false)
      }, undefined, { timeout: 30000 })
    } catch (error) {
      const state = await Promise.all([
        playerPage.evaluate(async () => {
          const snapshot = await window.karaokeRemotePlayer.getSnapshot().catch(() => null)
          return { connections: snapshot?.connections?.map(item => ({ role: item.deviceRole, state: item.state,
            reason: item.reason })) ?? null, pairing: snapshot?.playerPairing ?? null,
            intent: snapshot?.intent ?? null, errorCode: snapshot?.errorCode ?? null }
        }),
        managementPage.evaluate(async () => {
          const snapshot = await window.karaokeRemoteManagement.getSnapshot().catch(() => null)
          return { connections: snapshot?.connections?.map(item => ({ role: item.deviceRole, state: item.state,
            reason: item.reason, reconciled: item.reconciled })) ?? null, intent: snapshot?.intent ?? null,
            errorCode: snapshot?.errorCode ?? null }
        })
      ])
      console.error('Sanitized post-pair reconnection diagnostics:', JSON.stringify({ player: state[0], management: state[1] }))
      throw error
    }

    markStage('pairing-await-management-reconciliation')
    await waitForPageCondition(managementPage, async () => {
      const snapshot = await window.karaokeRemoteManagement.getSnapshot()
      return snapshot.connections.some(connection => connection.deviceRole === 'player' &&
        connection.state === 'synchronized' && connection.reconciled)
    }, undefined, { timeout: 60000 })
    const uncertainOperation = managementPage.getByRole('region', { name: 'Operações remotas' })
      .locator('.remote-device-card').filter({ hasText: `Operação ${operationId.slice(0, 12)}` })
    markStage('operation-query-await-card-render')
    await uncertainOperation.waitFor({ state: 'visible', timeout: 10000 })
    assert.match(await uncertainOperation.innerText(), /Resultado incerto/,
      'the real Management Main exposes the durable unknown outbox record after G4 reconciliation')
    const queryButton = managementPage.locator('#remote-devices-root [data-action="query-operation"]' +
      '[data-player-id="' + pairedPlayer.playerId + '"][data-operation-id="' + operationId + '"]')
    try {
      markStage('operation-query-await-button-render')
      await queryButton.waitFor({ state: 'visible', timeout: 10000 })
    } catch (error) {
      const diagnostics = await managementPage.evaluate(id => {
        return window.karaokeRemoteManagement.getSnapshot().then(snapshot => {
          const operation = snapshot.operations.find(item => item.operationId === id)
          const matchingConnection = operation && snapshot.connections.find(item =>
            item.deviceRole === 'player' && item.deviceId === operation.playerId)
          const card = [...document.querySelectorAll('.remote-operation-list .remote-device-card')]
            .find(element => [...element.querySelectorAll('[data-operation-id]')]
              .some(button => button.dataset.operationId === id))
          return {
            revision: snapshot.revision,
            operationPresent: Boolean(operation),
            operationStatus: operation?.status ?? null,
            matchingPlayerConnectionCount: matchingConnection ? 1 : 0,
            matchingConnectionState: matchingConnection?.state ?? null,
            matchingConnectionReconciled: matchingConnection?.reconciled ?? null,
            playerConnectionStates: snapshot.connections.filter(item => item.deviceRole === 'player')
              .map(item => ({ state: item.state, reconciled: item.reconciled, reason: item.reason })),
            managementConnectionTrace: window.__kqG5ConnectionTrace.slice(-12),
            queryButtonRendered: Boolean(card?.querySelector('[data-action="query-operation"]'))
          }
        })
      }, operationId)
      const playerDiagnostics = await playerPage.evaluate(async () => {
        const snapshot = await window.karaokeRemotePlayer.getSnapshot()
        return { controllerConnections: snapshot.connections.filter(item => item.deviceRole === 'controller')
          .map(item => ({ state: item.state, reconciled: item.reconciled, reason: item.reason })),
          connectionTrace: window.__kqG5ConnectionTrace.slice(-12) }
      })
      const proxyDiagnostics = await managementApp.evaluate(() =>
        globalThis.__kqG5TransportFaultProxy.getDiagnostics())
      console.error('Sanitized operation-query availability diagnostics:', JSON.stringify({
        management: diagnostics, player: playerDiagnostics, proxy: proxyDiagnostics
      }))
      throw error
    }
    markStage('operation-query-await-original-id-actionable')
    await waitForPageCondition(managementPage, async ({ playerId, id }) => {
      const snapshot = await window.karaokeRemoteManagement.getSnapshot()
      const operation = snapshot.operations.find(item => item.operationId === id && item.playerId === playerId)
      const connection = snapshot.connections.find(item => item.deviceRole === 'player' && item.deviceId === playerId)
      const button = [...document.querySelectorAll('#remote-devices-root [data-action="query-operation"]')]
        .find(element => element.getAttribute('data-operation-id') === id && element.getAttribute('data-player-id') === playerId)
      return operation?.status === 'unknown' && connection?.state === 'synchronized' && connection.reconciled &&
        button instanceof HTMLButtonElement && !button.disabled
    }, { playerId: pairedPlayer.playerId, id: operationId }, { timeout: 10000,
      label: 'original-operation-query-remains-actionable' })
    markStage('operation-query-not-found-ui-response')
    try { await queryButton.click() }
    catch (error) {
      const diagnostics = await managementPage.evaluate(async ({ playerId, id }) => {
        const snapshot = await window.karaokeRemoteManagement.getSnapshot().catch(() => null)
        const operation = snapshot?.operations.find(item => item.operationId === id && item.playerId === playerId)
        const connection = snapshot?.connections.find(item => item.deviceRole === 'player' && item.deviceId === playerId)
        const buttons = [...document.querySelectorAll('#remote-devices-root [data-action="query-operation"]')]
          .map(element => ({ operationId: element.getAttribute('data-operation-id'), playerId: element.getAttribute('data-player-id'),
            disabled: element instanceof HTMLButtonElement ? element.disabled : null }))
        const card = [...document.querySelectorAll('#remote-devices-root .remote-device-card')]
          .find(element => element.querySelector('[data-operation-id="' + id + '"][data-player-id="' + playerId + '"]'))
        return { revision: snapshot?.revision ?? null, operationStatus: operation?.status ?? null,
          operationPlayerId: operation?.playerId ?? null, connection: connection ? { state: connection.state,
            reconciled: connection.reconciled, reason: connection.reason } : null,
          matchingCard: Boolean(card),
          matchingButton: buttons.find(button => button.operationId === id && button.playerId === playerId) ?? null,
          visibleText: document.querySelector('#remote-devices-root')?.innerText?.slice(0, 800) ?? null }
      }, { playerId: pairedPlayer.playerId, id: operationId })
      const proxy = await managementApp.evaluate(() => globalThis.__kqG5TransportFaultProxy.getDiagnostics())
      console.error('Sanitized original operation query click diagnostics:', JSON.stringify({ diagnostics, proxy }))
      throw error
    }
    await managementPage.getByText(
      'O Player ainda não possui prova desta operação. A outbox permanece incerta; consulte novamente mais tarde.',
      { exact: true }).waitFor({ state: 'visible', timeout: 15000 })
    const afterStatusSnapshot = await managementPage.evaluate(id => window.karaokeRemoteManagement.getSnapshot()
      .then(snapshot => ({ status: snapshot.operations.find(operation => operation.operationId === id)?.status,
        state: snapshot.connections.find(connection => connection.deviceRole === 'player')?.state })), operationId)
    assert.equal(afterStatusSnapshot.status, 'unknown',
      'an authenticated not-found status preserves the original uncertain intent')
    assert.equal(afterStatusSnapshot.state,
      'synchronized', 'the result is queried over the authenticated and reconciled Main-owned channel')

    // Hold the authenticated operation response after WebSocket/TLS decoding.
    // A TCP-level downstream pause would also suppress WSS ping frames and
    // legitimately move the connection to backoff before the query deadline.
    // Intercept only this operation-status message so real ping/pong traffic
    // continues and the timeout is exercised on an independently healthy WSS.
    markStage('operation-query-timeout-ui')
    await installOperationStatusResponseHold(managementApp, operationId)
    await managementPage.evaluate(({ playerId, id }) => {
      window.__kqG5ExpectedOperation = { playerId, operationId: id }
      window.__kqG5OperationDomTrace = []
      const root = document.querySelector('#remote-devices-root')
      const inspect = () => {
        const card = root?.querySelector(`.remote-operation-list .remote-device-card[data-player-id="${playerId}"][data-operation-id="${id}"]`)
        const button = card?.querySelector('[data-action="query-operation"]')
        const trace = window.__kqG5OperationDomTrace
        trace.push({ at: Math.round(performance.now()), cardPresent: Boolean(card),
          queryButtonPresent: Boolean(button), queryButtonVisible: Boolean(button?.getClientRects().length),
          queryButtonDisabled: button instanceof HTMLButtonElement ? button.disabled : null,
          queryButtonText: button?.textContent?.trim() ?? null,
          latestSnapshotRevision: window.__kqG5ConnectionTrace.at(-1)?.revision ?? null,
          latestConnection: window.__kqG5ConnectionTrace.at(-1)?.connections?.find(item => item.deviceId === playerId)
            ? (({ state, reconciled, reason }) => ({ state, reconciled, reason }))(
              window.__kqG5ConnectionTrace.at(-1).connections.find(item => item.deviceId === playerId)) : null,
          latestOperation: window.__kqG5ConnectionTrace.at(-1)?.expectedOperation ?? null })
        if (trace.length > 60) trace.shift()
      }
      inspect()
      const observer = new MutationObserver(inspect)
      if (root) observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] })
      window.__kqG5OperationDomTraceStop = () => observer.disconnect()
    }, { playerId: pairedPlayer.playerId, id: operationId })
    await queryButton.click()
    const queryingButton = managementPage.getByRole('button', { name: 'Consultando…' })
    await queryingButton.waitFor({ state: 'visible', timeout: 5000 })
    await managementPage.getByText('Consulta com prazo limitado; nenhum comando será reenviado.', { exact: true })
      .waitFor({ state: 'visible', timeout: 5000 })
    try {
      await managementPage.getByText(
        'A consulta não terminou. A operação original continua preservada e não foi reenviada.',
        { exact: true }).waitFor({ state: 'visible', timeout: 15000 })
    } catch (error) {
      const [managementState, proxyState] = await Promise.all([
        managementPage.evaluate(async id => {
          const snapshot = await window.karaokeRemoteManagement.getSnapshot().catch(() => null)
          const operation = snapshot?.operations.find(item => item.operationId === id)
          const connection = snapshot?.connections.find(item => item.deviceRole === 'player' &&
            item.deviceId === operation?.playerId)
          const root = document.querySelector('#remote-devices-root')
          const card = [...root?.querySelectorAll('.remote-device-card') ?? []]
            .find(element => element.getAttribute('data-operation-id') === id)
          return {
            revision: snapshot?.revision ?? null,
            operationStatus: operation?.status ?? null,
            operationCount: snapshot?.operations.length ?? null,
            connectionState: connection?.state ?? null,
            reconciled: connection?.reconciled ?? null,
            queryButton: card ? {
              visible: Boolean(card.querySelector('[data-action="query-operation"]')?.getClientRects().length),
              disabled: card.querySelector('[data-action="query-operation"]')?.hasAttribute('disabled') ?? null,
              label: card.querySelector('[data-action="query-operation"]')?.textContent?.trim() ?? null
            } : null,
            inlineStatuses: [...root?.querySelectorAll('[role="status"]') ?? []]
              .map(element => element.textContent?.trim() ?? '').slice(-4)
          }
        }, operationId),
        managementApp.evaluate(() => globalThis.__kqG5TransportFaultProxy.getDiagnostics())
      ])
      console.error('Sanitized operation query timeout diagnostics:', JSON.stringify({ managementState, proxyState }))
      throw error
    }
    const timeoutSnapshot = await managementPage.evaluate(async id => {
      const snapshot = await window.karaokeRemoteManagement.getSnapshot()
      const matching = snapshot.operations.filter(operation => operation.operationId === id)
      const connection = snapshot.connections.find(item => item.deviceRole === 'player' &&
        item.deviceId === matching[0]?.playerId)
      return { revision: snapshot.revision, matchingOperationCount: matching.length,
        operationStatus: matching[0]?.status ?? null,
        connectionState: connection?.state ?? null, reconciled: connection?.reconciled ?? null,
        operationCount: snapshot.operations.length }
    }, operationId)
    assert.equal(timeoutSnapshot.matchingOperationCount, 1,
      'a timed-out status query retains exactly the original outbox record')
    assert.equal(timeoutSnapshot.operationStatus, 'unknown',
      'a status-query timeout does not invent rejection or completion')
    assert.equal(timeoutSnapshot.operationCount, 1,
      'a query timeout does not prepare or duplicate an operation')
    assert.equal(timeoutSnapshot.connectionState, 'synchronized',
      'the held response did not turn the independently healthy WSS connection into backoff')
    assert.equal(timeoutSnapshot.reconciled, true)
    const heldResponseDiagnostics = await managementApp.evaluate(() =>
      globalThis.__kqG5OperationResponseHold.getDiagnostics())
    assert.equal(heldResponseDiagnostics.matchingResponsesReceived, 1,
      'the real authenticated Player response reached the Management WebSocket but was held from the query dispatcher')
    assert.equal(heldResponseDiagnostics.pendingResponse, true)
    const timeoutButtonVisible = await queryButton.isVisible()
    if (!timeoutButtonVisible) {
      const uiObservation = await managementPage.evaluate(async ({ playerId, id }) => {
        const snapshot = await window.karaokeRemoteManagement.getSnapshot().catch(() => null)
        const operation = snapshot?.operations.find(item => item.playerId === playerId && item.operationId === id)
        const connection = snapshot?.connections.find(item => item.deviceRole === 'player' && item.deviceId === playerId)
        const card = document.querySelector(`#remote-devices-root .remote-operation-list .remote-device-card[data-player-id="${playerId}"][data-operation-id="${id}"]`)
        const button = card?.querySelector('[data-action="query-operation"]')
        return { main: { revision: snapshot?.revision ?? null, operationPresent: Boolean(operation),
            operationStatus: operation?.status ?? null, operationPlayerMatches: operation?.playerId === playerId,
            connectionState: connection?.state ?? null, connectionReconciled: connection?.reconciled ?? null,
            connectionReason: connection?.reason ?? null },
          dom: { cardPresent: Boolean(card), buttonPresent: Boolean(button),
            buttonVisible: Boolean(button?.getClientRects().length), buttonDisabled: button instanceof HTMLButtonElement ? button.disabled : null,
            operationCards: [...document.querySelectorAll('#remote-devices-root .remote-operation-list .remote-device-card')]
              .map(item => ({ playerMatches: item.getAttribute('data-player-id') === playerId,
                operationMatches: item.getAttribute('data-operation-id') === id,
                hasQueryButton: Boolean(item.querySelector('[data-action="query-operation"]')) })),
            statuses: [...document.querySelectorAll('#remote-devices-root [role="status"]')]
              .map(item => item.textContent?.trim() ?? '').slice(-5) },
          snapshotTrace: (window.__kqG5ConnectionTrace ?? []).slice(-20).map(item => ({ revision: item.revision,
            connection: item.connections.find(value => value.deviceId === playerId)
              ? (({ state, reconciled, reason }) => ({ state, reconciled, reason }))(item.connections.find(value => value.deviceId === playerId)) : null,
            expectedOperation: item.expectedOperation ?? null })),
          domTrace: (window.__kqG5OperationDomTrace ?? []).slice(-30) }
      }, { playerId: pairedPlayer.playerId, id: operationId })
      console.error('Sanitized operation timeout Renderer/Main divergence:', JSON.stringify(uiObservation))
    }
    assert.equal(timeoutButtonVisible, true,
      'after a timed-out query the same operation remains available for explicit follow-up')
    assert.equal(await queryButton.isEnabled(), true,
      'the timed-out query releases the UI busy state instead of leaving an infinite spinner')
    assert.equal((await queryButton.innerText()).trim(), 'Consultar estado')
    await managementPage.evaluate(() => window.__kqG5OperationDomTraceStop?.())
    const releasedHeldResponse = await managementApp.evaluate(() =>
      globalThis.__kqG5OperationResponseHold.release())
    assert.deepEqual(releasedHeldResponse, { released: 1 },
      'the late authenticated response is delivered only after the original query timed out')
    const afterLateStatusResponse = await managementPage.evaluate(async id => {
      const snapshot = await window.karaokeRemoteManagement.getSnapshot()
      return { matchingOperations: snapshot.operations.filter(operation => operation.operationId === id).length,
        status: snapshot.operations.find(operation => operation.operationId === id)?.status ?? null }
    }, operationId)
    assert.deepEqual(afterLateStatusResponse, { matchingOperations: 1, status: 'unknown' },
      'a late authenticated status response cannot mutate the uncertain outbox without an active request')

    markStage('spontaneous-wss-loss-during-operation-query')
    const playerBeforeTransportLoss = await playerPage.evaluate(() => window.karaokeRemotePlayer.getSnapshot())
    assert.equal(playerBeforeTransportLoss.intent, 'enabled', 'the Player has an explicit enabled intent before the network fault')
    assert.equal(playerBeforeTransportLoss.listener, 'advertising', 'the Player listener remains active before the network fault')
    assert.equal(playerBeforeTransportLoss.playerPairing, 'active', 'the G2 authority is active before the network fault')
    await managementApp.evaluate(() => globalThis.__kqG5TransportFaultProxy.pauseDownstream())
    await queryButton.click()
    await managementPage.getByRole('button', { name: 'Consultando…' }).waitFor({ state: 'visible', timeout: 5000 })
    const bufferedQueryResponseBytes = await managementApp.evaluate(() =>
      globalThis.__kqG5TransportFaultProxy.waitForDownstreamBuffer(15000))
    assert.ok(bufferedQueryResponseBytes > 0,
      'the authenticated query response reached the proxy while the original operation query remained in flight')
    await managementApp.evaluate(() => globalThis.__kqG5TransportFaultProxy.dropTransport())
    await waitForPageCondition(managementPage, async () => {
      const snapshot = await window.karaokeRemoteManagement.getSnapshot()
      return snapshot.connections.some(connection => connection.deviceRole === 'player' && connection.state === 'backoff')
    }, undefined, { timeout: 30000 })
    await managementPage.getByText(
      'A consulta não terminou. A operação original continua preservada e não foi reenviada.',
      { exact: true }).waitFor({ state: 'visible', timeout: 10000 })
    const queryAfterDisconnect = await managementPage.evaluate(async id => {
      const snapshot = await window.karaokeRemoteManagement.getSnapshot()
      const matching = snapshot.operations.filter(operation => operation.operationId === id)
      const connection = snapshot.connections.find(item => item.deviceRole === 'player' &&
        item.deviceId === matching[0]?.playerId)
      const card = [...document.querySelectorAll('.remote-operation-list .remote-device-card')]
        .find(element => element.getAttribute('data-operation-id') === id)
      return { revision: snapshot.revision, count: matching.length, status: matching[0]?.status ?? null,
        connectionState: connection?.state ?? null, reconciled: connection?.reconciled ?? null,
        queryButtonCount: card?.querySelectorAll('[data-action="query-operation"]').length ?? 0,
        busyLabelCount: card ? [...card.querySelectorAll('button')].filter(button => button.textContent?.trim() === 'Consultando…').length : 0 }
    }, operationId)
    assert.equal(queryAfterDisconnect.count, 1, 'disconnect during a query does not duplicate its durable outbox entry')
    assert.equal(queryAfterDisconnect.status, 'unknown', 'disconnect during a query cannot invent a terminal operation result')
    assert.equal(queryAfterDisconnect.connectionState, 'backoff', 'the exact Player channel is in real retry backoff')
    assert.equal(queryAfterDisconnect.reconciled, false, 'the lost channel no longer claims technical reconciliation')
    assert.equal(queryAfterDisconnect.queryButtonCount, 0, 'the query action is unavailable while that Player is disconnected')
    assert.equal(queryAfterDisconnect.busyLabelCount, 0, 'disconnect releases the query spinner instead of leaving it stuck')
    await managementApp.evaluate(() => globalThis.__kqG5TransportFaultProxy.resumeDownstream())
    await managementApp.evaluate(() => globalThis.__kqG5TransportFaultProxy.restoreTransport())
    await waitForPageCondition(playerPage, async () => {
      const snapshot = await window.karaokeRemotePlayer.getSnapshot()
      return snapshot.intent === 'enabled' && snapshot.listener === 'advertising' && snapshot.playerPairing === 'active' &&
        !snapshot.connections.some(connection => connection.deviceRole === 'controller')
    }, undefined, { timeout: 15000 })
    await managementApp.evaluate(() => globalThis.__kqG5TransportFaultProxy.restoreTransport())
    await waitForPageCondition(managementPage, async () => {
      const snapshot = await window.karaokeRemoteManagement.getSnapshot()
      return snapshot.connections.some(connection => connection.deviceRole === 'player' &&
        connection.state === 'synchronized' && connection.reconciled)
    }, undefined, { timeout: 60000 })
    await waitForPageCondition(playerPage, async () => {
      const snapshot = await window.karaokeRemotePlayer.getSnapshot()
      return snapshot.intent === 'enabled' && snapshot.listener === 'advertising' && snapshot.playerPairing === 'active' &&
        snapshot.connections.filter(connection => connection.deviceRole === 'controller').length === 1
    }, undefined, { timeout: 30000 })
    const playerAfterTransportRestore = await playerPage.evaluate(() => window.karaokeRemotePlayer.getSnapshot())
    assert.equal(playerAfterTransportRestore.intent, 'enabled', 'transport recovery preserves Player authorization intent')
    assert.equal(playerAfterTransportRestore.listener, 'advertising', 'transport recovery does not restart or disable playback service')
    assert.equal(playerAfterTransportRestore.playerPairing, 'active', 'transport recovery retains the G2 pairing')
    await waitForPageCondition(managementPage, async ({ playerId, id }) => {
      const snapshot = await window.karaokeRemoteManagement.getSnapshot()
      const operation = snapshot.operations.find(item => item.playerId === playerId && item.operationId === id)
      const connection = snapshot.connections.find(item => item.deviceRole === 'player' && item.deviceId === playerId)
      const button = [...document.querySelectorAll('#remote-devices-root [data-action="query-operation"]')]
        .find(element => element.getAttribute('data-player-id') === playerId && element.getAttribute('data-operation-id') === id)
      return operation?.status === 'unknown' && connection?.state === 'synchronized' && connection.reconciled &&
        button instanceof HTMLButtonElement && !button.disabled
    }, { playerId: pairedPlayer.playerId, id: operationId }, { timeout: 30000,
      label: 'original-query-available-after-disconnect-recovery' })
    const queryAfterRecovery = await managementPage.evaluate(async id => {
      const snapshot = await window.karaokeRemoteManagement.getSnapshot()
      const matching = snapshot.operations.filter(operation => operation.operationId === id)
      return { count: matching.length, status: matching[0]?.status ?? null }
    }, operationId)
    assert.deepEqual(queryAfterRecovery, { count: 1, status: 'unknown' },
      'reconciliation restores explicit query availability without interpreting the interrupted response')

    const confirmedDialog = playerPage.getByRole('alertdialog', { name: 'Vínculo confirmado' })
    if (await confirmedDialog.isVisible().catch(() => false)) {
      await confirmedDialog.getByRole('button', { name: 'Fechar · Enter' }).click()
    }
    // PairingStore retains failed OPAQUE attempts and applies its conservative cooldown after Player restart.
    // Run renewal before the restart scenarios so this E2E respects the real G2 lockout contract.
    markStage('renewal-player-ui-stage-new-certificate')
    const renewalBaseline = readPairingRenewalPersistence(player.userData, management.userData, pairedPlayer.playerId)
    assert.equal(renewalBaseline.playerId, pairedPlayer.playerId,
      'the saved Management peer is the Player identity whose renewal is being staged')
    assert.equal(renewalBaseline.playerAuthority?.phase, 'active')
    assert.equal(renewalBaseline.controllerAuthority?.phase, 'active')
    assert.equal(renewalBaseline.playerAuthority?.credentialGeneration, 1)
    assert.equal(renewalBaseline.controllerAuthority?.credentialGeneration, 1)
    assert.equal(renewalBaseline.playerAuthority?.certificateFingerprintSha256,
      renewalBaseline.identityFingerprint, 'initial Player authority and persisted certificate identity match')
    assert.equal(renewalBaseline.controllerAuthority?.certificateFingerprintSha256,
      renewalBaseline.identityFingerprint, 'initial Management authority pins the same Player certificate')
    const playerRenewButton = playerPage.locator('#remote-player-renew')
    await playerRenewButton.waitFor({ state: 'visible', timeout: 10000 })
    await playerRenewButton.click()
    const renewalNetworkDialog = playerPage.getByRole('dialog', { name: 'Renovar o vínculo deste Player?' })
    await renewalNetworkDialog.waitFor({ state: 'visible', timeout: 10000 })
    assert.equal(await renewalNetworkDialog.getByRole('button', { name: 'Continuar na rede' }).isEnabled(), true,
      'Player renewal requires the owner to explicitly continue on a private network')
    await renewalNetworkDialog.getByRole('button', { name: 'Continuar na rede' }).click()

    markStage('renewal-management-ui-observes-pin-conflict')
    const managementRenewButton = managementPage.locator('#remote-devices-root [data-purpose="renewal"]' +
      `[data-player-id="${pairedPlayer.playerId}"]`)
    try { await managementRenewButton.waitFor({ state: 'visible', timeout: 60000 }) }
    catch (error) {
      const observation = await observeRenewalFailure(pairedPlayer.playerId, playerPage, managementPage,
        player.userData, management.userData)
        .catch(diagnosticError => ({ diagnosticFailure: classifyRenewalConnectionError(diagnosticError?.code || diagnosticError?.message) }))
      console.error('Sanitized certificate renewal UI observation:', JSON.stringify(observation))
      throw error
    }
    assert.equal(await managementRenewButton.count(), 1,
      'Management offers renewal only on the saved Player candidate after a real certificate pin conflict')
    const renewalCandidateId = await managementRenewButton.getAttribute('data-candidate-id')
    assert.ok(renewalCandidateId, 'the renewal action is bound to the current Main-owned discovery candidate')
    const renewalCandidate = await managementPage.evaluate(async candidateId => {
      const snapshot = await window.karaokeRemoteManagement.getSnapshot()
      const candidate = snapshot.candidates.find(item => item.candidateId === candidateId)
      const connection = snapshot.connections.find(item => item.deviceRole === 'player' && item.deviceId === candidate?.claimedDeviceId)
      return { claimedPlayerId: candidate?.claimedDeviceId ?? null,
        connectionState: connection?.state ?? null, connectionReason: connection?.reason ?? null }
    }, renewalCandidateId)
    assert.deepEqual(renewalCandidate, { claimedPlayerId: pairedPlayer.playerId,
      connectionState: 'conflict', connectionReason: 'REMOTE_CERTIFICATE_PIN_MISMATCH' },
    'renewal is enabled for the same persisted peer only after Main observes the staged certificate pin mismatch')
    const pinFailureUi = await managementPage.evaluate(async playerId => {
      const snapshot = await window.karaokeRemoteManagement.getSnapshot()
      const connection = snapshot.connections.find(item => item.deviceRole === 'player' && item.deviceId === playerId)
      const card = document.querySelector(`[data-saved-player-id="${playerId}"]`)
      return { reconciled: connection?.reconciled, state: connection?.state,
        cardCount: document.querySelectorAll(`[data-saved-player-id="${playerId}"]`).length,
        badge: card?.querySelector('[data-connection-state]')?.getAttribute('data-connection-state') }
    }, pairedPlayer.playerId)
    assert.deepEqual(pinFailureUi, { reconciled: false, state: 'conflict', cardCount: 1, badge: 'conflict' },
      'real TLS pin rejection reaches IPC and the exact saved-peer DOM without fabricated synchronization')

    markStage('renewal-management-ui-pairing')
    await managementRenewButton.click()
    await managementPage.getByRole('dialog', { name: 'Confirme no Player' }).waitFor({ state: 'visible', timeout: 15000 })
    const renewalConsentDialog = playerPage.getByRole('dialog', { name: 'Permitir esta Gestão?' })
    await renewalConsentDialog.waitFor({ state: 'visible', timeout: 30000 })
    assert.match(await playerPage.locator('.remote-player-eyebrow').innerText(), /RENOVAÇÃO/,
      'Player labels the consent as certificate renewal, not as first-time pairing')
    await renewalConsentDialog.getByRole('button', { name: 'Permitir neste Player' }).click()
    const renewalCodeDialog = playerPage.getByRole('dialog', { name: 'Confirme o pareamento' })
    await renewalCodeDialog.waitFor({ state: 'visible', timeout: 30000 })
    const renewalCode = (await playerPage.locator('.remote-player-temporary-code').textContent()).trim()
    temporaryCodeForLogRedaction = renewalCode
    assert.match(renewalCode, /^\d{4} \d{4}$/, 'renewal uses a fresh ephemeral 4–4 code')
    const renewalCodeInput = managementPage.locator('#remote-pairing-code')
    await renewalCodeInput.waitFor({ state: 'visible', timeout: 30000 })
    assert.match(await managementPage.locator('.remote-pairing-dialog').innerText(), /RENOVAÇÃO/,
      'Management keeps the renewal purpose on the real code-entry presentation')
    markStage('renewal-ui-cancel-after-player-durable-admission')
    await installPlayerPreparedPairingResponseHold(playerApp)
    await renewalCodeInput.fill(renewalCode.replace(' ', ''))
    await renewalCodeInput.press('Enter')
    const heldPrepareCount = await playerApp.evaluate(() =>
      globalThis.__kqG5PreparedPairingResponseHold.waitForPrepared(60000))
    assert.equal(heldPrepareCount, 1,
      'the Player reaches response/prepare only after its renewal journal is durably admitted')
    const playerBeforeRenewalCancel = JSON.parse(fs.readFileSync(path.join(player.userData, 'remote-authorization.json'), 'utf8'))
    const managementBeforeRenewalCancel = JSON.parse(fs.readFileSync(path.join(management.userData, 'remote-authorization.json'), 'utf8'))
    const playerBoundJournal = playerBeforeRenewalCancel.journals.find(journal => journal.role === 'player' &&
      journal.context.playerId === pairedPlayer.playerId && journal.context.purpose === 'renewal' && journal.phase === 'bound')
    const controllerBoundJournal = managementBeforeRenewalCancel.journals.find(journal => journal.role === 'controller' &&
      journal.context.playerId === pairedPlayer.playerId && journal.context.purpose === 'renewal' && journal.phase === 'bound')
    assert.ok(playerBoundJournal && controllerBoundJournal,
      'both independent G2 stores durably retain the same renewal operation before its prepare response is delivered')
    assert.equal(playerBoundJournal.operationId, controllerBoundJournal.operationId,
      'the admitted Player and Management journals correlate to one original operation')
    assert.equal(playerBeforeRenewalCancel.renewal?.phase, 'staged',
      'the new Player certificate remains staged before the bilateral renewal completes')
    assert.equal(playerBeforeRenewalCancel.playerAuthority?.credentialGeneration, 1,
      'admission alone does not promote Player authority')
    assert.equal(managementBeforeRenewalCancel.controllerAuthorities[pairedPlayer.playerId]?.credentialGeneration, 1,
      'admission alone does not replace the Management authority')

    await managementPage.getByRole('button', { name: 'Cancelar · Esc' }).click()
    await managementPage.locator('#remote-pairing-heading').waitFor({ state: 'hidden', timeout: 15000 })
    await managementPage.getByText(
      'Solicitação cancelada. Se a operação já havia sido admitida, o Main preservará o resultado para recuperação.',
      { exact: true }).waitFor({ state: 'visible', timeout: 15000 })
    const playerAfterRenewalCancel = await playerPage.evaluate(() => window.karaokeRemotePlayer.getSnapshot())
    assert.equal(playerAfterRenewalCancel.playerPairing, 'recovery_required',
      'cancelling after durable admission preserves the Player journal as recovery-required')
    for (const [profile, journal] of [[player, playerBoundJournal], [management, controllerBoundJournal]]) {
      const persisted = JSON.parse(fs.readFileSync(path.join(profile.userData, 'remote-authorization.json'), 'utf8'))
      assert.ok(persisted.journals.some(item => item.operationId === journal.operationId &&
        item.sessionId === journal.sessionId), 'UI cancellation retains the original durable G2 evidence')
    }
    const releasedPrepareCount = await playerApp.evaluate(() =>
      globalThis.__kqG5PreparedPairingResponseHold.release().released)
    assert.equal(releasedPrepareCount, 1, 'the isolated prepare-response barrier is released after recording cancellation')

    await devicesPanel.getByRole('button', { name: 'Atualizar busca' }).click()
    const recoveryAction = managementPage.locator('#remote-devices-root [data-purpose="recovery"]' +
      `[data-player-id="${pairedPlayer.playerId}"]`)
    await recoveryAction.waitFor({ state: 'visible', timeout: 30000 })
    assert.equal(await recoveryAction.count(), 1,
      'the same active saved peer exposes recovery for its durably admitted renewal journal')
    assert.equal(await recoveryAction.getAttribute('data-candidate-id'),
      await managementPage.evaluate(playerId => window.karaokeRemoteManagement.getSnapshot()
        .then(snapshot => snapshot.candidates.find(candidate => candidate.claimedDeviceId === playerId)?.candidateId),
      pairedPlayer.playerId), 'recovery is bound to a fresh discovery candidate claiming the saved Player')
    await recoveryAction.click()
    await managementPage.getByRole('dialog', { name: 'Recuperando vínculo salvo' })
      .waitFor({ state: 'visible', timeout: 10000 })
    assert.equal(await managementPage.locator('#remote-pairing-code').count(), 0,
      'recovery resumes the same journal without requesting another temporary code')
    try {
      await playerPage.getByRole('alertdialog', { name: 'Vínculo confirmado' }).waitFor({ state: 'visible', timeout: 60000 })
    } catch (error) {
      const [playerState, managementState] = await Promise.all([
        playerPage.evaluate(async () => {
          const snapshot = await window.karaokeRemotePlayer.getSnapshot().catch(() => null)
          const dialog = document.querySelector('#remote-player-pairing-root [role="dialog"], #remote-player-pairing-root [role="alertdialog"]')
          return { snapshot: snapshot ? { revision: snapshot.revision, intent: snapshot.intent,
              listener: snapshot.listener, pairing: snapshot.playerPairing, errorCode: snapshot.errorCode } : null,
            dialogRole: dialog?.getAttribute('role') ?? null,
            dialogHeading: dialog?.querySelector('h1')?.textContent?.trim() ?? null,
            resultMessage: dialog?.querySelector('.remote-player-result')?.textContent?.trim() ?? null,
            temporaryCodeVisible: Boolean(document.querySelector('.remote-player-temporary-code')) }
        }),
        managementPage.evaluate(async playerId => {
          const snapshot = await window.karaokeRemoteManagement.getSnapshot().catch(() => null)
          const connection = snapshot?.connections.find(item => item.deviceRole === 'player' && item.deviceId === playerId)
          const device = snapshot?.savedDevices.find(item => item.playerId === playerId)
          return { revision: snapshot?.revision ?? null,
            connection: connection ? { state: connection.state, reason: connection.reason,
              reconciled: connection.reconciled } : null,
            savedDevice: device ? { active: device.status === 'active', recoveryRequired: device.recoveryRequired } : null,
            pairingDialog: document.querySelector('#remote-devices-root .remote-pairing-dialog')?.querySelector('h1')?.textContent?.trim() ?? null,
            actionErrorCode: document.querySelector('#remote-devices-root [data-error-code]')?.getAttribute('data-error-code') ?? null,
            stateMessage: document.querySelector('#remote-devices-root [role="status"]')?.textContent?.trim() ?? null }
        }, pairedPlayer.playerId)
      ])
      let persistedState
      try {
        const state = JSON.parse(fs.readFileSync(path.join(player.userData, 'remote-authorization.json'), 'utf8'))
        const persistence = readPairingRenewalPersistence(player.userData, management.userData, pairedPlayer.playerId)
        persistedState = { expectedPlayerMatches: persistence.playerId === pairedPlayer.playerId,
          renewalPhase: persistence.renewal?.phase ?? null,
          playerAuthorityPhase: persistence.playerAuthority?.phase ?? null,
          playerGeneration: persistence.playerAuthority?.credentialGeneration ?? null,
          managementAuthorityPhase: persistence.controllerAuthority?.phase ?? null,
          managementGeneration: persistence.controllerAuthority?.credentialGeneration ?? null,
          authoritiesPinCurrentIdentity: persistence.identityFingerprint === persistence.playerAuthority?.certificateFingerprintSha256 &&
            persistence.identityFingerprint === persistence.controllerAuthority?.certificateFingerprintSha256,
          retainedAttemptCount: Array.isArray(state.attempts) ? state.attempts.length : null }
      } catch (diagnosticError) {
        persistedState = { diagnosticError: safeAssertionValue(diagnosticError?.message) }
      }
      console.error('Sanitized renewal pairing completion diagnostics:', JSON.stringify({
        observedAt: new Date().toISOString(), player: playerState,
        playerResultMessage: safeAssertionValue(playerState.resultMessage),
        management: managementState, managementStateMessage: safeAssertionValue(managementState.stateMessage),
        persistedState
      }))
      throw error
    }
    await managementPage.getByText(/Vínculo salvo\./).waitFor({ state: 'visible', timeout: 60000 })
    await waitForPageCondition(managementPage, async playerId => {
      const snapshot = await window.karaokeRemoteManagement.getSnapshot()
      return snapshot.savedDevices.filter(device => device.playerId === playerId && device.status === 'active').length === 1 &&
        snapshot.connections.some(item => item.deviceRole === 'player' && item.deviceId === playerId &&
          item.state === 'synchronized' && item.reconciled)
    }, pairedPlayer.playerId, { timeout: 60000, label: 'renewed-player-saved-and-reconciled' })
    const renewedPersistence = readPairingRenewalPersistence(player.userData, management.userData, pairedPlayer.playerId)
    assert.equal(renewedPersistence.playerId, renewalBaseline.playerId)
    assert.notEqual(renewedPersistence.identityFingerprint, renewalBaseline.identityFingerprint,
      'the Player durably promotes a new certificate only after the renewal pairing commits')
    assert.equal(renewedPersistence.playerAuthority?.phase, 'active')
    assert.equal(renewedPersistence.playerAuthority?.credentialGeneration, 2)
    assert.equal(renewedPersistence.playerAuthority?.certificateFingerprintSha256,
      renewedPersistence.identityFingerprint, 'the Player identity and active authority commit the same new certificate')
    assert.equal(renewedPersistence.controllerAuthority?.phase, 'active')
    assert.equal(renewedPersistence.controllerAuthority?.credentialGeneration, 2)
    assert.equal(renewedPersistence.controllerAuthority?.certificateFingerprintSha256,
      renewedPersistence.identityFingerprint, 'Management commits the matching renewed certificate generation')
    assert.equal(renewedPersistence.renewal?.phase, 'promoted',
      'the Player clears the stage-first renewal journal only after durable identity promotion')
    assert.equal(renewedPersistence.renewal?.oldFingerprint, renewalBaseline.identityFingerprint)
    assert.equal(renewedPersistence.renewal?.newFingerprint, renewedPersistence.identityFingerprint)
    await playerPage.getByRole('alertdialog', { name: 'Vínculo confirmado' })
      .getByRole('button', { name: 'Fechar · Enter' }).click()

    markStage('explicit-offline-transition')
    const offlineButton = playerPage.locator('#remote-player-disable')
    await offlineButton.waitFor({ state: 'visible', timeout: 10000 })
    await offlineButton.click()
    const offlineDialog = playerPage.getByRole('alertdialog', { name: 'Entrar em modo offline?' })
    await offlineDialog.waitFor({ state: 'visible', timeout: 10000 })
    await offlineDialog.getByRole('button', { name: 'Entrar em modo offline' }).click()
    await waitForPageCondition(playerPage, async () => {
      const snapshot = await window.karaokeRemotePlayer.getSnapshot()
      return snapshot.intent === 'offline' && snapshot.listener === 'stopped' &&
        !snapshot.connections.some(item => item.deviceRole === 'controller' && item.state === 'authorized')
    }, undefined, { timeout: 30000 })
    await playerPage.getByText('MODO OFFLINE', { exact: true }).waitFor({ state: 'visible', timeout: 10000 })
    await waitForPageCondition(managementPage, async () => {
      const snapshot = await window.karaokeRemoteManagement.getSnapshot()
      return snapshot.connections.some(item => item.deviceRole === 'player' && item.state === 'backoff')
    }, undefined, { timeout: 30000 })
    const offlineConnectionBadge = managementPage.locator('#remote-devices-root .remote-device-card [data-connection-state]').first()
    await offlineConnectionBadge.waitFor({ state: 'visible', timeout: 10000 })
    assert.equal(await offlineConnectionBadge.getAttribute('data-connection-state'), 'backoff')
    assert.equal((await offlineConnectionBadge.innerText()).trim(), 'Aguardando nova tentativa',
      'the explicit offline transition appears as the actual G4 retry state in Management')

    markStage('player-confirmed-exit-and-offline-restart')
    reconnectBaseline = await managementPage.evaluate(async playerId => {
      const snapshot = await window.karaokeRemoteManagement.getSnapshot()
      const connection = snapshot.connections.find(item => item.deviceRole === 'player' && item.deviceId === playerId)
      return { revision: snapshot.revision,
        state: connection?.state ?? null, reconciled: connection?.reconciled ?? false }
    }, pairedPlayer.playerId)
    assert.equal(reconnectBaseline.state, 'backoff',
      'the post-restart trace baseline is captured only after Main observes the Player offline')
    await playerApp.evaluate(({ app: electronApp }) => electronApp.quit())
    const exitConfirmation = playerPage.locator('#standalone-exit-confirmation')
    await exitConfirmation.waitFor({ state: 'visible', timeout: 10000 })
    const playerProcessExit = waitForProcessExit(playerApp)
    await playerPage.locator('#exit-confirmation-confirm').click()
    const playerExit = await playerProcessExit
    assert.equal(playerExit.signal, null, 'Confirmar a saída deve encerrar o processo Player normalmente.')
    assert.equal(playerExit.code, 0, 'O Player deve completar o shutdown coordenado antes do restart.')
    playerApp = undefined
    playerApp = await launch(player)
    playerPage = await playerApp.firstWindow()
    await playerPage.waitForLoadState('domcontentloaded', { timeout: 20000 })
    await playerPage.waitForFunction(() => Boolean(window.karaokeRemotePlayer), undefined, { timeout: 20000 })
    await playerPage.evaluate(() => {
      window.__kqG5ConnectionTrace = []
      window.__kqG5ConnectionTraceUnsubscribe = window.karaokeRemotePlayer.onSnapshot(snapshot => {
        const trace = window.__kqG5ConnectionTrace
        trace.push({ at: Math.round(performance.now()), revision: snapshot.revision,
          connections: snapshot.connections.filter(item => item.deviceRole === 'controller')
            .map(item => ({ state: item.state, reconciled: item.reconciled, reason: item.reason })) })
        if (trace.length > 80) trace.shift()
      })
    })
    await waitForPageCondition(playerPage, async () => {
      const snapshot = await window.karaokeRemotePlayer.getSnapshot()
      return snapshot.intent === 'offline' && snapshot.listener === 'stopped' && snapshot.playerPairing === 'active'
    }, undefined, { timeout: 30000 })
    const savedAfterRestart = await managementPage.evaluate(() => window.karaokeRemoteManagement.getSnapshot())
    const savedPlayerAfterRestart = savedAfterRestart.savedDevices.find(device => device.status === 'active')
    assert.ok(savedPlayerAfterRestart,
      'Management retains the saved binding while the Player restarts offline')

    markStage('offline-reconnect-after-normal-restart')
    await playerPage.locator('#remote-player-enable').click()
    const reenableNetworkDialog = playerPage.getByRole('dialog', { name: 'Permitir descoberta nesta rede?' })
    await reenableNetworkDialog.waitFor({ state: 'visible', timeout: 10000 })
    await reenableNetworkDialog.getByRole('button', { name: 'Permitir descoberta' }).click()
    await waitForPageCondition(playerPage, async () => {
      const snapshot = await window.karaokeRemotePlayer.getSnapshot()
      return snapshot.intent === 'enabled' && snapshot.listener === 'advertising'
    }, undefined, { timeout: 30000 })
    markStage('player-listener-advertising-after-normal-restart')
    await updateTransportProxyTarget(managementApp, playerPage)
    markStage('management-reconnect-after-normal-restart')
    try {
      await waitForPageCondition(playerPage, async () => {
        const snapshot = await window.karaokeRemotePlayer.getSnapshot()
        return snapshot.intent === 'enabled' && snapshot.listener === 'advertising' && snapshot.playerPairing === 'active' &&
          snapshot.connections.some(connection => connection.deviceRole === 'controller' && connection.state === 'authorized')
      }, undefined, { timeout: 30000 })
    } catch (error) {
      const diagnostics = await Promise.all([
        managementPage.evaluate(async () => {
          const snapshot = await window.karaokeRemoteManagement.getSnapshot()
          return {
            revision: snapshot.revision,
            connections: snapshot.connections.filter(item => item.deviceRole === 'player')
              .map(item => ({ state: item.state, reconciled: item.reconciled, reason: item.reason })),
            trace: (window.__kqG5ConnectionTrace ?? []).slice(-20).map(item => ({
              revision: item.revision,
              connections: (item.connections ?? []).map(connection => ({
                state: connection.state, reconciled: connection.reconciled, reason: connection.reason
              }))
            }))
          }
        }),
        playerPage.evaluate(async () => {
          const snapshot = await window.karaokeRemotePlayer.getSnapshot().catch(() => null)
          return { intent: snapshot?.intent ?? null, listener: snapshot?.listener ?? null,
            pairing: snapshot?.playerPairing ?? null,
            connections: snapshot?.connections.filter(item => item.deviceRole === 'controller') ?? null,
            trace: (window.__kqG5ConnectionTrace ?? []).slice(-20) }
        }),
        managementApp.evaluate(() => globalThis.__kqG5TransportFaultProxy?.getDiagnostics() ?? null)
      ])
      console.error('Sanitized reconnection after normal restart diagnostics:', JSON.stringify({
        management: diagnostics[0], player: diagnostics[1], proxy: diagnostics[2]
      }))
      throw error
    }
    await waitForPageCondition(managementPage, async ({ traceStart, playerId }) => {
      const snapshot = await window.karaokeRemoteManagement.getSnapshot()
      const states = (window.__kqG5ConnectionTrace ?? []).flatMap(item =>
        item.revision > traceStart ? item.connections ?? [] : [])
      const playerStates = states.filter(item => item.deviceId === playerId)
      const current = snapshot.connections.find(item => item.deviceRole === 'player' && item.deviceId === playerId)
      const hasNewConnectionAttempt = playerStates.some(item => item.state === 'connecting')
      const hasNewReconciliation = playerStates.some(item => item.state === 'synchronized' && item.reconciled)
      return hasNewConnectionAttempt && hasNewReconciliation && snapshot.revision > traceStart &&
        current?.state === 'synchronized' && current.reconciled
    }, { traceStart: reconnectBaseline.revision, playerId: savedPlayerAfterRestart.playerId }, { timeout: 60000 })
    reconnectWaitEvidence = await managementPage.evaluate(async ({ baselineRevision, playerId }) => {
      const snapshot = await window.karaokeRemoteManagement.getSnapshot()
      const connection = snapshot.connections.find(item => item.deviceRole === 'player' && item.deviceId === playerId)
      return {
        baselineRevision, snapshotRevision: snapshot.revision,
        current: connection ? { state: connection.state, reconciled: connection.reconciled,
          reason: connection.reason } : null,
        postBaselineTrace: (window.__kqG5ConnectionTrace ?? []).filter(item => item.revision > baselineRevision)
          .map(item => ({ revision: item.revision,
            states: (item.connections ?? []).map(value => ({ state: value.state, reconciled: value.reconciled,
              reason: value.reason })) }))
      }
    }, { baselineRevision: reconnectBaseline.revision, playerId: savedPlayerAfterRestart.playerId })

    markStage('rendered-connection-after-normal-restart')
    if (!(await managementPage.locator('#remote-devices-root .remote-device-panel').isVisible().catch(() => false))) {
      await managementPage.locator('#btn-devices').click()
    }
    let deviceCard = managementPage.locator(`[data-saved-player-id="${savedPlayerAfterRestart.playerId}"]`)
    assert.equal(await deviceCard.count(), 1, 'the saved Player card selector identifies exactly one binding')
    await deviceCard.locator('[data-connection-state]').waitFor({ state: 'visible', timeout: 10000 })
    await waitForPageCondition(managementPage, async playerId => {
      const snapshot = await window.karaokeRemoteManagement.getSnapshot()
      const current = snapshot.connections.find(item => item.deviceRole === 'player' && item.deviceId === playerId)
      const matchingCard = [...document.querySelectorAll('#remote-devices-root .remote-device-card')]
        .find(card => card.getAttribute('data-saved-player-id') === playerId)
      const rendered = matchingCard?.querySelector('[data-connection-state]')
        ?.getAttribute('data-connection-state') ?? null
      const clauses = { synchronized: current?.state === 'synchronized', reconciled: current?.reconciled === true, domMatches: rendered === current?.state }
      window.__kqG5CardObservation = { expectedPeerId: playerId, clauses,
        cards: [...document.querySelectorAll('[data-saved-player-id]')].map(card => ({ id: card.getAttribute('data-saved-player-id'), state: card.querySelector('[data-connection-state]')?.getAttribute('data-connection-state') })), at: Date.now(), revision: snapshot.revision,
        peerFound: Boolean(current), cardFound: Boolean(matchingCard),
        state: current?.state ?? null, reconciled: current?.reconciled ?? null, rendered }
      return clauses.synchronized && clauses.reconciled && clauses.domMatches
    }, savedPlayerAfterRestart.playerId, { timeout: 10000, label: 'saved-card-synchronized-after-restart' })
    const restoredState = await deviceCard.locator('[data-connection-state]').getAttribute('data-connection-state')
    if (!['connecting', 'authorized', 'reconciling', 'synchronized'].includes(restoredState)) {
      const diagnostics = await Promise.all([
        managementPage.evaluate(async () => ({
          snapshot: await window.karaokeRemoteManagement.getSnapshot().then(value => ({
            connections: value.connections.filter(item => item.deviceRole === 'player'),
            trace: (window.__kqG5ConnectionTrace ?? []).slice(-20)
          })),
          renderedState: document.querySelector('#remote-devices-root [data-connection-state]')?.getAttribute('data-connection-state') ?? null
        })),
        playerPage.evaluate(async () => ({
          snapshot: await window.karaokeRemotePlayer.getSnapshot().then(value => ({
            listener: value.listener, intent: value.intent, pairing: value.playerPairing,
            listenerEndpoint: value.listenerEndpoint,
            connections: value.connections.filter(item => item.deviceRole === 'controller')
          })),
          trace: (window.__kqG5ConnectionTrace ?? []).slice(-20)
        })),
        managementApp.evaluate(() => globalThis.__kqG5TransportFaultProxy?.getDiagnostics() ?? null)
      ])
      const currentPlayerEndpoint = await playerPage.evaluate(() => window.karaokeRemotePlayer.getSnapshot()
        .then(snapshot => snapshot.listenerEndpoint).catch(() => null))
      const playerPid = playerApp?.process()?.pid ?? null
      console.error('Sanitized restored-connection diagnostics:', JSON.stringify({
        management: diagnostics[0], player: diagnostics[1], proxy: diagnostics[2],
        endpointAvailable: Boolean(currentPlayerEndpoint && Number.isInteger(currentPlayerEndpoint.port)),
        playerPid,
        endpointListeners: windowsListenerOwnership(currentPlayerEndpoint, playerPid)
      }))
    }
    assert.equal(restoredState, 'synchronized',
      `Management presents the real restored transport state, received ${restoredState}`)
    const stateLabels = {
      connecting: 'Conectando', authorized: 'Transporte autenticado', reconciling: 'Conciliando estado',
      synchronized: 'Reconciliado tecnicamente · sem controle de negócio'
    }
    assert.equal((await deviceCard.locator('[data-connection-state]').innerText()).trim(), stateLabels[restoredState],
      'Management presents copy corresponding to the real Main connection state')

    // Abruptly ending the real Player process simulates a WSS loss without
    // writing an offline intent or changing pairing authority.
    markStage('player-abrupt-stop-before-backoff')
    const abruptExit = waitForProcessExit(playerApp, 15000)
    // Execute in the actual Electron Main: Playwright's child may be a cmd.exe launcher on Windows.
    await playerApp.evaluate(() => process.kill(process.pid, 'SIGKILL')).catch(() => undefined)
    await abruptExit
    playerApp = undefined
    await waitForPageCondition(managementPage, async () => {
      const snapshot = await window.karaokeRemoteManagement.getSnapshot()
      return snapshot.connections.some(item => item.deviceRole === 'player' && item.state === 'backoff')
    }, undefined, { timeout: 30000, label: 'backoff-after-actual-player-crash' })
    await deviceCard.locator('[data-connection-state="backoff"]').waitFor({ state: 'visible', timeout: 10000 })
    // Seed terminal status-query fixtures while the real Player Main is stopped.
    // An accepted Player operation becomes unknown after restart, so accepted
    // presentation is covered by the Management SQLite E2E rather than treated
    // as durable across a Player restart.
    seedPlayerOperationStatuses(player.userData, controllerId, savedPlayerAfterRestart.playerId, {
      [operationQueryIds.rejected]: 'rejected',
      [operationQueryIds.completed]: 'completed'
    })

    markStage('player-abrupt-restart')
    playerApp = await launch(player)
    playerPage = await playerApp.firstWindow()
    await playerPage.waitForLoadState('domcontentloaded', { timeout: 20000 })
    await playerPage.waitForFunction(() => Boolean(window.karaokeRemotePlayer), undefined, { timeout: 20000 })
    await waitForPageCondition(playerPage, async () => {
      const snapshot = await window.karaokeRemotePlayer.getSnapshot()
      return snapshot.intent === 'enabled' && snapshot.listener === 'stopped' && snapshot.playerPairing === 'active'
    }, undefined, { timeout: 30000 })
    assert.equal(await playerPage.locator('#remote-player-connection-status').innerText(),
      'VÍNCULO SALVO · DESCONECTADO', 'the restarted Player reflects its durable pairing and stopped listener')
    markStage('recovery-after-abrupt-restart')
    await playerPage.locator('#remote-player-enable').click()
    const recoveryNetworkDialog = playerPage.getByRole('dialog', { name: 'Permitir descoberta nesta rede?' })
    markStage('recovery-network-permission-dialog')
    await recoveryNetworkDialog.waitFor({ state: 'visible', timeout: 10000 })
    await recoveryNetworkDialog.getByRole('button', { name: 'Permitir descoberta' }).click()
    markStage('recovery-player-listener-advertising')
    await waitForPageCondition(playerPage, async () => {
      const snapshot = await window.karaokeRemotePlayer.getSnapshot()
      return snapshot.intent === 'enabled' && snapshot.listener === 'advertising'
    }, undefined, { timeout: 30000, label: 'player-advertising-after-abrupt-restart' })
    markStage('recovery-update-proxy-target')
    await updateTransportProxyTarget(managementApp, playerPage)
    markStage('recovery-management-reconciled')
    await waitForPageCondition(managementPage, async () => {
      const snapshot = await window.karaokeRemoteManagement.getSnapshot()
      return snapshot.connections.some(item => item.deviceRole === 'player' &&
        item.state === 'synchronized' && item.reconciled)
    }, undefined, { timeout: 60000, label: 'management-reconciled-after-abrupt-restart' })
    markStage('recovery-render-saved-card')
    await deviceCard.locator('[data-connection-state]').waitFor({ state: 'visible', timeout: 10000 })
    const reconnectedState = await deviceCard.locator('[data-connection-state]').getAttribute('data-connection-state')
    assert.ok(['connecting', 'authorized', 'reconciling', 'synchronized'].includes(reconnectedState),
      `Management reflects the real reconnect after WSS loss, received ${reconnectedState}`)
    assert.equal((await deviceCard.locator('[data-connection-state]').innerText()).trim(), stateLabels[reconnectedState],
      'Management does not label connection/reconciliation as business control after reconnect')

    // The Player's terminal events were reconciled before these Management intents existed.
    // This leaves the exact operationIds unknown locally so the following authenticated
    // status queries exercise the query response path, rather than the already-tested G4
    // event reconciliation path.
    markStage('operation-query-seed-management-after-reconciliation')
    for (const status of ['rejected', 'completed']) {
      seedUncertainOutbox(management.userData, controllerId, pairedPlayer.playerId, operationQueryIds[status])
    }
    const refreshedForStatusQueries = await managementPage.evaluate(() =>
      window.karaokeRemoteManagement.refreshDiscovery())
    assert.equal(refreshedForStatusQueries.outcome, 'started',
      'the real Main publishes a fresh snapshot after isolated unknown query intents are committed')
    await waitForPageCondition(managementPage, async ({ ids, playerId }) => {
      const snapshot = await window.karaokeRemoteManagement.getSnapshot()
      const connection = snapshot.connections.find(item => item.deviceRole === 'player' &&
        item.deviceId === playerId)
      return Object.values(ids).every(id => snapshot.operations.some(operation =>
        operation.operationId === id && operation.playerId === playerId && operation.status === 'unknown')) &&
        connection?.state === 'synchronized' && connection.reconciled
    }, { playerId: pairedPlayer.playerId,
      ids: { rejected: operationQueryIds.rejected, completed: operationQueryIds.completed } },
    { timeout: 10000, label: 'terminal-status-query-intents-are-unknown-on-the-reconciled-player' })

    markStage('authenticated-operation-status-responses')
    for (const [status, expectedLabel] of [
      ['rejected', 'Rejeitada'],
      ['completed', 'Concluída']
    ]) {
      const id = operationQueryIds[status]
      const operationCard = managementPage.locator('#remote-devices-root .remote-operation-list .remote-device-card' +
        '[data-player-id="' + pairedPlayer.playerId + '"][data-operation-id="' + id + '"]')
      await operationCard.waitFor({ state: 'visible', timeout: 10000 })
      assert.equal(await operationCard.count(), 1,
        'the operation card is selected by stable Player and operation identities before query')
      const query = managementPage.locator('#remote-devices-root [data-action="query-operation"]' +
        '[data-player-id="' + pairedPlayer.playerId + '"][data-operation-id="' + id + '"]')
      try { await query.waitFor({ state: 'visible', timeout: 10000 }) }
      catch (error) {
        const diagnostics = await managementPage.evaluate(async ({ operationId: expectedOperationId, playerId }) => {
          const snapshot = await window.karaokeRemoteManagement.getSnapshot().catch(() => null)
          const operation = snapshot?.operations.find(item => item.operationId === expectedOperationId)
          const connection = snapshot?.connections.find(item => item.deviceRole === 'player' && item.deviceId === playerId)
          const cards = [...document.querySelectorAll('#remote-devices-root .remote-operation-list .remote-device-card')]
            .map(card => ({ text: card.textContent?.trim() ?? '',
              operationIds: [...card.querySelectorAll('[data-operation-id]')]
                .map(button => button.getAttribute('data-operation-id')),
              playerIds: [...card.querySelectorAll('[data-player-id]')]
                .map(button => button.getAttribute('data-player-id')) }))
          const buttons = [...document.querySelectorAll('#remote-devices-root [data-action="query-operation"]')]
            .map(button => ({ operationId: button.getAttribute('data-operation-id'),
              playerId: button.getAttribute('data-player-id'),
              disabled: button instanceof HTMLButtonElement ? button.disabled : null,
              visible: button instanceof HTMLElement && button.getClientRects().length > 0 }))
          return { observedAt: new Date().toISOString(), revision: snapshot?.revision ?? null,
            expected: { operationId: expectedOperationId, playerId },
            operation: operation ? { operationId: operation.operationId, playerId: operation.playerId,
              status: operation.status, updatedAt: operation.updatedAt } : null,
            operationPresent: Boolean(operation), operationPlayerMatches: operation?.playerId === playerId,
            connection: connection ? { deviceId: connection.deviceId, state: connection.state,
              reconciled: connection.reconciled, revision: connection.revision ?? null,
              generation: connection.generation ?? null, reason: connection.reason } : null,
            canQuery: Boolean(operation && operation.playerId === playerId &&
              ['accepted', 'unknown'].includes(operation.status) && connection?.state === 'synchronized' &&
              connection.reconciled),
            panelVisible: document.querySelector('#remote-devices-root .remote-device-panel') instanceof HTMLElement &&
              document.querySelector('#remote-devices-root .remote-device-panel')!.getClientRects().length > 0,
            operationListVisible: document.querySelector('#remote-devices-root .remote-operation-list') instanceof HTMLElement &&
              document.querySelector('#remote-devices-root .remote-operation-list')!.getClientRects().length > 0,
            expectedButtonCount: document.querySelectorAll('#remote-devices-root [data-action="query-operation"]' +
              '[data-player-id="' + playerId + '"][data-operation-id="' + expectedOperationId + '"]').length,
            buttons, cards }
        }, { operationId: id, playerId: pairedPlayer.playerId })
        console.error('Sanitized terminal operation query availability diagnostics:', JSON.stringify({ status, diagnostics }))
        throw error
      }
      await query.click()
      await waitForPageCondition(managementPage, async ({ operationId: id, expectedStatus }) => {
        const snapshot = await window.karaokeRemoteManagement.getSnapshot()
        return snapshot.operations.find(operation => operation.operationId === id)?.status === expectedStatus
      }, { operationId: id, expectedStatus: status }, { timeout: 15000, label: `query-operation-status-${status}` })
      await operationCard.getByText(expectedLabel, { exact: false }).waitFor({ state: 'visible', timeout: 10000 })
      assert.equal(await operationCard.getAttribute('data-operation-id'), id,
        'the terminal result stays attached to the same operation card after the query action disappears')
      assert.equal(await operationCard.locator('[data-action="query-operation"]').count(),
        0, 'terminal operation status does not expose a redundant query')
    }

    // Persist one more uncertain intent, begin its authenticated status query,
    // and restart the real Management Main while the matching response is held
    // after WSS decoding. The same saved endpoint is preserved by rehosting the
    // test proxy in the still-running Player Main on its original port.
    markStage('management-restart-during-active-operation-query')
    const restartQueryOperationId = randomUUID()
    await observePlayerCommandForOperation(playerApp, restartQueryOperationId)
    seedUncertainOutbox(management.userData, controllerId, pairedPlayer.playerId, restartQueryOperationId)
    const refreshedForRestartQuery = await managementPage.evaluate(() =>
      window.karaokeRemoteManagement.refreshDiscovery())
    assert.equal(refreshedForRestartQuery.outcome, 'started')
    await waitForPageCondition(managementPage, async ({ id, playerId }) => {
      const snapshot = await window.karaokeRemoteManagement.getSnapshot()
      const matches = snapshot.operations.filter(operation => operation.operationId === id)
      return matches.length === 1 && matches[0].playerId === playerId && matches[0].status === 'unknown'
    }, { id: restartQueryOperationId, playerId: pairedPlayer.playerId },
    { timeout: 10000, label: 'unknown-operation-persisted-before-management-restart' })
    const restartQueryButton = managementPage.locator('#remote-devices-root [data-action="query-operation"]' +
      `[data-player-id="${pairedPlayer.playerId}"][data-operation-id="${restartQueryOperationId}"]`)
    await restartQueryButton.waitFor({ state: 'visible', timeout: 10000 })
    await installOperationStatusResponseHold(managementApp, restartQueryOperationId)
    await restartQueryButton.click()
    await managementPage.getByRole('button', { name: 'Consultando…' }).waitFor({ state: 'visible', timeout: 5000 })
    const heldRestartResponseCount = await managementApp.evaluate(() =>
      globalThis.__kqG5OperationResponseHold.waitForMatchingResponse(15000))
    assert.equal(heldRestartResponseCount, 1,
      'the real authenticated operation-status response is in flight while Management restarts')
    const playerEndpointBeforeManagementRestart = await playerPage.evaluate(() =>
      window.karaokeRemotePlayer.getSnapshot().then(snapshot => snapshot.listenerEndpoint))
    assert.ok(playerEndpointBeforeManagementRestart && Number.isInteger(playerEndpointBeforeManagementRestart.port))

    const previousManagementApp = managementApp
    await installManagementCloseChoice(previousManagementApp)
    const managementExit = waitForProcessExit(previousManagementApp, 30000)
    const selectedCloseDecision = previousManagementApp.evaluate(() =>
      globalThis.__kqG5ManagementCloseChoice.waitForDecision(10000))
    await previousManagementApp.evaluate(({ app: electronApp }) => electronApp.quit())
    assert.deepEqual(await selectedCloseDecision, {
      selectedButton: 'Sair sem encerrar sessão', title: 'Karaoke Queue', response: 1
    }, 'normal close decision exits Management while preserving the active test session')
    const managementExitResult = await managementExit
    assert.deepEqual(managementExitResult, { code: 0, signal: null },
      'Management exits normally while its status query is in flight')
    await withElectronTestDeadline(previousManagementApp.close(), 'management:restart-app-close', 5000)
    assert.equal(readManagementCloseDecision(management.userData)?.sessionRemainsOpen, true,
      'the confirmed process close does not terminate the Management session')
    managementApp = undefined
    managementPage = undefined
    const proxyPortAfterRestart = await startTransportFaultProxy(playerApp, {
      address: playerEndpointBeforeManagementRestart.address,
      port: playerEndpointBeforeManagementRestart.port
    }, faultProxyPort)
    assert.equal(proxyPortAfterRestart, faultProxyPort,
      'the test proxy reuses the saved endpoint while running in the independent Player Main')
    faultProxyOwner = playerApp
    faultProxyStarted = true

    managementApp = await launch(management)
    managementPage = await managementApp.firstWindow()
    await managementPage.waitForLoadState('domcontentloaded', { timeout: 20000 })
    await managementPage.waitForFunction(() => Boolean(window.karaokeRemoteManagement), undefined, { timeout: 20000 })
    await managementPage.evaluate(() => {
      window.__kqG5ConnectionTrace = []
      window.__kqG5ConnectionTraceUnsubscribe = window.karaokeRemoteManagement.onSnapshot(snapshot => {
        window.__kqG5ConnectionTrace.push({ at: Math.round(performance.now()), revision: snapshot.revision,
          connections: snapshot.connections.filter(item => item.deviceRole === 'player')
            .map(item => ({ deviceId: item.deviceId, state: item.state,
              reconciled: item.reconciled, reason: item.reason })) })
      })
    })
    const managementContinueButton = managementPage.locator('#btn-startup-primary')
    if (await managementContinueButton.isVisible().catch(() => false)) await managementContinueButton.click()
    await managementPage.locator('#form-entry').waitFor({ state: 'visible', timeout: 20000 })
    await waitForPageCondition(managementPage, async ({ id, playerId }) => {
      const snapshot = await window.karaokeRemoteManagement.getSnapshot()
      const matches = snapshot.operations.filter(operation => operation.operationId === id)
      const connection = snapshot.connections.find(item => item.deviceRole === 'player' && item.deviceId === playerId)
      return matches.length === 1 && matches[0].playerId === playerId && matches[0].status === 'unknown' &&
        connection?.state === 'synchronized' && connection.reconciled === true
    }, { id: restartQueryOperationId, playerId: pairedPlayer.playerId },
    { timeout: 60000, label: 'unknown-operation-and-saved-peer-restored-after-management-restart' })

    const replayedCommandCount = await playerApp.evaluate(() =>
      globalThis.__kqG5CommandObservation.count())
    assert.equal(replayedCommandCount, 0,
      'Management restart and G4 reconciliation never transmit the uncertain command again')

    if (!(await managementPage.locator('#remote-devices-root .remote-device-panel').isVisible().catch(() => false))) {
      await managementPage.locator('#btn-devices').click()
    }
    deviceCard = managementPage.locator(`[data-saved-player-id="${pairedPlayer.playerId}"]`)
    const restoredRestartQueryCard = managementPage.locator('#remote-devices-root .remote-operation-list .remote-device-card' +
      `[data-player-id="${pairedPlayer.playerId}"][data-operation-id="${restartQueryOperationId}"]`)
    await restoredRestartQueryCard.waitFor({ state: 'visible', timeout: 10000 })
    assert.equal(await restoredRestartQueryCard.count(), 1,
      'the same persisted operation identity is rendered exactly once after Management restart')
    assert.equal(await restoredRestartQueryCard.getAttribute('data-operation-id'), restartQueryOperationId)
    assert.equal(await restoredRestartQueryCard.getAttribute('data-player-id'), pairedPlayer.playerId)
    assert.equal(await restoredRestartQueryCard.locator('[data-action="query-operation"]').count(), 1,
      'an unknown operation remains explicitly queryable after process restart')
    assert.equal(await restoredRestartQueryCard.getByRole('button', { name: 'Consultar estado' }).isEnabled(), true)
    assert.equal(await restoredRestartQueryCard.getByRole('button', { name: 'Consultando…' }).count(), 0,
      'restart clears only the transient query spinner and leaves the durable unknown record intact')

    markStage('binding-removal-and-player-revocation')
    const savedBeforeRemoval = await managementPage.evaluate(() => window.karaokeRemoteManagement.getSnapshot())
    const savedDevice = savedBeforeRemoval.savedDevices.find(device => device.status === 'active')
    assert.ok(savedDevice, 'the Management binding remains saved after Player restart and G4 reconnection')
    const savedDeviceCard = deviceCard.filter({ hasText: `Player salvo · ${savedDevice.playerId.slice(0, 8)}` })
    markStage('local-removal-persistence-failure-ui')
    const beforeFailedRemoval = fs.readFileSync(path.join(management.userData, 'remote-authorization.json'), 'utf8')
    await managementApp.evaluate(async ({ app }) => {
      const moduleApi = process.getBuiltinModule('node:module')
      const path = process.getBuiltinModule('node:path')
      const req = moduleApi.createRequire(path.join(app.getAppPath(), 'package.json'))
      const nativeFs = req('node:fs/promises')
      const target = path.join(app.getPath('userData'), 'remote-authorization.json')
      const original = nativeFs.rename
      nativeFs.rename = async function (source, destination) {
        if (String(destination) === target) throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
        return original.apply(this, arguments)
      }
      globalThis.__kqRestorePairingWrite = () => { nativeFs.rename = original }
    })
    await savedDeviceCard.getByRole('button', { name: 'Remover desta Gestão' }).click()
    await managementPage.getByRole('alertdialog', { name: 'Remover deste computador?' })
      .getByRole('button', { name: 'Remover localmente' }).click()
    await managementPage.locator('#remote-devices-root .remote-inline-state--error').waitFor({ state: 'visible', timeout: 10000 })
    assert.equal(fs.readFileSync(path.join(management.userData, 'remote-authorization.json'), 'utf8'), beforeFailedRemoval,
      'failed atomic G2 write preserves all durable authorization evidence byte-for-byte')
    assert.equal((await managementPage.evaluate(() => window.karaokeRemoteManagement.getSnapshot())).savedDevices
      .find(device => device.playerId === savedDevice.playerId)?.status, 'active',
      'failed persistence never publishes revoked authority through IPC')
    await managementApp.evaluate(() => globalThis.__kqRestorePairingWrite())
    if (process.env.KQ_G5_BLOCKED_ONLY === '1') {
      await managementApp.evaluate(({ app }) => {
        const moduleApi = process.getBuiltinModule('node:module')
        const pathApi = process.getBuiltinModule('node:path')
        const req = moduleApi.createRequire(pathApi.join(app.getAppPath(), 'package.json'))
        const proto = req('./build/src/remote-operational-client.js').RemoteOperationalClient.prototype
        const original = proto.close
        proto.close = async function () {
          proto.close = original
          throw new Error('G5_TEST_CHANNEL_CLOSE_FAILED')
        }
      })
    }
    await savedDeviceCard.getByRole('button', { name: 'Remover desta Gestão' }).click()
    const removeConfirmation = managementPage.getByRole('alertdialog', { name: 'Remover deste computador?' })
    await removeConfirmation.waitFor({ state: 'visible', timeout: 10000 })
    await removeConfirmation.getByText(/Remoção local não confirma revogação remota/).waitFor({ state: 'visible' })
    await removeConfirmation.getByRole('button', { name: 'Remover localmente' }).click()
    if (process.env.KQ_G5_BLOCKED_ONLY === '1') {
      await waitForPageCondition(managementPage, async playerId => {
        const snapshot = await window.karaokeRemoteManagement.getSnapshot()
        const connection = snapshot.connections.find(item => item.deviceId === playerId)
        const card = document.querySelector(`[data-saved-player-id="${playerId}"]`)
        return connection?.state === 'blocked' && !connection.reconciled &&
          card?.querySelector('[data-connection-state]')?.getAttribute('data-connection-state') === 'blocked' &&
          snapshot.savedDevices.find(item => item.playerId === playerId)?.status === 'revoked'
      }, savedDevice.playerId, { timeout: 10000, label: 'real-close-failure-blocked-main-ipc-dom' })
      await closeElectronTestAppNormally(managementApp, 'management')
      managementApp = await launch(management)
      managementPage = await managementApp.firstWindow()
      await managementPage.waitForFunction(() => Boolean(window.karaokeRemoteManagement))
      const persistedBlock = await managementPage.evaluate(() => window.karaokeRemoteManagement.getSnapshot())
      assert.equal(persistedBlock.savedDevices.find(item => item.playerId === savedDevice.playerId)?.status, 'revoked')
      assert.equal(persistedBlock.connections.some(item => item.deviceId === savedDevice.playerId &&
        ['authorized', 'reconciling', 'synchronized'].includes(item.state)), false,
        'restart preserves durable revocation rather than automatically authorizing a peer whose channel close failed')
      console.log('PASS G5 blocked channel close reaches Main/IPC/DOM; durable revocation fences restart')
      return
    }
    await managementPage.getByText('Vínculo removido somente nesta Gestão. A revogação no Player não foi confirmada.',
      { exact: true }).waitFor({ state: 'visible', timeout: 10000 })
    const managementAfterRemoval = await managementPage.evaluate(() => window.karaokeRemoteManagement.getSnapshot())
    assert.equal(managementAfterRemoval.savedDevices.find(device => device.playerId === savedDevice.playerId)?.status,
      'revoked', 'Management records local removal without claiming Player revocation')
    assert.equal((await playerPage.evaluate(() => window.karaokeRemotePlayer.getSnapshot())).playerPairing,
      'active', 'removing the Management binding alone leaves Player authority active')

    await playerPage.locator('#remote-player-revoke').click()
    const playerRevokeConfirmation = playerPage.getByRole('alertdialog', { name: 'Revogar acesso deste Player?' })
    await playerRevokeConfirmation.waitFor({ state: 'visible', timeout: 10000 })
    await playerRevokeConfirmation.getByRole('button', { name: 'Revogar vínculo' }).click()
    const revocationToast = playerPage.locator('#remote-player-action-toast')
    await revocationToast.waitFor({ state: 'visible', timeout: 10000 })
    assert.equal((await revocationToast.innerText()).trim(),
      'Vínculo revogado localmente. O Player continua funcionando.',
      'the Player presents local revocation without overwriting the live discovery state')
    assert.equal(await playerPage.locator('#remote-player-connection-status').innerText(), 'DESCOBERTA ATIVA')
    await waitForPageCondition(playerPage, async () => {
      const snapshot = await window.karaokeRemotePlayer.getSnapshot()
      return snapshot.playerPairing === 'revoked' &&
        !snapshot.connections.some(item => item.deviceRole === 'controller' && item.state === 'authorized')
    }, undefined, { timeout: 10000 })

  } catch (error) {
    const errorName = error instanceof Error ? error.name : 'UnknownError'
    const errorText = error instanceof Error ? error.message : String(error)
    const errorCode = errorText.match(/\b[A-Z][A-Z0-9_]{2,}\b/)?.[0] ?? null
    const diagnostic: Record<string, unknown> = {
      stage: currentStage, occurredAt: new Date().toISOString(), errorName, errorCode,
      errorMessage: safeAssertionValue(errorText),
      assertion: errorName === 'AssertionError' ? {
        operator: typeof error.operator === 'string' ? error.operator.slice(0, 20) : null,
        actual: safeAssertionValue(error.actual), expected: safeAssertionValue(error.expected),
        message: safeAssertionValue(error.message)
      } : null
    }
    if (currentStage.includes('restart')) {
      diagnostic.reconnectBaseline = reconnectBaseline ?? null
      diagnostic.reconnectWaitEvidence = reconnectWaitEvidence ?? null
    }
    if (currentStage.startsWith('management-restart-during-active-operation-query')) {
      diagnostic.managementCloseChoice = await managementApp?.evaluate(() =>
        globalThis.__kqG5ManagementCloseChoice?.getObservation() ?? null).catch(() => null)
    }
    if (currentStage.startsWith('recovery-')) {
      const [playerRecovery, managementRecovery] = await Promise.all([
        playerPage?.evaluate(async () => {
          const snapshot = await window.karaokeRemotePlayer.getSnapshot().catch(() => null)
          return { revision: snapshot?.revision ?? null, intent: snapshot?.intent ?? null,
            listener: snapshot?.listener ?? null, pairing: snapshot?.playerPairing ?? null,
            errorCode: snapshot?.errorCode ?? null,
            connections: snapshot?.connections.filter(item => item.deviceRole === 'controller')
              .map(item => ({ state: item.state, reconciled: item.reconciled, reason: item.reason })) ?? null }
        }).catch(() => null),
        managementPage?.evaluate(async () => {
          const snapshot = await window.karaokeRemoteManagement.getSnapshot().catch(() => null)
          return { revision: snapshot?.revision ?? null, errorCode: snapshot?.errorCode ?? null,
            connections: snapshot?.connections.filter(item => item.deviceRole === 'player')
              .map(item => ({ deviceId: item.deviceId, state: item.state, reconciled: item.reconciled,
                reason: item.reason })) ?? null,
            trace: (window.__kqG5ConnectionTrace ?? []).slice(-12) }
        }).catch(() => null)
      ])
      diagnostic.abruptRestartObservation = { player: playerRecovery, management: managementRecovery }
    }
    if (currentStage.startsWith('pairing-three-attempt-lockout-ui')) {
      diagnostic.lockoutAttemptTrace = lockoutAttemptTrace
      diagnostic.lockoutObservation = await readLockoutUiObservation(
        playerPage, managementPage, activeLockoutRequestId, player.userData, management.userData).catch(() => null)
    }
    if (currentStage === 'rendered-connection-after-normal-restart') {
      const [managementState, playerState, proxyState] = await Promise.all([
        managementPage?.evaluate(async () => {
          const snapshot = await window.karaokeRemoteManagement.getSnapshot().catch(() => null)
          const card = document.querySelector('#remote-devices-root .remote-device-card [data-connection-state]')
          return {
            connections: snapshot?.connections.filter(item => item.deviceRole === 'player')
              .map(item => ({ state: item.state, reconciled: item.reconciled, reason: item.reason })) ?? null,
            renderedState: card?.getAttribute('data-connection-state') ?? null,
            lastPollingObservation: window.__kqG5CardObservation ?? null,
            trace: (window.__kqG5ConnectionTrace ?? []).slice(-20).map(item => ({
              revision: item.revision,
              connections: (item.connections ?? []).map(connection => ({
                state: connection.state, reconciled: connection.reconciled, reason: connection.reason
              }))
            }))
          }
        }).catch(() => null),
        playerPage?.evaluate(async () => {
          const snapshot = await window.karaokeRemotePlayer.getSnapshot().catch(() => null)
          return {
            intent: snapshot?.intent ?? null, listener: snapshot?.listener ?? null,
            pairing: snapshot?.playerPairing ?? null,
            controllers: snapshot?.connections.filter(item => item.deviceRole === 'controller')
              .map(item => ({ state: item.state, reconciled: item.reconciled, reason: item.reason })) ?? null,
            trace: (window.__kqG5ConnectionTrace ?? []).slice(-20).map(item => ({
              revision: item.revision,
              connections: (item.connections ?? []).map(connection => ({
                state: connection.state, reconciled: connection.reconciled, reason: connection.reason
              }))
            }))
          }
        }).catch(() => null),
        managementApp?.evaluate(() => globalThis.__kqG5TransportFaultProxy?.getDiagnostics() ?? null)
          .catch(() => null)
      ])
      diagnostic.connectionFailure = { management: managementState, player: playerState, proxy: proxyState }
    }
    try {
      const diagnosticPath = path.join(os.tmpdir(), `${diagnosticPrefix()}-g5-failure.json`)
      fs.writeFileSync(diagnosticPath, JSON.stringify(diagnostic) + '\n', { flag: 'wx' })
      preserveSanitizedFailureLogs(player, management)
    } catch { /* the functional failure remains primary if the optional diagnostic cannot be stored */ }
    console.error('G5_E2E_FAILURE', JSON.stringify(diagnostic))
    throw error
    }
  }, async () => {
    if (playerApp) {
      await playerApp.evaluate(() => globalThis.__kqG5PreparedPairingResponseHold?.release()).catch(() => undefined)
    }
    if (managementApp) {
      await managementApp.evaluate(() => globalThis.__kqG5OperationResponseHold?.release()).catch(() => undefined)
    }
    if (faultProxyOwner && faultProxyStarted) {
      await faultProxyOwner.evaluate(() => globalThis.__kqG5TransportFaultProxy?.close()).catch(() => undefined)
    }
    await dismissPairingDialogsBeforeExit(playerPage, managementPage).catch(() => undefined)
    const cleanupErrors = []
    for (const [app, role] of [[playerApp, 'player'], [managementApp, 'management']]) {
      if (!app) continue
      try { await withElectronTestDeadline(closeElectronTestAppNormally(app, role), `${role}:whole-cleanup`, 30_000) }
      catch { cleanupErrors.push('ELECTRON_TEST_NORMAL_EXIT_FAILED') }
    }
    if (cleanupErrors.length) {
      console.error('G5 Electron cleanup failed; isolated profile retained for runner residual-process inspection:', cleanupErrors.join(','))
      throw new Error('G5_ELECTRON_CLEANUP_INCOMPLETE')
    }
    fs.rmSync(profileRoot, { recursive: true, force: true })
    fs.rmSync(stageDiagnosticPath(), { force: true })
  })
}

run().catch(error => {
  // Assertion details can contain the temporary code; emit only the sanitized classification above.
  process.exitCode = 1
  if (error?.message === 'G5_ELECTRON_CLEANUP_INCOMPLETE') {
    // End the automation harness after its bounded normal-exit attempt; leave any residual Electron process
    // visible to the official runner's residual-process gate instead of waiting indefinitely or killing it.
    process.exit(1)
  }
  terminateElectronTestHarnessAfterCleanupFailure(error)
})
