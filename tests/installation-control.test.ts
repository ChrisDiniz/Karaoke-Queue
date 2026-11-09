import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createUnconfiguredManifest,
  InstallationControlError,
  InstallationControlStore,
  parseInstallationManifest
} from '../src/installation-control'

function fixture(): { directory: string; store: InstallationControlStore; cleanup: () => void } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kq-install-control-'))
  return { directory, store: new InstallationControlStore(directory), cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) }
}
const firstId = '9ee1683d-15a8-429b-a8fd-43f58f75264e'
const operationId = '2c67eb01-8588-4c54-89f7-a7fe884a1406'

test('creates a strict unconfigured global-role manifest in a synthetic directory', () => {
  const f = fixture()
  try {
    const created = f.store.initialize(createUnconfiguredManifest(firstId))
    assert.equal(created.role, null)
    assert.equal(created.status, 'unconfigured')
    assert.deepEqual(f.store.read(), created)
    assert.throws(() => f.store.initialize(createUnconfiguredManifest()), (error: unknown) =>
      error instanceof InstallationControlError && error.code === 'MANIFEST_ALREADY_INITIALIZED')
  } finally { f.cleanup() }
})

test('initial role confirmation uses pending then one durable generation and is idempotent', () => {
  const f = fixture()
  try {
    f.store.initialize(createUnconfiguredManifest(firstId))
    const pending = f.store.beginInitialRole(operationId, 0, 'player')
    assert.equal(pending.status, 'pending')
    assert.equal(pending.role, null)
    assert.equal(f.store.beginInitialRole(operationId, 0, 'player').pending?.operationId, operationId)
    const committed = f.store.commitInitialRole(operationId)
    assert.deepEqual({ generation: committed.generation, role: committed.role, status: committed.status },
      { generation: 1, role: 'player', status: 'ready' })
    assert.equal(committed.identityRevision, 1, 'identity is published only after the role shortcuts are provisioned')
    assert.equal(f.store.commitInitialRole(operationId).generation, 1)
    assert.equal(f.store.beginInitialRole(operationId, 0, 'player').generation, 1)
    assert.throws(() => f.store.beginInitialRole(operationId, 0, 'combined'), /operationId já foi confirmado/)
  } finally { f.cleanup() }
})

test('maintenance role change keeps the old role until shortcuts commit and resumes only the same pending intent', () => {
  const f = fixture()
  const changeId = '901eb673-54a8-4cac-8d91-4c3e31daee36'
  try {
    f.store.initialize(createUnconfiguredManifest(firstId))
    f.store.beginInitialRole(operationId, 0, 'player')
    f.store.commitInitialRole(operationId)
    const pending = f.store.beginRoleChange(changeId, 1, 'combined')
    assert.equal(pending.status, 'pending')
    assert.equal(pending.role, 'player', 'the previous confirmed role remains authoritative while effects are pending')
    assert.deepEqual(pending.pending, {
      operationId: changeId, kind: 'change-role', baseGeneration: 1, previousRole: 'player', role: 'combined'
    })
    assert.equal(f.store.beginRoleChange(changeId, 1, 'combined').pending?.operationId, changeId)
    assert.throws(() => f.store.beginRoleChange('a8b207e9-e90a-4d3f-814a-8700b9cc2ca6', 1, 'player'), /operação pendente/)
    const committed = f.store.commitRoleChange(changeId)
    assert.deepEqual({ generation: committed.generation, role: committed.role, status: committed.status,
      identityRevision: committed.identityRevision }, { generation: 2, role: 'combined', status: 'ready', identityRevision: 2 })
    assert.deepEqual(committed.lastCompletedOperation, {
      operationId: changeId, kind: 'change-role', generation: 2, previousRole: 'player', role: 'combined'
    })
    assert.equal(f.store.commitRoleChange(changeId).generation, 2)
    assert.throws(() => f.store.beginRoleChange('c185685f-d88d-49b6-9ab6-29a8de4ef5a1', 2, 'combined'), /já está confirmada/)
  } finally { f.cleanup() }
})

