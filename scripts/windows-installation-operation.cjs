'use strict'
// Safe Windows proof: the addon uses compile-only random names. No global
// product namespace, elevation, filesystem ACL, installer, or operational data.
const assert = require('node:assert/strict')
const { fork, spawn } = require('node:child_process')
const { once } = require('node:events')
const net = require('node:net')
const crypto = require('node:crypto')

async function worker(addon, pipe, id) {
  const socket = net.connect(pipe)
  await once(socket, 'connect')
  const native = require(addon)
  socket.write(JSON.stringify({ id, ready: true, pid: process.pid }) + '\n')
  let input = ''
  socket.on('data', data => {
    input += data
    while (input.includes('\n')) {
      const index = input.indexOf('\n')
      const command = JSON.parse(input.slice(0, index)); input = input.slice(index + 1)
      if (command.action === 'exit') process.exit(command.code || 0)
      if (command.action === 'child') {
        spawn(process.execPath, [__filename, '--worker', addon, pipe, 'delegate'], {
          // libuv otherwise puts children in its own kill-on-parent-close job.
          // Detached suppresses that harness behavior; our non-breakaway job
          // still inherits through CreateProcess, matching NSIS ExecWait.
          detached: true, env: process.env, stdio: ['ignore', 'inherit', 'inherit'] }).unref()
        socket.write(JSON.stringify({ id, spawned: true }) + '\n')
      } else {
        socket.write(JSON.stringify({ id, result: native.enterInstallationOperation() }) + '\n')
      }
    }
  })
}

async function prove(addon) {
  assert.equal(process.platform, 'win32')
  const pipe = `\\\\.\\pipe\\kq-operation-proof-${crypto.randomUUID()}`
  let delegatePid
  const sockets = new Map(), queues = new Map(), waiters = new Map(), processes = []
  function publish(message) {
    if (message.id === 'delegate' && message.ready) delegatePid = message.pid
    const pending = waiters.get(message.id)
    if (pending) { waiters.delete(message.id); pending(message) }
    else { const queue = queues.get(message.id) || []; queue.push(message); queues.set(message.id, queue) }
  }
  function next(id) { const queue = queues.get(id); return queue?.length ? Promise.resolve(queue.shift()) :
    new Promise(resolve => waiters.set(id, resolve)) }
  async function command(id, action, fields = {}) {
    sockets.get(id).write(JSON.stringify({ action, ...fields }) + '\n')
    return next(id)
  }
  const server = net.createServer(socket => {
    let input = ''
    socket.on('data', data => {
      input += data
      while (input.includes('\n')) {
        const index = input.indexOf('\n'), message = JSON.parse(input.slice(0, index)); input = input.slice(index + 1)
        sockets.set(message.id, socket); publish(message)
      }
    })
  })
  server.listen(pipe); await once(server, 'listening')
  async function launch(id) {
    const child = fork(__filename, ['--worker', addon, pipe, id], { execPath: require('electron'),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })
    processes.push(child)
    await next(id)
    return child
  }
  try {
    const holder = await launch('holder'), contender = await launch('contender')
    assert.equal((await command('holder', 'enter')).result.status, 'joined')
    assert.equal((await command('contender', 'enter')).result.status, 'busy')
    await command('holder', 'child'); await next('delegate')
    assert.equal((await command('delegate', 'enter')).result.status, 'delegated')
    // Simulate the precise handoff: parent exits unexpectedly while its helper
    // remains live. There is no timeout-based assumption of ownership.
    const holderExited = once(holder, 'exit')
    sockets.get('holder').write(JSON.stringify({ action: 'exit', code: 77 }) + '\n')
    assert.equal((await holderExited)[0], 77)
    assert.equal(sockets.get('delegate').destroyed, false, 'the delegate must remain alive after parent crash')
    assert.equal((await command('contender', 'enter')).result.status, 'busy')
    const observer = require(addon)
    assert.equal(observer.openTestProcessReference(delegatePid).status, 'opened')
    const delegateSocket = sockets.get('delegate')
    const delegateClosed = once(delegateSocket, 'close')
    delegateSocket.write(JSON.stringify({ action: 'exit' }) + '\n'); await delegateClosed
    assert.equal(observer.waitTestProcessExit().status, 'exited')
    assert.equal((await command('contender', 'enter')).result.status, 'joined')
    const exited = once(contender, 'exit'); sockets.get('contender').write('{"action":"exit"}\n'); await exited
    console.log('WINDOWS ELECTRON OPERATION TREE PASS independent contention / inherited helper / parent crash / recovery after final exit')
  } finally {
    for (const socket of sockets.values()) if (!socket.destroyed) socket.write('{"action":"exit"}\n')
    for (const process of processes) if (process.exitCode === null) await once(process, 'exit')
    for (const socket of sockets.values()) socket.destroy()
    await new Promise(resolve => server.close(resolve))
  }
}

if (process.argv[2] === '--worker') worker(...process.argv.slice(3)).catch(error => { console.error(error); process.exit(1) })
else prove(process.argv[2]).catch(error => { console.error(error); process.exitCode = 1 })
