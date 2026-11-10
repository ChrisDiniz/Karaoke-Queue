import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createInitialStandalonePlayerSnapshot,
  type StandalonePlayerCommandRequest,
  type StandalonePlayerCommandResult,
  type StandalonePlayerControl
} from '../src/standalone-player-contracts'
import {
  StandalonePlayerInteractionController,
  type StandaloneInteractionScheduler,
  type StandalonePlayerInteractionIntent
} from '../src/standalone-player-interaction'
import {
  interpretStandaloneKeyboardStroke,
  type StandaloneKeyboardStroke
} from '../src/standalone-player-keyboard'

interface FakeTimer {
  readonly callback: () => void
  readonly delayMs: number
  cancelled: boolean
}

class FakeScheduler implements StandaloneInteractionScheduler {
  readonly timers: FakeTimer[] = []

  schedule(callback: () => void, delayMs: number): FakeTimer {
    const timer = { callback, delayMs, cancelled: false }
    this.timers.push(timer)
    return timer
  }

  cancel(handle: unknown): void {
    assert.ok(handle && typeof handle === 'object' && 'cancelled' in handle)
    ;(handle as FakeTimer).cancelled = true
  }

  latest(): FakeTimer {
    const timer = this.timers.at(-1)
    assert.ok(timer)
    return timer
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function build(timeoutMs = 5_000) {
  const scheduler = new FakeScheduler()
  let operationNumber = 0
  const controller = new StandalonePlayerInteractionController({
    scheduler,
    digitPanelInactivityMs: timeoutMs,
    createOperationId: () => `b2-operation-${++operationNumber}`
  })
  return { controller, scheduler, get operationNumber() { return operationNumber } }
}

function stroke(controller: StandalonePlayerInteractionController, key: string,
  options: Omit<StandaloneKeyboardStroke, 'key'> = {}): StandalonePlayerInteractionIntent | undefined {
  return controller.handleKeyStroke({ key, ...options })
}

function playerCommand(intent: StandalonePlayerInteractionIntent | undefined): StandalonePlayerCommandRequest {
  assert.ok(intent)
  assert.equal(intent.type, 'player-command')
  if (intent.type !== 'player-command') throw new Error('Expected a B1 player command intent')
  return intent.request
}

function typeDigits(controller: StandalonePlayerInteractionController, digits: string): void {
  for (const digit of digits) stroke(controller, digit)
}

test('the first digit opens the numeric panel and is inserted', () => {
  const { controller, scheduler } = build()
  stroke(controller, '7')
  assert.deepEqual(controller.getSnapshot(), { numericPanelOpen: true, enteredCode: '7', menuScreen: 'closed' })
  assert.equal(scheduler.latest().delayMs, 5_000)
  controller.dispose()
})

test('digits are preserved in entry order, including numeric keypad keys', () => {
  const { controller } = build()
  stroke(controller, '1', { code: 'Digit1' })
  stroke(controller, '2', { code: 'Numpad2' })
  stroke(controller, '3', { code: 'Digit3' })
  assert.equal(controller.getSnapshot().enteredCode, '123')
  controller.dispose()
})

test('C2 entry scope uses the shared B2 parser and submits only Enter/P without enabling other playback commands', () => {
  const fixture = build(5_000)
  const { controller } = fixture
  assert.equal(controller.handleEntryKeyStroke({ key: 'End', code: 'Numpad1' }).recognized, true)
  assert.equal(controller.handleEntryKeyStroke({ key: '0' }).recognized, true)
  assert.equal(controller.handleEntryKeyStroke({ key: 'Enter' }).intent, undefined)
  assert.equal(controller.handleEntryKeyStroke({ key: 'p' }).intent, undefined)
  assert.equal(controller.handleEntryKeyStroke({ key: ' ' }).recognized, true)
  assert.equal(controller.handleEntryKeyStroke({ key: 'ArrowRight', ctrlKey: true }).recognized, true)
  assert.equal(controller.handleEntryKeyStroke({ key: 'S' }).recognized, false)
  assert.deepEqual(controller.getSnapshot(), {
    numericPanelOpen: true,
    enteredCode: '10',
    menuScreen: 'closed'
  })
  assert.equal(fixture.operationNumber, 0)
  assert.equal(fixture.scheduler.latest().delayMs, 5_000)
  assert.equal(controller.handleEntryKeyStroke({ key: 'Escape' }).recognized, true)
  assert.deepEqual(controller.getSnapshot(), { numericPanelOpen: false, enteredCode: '', menuScreen: 'closed' })
  assert.equal(controller.handleEntryKeyStroke({ key: 'Escape' }).recognized, true)
  assert.equal(controller.getSnapshot().menuScreen, 'main', 'a second Esc opens the C7 menu after numeric entry closes.')
  assert.equal(controller.handleEntryKeyStroke({ key: 'Escape' }).recognized, true)
  assert.equal(controller.getSnapshot().menuScreen, 'closed', 'Esc closes the main menu.')
  controller.dispose()
})

test('C2 entry scope emits normal and priority submissions only when enabled by the Renderer state', () => {
  const { controller } = build()
  typeDigits(controller, '1001')
  const normal = controller.handleEntryKeyStroke({ key: 'Enter' }, true).intent
  assert.ok(normal && normal.type === 'player-command')
  assert.deepEqual(normal.request.command, { type: 'submit-code', enteredCode: '1001', priority: 'normal' })

  typeDigits(controller, '1002')
  const priority = controller.handleEntryKeyStroke({ key: 'P' }, true).intent
  assert.ok(priority && priority.type === 'player-command')
  assert.deepEqual(priority.request.command, { type: 'submit-code', enteredCode: '1002', priority: 'priority' })
  assert.notEqual(normal.request.operationId, priority.request.operationId)
  assert.equal(controller.getSnapshot().enteredCode, '')
  controller.dispose()
})

test('C5 entry scope emits Next and Restart only when the authoritative playback is stable', () => {
  const { controller } = build()
  const countdownNext = controller.handleEntryKeyStroke({ key: 'ArrowRight', ctrlKey: true }, false, true, false, true)
  assert.equal(countdownNext.recognized, true)
  assert.equal(countdownNext.intent, undefined, 'countdown/celebration keep their own timer command scope.')
  const loadingRestart = controller.handleEntryKeyStroke({ key: 'R' })
  assert.equal(loadingRestart.intent, undefined, 'C1-C4 callers do not enable the C5 playback command scope by default.')
  const next = controller.handleEntryKeyStroke({ key: 'ArrowRight', ctrlKey: true }, false, false, false, true)
  assert.equal(next.intent?.type, 'player-command')
  if (next.intent?.type === 'player-command') assert.deepEqual(next.intent.request.command, { type: 'next' })
  const restart = controller.handleEntryKeyStroke({ key: 'R' }, false, false, false, true)
  assert.equal(restart.intent?.type, 'player-command')
  if (restart.intent?.type === 'player-command') assert.deepEqual(restart.intent.request.command, { type: 'restart' })
  controller.dispose()
})

test('countdown scope maps Space to the existing pause command without enabling playback controls or submissions', () => {
  const { controller } = build()
  typeDigits(controller, '1001')
  const paused = controller.handleEntryKeyStroke({ key: ' ' }, false, true)
  assert.equal(paused.recognized, true)
  assert.ok(paused.intent && paused.intent.type === 'player-command')
  if (paused.intent?.type === 'player-command') assert.deepEqual(paused.intent.request.command, { type: 'toggle-pause' })
  assert.equal(controller.getSnapshot().enteredCode, '1001')
  const blockedSubmission = controller.handleEntryKeyStroke({ key: 'Enter' }, false, true)
  assert.equal(blockedSubmission.recognized, true)
  assert.equal(blockedSubmission.intent, undefined)
  const blockedNext = controller.handleEntryKeyStroke({ key: 'ArrowRight', ctrlKey: true }, false, true)
  assert.equal(blockedNext.recognized, true)
  assert.equal(blockedNext.intent, undefined)
  controller.dispose()
})

test('the code accepts at most five digits and does not pad leading zeroes', () => {
  const { controller } = build()
  typeDigits(controller, '123456')
  assert.equal(controller.getSnapshot().enteredCode, '12345')
  const request = playerCommand(stroke(controller, 'Enter'))
  assert.deepEqual(request.command, { type: 'submit-code', enteredCode: '12345', priority: 'normal' })
  controller.dispose()

  const shortCode = build()
  typeDigits(shortCode.controller, '123')
  const shortRequest = playerCommand(stroke(shortCode.controller, 'Enter'))
  assert.deepEqual(shortRequest.command, { type: 'submit-code', enteredCode: '123', priority: 'normal' })
  shortCode.controller.dispose()
})

test('Backspace removes exactly one digit at a time', () => {
  const { controller } = build()
  typeDigits(controller, '123')
  stroke(controller, 'Backspace')
  assert.equal(controller.getSnapshot().enteredCode, '12')
  stroke(controller, 'Backspace')
  assert.equal(controller.getSnapshot().enteredCode, '1')
  controller.dispose()
})

test('Backspace with the panel closed has no effect', () => {
  const { controller, scheduler } = build()
  stroke(controller, 'Backspace')
  assert.deepEqual(controller.getSnapshot(), { numericPanelOpen: false, enteredCode: '', menuScreen: 'closed' })
  assert.equal(scheduler.timers.length, 0)
  controller.dispose()
})

test('Enter creates one normal-add request and clears the code while keeping the panel open', () => {
  const { controller } = build()
  typeDigits(controller, '1001')
  const request = playerCommand(stroke(controller, 'Enter'))
  assert.deepEqual(request.command, { type: 'submit-code', enteredCode: '1001', priority: 'normal' })
  assert.deepEqual(controller.getSnapshot(), {
    numericPanelOpen: true, enteredCode: '', menuScreen: 'closed',
    lastSubmission: { operationId: request.operationId, enteredCode: '1001', priority: 'normal', outcome: 'pending' }
  })
  controller.dispose()
})

test('P creates a priority request', () => {
  const { controller } = build()
  typeDigits(controller, '1111')
  const request = playerCommand(stroke(controller, 'p'))
  assert.deepEqual(request.command, { type: 'submit-code', enteredCode: '1111', priority: 'priority' })
  controller.dispose()
})

test('Enter and P with empty input do not create operation IDs or command intents', () => {
  const fixture = build()
  const { controller } = fixture
  typeDigits(controller, '8')
  stroke(controller, 'Backspace')
  assert.equal(stroke(controller, 'Enter'), undefined)
  assert.equal(stroke(controller, 'P'), undefined)
  assert.equal(fixture.operationNumber, 0)
  controller.dispose()
})

test('the panel remains open after confirmation and accepts another code immediately', () => {
  const { controller } = build()
  typeDigits(controller, '1001')
  const first = playerCommand(stroke(controller, 'Enter'))
  assert.equal(controller.getSnapshot().numericPanelOpen, true)
  typeDigits(controller, '2002')
  const second = playerCommand(stroke(controller, 'P'))
  assert.deepEqual(first.command, { type: 'submit-code', enteredCode: '1001', priority: 'normal' })
  assert.deepEqual(second.command, { type: 'submit-code', enteredCode: '2002', priority: 'priority' })
  assert.notEqual(first.operationId, second.operationId)
  assert.equal(controller.getSnapshot().enteredCode, '')
  controller.dispose()
})

test('the numeric panel expires after the configured inactivity interval', () => {
  const { controller, scheduler } = build(7_500)
  stroke(controller, '4')
  const timer = scheduler.latest()
  assert.equal(timer.delayMs, 7_500)
  timer.callback()
  assert.deepEqual(controller.getSnapshot(), { numericPanelOpen: false, enteredCode: '', menuScreen: 'closed' })
  controller.dispose()
})

test('each interaction resets inactivity and an already queued stale timeout is ignored', () => {
  const { controller, scheduler } = build(2_000)
  stroke(controller, '1')
  const staleTimer = scheduler.latest()
  stroke(controller, '2')
  const currentTimer = scheduler.latest()
  assert.equal(staleTimer.cancelled, true)
  staleTimer.callback()
  assert.deepEqual(controller.getSnapshot(), { numericPanelOpen: true, enteredCode: '12', menuScreen: 'closed' })
  assert.equal(currentTimer.delayMs, 2_000)
  currentTimer.callback()
  assert.equal(controller.getSnapshot().numericPanelOpen, false)
  controller.dispose()
})

test('Esc closes the numeric panel and discards the current code', () => {
  const { controller } = build()
  typeDigits(controller, '123')
  stroke(controller, 'Escape')
  assert.deepEqual(controller.getSnapshot(), { numericPanelOpen: false, enteredCode: '', menuScreen: 'closed' })
  controller.dispose()
})

test('closing numeric entry on idle-to-playing cancels its timer and prevents a late rejection from restoring input', () => {
  const { controller, scheduler } = build()
  typeDigits(controller, '1001')
  const intent = stroke(controller, 'Enter')
  const request = playerCommand(intent)
  assert.equal(controller.getSnapshot().numericPanelOpen, true)
  const pendingTimer = scheduler.latest()

  controller.closeNumericEntry()

  assert.deepEqual(controller.getSnapshot(), { numericPanelOpen: false, enteredCode: '', menuScreen: 'closed',
    lastSubmission: { operationId: request.operationId, enteredCode: '1001', priority: 'normal', outcome: 'pending' } })
  assert.equal(pendingTimer.cancelled, true)
  controller.applyCommandOutcome({ operationId: request.operationId, outcome: 'rejected', errorCode: 'INVALID_STATE' })
  assert.deepEqual(controller.getSnapshot(), { numericPanelOpen: false, enteredCode: '', menuScreen: 'closed',
    lastSubmission: { operationId: request.operationId, enteredCode: '1001', priority: 'normal', outcome: 'rejected', errorCode: 'INVALID_STATE' } })
  controller.dispose()
})

test('Esc opens the main menu only when no panel or menu is open, then closes it', () => {
  const { controller } = build()
  stroke(controller, 'Escape')
  assert.equal(controller.getSnapshot().menuScreen, 'main')
  stroke(controller, 'Escape')
  assert.equal(controller.getSnapshot().menuScreen, 'closed')
  controller.dispose()
})

test('Esc closes hidden code entry and opens the menu during countdown or celebration', () => {
  const { controller, scheduler } = build()
  stroke(controller, '1')
  const entryTimer = scheduler.latest()

  const result = controller.handleEntryKeyStroke(
    { key: 'Escape' }, false, true, false, false, false, true
  )

  assert.equal(result.recognized, true)
  assert.equal(result.intent, undefined)
  assert.deepEqual(controller.getSnapshot(), {
    numericPanelOpen: false,
    enteredCode: '',
    menuScreen: 'main'
  })
  assert.equal(entryTimer.cancelled, true, 'closing the hidden numeric panel cancels its local inactivity timer.')
  controller.dispose()
})

test('Esc from a submenu returns to the main menu', () => {
  const { controller } = build()
  stroke(controller, 'Escape')
  controller.selectMenuAction('commands')
  assert.equal(controller.getSnapshot().menuScreen, 'commands')
  stroke(controller, 'Escape')
  assert.equal(controller.getSnapshot().menuScreen, 'main')
  controller.dispose()
})

test('menu actions expose commands, options, Back, and exit confirmation states', () => {
  const { controller } = build()
  stroke(controller, 'Escape')
  controller.selectMenuAction('commands')
  assert.equal(controller.getSnapshot().menuScreen, 'commands')
  controller.selectMenuAction('back')
  controller.selectMenuAction('options')
  assert.equal(controller.getSnapshot().menuScreen, 'options')
  controller.selectMenuAction('back')
  controller.selectMenuAction('exit')
  assert.equal(controller.getSnapshot().menuScreen, 'exit-confirmation')
  controller.dispose()
})

test('Back from the main menu returns to playback state without an exit request', () => {
  const { controller } = build()
  stroke(controller, 'Escape')
  controller.selectMenuAction('back')
  assert.equal(controller.getSnapshot().menuScreen, 'closed')
  controller.dispose()
})

test('exit confirmation can be canceled or emits only an exit intent after confirmation', () => {
  const { controller } = build()
  stroke(controller, 'Escape')
  controller.selectMenuAction('exit')
  assert.equal(controller.resolveExitConfirmation(false), undefined)
  assert.equal(controller.getSnapshot().menuScreen, 'main')
  controller.selectMenuAction('exit')
  const intent = controller.resolveExitConfirmation(true)
  assert.deepEqual(intent, { type: 'request-application-exit' })
  assert.equal(controller.getSnapshot().menuScreen, 'closed')
  assert.equal(controller.resolveExitConfirmation(true), undefined,
    'a repeated confirmation cannot emit a second application-exit intent.')
  controller.dispose()
})

test('a Main-originated close confirmation restores the screen that was open before the request', () => {
  const closed = build().controller
  closed.showExitConfirmation()
  assert.equal(closed.getSnapshot().menuScreen, 'exit-confirmation')
  assert.equal(closed.resolveExitConfirmation(false, 'closed'), undefined)
  assert.equal(closed.getSnapshot().menuScreen, 'closed')
  closed.dispose()

  const options = build().controller
  stroke(options, 'Escape')
  options.selectMenuAction('options')
  options.showExitConfirmation()
  assert.equal(options.resolveExitConfirmation(false, 'options'), undefined)
  assert.equal(options.getSnapshot().menuScreen, 'options')
  options.dispose()
})

test('Escape from exit confirmation returns to the main menu and other Player shortcuts are consumed', () => {
  const { controller, operationNumber } = build()
  stroke(controller, 'Escape')
  controller.selectMenuAction('exit')

  for (const key of ['5', 'P', 'Enter', ' ', 'R', 'Backspace', 'i']) {
    assert.equal(stroke(controller, key), undefined, `${key} does not create a Player action under exit confirmation.`)
  }
  assert.equal(controller.getSnapshot().menuScreen, 'exit-confirmation')
  assert.equal(controller.getSnapshot().numericPanelOpen, false)
  assert.equal(operationNumber, 0)

  stroke(controller, 'Escape')
  assert.equal(controller.getSnapshot().menuScreen, 'main', 'the first Esc cancels the topmost confirmation.')
  assert.equal(controller.getSnapshot().numericPanelOpen, false)
  assert.equal(operationNumber, 0)
  controller.dispose()
})

test('while a menu is open, keyboard playback and code-entry shortcuts are ignored', () => {
  const fixture = build()
  const { controller } = fixture
  stroke(controller, 'Escape')
  controller.selectMenuAction('options')
  for (const key of ['1', 'Enter', 'P', ' ', 'R', 'Backspace']) assert.equal(stroke(controller, key), undefined)
  assert.equal(stroke(controller, 'ArrowRight', { ctrlKey: true }), undefined)
  assert.equal(stroke(controller, ' ', { ctrlKey: true }), undefined)
  assert.equal(stroke(controller, 'i'), undefined)
  assert.equal(controller.getSnapshot().menuScreen, 'options')
  assert.equal(controller.getSnapshot().enteredCode, '')
  assert.equal(fixture.operationNumber, 0)
  controller.dispose()
})

test('I is owned by the current-track panel only during confirmed playback and Esc closes it first', () => {
  const { controller } = build()
  assert.deepEqual(controller.handleEntryKeyStroke({ key: 'i' }, false, false, false, true).intent,
    { type: 'show-current-track-info' })
  assert.deepEqual(controller.handleEntryKeyStroke({ key: 'I' }, false, false, false, true).intent,
    { type: 'show-current-track-info' }, 'uppercase and lowercase I share the B2 keyboard parser.')
  assert.deepEqual(controller.handleEntryKeyStroke({ key: 'i' }), { recognized: true },
    'idle, countdown, loading, celebration, and unavailable states consume I without opening a panel.')
  assert.deepEqual(controller.handleEntryKeyStroke({ key: 'Escape' }, false, false, false, true, true).intent,
    { type: 'close-current-track-info' }, 'Esc closes the information panel before it can open the menu.')
  assert.equal(controller.getSnapshot().menuScreen, 'closed')
  controller.dispose()
})

test('I does not take ownership from numeric entry, stop confirmation, or an open menu', () => {
  const { controller } = build()
  controller.handleEntryKeyStroke({ key: '1' }, false, false, false, true)
  assert.deepEqual(controller.handleEntryKeyStroke({ key: 'i' }, false, false, false, true), { recognized: true })
  assert.equal(controller.getSnapshot().enteredCode, '1')

  const modal = controller.handleEntryKeyStroke({ key: ' ', ctrlKey: true }, false, false, false, true)
  assert.equal(modal.intent?.type, 'open-stop-confirmation')
  assert.deepEqual(controller.handleEntryKeyStroke({ key: 'i' }, false, false, true, true), { recognized: true })

  controller.handleEntryKeyStroke({ key: 'Escape' }, false, false, true, true)
  controller.handleEntryKeyStroke({ key: 'Escape' }, false, false, false, true)
  controller.handleKeyStroke({ key: 'Escape' })
  controller.selectMenuAction('commands')
  assert.deepEqual(controller.handleEntryKeyStroke({ key: 'i' }, false, false, false, true), { recognized: true })
  assert.equal(controller.getSnapshot().menuScreen, 'commands')
  controller.dispose()
})

test('opening and interacting with menus does not issue a pause command', () => {
  const fixture = build()
  const { controller } = fixture
  stroke(controller, 'Escape')
  controller.selectMenuAction('commands')
  assert.equal(fixture.operationNumber, 0)
  assert.equal(controller.getSnapshot().menuScreen, 'commands')
  controller.dispose()
})

test('Space emits the B1 pause-toggle command', () => {
  const { controller } = build()
  assert.deepEqual(playerCommand(stroke(controller, ' ')).command, { type: 'toggle-pause' })
  controller.dispose()
})

test('Ctrl+Right emits Next and other arrow combinations are ignored', () => {
  const { controller } = build()
  assert.equal(stroke(controller, 'ArrowRight'), undefined)
  assert.equal(stroke(controller, 'ArrowLeft', { ctrlKey: true }), undefined)
  assert.deepEqual(playerCommand(stroke(controller, 'ArrowRight', { ctrlKey: true })).command, { type: 'next' })
  controller.dispose()
})

test('R emits Restart without depending on engine state', () => {
  const { controller } = build()
  assert.deepEqual(playerCommand(stroke(controller, 'r')).command, { type: 'restart' })
  controller.dispose()
})

test('unsupported modifier combinations are ignored while Ctrl+Space remains the approved confirmation shortcut', () => {
  const fixture = build()
  const { controller } = fixture
  for (const options of [
    { shiftKey: true }, { altKey: true }, { metaKey: true }
  ]) {
    assert.equal(stroke(controller, '2', options), undefined)
    assert.equal(stroke(controller, 'P', options), undefined)
    assert.equal(stroke(controller, 'R', options), undefined)
    assert.equal(stroke(controller, 'Enter', options), undefined)
    assert.equal(stroke(controller, ' ', options), undefined)
  }
  for (const key of ['2', 'P', 'R', 'Enter']) assert.equal(stroke(controller, key, { ctrlKey: true }), undefined)
  assert.deepEqual(stroke(controller, ' ', { ctrlKey: true }), { type: 'open-stop-confirmation' })
  assert.equal(fixture.operationNumber, 0)
  controller.dispose()
})

test('Ctrl+Right rejects additional modifiers', () => {
  const fixture = build()
  const { controller } = fixture
  assert.equal(stroke(controller, 'ArrowRight', { ctrlKey: true, shiftKey: true }), undefined)
  assert.equal(stroke(controller, 'ArrowRight', { ctrlKey: true, altKey: true }), undefined)
  assert.equal(stroke(controller, 'ArrowRight', { ctrlKey: true, metaKey: true }), undefined)
  assert.equal(fixture.operationNumber, 0)
  controller.dispose()
})

test('key repeat is ignored for digits and operational actions', () => {
  const fixture = build()
  const { controller } = fixture
  assert.equal(stroke(controller, '1', { repeat: true }), undefined)
  assert.equal(stroke(controller, 'Enter', { repeat: true }), undefined)
  assert.equal(stroke(controller, 'P', { repeat: true }), undefined)
  assert.equal(stroke(controller, ' ', { repeat: true }), undefined)
  assert.equal(stroke(controller, 'ArrowRight', { ctrlKey: true, repeat: true }), undefined)
  assert.equal(stroke(controller, 'R', { repeat: true }), undefined)
  assert.equal(controller.getSnapshot().numericPanelOpen, false)
  assert.equal(fixture.operationNumber, 0)
  controller.dispose()
})

test('separate non-repeat key presses remain separate intentional actions', () => {
  const { controller } = build()
  const first = playerCommand(stroke(controller, ' '))
  const second = playerCommand(stroke(controller, ' '))
  assert.notEqual(first.operationId, second.operationId)
  controller.dispose()
})

test('Ctrl+Space opens confirmation exactly once and does not emit pause or Stop All', () => {
  const { controller } = build()
  const opened = controller.handleEntryKeyStroke({ key: ' ', code: 'Space', ctrlKey: true }, true)
  assert.equal(opened.recognized, true)
  assert.deepEqual(opened.intent, { type: 'open-stop-confirmation' })
  const repeated = controller.handleEntryKeyStroke({ key: ' ', code: 'Space', ctrlKey: true, repeat: true }, true)
  assert.deepEqual(repeated, { recognized: false })
  assert.equal(controller.handleEntryKeyStroke({ key: ' ', code: 'Space', ctrlKey: true, shiftKey: true }, true).intent, undefined)
  assert.equal(controller.handleEntryKeyStroke({ key: ' ', code: 'Space', ctrlKey: true, altKey: true }, true).intent, undefined)
  assert.equal(controller.handleEntryKeyStroke({ key: ' ', code: 'Space', ctrlKey: true, metaKey: true }, true).intent, undefined)
  controller.dispose()
})

test('confirmation owns keyboard input; Esc cancels and Enter sends one identified Stop All command', () => {
  const { controller } = build()
  const opened = controller.handleEntryKeyStroke({ key: ' ', code: 'Space', ctrlKey: true }, true)
  assert.deepEqual(opened.intent, { type: 'open-stop-confirmation' })
  assert.deepEqual(controller.handleEntryKeyStroke({ key: ' ', code: 'Space' }, true, false, true), { recognized: true },
    'Space inside the modal cannot pause playback.')
  assert.deepEqual(controller.handleEntryKeyStroke({ key: 'Escape' }, true, false, true).intent,
    { type: 'close-stop-confirmation' })

  const reopened = controller.handleEntryKeyStroke({ key: ' ', code: 'Space', ctrlKey: true }, true)
  assert.deepEqual(reopened.intent, { type: 'open-stop-confirmation' })
  const confirmed = controller.handleEntryKeyStroke({ key: 'Enter' }, true, false, true)
  assert.equal(confirmed.recognized, true)
  assert.ok(confirmed.intent?.type === 'player-command')
  if (confirmed.intent?.type !== 'player-command') throw new Error('Expected Main-authoritative Stop All command.')
  assert.deepEqual(confirmed.intent.request.command, { type: 'stop-all' })
  const operationId = confirmed.intent.request.operationId
  assert.equal(controller.handleEntryKeyStroke({ key: 'Enter' }, true, false, true).intent, undefined,
    'a rapid duplicate confirmation is suppressed while its request is pending.')
  assert.deepEqual(controller.applyCommandOutcome({ operationId, outcome: 'uncertain', errorCode: 'COMMAND_TIMEOUT' }), undefined)
  const retry = controller.handleEntryKeyStroke({ key: 'Enter' }, true, false, true)
  assert.equal(retry.intent?.type, 'player-command')
  if (retry.intent?.type === 'player-command') assert.equal(retry.intent.request.operationId, operationId,
    'an uncertain retry reuses its original operationId.')
  controller.resetAfterStopAll()
  assert.equal(controller.getStopAllPending(), false)
  controller.dispose()
})

test('keyboard interpreter recognizes only V1 actions and keypad digits', () => {
  assert.deepEqual(interpretStandaloneKeyboardStroke({ key: '6', code: 'Numpad6' }), { type: 'digit', digit: '6' })
  assert.deepEqual(interpretStandaloneKeyboardStroke({ key: 'End', code: 'Numpad1' }), { type: 'digit', digit: '1' },
    'a physical Numpad digit remains usable when NumLock makes Chromium emit its navigation key value.')
  assert.equal(interpretStandaloneKeyboardStroke({ key: 'End', code: 'Numpad1', ctrlKey: true }), undefined,
    'modifier combinations do not turn navigation keypad keys into code digits.')
  assert.deepEqual(interpretStandaloneKeyboardStroke({ key: 'Enter' }), { type: 'confirm-normal' })
  assert.deepEqual(interpretStandaloneKeyboardStroke({ key: 'p' }), { type: 'confirm-priority' })
  assert.deepEqual(interpretStandaloneKeyboardStroke({ key: ' ' }), { type: 'toggle-pause' })
  assert.deepEqual(interpretStandaloneKeyboardStroke({ key: 'ArrowRight', ctrlKey: true }), { type: 'next' })
  assert.deepEqual(interpretStandaloneKeyboardStroke({ key: ' ', code: 'Space', ctrlKey: true }), { type: 'confirm-stop-all' })
  assert.equal(interpretStandaloneKeyboardStroke({ key: ' ', code: 'Space', ctrlKey: true, shiftKey: true }), undefined)
  assert.equal(interpretStandaloneKeyboardStroke({ key: ' ', code: 'Space', ctrlKey: true, repeat: true }), undefined)
  assert.deepEqual(interpretStandaloneKeyboardStroke({ key: 'R' }), { type: 'restart' })
  assert.deepEqual(interpretStandaloneKeyboardStroke({ key: 'i' }), { type: 'show-current-track-info' })
  assert.deepEqual(interpretStandaloneKeyboardStroke({ key: 'I' }), { type: 'show-current-track-info' })
  assert.equal(interpretStandaloneKeyboardStroke({ key: 'I', ctrlKey: true }), undefined)
  assert.deepEqual(interpretStandaloneKeyboardStroke({ key: 'Backspace' }), { type: 'backspace' })
  assert.deepEqual(interpretStandaloneKeyboardStroke({ key: 'Escape' }), { type: 'escape' })
  assert.equal(interpretStandaloneKeyboardStroke({ key: 'S' }), undefined)
  assert.equal(interpretStandaloneKeyboardStroke({ key: 'ArrowLeft', ctrlKey: true }), undefined)
})

test('operation request is immutable so a caller can retry the same intention unchanged', () => {
  const { controller } = build()
  typeDigits(controller, '1001')
  const request = playerCommand(stroke(controller, 'Enter'))
  assert.equal(Object.isFrozen(request), true)
  assert.equal(Object.isFrozen(request.command), true)
  const retry = request
  assert.equal(retry, request)
  assert.equal(retry.operationId, request.operationId)
  controller.dispose()
})

test('the emitted request is accepted by the B1 control contract and rejection stays authoritative', async () => {
  const { controller } = build()
  type B1CommandPort = Pick<StandalonePlayerControl, 'execute'>
  const received: StandalonePlayerCommandRequest[] = []
  const b1: B1CommandPort = {
    async execute(request) {
      received.push(request)
      const snapshot = createInitialStandalonePlayerSnapshot()
      return {
        outcome: 'rejected', operationId: request.operationId,
        error: { code: 'INVALID_MUSIC_CODE' }, snapshot
      }
    }
  }

  typeDigits(controller, '99999')
  const intent = controller.handleKeyStroke({ key: 'Enter' })
  const request = playerCommand(intent)
  assert.equal(controller.getSnapshot().lastSubmission?.outcome, 'pending')
  const result: StandalonePlayerCommandResult = await b1.execute(request)
  assert.deepEqual(received, [request])
  assert.equal(result.outcome, 'rejected')
  assert.deepEqual(controller.applyCommandResult(result), {
    operationId: request.operationId, enteredCode: '99999', priority: 'normal',
    outcome: 'rejected', errorCode: 'INVALID_MUSIC_CODE'
  })
  assert.equal('outcome' in (intent ?? {}), false)
  assert.deepEqual(controller.getSnapshot(), {
    numericPanelOpen: true, enteredCode: '99999', menuScreen: 'closed',
    lastSubmission: {
      operationId: request.operationId, enteredCode: '99999', priority: 'normal',
      outcome: 'rejected', errorCode: 'INVALID_MUSIC_CODE'
    }
  })
  controller.dispose()
})

test('a rejection restores its code only while the operator has not changed or closed the entry panel', () => {
  const { controller } = build()
  typeDigits(controller, '99999')
  const request = playerCommand(stroke(controller, 'Enter'))
  typeDigits(controller, '2')
  controller.applyCommandOutcome({ operationId: request.operationId, outcome: 'rejected', errorCode: 'MEDIA_UNAVAILABLE' })
  assert.equal(controller.getSnapshot().enteredCode, '2')
  stroke(controller, 'Escape')

  typeDigits(controller, '99999')
  const closedRequest = playerCommand(stroke(controller, 'P'))
  stroke(controller, 'Escape')
  controller.applyCommandOutcome({ operationId: closedRequest.operationId, outcome: 'rejected', errorCode: 'MEDIA_UNAVAILABLE' })
  assert.equal(controller.getSnapshot().numericPanelOpen, false)
  assert.equal(controller.getSnapshot().enteredCode, '')
  controller.dispose()
})

test('out-of-order B1 results stay correlated to their submission and do not overwrite the latest status', async () => {
  const { controller } = build()
  type B1CommandPort = Pick<StandalonePlayerControl, 'execute'>
  const pending: StandalonePlayerCommandRequest[] = []
  const firstResponse = deferred<StandalonePlayerCommandResult>()
  const secondResponse = deferred<StandalonePlayerCommandResult>()
  const b1: B1CommandPort = {
    execute(request) {
      pending.push(request)
      const code = request.command.type === 'submit-code' ? request.command.enteredCode : ''
      return code === '11111' ? firstResponse.promise : secondResponse.promise
    }
  }

  typeDigits(controller, '11111')
  const firstIntent = controller.handleKeyStroke({ key: 'Enter' })
  const first = playerCommand(firstIntent)
  typeDigits(controller, '22222')
  const secondIntent = controller.handleKeyStroke({ key: 'P' })
  const second = playerCommand(secondIntent)
  assert.equal(controller.getSnapshot().lastSubmission?.operationId, second.operationId)

  const firstResultPromise = b1.execute(first)
  const secondResultPromise = b1.execute(second)
  secondResponse.resolve({
    outcome: 'confirmed', operationId: second.operationId,
    snapshot: createInitialStandalonePlayerSnapshot()
  })
  const secondResult = await secondResultPromise
  assert.equal(controller.applyCommandResult(secondResult)?.outcome, 'confirmed')
  assert.equal(controller.getSnapshot().lastSubmission?.outcome, 'confirmed')
  firstResponse.resolve({
    outcome: 'rejected', operationId: first.operationId,
    error: { code: 'INVALID_MUSIC_CODE' }, snapshot: createInitialStandalonePlayerSnapshot()
  })
  const firstResult = await firstResultPromise
  const firstStatus = controller.applyCommandResult(firstResult)
  assert.equal(firstStatus?.enteredCode, '11111')
  assert.equal(firstStatus?.outcome, 'rejected')
  assert.equal(controller.getSnapshot().lastSubmission?.outcome, 'confirmed')
  assert.equal(controller.applyCommandResult(secondResult), undefined)
  assert.deepEqual(pending, [first, second])
  controller.dispose()
})

test('dispose cancels the active timeout and prevents later timer callbacks or keyboard actions', () => {
  const { controller, scheduler } = build()
  stroke(controller, '5')
  const timer = scheduler.latest()
  controller.dispose()
  assert.equal(timer.cancelled, true)
  timer.callback()
  assert.deepEqual(controller.getSnapshot(), { numericPanelOpen: false, enteredCode: '', menuScreen: 'closed' })
  assert.equal(stroke(controller, '6'), undefined)
  assert.equal(controller.getSnapshot().enteredCode, '')
})

test('unsubscribed listeners stop receiving state changes', () => {
  const { controller } = build()
  const snapshots: string[] = []
  const unsubscribe = controller.subscribe(snapshot => snapshots.push(snapshot.enteredCode))
  stroke(controller, '1')
  unsubscribe()
  stroke(controller, '2')
  assert.deepEqual(snapshots, ['1'])
  controller.dispose()
})