test('upgrade intent blocks startup until an idempotent maintenance recovery confirms the new generation', () => {
  const f = fixture()
  const updateId = '5b57965a-a1bf-4c6c-a66d-5fac7c19a45e'
  try {
    f.store.initialize(createUnconfiguredManifest(firstId))
    f.store.beginInitialRole(operationId, 0, 'combined')
    f.store.commitInitialRole(operationId)
    const before = f.store.read()!
    const pending = f.store.beginInstallationUpdate(updateId, before.generation)
    assert.equal(pending.status, 'pending')
    assert.equal(pending.role, 'combined')
    assert.deepEqual(pending.pending, { operationId: updateId, kind: 'prepare-update', baseGeneration: 1, role: 'combined' })
    assert.deepEqual(f.store.beginInstallationUpdate(updateId, 1), pending)
    assert.throws(() => f.store.beginInstallationUpdate('dd906614-7b05-4418-b5cc-90c8edb531ed', 1), /pendente/)
    const committed = f.store.commitInstallationUpdate(updateId)
    assert.deepEqual({ status: committed.status, role: committed.role, generation: committed.generation,
      identityRevision: committed.identityRevision },
    { status: 'ready', role: 'combined', generation: 2, identityRevision: before.identityRevision })
    assert.deepEqual(committed.lastCompletedOperation,
      { operationId: updateId, kind: 'prepare-update', generation: 2, role: 'combined' })
    assert.equal(f.store.commitInstallationUpdate(updateId).generation, 2)
  } finally { f.cleanup() }
})

test('an update of an unconfigured installation preserves null role through pending and restart recovery', () => {
  const f = fixture()
  const updateId = '506ed810-202f-42ea-94e5-812c72b18963'
  try {
    f.store.initialize(createUnconfiguredManifest(firstId))
    const pending = f.store.beginInstallationUpdate(updateId, 0)
    assert.equal(pending.status, 'pending')
    assert.equal(pending.role, null)
    assert.deepEqual(pending.pending, { operationId: updateId, kind: 'prepare-update', baseGeneration: 0, role: null })

    const committed = f.store.commitInstallationUpdate(updateId)
    assert.equal(committed.status, 'unconfigured')
    assert.equal(committed.role, null)
    assert.equal(committed.generation, 1)
    assert.deepEqual(committed.lastCompletedOperation,
      { operationId: updateId, kind: 'prepare-update', generation: 1, role: null })
    assert.equal(f.store.commitInstallationUpdate(updateId).generation, 1,
      'lost acknowledgement retry does not choose a function or increment generation again')
  } finally { f.cleanup() }
})

test('uninstall intent blocks the old role and reinstall requires a new explicit choice', () => {
  const f = fixture()
  const uninstallId = '5bc1b410-4a8b-499a-b5e5-4cf2b2209098'
  try {
    f.store.initialize(createUnconfiguredManifest(firstId))
    f.store.beginInitialRole(operationId, 0, 'combined')
    f.store.commitInitialRole(operationId)
    const pending = f.store.beginInstallationUninstall(uninstallId, 1)
    assert.equal(pending.status, 'pending')
    assert.deepEqual(pending.pending, { operationId: uninstallId, kind: 'uninstall', baseGeneration: 1, role: 'combined' })
    assert.equal(f.store.beginInstallationUninstall(uninstallId, 1).pending?.operationId, uninstallId,
      'an interrupted uninstall resumes the same intent')
    assert.throws(() => f.store.beginInstallationUpdate('189973bf-0c40-47d7-99eb-79bcf4bc8ea1', 1), /pendente/)

    const restored = f.store.restoreInstallationAfterUninstall(uninstallId)
    assert.deepEqual({ status: restored.status, role: restored.role, generation: restored.generation,
      identityRevision: restored.identityRevision },
    { status: 'unconfigured', role: null, generation: 2, identityRevision: 1 })
    assert.deepEqual(restored.lastCompletedOperation,
      { operationId: uninstallId, kind: 'restore-installation', generation: 2, role: null })
    assert.equal(f.store.restoreInstallationAfterUninstall(uninstallId).generation, 2,
      'reinstall retry after lost acknowledgement is idempotent')
  } finally { f.cleanup() }
})

test('pending, stale generation and an already selected role fail closed', () => {
  const f = fixture()
  try {
    f.store.initialize(createUnconfiguredManifest(firstId))
    f.store.beginInitialRole(operationId, 0, 'combined')
    assert.throws(() => f.store.beginInitialRole('b38b793b-88ec-469f-9510-7d6c478e4c2c', 0, 'player'), /operação pendente/)
    assert.throws(() => f.store.commitInitialRole('b38b793b-88ec-469f-9510-7d6c478e4c2c'), /não corresponde/)
    f.store.commitInitialRole(operationId)
    assert.throws(() => f.store.beginInitialRole('b38b793b-88ec-469f-9510-7d6c478e4c2c', 0, 'player'), /já foi confirmada/)
  } finally { f.cleanup() }
})

test('generation conflicts and unsupported or malformed manifest data do not mutate it', () => {
  const f = fixture()
  try {
    f.store.initialize(createUnconfiguredManifest(firstId))
    const original = fs.readFileSync(path.join(f.directory, 'installation.json'))
    assert.throws(() => f.store.beginInitialRole(operationId, 1, 'player'), /mudou/)
    assert.deepEqual(fs.readFileSync(path.join(f.directory, 'installation.json')), original)
    const invalid = [{ ...createUnconfiguredManifest(firstId), extra: true }, { ...createUnconfiguredManifest(firstId), role: 'controller' },
      { ...createUnconfiguredManifest(firstId), status: 'ready' }, { ...createUnconfiguredManifest(firstId), generation: Number.MAX_SAFE_INTEGER + 1 }]
    for (const value of invalid) assert.throws(() => parseInstallationManifest(value), InstallationControlError)
    fs.writeFileSync(path.join(f.directory, 'installation.json'), '{bad json')
    const corrupted = fs.readFileSync(path.join(f.directory, 'installation.json'))
    assert.throws(() => f.store.read(), /JSON inválido/)
    assert.deepEqual(fs.readFileSync(path.join(f.directory, 'installation.json')), corrupted)
  } finally { f.cleanup() }
})

test('manifest symlinks and pending temporary files are not followed or adopted', t => {
  const f = fixture()
  const target = path.join(f.directory, 'outside.json')
  fs.writeFileSync(target, JSON.stringify(createUnconfiguredManifest(firstId)))
  try {
    try { fs.symlinkSync(target, path.join(f.directory, 'installation.json')) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('symlink creation unavailable'); return } throw error }
    assert.throws(() => f.store.read(), /arquivo regular/)
  } finally { f.cleanup() }
})

test('a flush failure before replace preserves the confirmed manifest', () => {
  const f = fixture()
  const original = fs.fsyncSync
  try {
    f.store.initialize(createUnconfiguredManifest(firstId))
    const before = fs.readFileSync(path.join(f.directory, 'installation.json'))
    fs.fsyncSync = (() => { throw new Error('injected flush failure') }) as typeof fs.fsyncSync
    assert.throws(() => f.store.beginInitialRole(operationId, 0, 'player'), (error: unknown) =>
      error instanceof InstallationControlError && error.code === 'MANIFEST_WRITE_FAILED')
    fs.fsyncSync = original
    assert.deepEqual(fs.readFileSync(path.join(f.directory, 'installation.json')), before)
    assert.equal(fs.readdirSync(f.directory).some(name => name.endsWith('.tmp')), false)
  } finally { fs.fsyncSync = original; f.cleanup() }
})

test('a failure after atomic replace is reconciled by rereading and replaying the same operation', () => {
  const f = fixture()
  const original = fs.renameSync
  try {
    f.store.initialize(createUnconfiguredManifest(firstId))
    f.store.beginInitialRole(operationId, 0, 'player')
    fs.renameSync = ((source: fs.PathLike, destination: fs.PathLike) => {
      original(source, destination)
      throw new Error('injected uncertain outcome after atomic replace')
    }) as typeof fs.renameSync
    assert.throws(() => f.store.commitInitialRole(operationId), (error: unknown) =>
      error instanceof InstallationControlError && error.code === 'MANIFEST_WRITE_FAILED')
    fs.renameSync = original
    assert.equal(f.store.read()?.role, 'player')
    assert.equal(f.store.commitInitialRole(operationId).generation, 1)
  } finally { fs.renameSync = original; f.cleanup() }
})
