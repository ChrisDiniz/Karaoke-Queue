#!/usr/bin/env node
'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const readline = require('node:readline')

const VERSION = 1
const MARKER = 'karaoke-queue-wsl-snapshot.json'
const PENDING = 'karaoke-queue-wsl-sync-pending.json'
const LOCK = 'karaoke-queue-windows-test.lock'
const REPORT = 'karaoke-queue-last-windows-test.json'
const REPORT_OWNER = 'karaoke-queue-windows-test-runner-v1'
const EXCLUDED_DIRS = new Set(['.git', '.npm-cache', '.playwright-mcp', 'build', 'coverage', 'dist', 'ia', 'node_modules', 'out'])
const EXCLUDED_NAMES = new Set(['.ds_store'])
const EXCLUDED_EXTENSIONS = new Set(['.log', '.tmp', '.temp', '.bak', '.swp'])
const SENSITIVE_EXTENSIONS = new Set([
  '.db', '.db-shm', '.db-wal', '.env', '.key', '.lic', '.license', '.p12', '.pem', '.pfx',
  '.secret', '.secrets', '.sqlite', '.sqlite-journal', '.sqlite-shm', '.sqlite-wal', '.sqlite3',
  '.sqlite3-journal', '.sqlite3-shm', '.sqlite3-wal'
])

function fail(message, exitCode = 1) {
  const error = new Error(message)
  error.exitCode = exitCode
  throw error
}

function observeWorkerInputErrors(stream, cancellationRequested, onUnexpectedError) {
  stream.on('error', error => {
    if (cancellationRequested() && error && error.code === 'EPIPE') return
    onUnexpectedError(error)
  })
}

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: options.binary ? null : 'utf8',
    maxBuffer: options.maxBuffer || 64 * 1024 * 1024,
    shell: false,
    stdio: options.stdio || 'pipe'
  })
  if (result.status === null || (result.status !== 0 && result.status !== undefined)) {
    fail(executable + ' ' + args.join(' ') + ' falhou: ' +
      String(result.stderr || (result.error && result.error.message) || ('exit ' + result.status)).trim())
  }
  return result
}

function git(root, args, options = {}) {
  return run('git', args, { ...options, cwd: root })
}

function nulList(value) {
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value || '')
  return text.split('\0').filter(Boolean)
}

function normalizePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0')) fail('Caminho inválido no snapshot.')
  if (value.includes('\\')) fail('Separador de caminho incompatível com o snapshot: ' + value)
  const normalized = value
  const segments = normalized.split('/')
  if (normalized.startsWith('/') || segments.some(part => !part || part === '.' || part === '..')) {
    fail('Caminho fora do checkout: ' + value)
  }
  if (segments.some(part => /[<>:"|?*\x00-\x1f]/.test(part) || /[ .]$/.test(part))) fail('Caminho incompatível com Windows: ' + value)
  if (segments.some(part => /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part))) fail('Nome reservado no Windows: ' + value)
  return normalized
}

function isExcludedPath(value) {
  const normalized = normalizePath(value)
  if (normalized.split('/').some(part => EXCLUDED_DIRS.has(part.toLowerCase()))) return true
  const name = path.posix.basename(normalized).toLowerCase()
  return EXCLUDED_NAMES.has(name) || EXCLUDED_EXTENSIONS.has(path.posix.extname(name))
}

function isSensitivePath(value) {
  const normalized = normalizePath(value).toLowerCase()
  const name = path.posix.basename(normalized)
  const ext = path.posix.extname(name)
  return normalized.split('/').some(part => ['activation-data', 'credentials', 'license-data', 'personal-licenses', 'secrets', 'user-data', 'userdata'].includes(part)) ||
    name === '.env' || name === '.envrc' || name.startsWith('.env.') || name.startsWith('.env-') || SENSITIVE_EXTENSIONS.has(ext) ||
    /(^|[-_.])(secret|secrets|credential|credentials|token|password|passwd)([-_.]|$)/i.test(name)
    || /^(license|licence|activation)(-token)?\.(json|dat|bin|txt|token)$/i.test(name)
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function assertPlainFile(filePath, label) {
  const stat = fs.lstatSync(filePath)
  if (!stat.isFile() || stat.isSymbolicLink() || (process.platform === 'win32' && (stat.attributes & 0x400))) {
    fail(label + ' não é um arquivo regular: ' + filePath)
  }
}

function lastNonEmptyLine(value) {
  return String(value || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean).at(-1) || ''
}

function makeFingerprint(branch, head, trackedPaths, files) {
  const value = {
    branch,
    head,
    trackedPaths: [...trackedPaths].sort(),
    files: files.map(file => ({ path: file.path, sha256: file.sha256 })).sort((a, b) => a.path.localeCompare(b.path))
  }
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function validateManifest(input) {
  if (!input || input.version !== VERSION || typeof input.branch !== 'string' || typeof input.head !== 'string' ||
      !Array.isArray(input.trackedPaths) || !Array.isArray(input.files)) fail('Manifesto de snapshot inválido.')
  const trackedPaths = input.trackedPaths.map(normalizePath).sort()
  if (new Set(trackedPaths).size !== trackedPaths.length) fail('Caminhos tracked duplicados no manifesto.')
  for (const filePath of trackedPaths) {
    if (isSensitivePath(filePath)) fail('Caminho tracked sensível bloqueado: ' + filePath)
    if (isExcludedPath(filePath)) fail('Artefato excluído em caminho tracked: ' + filePath)
  }
  const files = input.files.map(item => {
    const filePath = normalizePath(item.path)
    if (!/^[a-f0-9]{64}$/.test(item.sha256) || !['tracked', 'untracked', 'adopted'].includes(item.kind)) {
      fail('Entrada inválida no manifesto: ' + filePath)
    }
    if (isSensitivePath(filePath)) fail('Arquivo sensível bloqueado: ' + filePath)
    if (isExcludedPath(filePath)) fail('Artefato excluído presente no manifesto: ' + filePath)
    return { path: filePath, sha256: item.sha256, kind: item.kind }
  }).sort((a, b) => a.path.localeCompare(b.path))
  const exact = new Set()
  const folded = new Map()
  for (const item of files) {
    if (exact.has(item.path)) fail('Caminho duplicado no snapshot: ' + item.path)
    exact.add(item.path)
    const segments = item.path.split('/')
    for (let index = 1; index <= segments.length; index++) {
      const prefix = segments.slice(0, index).join('/')
      const lower = prefix.toLowerCase()
      if (folded.has(lower) && folded.get(lower) !== prefix) {
        fail('Colisão de caminho no Windows: ' + folded.get(lower) + ' / ' + prefix)
      }
      folded.set(lower, prefix)
    }
    if (item.kind === 'tracked' && !trackedPaths.includes(item.path)) fail('Arquivo tracked ausente da lista Git: ' + item.path)
  }
  const deletedTracked = [...new Set((input.deletedTracked || []).map(normalizePath))].sort()
  for (const filePath of deletedTracked) {
    if (isSensitivePath(filePath)) fail('Exclusão de caminho sensível bloqueada: ' + filePath)
    if (isExcludedPath(filePath)) fail('Exclusão de artefato bloqueada: ' + filePath)
  }
  const result = {
    version: VERSION,
    branch: input.branch,
    head: input.head,
    trackedPaths,
    files,
    deletedTracked,
    headBlobs: input.headBlobs || {}
  }
  result.fingerprint = makeFingerprint(result.branch, result.head, result.trackedPaths, result.files)
  if (input.fingerprint && input.fingerprint !== result.fingerprint) fail('Fingerprint do manifesto não corresponde ao conteúdo.')
  return result
}

function validateLegacyManifest(input) {
  if (!input || typeof input.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(input.fingerprint)) {
    fail('Fingerprint legado ausente ou inválido.')
  }
  const normalized = { ...input }
  delete normalized.fingerprint
  return validateManifest(normalized)
}

function headBlobMap(root) {
  const bytes = git(root, ['ls-tree', '-rz', '--full-tree', 'HEAD'], { binary: true }).stdout || Buffer.alloc(0)
  const result = Object.create(null)
  for (const entry of nulList(bytes)) {
    const tab = entry.indexOf('\t')
    if (tab < 0) continue
    const metadata = entry.slice(0, tab).split(' ')
    const filePath = normalizePath(entry.slice(tab + 1))
    if (metadata[1] !== 'blob') continue
    if (metadata[0] === '120000') fail('Symlink tracked não suportado no checkout Windows: ' + filePath)
    result[filePath] = metadata[2]
  }
  return result
}

function readSourceSnapshot(root) {
  const branch = git(root, ['branch', '--show-current']).stdout.trim()
  if (!branch) fail('A origem WSL está detached; valide a partir de uma branch.')
  const head = git(root, ['rev-parse', 'HEAD']).stdout.trim()
  const trackedPaths = nulList(git(root, ['ls-files', '--cached', '-z'], { binary: true }).stdout).map(normalizePath).sort()
  const untrackedPaths = nulList(git(root, ['ls-files', '--others', '--exclude-standard', '-z'], { binary: true }).stdout).map(normalizePath).sort()
  const tracked = new Set(trackedPaths)
  const candidates = trackedPaths.map(filePath => ({ path: filePath, kind: 'tracked' }))
  for (const filePath of untrackedPaths) {
    if (tracked.has(filePath)) continue
    if (isSensitivePath(filePath)) fail('Arquivo sensível não será transferido: ' + filePath)
    if (isExcludedPath(filePath)) {
      process.stdout.write('SYNC EXCLUDED ' + filePath + ' (temporário/cache)\n')
      continue
    }
    candidates.push({ path: filePath, kind: 'untracked' })
  }
  const files = []
  const deletedTracked = []
  const headBlobs = headBlobMap(root)
  for (const item of candidates) {
    const absolute = path.join(root, ...item.path.split('/'))
    if (!fs.existsSync(absolute)) {
      if (item.kind === 'tracked') deletedTracked.push(item.path)
      continue
    }
    const stat = fs.lstatSync(absolute)
    if (!stat.isFile() || stat.isSymbolicLink()) fail('Somente arquivos regulares podem ser sincronizados: ' + item.path)
    if (isSensitivePath(item.path)) fail('Arquivo sensível não será transferido: ' + item.path)
    if (isExcludedPath(item.path)) fail('Arquivo versionado/não ignorado usa nome de artefato: ' + item.path)
    files.push({ path: item.path, sha256: sha256(absolute), kind: item.kind })
  }
  for (const filePath of Object.keys(headBlobs)) {
    if (!tracked.has(filePath) || !fs.existsSync(path.join(root, ...filePath.split('/')))) deletedTracked.push(filePath)
  }
  const manifest = validateManifest({ version: VERSION, branch, head, trackedPaths, files, deletedTracked, headBlobs })
  manifest.trackedChanges = trackedDiff(root)
  return manifest
}

function trackedDiff(root) {
  const bytes = git(root, ['diff', '--name-status', '--no-renames', '-z', 'HEAD'], { binary: true }).stdout || Buffer.alloc(0)
  const fields = nulList(bytes)
  const changes = []
  for (let index = 0; index + 1 < fields.length; index += 2) {
    changes.push({ status: fields[index], path: normalizePath(fields[index + 1]) })
  }
  return changes
}

function stageSnapshot(root, manifest, targetMarker, temporaryRoot = os.tmpdir()) {
  let includeHeadBundle = false
  if (targetMarker && targetMarker.branch !== manifest.branch) {
    fail('Branch do checkout Windows diverge da origem; reconstrua o clone isolado.')
  }
  if (targetMarker && targetMarker.head !== manifest.head) {
    const ancestry = spawnSync('git', ['merge-base', '--is-ancestor', targetMarker.head, manifest.head], {
      cwd: root, encoding: 'utf8', shell: false
    })
    if (ancestry.status !== 0) fail('HEAD Windows não é ancestral do HEAD WSL; reconstrua o clone isolado.')
    includeHeadBundle = true
  }

  const stage = fs.mkdtempSync(path.join(temporaryRoot, 'karaoke-queue-windows-stage-'))
  try {
    const sourceTree = path.join(stage, 'tree')
    const metadata = path.join(stage, 'metadata')
    fs.mkdirSync(sourceTree)
    fs.mkdirSync(metadata)
    for (const item of manifest.files) {
      const source = path.join(root, ...item.path.split('/'))
      const target = path.join(sourceTree, ...item.path.split('/'))
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL)
      if (sha256(target) !== item.sha256) fail('A origem mudou durante o staging: ' + item.path)
    }
    if (includeHeadBundle) {
      const bundle = path.join(metadata, 'source-head.bundle')
      const bundled = spawnSync('git', ['bundle', 'create', bundle, 'HEAD', '^' + targetMarker.head], {
        cwd: root, encoding: 'utf8', shell: false, maxBuffer: 4 * 1024 * 1024
      })
      if (bundled.status !== 0) fail('Não foi possível preparar o bundle Git incremental: ' + (bundled.stderr || bundled.error))
    }
    if (targetMarker && targetMarker.legacyManifest) {
      fs.writeFileSync(path.join(metadata, 'legacy-baseline.json'), JSON.stringify(targetMarker.legacyManifest), { flag: 'wx' })
    }
    fs.writeFileSync(path.join(metadata, 'snapshot.json'), JSON.stringify(manifest), { flag: 'wx' })
    return stage
  } catch (error) {
    try {
      fs.rmSync(stage, { recursive: true, force: true })
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Falha ao preparar o snapshot e remover o staging temporário.')
    }
    throw error
  }
}

function enumerateFiles(root) {
  const result = []
  const folded = new Map()
  function visit(directory, prefix) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = normalizePath(prefix ? prefix + '/' + entry.name : entry.name)
      if (entry.isSymbolicLink()) fail('Link inesperado no checkout Windows: ' + relative)
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name.toLowerCase())) continue
        const absolute = path.join(directory, entry.name)
        const stat = fs.lstatSync(absolute)
        if (process.platform === 'win32' && (stat.attributes & 0x400)) fail('Reparse point inesperado no checkout Windows: ' + relative)
        visit(absolute, relative)
        continue
      }
      const absolute = path.join(directory, entry.name)
      const stat = fs.lstatSync(absolute)
      if (process.platform === 'win32' && (stat.attributes & 0x400)) fail('Reparse point inesperado no checkout Windows: ' + relative)
      if (!entry.isFile() || isExcludedPath(relative)) continue
      const segments = relative.split('/')
      for (let index = 1; index <= segments.length; index++) {
        const prefix = segments.slice(0, index).join('/')
        const lower = prefix.toLowerCase()
        if (folded.has(lower) && folded.get(lower) !== prefix) fail('Colisão de caixa no destino: ' + folded.get(lower) + ' / ' + prefix)
        folded.set(lower, prefix)
      }
      result.push({ path: relative, absolutePath: absolute })
    }
  }
  visit(root, '')
  return result.sort((a, b) => a.path.localeCompare(b.path))
}

function verifySnapshotDirectory(root, input) {
  const manifest = validateManifest(input)
  const expected = new Map(manifest.files.map(file => [file.path, file.sha256]))
  const observed = new Map()
  const unexpected = []
  for (const item of enumerateFiles(root)) {
    if (!expected.has(item.path)) {
      unexpected.push(item.path + ' (inesperado no destino)')
      continue
    }
    observed.set(item.path, sha256(item.absolutePath))
  }
  const divergence = []
  for (const [filePath, hash] of expected) {
    if (!observed.has(filePath)) divergence.push(filePath + ' (ausente)')
    else if (observed.get(filePath) !== hash) divergence.push(filePath + ' (hash diferente)')
  }
  divergence.push(...unexpected)
  if (divergence.length) {
    const details = divergence.slice(0, 40).map(item => '  - ' + item).join('\n')
    fail('Divergência no checkout Windows; execução bloqueada:\n' + details +
      (divergence.length > 40 ? '\n  ... e mais ' + (divergence.length - 40) : ''))
  }
  return { fileCount: expected.size, fingerprint: manifest.fingerprint }
}

function verifyThenRun(root, manifest, action) {
  verifySnapshotDirectory(root, manifest)
  return action()
}

function gitWin(root, args, options = {}) {
  return run('git.exe', ['-C', root, ...args], { ...options, cwd: root })
}

function gitState(root) {
  return {
    branch: gitWin(root, ['branch', '--show-current']).stdout.trim(),
    head: gitWin(root, ['rev-parse', 'HEAD']).stdout.trim()
  }
}

function assertIndexMatchesHead(root) {
  const result = spawnSync('git.exe', ['-C', root, 'diff', '--cached', '--quiet', 'HEAD', '--'], {
    encoding: 'utf8', shell: false, cwd: root
  })
  if (result.status === null || result.status === undefined || result.status > 1) {
    fail('Não foi possível verificar o índice Git do checkout Windows: ' + String(result.stderr || result.error || result.status))
  }
  if (result.status === 1) fail('O índice Git do checkout Windows contém alterações não autorizadas; nada será sobrescrito.')
}

function atomicWrite(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporary = filePath + '.' + process.pid + '-' + crypto.randomUUID() + '.tmp'
  fs.writeFileSync(temporary, content, { flag: 'wx' })
  fs.renameSync(temporary, filePath)
}

function hashDirectoryAsMarker(root, state, trackedPaths) {
  const files = enumerateFiles(root).map(item => ({
    path: item.path,
    sha256: sha256(item.absolutePath),
    kind: trackedPaths.includes(item.path) ? 'tracked' : 'adopted'
  }))
  return validateManifest({ version: VERSION, branch: state.branch, head: state.head, trackedPaths, files })
}

function verifyBootstrap(root, manifest) {
  const state = gitState(root)
  if (state.branch !== manifest.branch || state.head !== manifest.head) {
    fail('Checkout sem manifesto diverge em branch/HEAD: destino=' + state.branch + '@' + state.head +
      ', origem=' + manifest.branch + '@' + manifest.head)
  }
  assertIndexMatchesHead(root)
  const expected = new Map(manifest.files.map(item => [item.path, item.sha256]))
  const actual = new Map(enumerateFiles(root).map(item => [item.path, { absolutePath: item.absolutePath, hash: sha256(item.absolutePath) }]))
  const deleted = new Set(manifest.deletedTracked)
  const unexpected = []
  for (const [filePath, item] of actual) {
    if (expected.get(filePath) === item.hash) continue
    const headBlob = manifest.headBlobs[filePath]
    if (!headBlob || gitWin(root, ['hash-object', '--path=' + filePath, '--', filePath]).stdout.trim() !== headBlob) {
      unexpected.push(filePath + ' (não corresponde à origem nem ao HEAD)')
    }
  }
  for (const item of manifest.files) {
    if (!actual.has(item.path) && item.kind === 'tracked' && !deleted.has(item.path) && manifest.headBlobs[item.path]) {
      unexpected.push(item.path + ' (tracked ausente)')
    }
  }
  for (const filePath of actual.keys()) {
    if (!expected.has(filePath) && !deleted.has(filePath)) unexpected.push(filePath + ' (fora do snapshot)')
  }
  if (unexpected.length) fail('Checkout sem manifesto possui conteúdo não verificado:\n' + unexpected.map(item => '  - ' + item).join('\n'))
  return hashDirectoryAsMarker(root, state, manifest.trackedPaths)
}

function gitTreePaths(root, revision) {
  const bytes = gitWin(root, ['ls-tree', '-rz', '--full-tree', revision], { binary: true }).stdout || Buffer.alloc(0)
  const paths = new Set()
  for (const record of nulList(bytes)) {
    const tab = record.indexOf('\t')
    if (tab >= 0) paths.add(normalizePath(record.slice(tab + 1)))
  }
  return paths
}

function recordBackup(backupRoot, records, category, filePath, sourcePath, expectedHash) {
  const relative = category + '/' + filePath
  const target = path.join(backupRoot, ...relative.split('/'))
  if (fs.existsSync(target)) fail('Backup de sincronização já existe: ' + relative)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(sourcePath, target, fs.constants.COPYFILE_EXCL)
  const hash = sha256(sourcePath)
  if (hash !== expectedHash || sha256(target) !== expectedHash) fail('Backup de sincronização diverge: ' + relative)
  records.push({ path: relative, sha256: expectedHash })
}

function backupPreviousSnapshot(root, marker, backupRoot, records) {
  for (const item of marker.files) {
    const source = path.join(root, ...item.path.split('/'))
    if (!fs.existsSync(source)) fail('Snapshot mudou antes do avanço Git: ' + item.path)
    assertPlainFile(source, 'Snapshot anterior')
    if (sha256(source) !== item.sha256) fail('Snapshot mudou antes do avanço Git: ' + item.path)
    recordBackup(backupRoot, records, 'previous', item.path, source, item.sha256)
  }
}

function fileMatchesGitBlob(root, filePath, candidatePath, blob) {
  return !!blob && gitWin(root, ['hash-object', '--path=' + filePath, '--', candidatePath]).stdout.trim() === blob
}

function moveToSyncBackup(backupRoot, records, category, filePath, sourcePath, matches) {
  const relative = category + '/' + filePath
  const backup = path.join(backupRoot, ...relative.split('/'))
  if (fs.existsSync(backup)) fail('Backup de sincronização já existe: ' + relative)
  fs.mkdirSync(path.dirname(backup), { recursive: true })
  fs.renameSync(sourcePath, backup)
  assertPlainFile(backup, 'Backup de sincronização')
  if (!matches(backup)) {
    if (!fs.existsSync(sourcePath)) fs.renameSync(backup, sourcePath)
    fail('O destino mudou durante a sincronização; conteúdo preservado em .git/karaoke-queue-sync-backup-' + path.basename(backupRoot) + '/' + relative)
  }
  const hash = sha256(backup)
  records.push({ path: relative, sha256: hash })
  return backup
}

function removeManagedUntracked(root, marker, trackedAtHead, backupRoot, records) {
  for (const item of marker.files) {
    if (trackedAtHead.has(item.path)) continue
    const filePath = path.join(root, ...item.path.split('/'))
    if (!fs.existsSync(filePath)) continue
    if (sha256(filePath) !== item.sha256) fail('Arquivo não rastreado gerenciado foi alterado: ' + item.path)
    moveToSyncBackup(backupRoot, records, 'removed-untracked', item.path, filePath,
      candidate => sha256(candidate) === item.sha256)
  }
}

function verifyTrackedSnapshotDirectory(root, marker, trackedAtHead) {
  const trackedFiles = marker.files.filter(item => trackedAtHead.has(item.path))
  const reduced = validateManifest({
    version: VERSION,
    branch: marker.branch,
    head: marker.head,
    trackedPaths: marker.trackedPaths,
    files: trackedFiles,
    headBlobs: marker.headBlobs
  })
  verifySnapshotDirectory(root, reduced)
}

function advanceHead(root, marker, manifest, stage, backupRoot, records) {
  if (marker.head === manifest.head) return false
  const bundle = path.join(stage, 'metadata', 'source-head.bundle')
  if (!fs.existsSync(bundle)) fail('Bundle da revisão de origem ausente.')
  gitWin(root, ['fetch', '--no-tags', bundle, 'HEAD'])
  const fetched = gitWin(root, ['rev-parse', 'FETCH_HEAD']).stdout.trim()
  if (fetched !== manifest.head) fail('Bundle não corresponde ao HEAD informado.')
  const ancestry = spawnSync('git.exe', ['-C', root, 'merge-base', '--is-ancestor', marker.head, manifest.head], { encoding: 'utf8', shell: false })
  if (ancestry.status !== 0) fail('HEAD do checkout divergiu da origem; reconstrua o clone isolado.')
  const trackedAtOldHead = gitTreePaths(root, marker.head)
  verifySnapshotDirectory(root, marker)
  assertIndexMatchesHead(root)
  backupPreviousSnapshot(root, marker, backupRoot, records)
  verifySnapshotDirectory(root, marker)
  removeManagedUntracked(root, marker, trackedAtOldHead, backupRoot, records)
  verifyTrackedSnapshotDirectory(root, marker, trackedAtOldHead)
  gitWin(root, ['reset', '--hard', marker.head])
  gitWin(root, ['merge', '--ff-only', 'FETCH_HEAD'])
  const state = gitState(root)
  if (state.branch !== manifest.branch || state.head !== manifest.head) fail('Fast-forward não atingiu o HEAD da origem.')
  return true
}

function acquireLock(root, runId) {
  const lockPath = path.join(root, '.git', LOCK)
  const token = crypto.randomUUID()
  let descriptor
  try {
    descriptor = fs.openSync(lockPath, 'wx', 0o600)
  } catch (error) {
    if (error.code === 'EEXIST') fail('Outro runner está ativo ou deixou um lock para revisão em ' + lockPath)
    throw error
  }
  try {
    fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, runId, token, createdAt: new Date().toISOString() }))
  } catch (error) {
    try { fs.closeSync(descriptor) } catch {}
    throw error
  }
  return function release() {
    fs.closeSync(descriptor)
    let owner
    try { owner = JSON.parse(fs.readFileSync(lockPath, 'utf8')) } catch {
      fail('O lock do runner desapareceu ou ficou ilegível; ele não será removido automaticamente.')
    }
    if (owner.pid !== process.pid || owner.runId !== runId || owner.token !== token) {
      fail('O lock agora pertence a outra execução; ele não será removido.')
    }
    fs.unlinkSync(lockPath)
  }
}

function syncSnapshot(root, stage, manifest, marker, runId, advancedHead, backupRoot, backupRecords) {
  const expected = new Map(manifest.files.map(item => [item.path, item.sha256]))
  const prior = new Map(marker.files.map(item => [item.path, item.sha256]))
  const deletable = new Set([...prior.keys(), ...manifest.trackedPaths])
  for (const filePath of deletable) {
    if (expected.has(filePath)) continue
    const target = path.join(root, ...filePath.split('/'))
    if (!fs.existsSync(target)) continue
    assertPlainFile(target, 'Destino a excluir')
    const oldHash = prior.get(filePath)
    const headBlob = manifest.headBlobs[filePath]
    const useHeadBase = advancedHead && !!headBlob
    const matches = candidate => useHeadBase
      ? fileMatchesGitBlob(root, filePath, candidate, headBlob)
      : oldHash ? sha256(candidate) === oldHash : fileMatchesGitBlob(root, filePath, candidate, headBlob)
    if (!matches(target)) fail('Recusa de exclusão de arquivo alterado: ' + filePath)
    moveToSyncBackup(backupRoot, backupRecords, 'deleted', filePath, target, matches)
  }
  for (const item of manifest.files) {
    const source = path.join(stage, 'tree', ...item.path.split('/'))
    const target = path.join(root, ...item.path.split('/'))
    if (!fs.existsSync(source)) fail('Staging ausente ou divergente: ' + item.path)
    assertPlainFile(source, 'Staging')
    if (sha256(source) !== item.sha256) fail('Staging ausente ou divergente: ' + item.path)
    let parent = root
    for (const segment of item.path.split('/').slice(0, -1)) {
      parent = path.join(parent, segment)
      if (fs.existsSync(parent)) {
        const stat = fs.lstatSync(parent)
        if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.attributes & 0x400)) fail('Diretório de destino inseguro: ' + parent)
      }
    }
    fs.mkdirSync(path.dirname(target), { recursive: true })
    if (!fs.existsSync(target) && prior.has(item.path) && !advancedHead) {
      fail('Arquivo gerenciado desapareceu após a verificação do snapshot: ' + item.path)
    }
    if (fs.existsSync(target)) {
      assertPlainFile(target, 'Destino de sincronização')
      if (sha256(target) === item.sha256) continue
    }
    const oldHash = prior.get(item.path)
    const headBlob = manifest.headBlobs[item.path]
    const useHeadBase = advancedHead && !!headBlob && manifest.trackedPaths.includes(item.path)
    const matches = candidate => useHeadBase
      ? fileMatchesGitBlob(root, item.path, candidate, headBlob)
      : oldHash ? sha256(candidate) === oldHash : fileMatchesGitBlob(root, item.path, candidate, headBlob)
    if (fs.existsSync(target)) {
      if (!matches(target)) fail('Arquivo de destino mudou após a verificação do snapshot: ' + item.path)
      moveToSyncBackup(backupRoot, backupRecords, 'replaced', item.path, target, matches)
    }
    const temp = target + '.' + runId + '.sync-tmp'
    if (fs.existsSync(temp)) fail('Temporário de cópia já existe: ' + item.path)
    try {
      fs.copyFileSync(source, temp, fs.constants.COPYFILE_EXCL)
      assertPlainFile(temp, 'Temporário de sincronização')
      if (sha256(temp) !== item.sha256) fail('Hash após cópia diverge: ' + item.path)
      fs.copyFileSync(temp, target, fs.constants.COPYFILE_EXCL)
      assertPlainFile(target, 'Novo arquivo sincronizado')
      if (sha256(target) !== item.sha256) fail('Arquivo no destino mudou durante a sincronização: ' + item.path)
    } finally {
      if (fs.existsSync(temp)) {
        const tempStat = fs.lstatSync(temp)
        if (tempStat.isFile() && !tempStat.isSymbolicLink() &&
            !(process.platform === 'win32' && (tempStat.attributes & 0x400)) && sha256(temp) === item.sha256) {
          fs.unlinkSync(temp)
        }
      }
    }
  }
}

function cleanupSyncBackup(backupRoot, records) {
  const expected = new Map(records.map(item => [item.path, item.sha256]))
  const actual = new Map()
  function visit(directory, prefix) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = normalizePath(prefix ? prefix + '/' + entry.name : entry.name)
      const absolute = path.join(directory, entry.name)
      const stat = fs.lstatSync(absolute)
      if (entry.isSymbolicLink() || !((stat.isDirectory()) || stat.isFile())) fail('Conteúdo inesperado no backup de sincronização: ' + relative)
      if (stat.isDirectory()) visit(absolute, relative)
      else actual.set(relative, sha256(absolute))
    }
  }
  visit(backupRoot, '')
  const divergence = []
  for (const [relative, hash] of actual) if (expected.get(relative) !== hash) divergence.push(relative)
  for (const relative of expected.keys()) if (!actual.has(relative)) divergence.push(relative + ' (ausente)')
  if (divergence.length) fail('Backup de sincronização diverge; preservado para inspeção: ' + divergence.join(', '))
  fs.rmSync(backupRoot, { recursive: true, force: false })
}

function createApprovalChannel() {
  const rl = readline.createInterface({ input: process.stdin })
  const buffered = []
  let pending = null
  let closed = false
  rl.on('line', line => {
    if (pending) {
      const request = pending
      pending = null
      if (line === request.expected) request.resolve()
      else request.reject(new Error('Origem mudou ou execução foi cancelada.'))
    } else buffered.push(line)
  })
  rl.on('close', () => {
    closed = true
    if (pending) {
      pending.reject(new Error('Orquestrador fechou antes da confirmação da origem.'))
      pending = null
    }
  })
  return {
    wait(fingerprintValue) {
      const expected = 'CONTINUE ' + fingerprintValue
      if (buffered.length) {
        const actual = buffered.shift()
        return actual === expected ? Promise.resolve() : Promise.reject(new Error('Origem mudou ou execução foi cancelada.'))
      }
      if (closed) return Promise.reject(new Error('Orquestrador fechou antes da confirmação da origem.'))
      return new Promise((resolve, reject) => {
        pending = { expected, resolve, reject }
      })
    },
    close() {
      rl.close()
      process.stdin.destroy()
    }
  }
}

function generatedBuildPaths(manifests) {
  const expected = new Set()
  for (const manifest of manifests) {
    if (!manifest || !Array.isArray(manifest.files)) continue
    for (const file of manifest.files) {
      if (file.path.endsWith('.ts') && !file.path.endsWith('.d.ts')) {
        expected.add('build/' + file.path.slice(0, -3) + '.js')
      }
      if (file.path === 'src/index.html' || file.path === 'src/style.css') {
        expected.add('build/src/' + file.path.slice(4))
      }
      if (file.path === 'src/player-playback.html' || file.path === 'src/player-playback.css') {
        expected.add('build/src/' + file.path.slice(4))
      }
      if (file.path === 'src/player-control.html' || file.path === 'src/player-control.css' ||
          file.path === 'src/welcome.html' || file.path === 'src/welcome.css') {
        expected.add('build/src/' + file.path.slice(4))
      }
      if (file.path === 'src/standalone-player.html' || file.path === 'src/standalone-player.css') {
        expected.add('build/src/' + file.path.slice(4))
      }
      if (file.path === 'src/player-playback-renderer.ts') {
        expected.add('build/src/player-playback.js')
      }
      if (file.path === 'src/player-control-renderer.ts') {
        expected.add('build/src/player-control-renderer.bundle.js')
      }
      if (file.path === 'src/welcome-renderer.ts') {
        expected.add('build/src/welcome-renderer.bundle.js')
      }
      if (file.path === 'src/standalone-player-renderer.ts') {
        expected.add('build/src/standalone-player-renderer.bundle.js')
      }
      if (file.path === 'standalone-player-preload.ts' || file.path === 'player-preload.ts') {
        expected.add('build/standalone-player-ui-preload.js')
      }
      if (file.path === 'standalone-player-preload.ts') {
        expected.add('build/standalone-player-preload.bundle.js')
      }
      if (file.path.startsWith('src/assets/')) expected.add('build/' + file.path)
    }
  }
  return expected
}

function prepareFreshBuild(root, runId) {
  const buildPath = path.join(root, 'build')
  const backupPath = path.join(root, '.git', 'karaoke-queue-build-backup-' + runId)
  if (fs.existsSync(backupPath)) fail('Backup de build para este runId já existe; nenhum conteúdo foi sobrescrito.')
  if (!fs.existsSync(buildPath)) return { buildPath, backupPath, hadBuild: false, runId }
  const rootStat = fs.lstatSync(root)
  const buildStat = fs.lstatSync(buildPath)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !buildStat.isDirectory() || buildStat.isSymbolicLink() ||
      (process.platform === 'win32' && ((rootStat.attributes | buildStat.attributes) & 0x400))) {
    fail('build/ ou o checkout não é um diretório local seguro.')
  }
  fs.renameSync(buildPath, backupPath)
  return { buildPath, backupPath, hadBuild: true, runId }
}

function verifyBuildOutput(root, ...manifests) {
  const buildPath = path.join(root, 'build')
  const expected = generatedBuildPaths(manifests)
  if (!fs.existsSync(buildPath)) fail('Build nativo ausente após compile.')
  const actual = new Set()
  function inspect(directory, relative) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name)
      const child = relative ? relative + '/' + entry.name : entry.name
      const stat = fs.lstatSync(absolute)
      if (entry.isSymbolicLink() || (process.platform === 'win32' && (stat.attributes & 0x400))) {
        fail('Link/reparse inesperado no build Windows: ' + child)
      } else if (entry.isDirectory()) {
        inspect(absolute, child)
      } else if (!entry.isFile()) {
        fail('Entrada especial inesperada no build Windows: ' + child)
      } else {
        actual.add('build/' + child.replaceAll('\\', '/'))
      }
    }
  }
  inspect(buildPath, '')
  const missing = [...expected].filter(filePath => !actual.has(filePath))
  const extra = [...actual].filter(filePath => !expected.has(filePath))
  if (missing.length || extra.length) {
    fail('Inventário do build diverge dos outputs-fonte conhecidos:' +
      (missing.length ? '\\n ausentes:\\n' + missing.map(item => '  - ' + item).join('\\n') : '') +
      (extra.length ? '\\n extras:\\n' + extra.map(item => '  - ' + item).join('\\n') : ''))
  }
  return { fileCount: actual.size, files: [...actual].sort() }
}

function restorePreviousBuild(root, state, manifests) {
  if (!state || !state.hadBuild) return
  if (fs.existsSync(state.buildPath)) {
    verifyBuildOutput(root, ...manifests)
    fs.rmSync(state.buildPath, { recursive: true, force: false })
  }
  if (!fs.existsSync(state.backupPath)) fail('Backup de build original ausente; não será apagado conteúdo do destino.')
  if (fs.existsSync(state.buildPath)) fail('build/ já existe; backup original não será sobrescrito.')
  fs.renameSync(state.backupPath, state.buildPath)
}

function commandWithStdio(executable, args, cwd, label) {
  const result = spawnSync(executable, args, { cwd, stdio: 'inherit', shell: false })
  if (result.status !== 0) fail(label + ' falhou com código ' + result.status)
}

function runNpmCommand(root, text, label) {
  commandWithStdio(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', text], root, label)
}

function focusResult(text) {
  const rows = text.split(/\r?\n/)
    .filter(line => line.startsWith('WINDOW_ACTIVATION '))
    .map(line => {
      try { return JSON.parse(line.slice('WINDOW_ACTIVATION '.length)) } catch { return null }
    })
    .filter(Boolean)
  const restore = rows.find(row => row.scenario === 'minimized-window restore')
  const show = rows.find(row => row.scenario === 'hidden-window show')
  const passed = !!restore && !!show &&
    [restore, show].every(row => row.focusEventObserved === true && row.focused === true)
  return { status: passed ? 'PASS' : 'NOT VERIFIED', rows }
}

function requiresWindowFocus(playbackMode) {
  return ![
    '--playback-chromium-final',
    '--playback-chromium-interactive',
    '--player-playback',
    '--standalone-playback',
    '--standalone-integration',
    '--player-recovery',
    '--player-control',
    '--standalone-options',
    '--standalone-production'
  ].includes(playbackMode)
}

function selectWindowsTestSuites(playbackMode) {
  const focusedChromium = playbackMode === '--playback-chromium-final' || playbackMode === '--playback-chromium-interactive'
  const focusedPlayerPlayback = playbackMode === '--player-playback'
  const focusedStandalonePlayback = playbackMode === '--standalone-playback'
  const focusedStandaloneIntegration = playbackMode === '--standalone-integration'
  const focusedPlayerRecovery = playbackMode === '--player-recovery'
  const focusedPlayerControl = playbackMode === '--player-control'
  const focusedStandaloneOptions = playbackMode === '--standalone-options'
  const focusedStandaloneProduction = playbackMode === '--standalone-production'
  if (focusedPlayerRecovery) return [
    { name: 'player-playback-recovery-unit', script: 'build/tests/player-playback-recovery.test.js' },
    { name: 'player-playback-recovery-electron', script: 'build/tests/player-playback-recovery-electron.js' }
  ]
  if (focusedPlayerPlayback) return [{ name: 'player-playback-electron', script: 'build/tests/player-playback-electron.js' }]
  if (focusedStandalonePlayback) return [
    { name: 'standalone-player-contracts-unit', script: 'build/tests/standalone-player-contracts.test.js' },
    { name: 'standalone-player-runtime-unit', script: 'build/tests/standalone-player-runtime.test.js' },
    { name: 'standalone-player-sequence-unit', script: 'build/tests/standalone-player-sequence.test.js' },
    { name: 'standalone-player-interaction-unit', script: 'build/tests/standalone-player-interaction.test.js' },
    { name: 'standalone-player-playback-adapter-unit', script: 'build/tests/standalone-player-playback-adapter.test.js' },
    { name: 'player-playback-unit', script: 'build/tests/player-playback.test.js' },
    { name: 'player-recovery-unit', script: 'build/tests/player-playback-recovery.test.js' },
    { name: 'standalone-player-playback-electron', script: 'build/tests/standalone-player-playback-electron.js' }
  ]
  if (focusedStandaloneIntegration) return [
    { name: 'standalone-player-contracts-unit', script: 'build/tests/standalone-player-contracts.test.js' },
    { name: 'standalone-player-runtime-unit', script: 'build/tests/standalone-player-runtime.test.js' },
    { name: 'standalone-player-sequence-unit', script: 'build/tests/standalone-player-sequence.test.js' },
    { name: 'standalone-player-interaction-unit', script: 'build/tests/standalone-player-interaction.test.js' },
    { name: 'standalone-player-interaction-transport-unit', script: 'build/tests/standalone-player-interaction-transport.test.js' },
    { name: 'standalone-player-ipc-unit', script: 'build/tests/standalone-player-ipc.test.js' },
    { name: 'standalone-player-playback-adapter-unit', script: 'build/tests/standalone-player-playback-adapter.test.js' },
    { name: 'player-playback-unit', script: 'build/tests/player-playback.test.js' },
    { name: 'player-recovery-unit', script: 'build/tests/player-playback-recovery.test.js' },
    { name: 'standalone-player-integration-electron', script: 'build/tests/standalone-player-integration-electron.js' }
  ]
  if (focusedPlayerControl) return [{ name: 'player-control-electron', script: 'build/tests/player-control-electron.js' }]
  if (focusedStandaloneOptions) return [
    { name: 'standalone-player-options-unit', script: 'build/tests/standalone-player-options.test.js' },
    { name: 'standalone-player-ipc-unit', script: 'build/tests/standalone-player-ipc.test.js' },
    { name: 'standalone-player-metadata-preview-unit', script: 'build/tests/standalone-player-metadata-preview.test.js' },
    { name: 'music-catalog-unit', script: 'build/tests/music-catalog.test.js' },
    { name: 'standalone-options-electron', script: 'build/tests/standalone-player-ui-electron.js' }
  ]
  if (focusedStandaloneProduction) return [
    { name: 'standalone-player-contracts-unit', script: 'build/tests/standalone-player-contracts.test.js' },
    { name: 'standalone-player-runtime-unit', script: 'build/tests/standalone-player-runtime.test.js' },
    { name: 'standalone-player-sequence-unit', script: 'build/tests/standalone-player-sequence.test.js' },
    { name: 'standalone-player-ipc-unit', script: 'build/tests/standalone-player-ipc.test.js' },
    { name: 'player-playback-unit', script: 'build/tests/player-playback.test.js' },
    { name: 'player-recovery-unit', script: 'build/tests/player-playback-recovery.test.js' },
    { name: 'standalone-player-production-electron', script: 'build/tests/standalone-player-production-electron.js' }
  ]
  if (focusedChromium) return [{ name: 'playback-harness-unit', script: 'scripts/playback-engine-evaluation.test.cjs' }]
  return [
    { name: 'database-migration-unit', script: 'build/tests/database-migration.test.js' },
    { name: 'operating-mode-unit', script: 'build/tests/operating-mode.test.js' },
    { name: 'video-library-unit', script: 'build/tests/video-library.test.js' },
    { name: 'music-catalog-unit', script: 'build/tests/music-catalog.test.js' },
    { name: 'multi-instance', script: 'build/tests/multi-instance-electron.js' },
    { name: 'operating-modes', script: 'build/tests/operating-modes-electron.js' },
    { name: 'video-library', script: 'build/tests/video-library-electron.js' },
    { name: 'music-catalog', script: 'build/tests/music-catalog-electron.js' }
  ]
}

function residualProcessCheck(profileRoot) {
  const escaped = profileRoot.replaceAll("'", "''")
  const script = "$ErrorActionPreference='Stop'; try { $needle='" + escaped + "'; $items=@(Get-CimInstance Win32_Process -Filter \"Name = 'electron.exe'\" -ErrorAction Stop | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($needle) }); foreach($item in $items){ Write-Output ('RESIDUAL_ELECTRON pid=' + $item.ProcessId) }; if($items.Count){ exit 3 } } catch { Write-Error $_; exit 4 }"
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', shell: false })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.status === null) return { status: 'NOT VERIFIED', detail: String(result.error || 'PowerShell não concluiu a consulta.') }
  if (result.status !== 0) return { status: 'FAIL', detail: 'Há processo Electron associado ao perfil deste run.' }
  return { status: 'PASS', detail: 'Nenhum processo Electron com o perfil exclusivo deste run permaneceu.' }
}

async function windowsWorker(root, stage, playbackEvaluation = false, playbackMode = null) {
  if (process.platform !== 'win32') fail('O worker precisa de Node.js nativo Windows.')
  root = path.resolve(root)
  stage = path.resolve(stage)
  const manifest = validateManifest(JSON.parse(fs.readFileSync(path.join(stage, 'metadata', 'snapshot.json'), 'utf8')))
  const runId = path.basename(stage).replace(/^karaoke-queue-windows-stage-/, '')
  const gitDir = path.join(root, '.git')
  const gitStat = fs.lstatSync(gitDir)
  if (!gitStat.isDirectory() || gitStat.isSymbolicLink() || (process.platform === 'win32' && (gitStat.attributes & 0x400))) {
    fail('O checkout Windows não possui .git independente e local.')
  }
  let release = acquireLock(root, runId)
  const markerPath = path.join(gitDir, MARKER)
  const pendingPath = path.join(gitDir, PENDING)
  const reportPath = path.join(gitDir, REPORT)
  let profileRoot
  let buildState
  let preserveLock = false
  let approvals
  let marker
  let reportStage = 'SYNC'
  let reportInitialized = false
  try {
    if (fs.existsSync(reportPath)) {
      let previousReport
      try { previousReport = JSON.parse(fs.readFileSync(reportPath, 'utf8')) } catch {
        fail('O relatório local existente não é reconhecido pelo runner; nenhum arquivo foi sobrescrito.')
      }
      if (previousReport.owner !== REPORT_OWNER) fail('O relatório local existente pertence a outro uso; nenhum arquivo foi sobrescrito.')
    }
    const saveReport = report => atomicWrite(reportPath, JSON.stringify({
      owner: REPORT_OWNER,
      runId,
      branch: manifest.branch,
      head: manifest.head,
      fingerprint: manifest.fingerprint,
      ...report
    }))
    saveReport({
      status: 'RUNNING',
      stage: reportStage,
      startedAt: new Date().toISOString()
    })
    reportInitialized = true
    if (fs.existsSync(pendingPath)) fail('Sincronização anterior incompleta; revise ou reconstrua o checkout Windows.')
    const current = gitState(root)
    if (current.branch !== manifest.branch) fail('Branch diferente: WSL=' + manifest.branch + ', Windows=' + current.branch)
    if (fs.existsSync(markerPath)) {
      marker = validateManifest(JSON.parse(fs.readFileSync(markerPath, 'utf8')))
      if (marker.branch !== current.branch || marker.head !== current.head) fail('Branch/HEAD mudou desde o último snapshot registrado.')
      verifySnapshotDirectory(root, marker)
    } else {
      const legacyPath = path.join(stage, 'metadata', 'legacy-baseline.json')
      if (fs.existsSync(legacyPath)) {
        marker = validateManifest(JSON.parse(fs.readFileSync(legacyPath, 'utf8')))
        if (marker.branch !== current.branch || marker.head !== current.head) {
          fail('O manifesto legado não corresponde à branch/HEAD do checkout Windows.')
        }
        verifySnapshotDirectory(root, marker)
        process.stdout.write('SYNC LEGACY BASELINE PASS inventory=' + marker.files.length + ' fingerprint=' + marker.fingerprint + '\n')
      } else {
        marker = verifyBootstrap(root, manifest)
      }
      atomicWrite(markerPath, JSON.stringify(marker))
    }
    assertIndexMatchesHead(root)

    atomicWrite(pendingPath, JSON.stringify({
      runId,
      fromFingerprint: marker.fingerprint,
      targetFingerprint: manifest.fingerprint,
      startedAt: new Date().toISOString()
    }))
    const syncBackupRoot = path.join(gitDir, 'karaoke-queue-sync-backup-' + runId)
    if (fs.existsSync(syncBackupRoot)) fail('Backup de sincronização para este runId já existe.')
    fs.mkdirSync(syncBackupRoot)
    const syncBackupRecords = []
    const advancedHead = advanceHead(root, marker, manifest, stage, syncBackupRoot, syncBackupRecords)
    syncSnapshot(root, stage, manifest, marker, runId, advancedHead, syncBackupRoot, syncBackupRecords)
    const afterSync = gitState(root)
    if (afterSync.branch !== manifest.branch || afterSync.head !== manifest.head) fail('Branch/HEAD não corresponde à origem após sincronização.')
    verifySnapshotDirectory(root, manifest)
    cleanupSyncBackup(syncBackupRoot, syncBackupRecords)
    atomicWrite(markerPath, JSON.stringify(manifest))
    fs.unlinkSync(pendingPath)
    process.stdout.write('SYNC PASS branch=' + manifest.branch + ' HEAD=' + manifest.head + ' files=' + manifest.files.length + '\n')
    approvals = createApprovalChannel()
    process.stdout.write('KQ_SYNC_READY ' + manifest.fingerprint + ' ' + manifest.branch.replaceAll(' ', '_') + ' ' + manifest.head + '\n')
    await approvals.wait(manifest.fingerprint)

    verifySnapshotDirectory(root, manifest)
    process.stdout.write('VERIFY PASS fingerprint=' + manifest.fingerprint + '\n')
    if (!process.execPath.startsWith(root + path.sep)) process.stdout.write('NODE executable=native Windows Node from PATH\n')
    const nodeInfo = spawnSync(process.execPath, ['-p', 'JSON.stringify({platform:process.platform,version:process.version,arch:process.arch})'], { cwd: root, encoding: 'utf8', shell: false })
    if (nodeInfo.status !== 0 || !nodeInfo.stdout.includes('"platform":"win32"')) fail('Node do Windows não confirmou process.platform=win32.')
    process.stdout.write('RUNTIME PASS node=' + nodeInfo.stdout.trim() + '\n')
    runNpmCommand(root, 'npm.cmd --version', 'npm.cmd --version')

    process.stdout.write('DEPENDENCIES START npm.cmd ci (node_modules e cache no checkout Windows)\n')
    reportStage = 'DEPENDENCIES'
    saveReport({ status: 'RUNNING', stage: reportStage, startedAt: new Date().toISOString() })
    runNpmCommand(root, 'npm.cmd ci --cache .npm-cache', 'npm.cmd ci')
    const electronExe = spawnSync(process.execPath, ['-p', 'require("electron")'], { cwd: root, encoding: 'utf8', shell: false })
    const playwrightEntry = spawnSync(process.execPath, ['-p', 'require.resolve("playwright")'], { cwd: root, encoding: 'utf8', shell: false })
    if (electronExe.status !== 0 || playwrightEntry.status !== 0) fail('Electron/Playwright não resolvem no node_modules Windows local.')
    const electronValue = lastNonEmptyLine(electronExe.stdout)
    const playwrightValue = lastNonEmptyLine(playwrightEntry.stdout)
    const electronPath = path.resolve(electronValue || '')
    const playwrightPath = path.resolve(playwrightValue || '')
    if (!electronPath.startsWith(root + path.sep) || !fs.existsSync(electronPath)) fail('Electron não está no checkout de validação: ' + electronPath)
    if (!playwrightPath.startsWith(root + path.sep) || !fs.existsSync(playwrightPath)) fail('Playwright não está no checkout de validação: ' + playwrightPath)
    process.stdout.write('DEPENDENCIES PASS electron=' + path.relative(root, electronPath) +
      ' playwright=' + path.relative(root, playwrightPath) + '\n')

    reportStage = 'BUILD'
    buildState = prepareFreshBuild(root, runId)
    verifySnapshotDirectory(root, manifest)
    saveReport({
      status: 'RUNNING',
      stage: reportStage,
      startedAt: new Date().toISOString(),
      hadPreviousBuild: buildState.hadBuild
    })
    process.stdout.write('KQ_SOURCE_GATE BUILD ' + manifest.fingerprint + '\n')
    await approvals.wait(manifest.fingerprint)
    process.stdout.write('BUILD START npm.cmd run compile\n')
    runNpmCommand(root, 'npm.cmd run compile', 'npm.cmd run compile')
    verifyBuildOutput(root, marker, manifest)
    if (!fs.existsSync(path.join(root, 'build', 'main.js'))) fail('build/main.js não foi gerado no Windows.')
    process.stdout.write('BUILD PASS native Windows artifacts\n')

    const gui = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      'if ([Environment]::UserInteractive -and (Get-Process explorer -ErrorAction SilentlyContinue)) { exit 0 } else { exit 1 }'],
    { encoding: 'utf8', shell: false })
    if (gui.status !== 0) {
      reportStage = 'TEST'
      process.stdout.write('TEST NOT RUN: suíte de minimize/restore/focus exige desktop Windows interativo.\n')
      fail('E2E não executado porque a sessão gráfica Windows não está disponível.', 2)
    }
    profileRoot = path.join(os.tmpdir(), 'karaoke-queue-windows-e2e-' + runId)
    if (fs.existsSync(profileRoot)) fail('Perfil temporário já existe; nenhum dado foi alterado: ' + profileRoot)
    const env = { ...process.env, KARAOKE_TEST_TEMP_ROOT: profileRoot }
    verifySnapshotDirectory(root, manifest)
    verifyBuildOutput(root, marker, manifest)
    reportStage = 'TEST'
    saveReport({
      status: 'RUNNING',
      stage: reportStage,
      startedAt: new Date().toISOString(),
      profileName: path.basename(profileRoot)
    })
    process.stdout.write('KQ_SOURCE_GATE TEST ' + manifest.fingerprint + '\n')
    await approvals.wait(manifest.fingerprint)
    const focusedChromium = playbackMode === '--playback-chromium-final' || playbackMode === '--playback-chromium-interactive'
    const focusedPlayerPlayback = playbackMode === '--player-playback'
    const focusedStandalonePlayback = playbackMode === '--standalone-playback'
    const focusedStandaloneIntegration = playbackMode === '--standalone-integration'
    const focusedPlayerRecovery = playbackMode === '--player-recovery'
    const focusedPlayerControl = playbackMode === '--player-control'
    const focusedStandaloneOptions = playbackMode === '--standalone-options'
    const focusedStandaloneProduction = playbackMode === '--standalone-production'
    if (focusedPlayerPlayback && !process.env.KQ_PLAYER_TEST_MEDIA_DIR) {
      fail('O modo player-playback requer KQ_PLAYER_TEST_MEDIA_DIR com os vídeos de teste de leitura.')
    }
    if (focusedStandalonePlayback && !process.env.KQ_PLAYER_TEST_MEDIA_DIR) {
      fail('O modo standalone-playback requer KQ_PLAYER_TEST_MEDIA_DIR com os vídeos MP4 de teste de leitura.')
    }
    if (focusedStandaloneIntegration && !process.env.KQ_PLAYER_TEST_MEDIA_DIR) {
      fail('O modo standalone-integration requer KQ_PLAYER_TEST_MEDIA_DIR com os vídeos MP4 de teste de leitura.')
    }
    if (focusedPlayerRecovery && !process.env.KQ_PLAYER_RECOVERY_TEST_MEDIA_DIR) {
      fail('O modo player-recovery requer KQ_PLAYER_RECOVERY_TEST_MEDIA_DIR com os vídeos de teste de leitura.')
    }
    if (focusedPlayerControl && !process.env.KQ_PLAYER_TEST_MEDIA_DIR) {
      fail('O modo player-control requer KQ_PLAYER_TEST_MEDIA_DIR com os vídeos de teste de leitura.')
    }
    if (focusedStandaloneProduction) {
      const mediaPath = process.env.KQ_PLAYER_TEST_MEDIA_DIR
      if (!mediaPath || !path.isAbsolute(mediaPath) || !fs.existsSync(mediaPath) || !fs.statSync(mediaPath).isDirectory() ||
          !fs.existsSync(path.join(mediaPath, '01001.mp4')) || !fs.statSync(path.join(mediaPath, '01001.mp4')).isFile()) {
        fail('O modo standalone-production requer KQ_PLAYER_TEST_MEDIA_DIR com 01001.mp4 real no Windows.')
      }
    }
    if (focusedStandaloneOptions) {
      if (!process.env.KQ_PLAYER_TEST_MEDIA_DIR) {
        fail('O modo standalone-options requer KQ_PLAYER_TEST_MEDIA_DIR com o MP4 real de teste e a biblioteca local.')
      }
      for (const variable of ['KQ_STANDALONE_C8_REPRO_ORIGINAL_CSV', 'KQ_STANDALONE_C8_REPRO_REPLACEMENT_CSV']) {
        const value = process.env[variable]
        if (!value || !path.isAbsolute(value) || !fs.existsSync(value) || !fs.statSync(value).isFile()) {
          fail('O modo standalone-options requer ' + variable + ' como caminho absoluto para arquivo regular Windows.')
        }
      }
    }
    process.stdout.write(focusedChromium
      ? 'TEST START isolated Chromium playback harness; interactive Windows desktop\n'
      : focusedPlayerPlayback ? 'TEST START production Chromium service in isolated Electron host\n'
      : focusedStandalonePlayback ? 'TEST START isolated Standalone sequence/runtime with real Chromium and MP4; no production Main wiring\n'
      : focusedStandaloneIntegration ? 'TEST START isolated Standalone B2/Preload/IPC/Main/Chromium integration with real MP4; no production Main wiring\n'
      : focusedPlayerRecovery ? 'TEST START production Player recovery in isolated Electron processes; Windows desktop\n'
      : focusedPlayerControl ? 'TEST START isolated Player control UI through production Main/Preload/IPC and Chromium host\n'
      : focusedStandaloneOptions ? 'TEST START focused C8 options/catalog UI in real Electron + Playwright + SQLite + MP4; Windows paths supplied read-only\n'
      : focusedStandaloneProduction ? 'TEST START C9 production Standalone Main/Preload/IPC/shutdown with real Electron, MP4 and isolated SQLite\n'
      : 'TEST START Electron real + Playwright + SQLite temporário; sessão gráfica Windows\n')
    if (focusedStandaloneOptions) env.KQ_STANDALONE_C8_ONLY = '1'
    const suiteResults = []
    let suites = selectWindowsTestSuites(playbackMode)
    if (playbackEvaluation || focusedChromium) {
      const playbackArgs = playbackMode === '--playback-chromium-final'
        ? ['--chromium-final-validation']
        : playbackMode === '--playback-chromium-interactive' ? ['--interactive-chromium'] : []
      suites.push({ name: 'playback-engine-evaluation', script: 'scripts/playback-engine-evaluation.cjs', args: playbackArgs })
    }
    for (const suite of suites) {
      const result = spawnSync(process.execPath, [suite.script, ...(suite.args || [])], {
        cwd: root, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell: false
      })
      suiteResults.push({ ...suite, ...result })
      if (result.stdout) process.stdout.write(result.stdout)
      if (result.stderr) process.stderr.write(result.stderr)
      if (result.status !== 0) break
    }
    const multiInstance = suiteResults.find(result => result.name === 'multi-instance')
    const focus = requiresWindowFocus(playbackMode)
      ? focusResult(multiInstance?.stdout || '')
      : { status: 'NOT APPLICABLE', rows: [] }
    process.stdout.write('WINDOW_FOCUS ' + focus.status + ' evidence=' + JSON.stringify(focus.rows) + '\n')
    reportStage = 'CLEANUP'
    const residuals = residualProcessCheck(profileRoot)
    process.stdout.write('RESIDUAL_PROCESS_CHECK ' + residuals.status + ' ' + residuals.detail + '\n')
    if (residuals.status !== 'PASS') {
      preserveLock = true
      fail('Verificação de processos residuais incompleta ou falhou: ' + residuals.detail)
    }
    if (fs.existsSync(profileRoot)) fail('O teste deixou o perfil temporário: ' + profileRoot)
    process.stdout.write('CLEANUP PASS perfis temporários removidos; nenhum processo residual\n')
    const failedSuite = suiteResults.find(result => result.status !== 0)
    if (failedSuite) fail('E2E Windows ' + failedSuite.name + ' falhou com código ' + failedSuite.status + ': ' + (failedSuite.stderr || failedSuite.error || ''))
    if (requiresWindowFocus(playbackMode) && focus.status !== 'PASS') fail('Foco da janela não foi observado como confirmado; causa não presumida.')
    verifyBuildOutput(root, marker, manifest)
    process.stdout.write(focusedChromium
      ? 'TEST PASS focused Chromium playback evaluation; unrelated regression suites not run by request\n'
      : focusedPlayerPlayback ? 'TEST PASS production Chromium playback service integration; unrelated regression suites not run by request\n'
      : focusedStandalonePlayback ? 'TEST PASS focused Standalone real Chromium/MP4 integration; unrelated Controller/Combined suites not run by request\n'
      : focusedStandaloneIntegration ? 'TEST PASS focused Standalone B2/IPC/Chromium/MP4 integration; unrelated Controller/Combined suites not run by request\n'
      : focusedPlayerRecovery ? 'TEST PASS production Player recovery Electron integration; unrelated regression suites not run by request\n'
      : focusedPlayerControl ? 'TEST PASS production Player control UI and playback integration; unrelated regression suites not run by request\n'
      : focusedStandaloneOptions ? 'TEST PASS focused C8 options/catalog UI through real Electron, Playwright, IPC, SQLite and MP4; native file-picker window is represented by the test-only dialog port\n'
      : focusedStandaloneProduction ? 'TEST PASS production C9 Standalone Electron lifecycle with real MP4 and recovery; unrelated Controller/Combined suites not run by request\n'
      : 'TEST PASS database migration, operating-mode, video-library and music-catalog unit; multi-instance, operating-modes, video-library and music-catalog Electron suites\n')
    restorePreviousBuild(root, buildState, [marker, manifest])
    buildState = null
    reportStage = 'REPORT'
    const finalState = gitState(root)
    if (finalState.branch !== manifest.branch || finalState.head !== manifest.head) fail('Branch/HEAD do checkout mudou durante os testes.')
    verifySnapshotDirectory(root, manifest)
    saveReport({ status: 'PASS', node: process.version, focus: focus.status, testedAt: new Date().toISOString() })
    const releaseLock = release
    release = null
    try { releaseLock() } catch (error) {
      preserveLock = true
      throw error
    }
    process.stdout.write('REPORT PASS branch=' + manifest.branch + ' HEAD=' + manifest.head + ' fingerprint=' + manifest.fingerprint + '\n')
  } catch (error) {
    if (buildState && buildState.hadBuild) {
      try {
        restorePreviousBuild(root, buildState, [marker, manifest])
        buildState = null
      } catch (restoreError) {
        preserveLock = true
        error.message += '; o build foi preservado para inspeção: ' + restoreError.message
      }
    }
    if (reportInitialized) {
      try {
        atomicWrite(reportPath, JSON.stringify({
          owner: REPORT_OWNER,
          runId,
          status: error.exitCode === 2 ? 'NOT RUN' : 'FAIL',
          stage: reportStage,
          branch: manifest.branch,
          head: manifest.head,
          fingerprint: manifest.fingerprint,
          reason: error.message,
          testedAt: new Date().toISOString()
        }))
      } catch {}
    }
    throw error
  } finally {
    // Pending is retained after an interrupted sync so another run cannot test a partial tree.
    if (approvals) approvals.close()
    if (release && !preserveLock) release()
  }
}

function powershellLauncher(stagePath, runId, playbackEvaluation = false, playbackMode = null) {
  if (playbackMode !== null && !['--playback-chromium-final', '--playback-chromium-interactive', '--player-playback', '--standalone-playback', '--standalone-integration', '--player-recovery', '--player-control', '--standalone-options', '--standalone-production'].includes(playbackMode)) {
    fail('Modo de playback não permitido para o worker Windows.')
  }
  const data = Buffer.from(JSON.stringify({ stagePath, runId, playbackEvaluation, playbackMode }), 'utf8').toString('base64')
  return [
    "$ErrorActionPreference = 'Stop'",
    "$payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + data + "')) | ConvertFrom-Json",
    '$checkout = $env:KARAOKE_QUEUE_WIN_CHECKOUT',
    "if ([string]::IsNullOrWhiteSpace($checkout)) { $checkout = Join-Path $env:USERPROFILE 'source\\karaoke-queue-win' }",
    '$checkout = [IO.Path]::GetFullPath($checkout)',
    "if ($checkout -notmatch '^[A-Za-z]:\\\\') { throw 'O checkout precisa usar um caminho local em letra de unidade NTFS, não UNC.' }",
    "if (-not (Test-Path -LiteralPath $checkout -PathType Container)) { throw 'Checkout Windows ausente; configure KARAOKE_QUEUE_WIN_CHECKOUT ou reconstrua o clone isolado.' }",
    '$drive = New-Object IO.DriveInfo ([IO.Path]::GetPathRoot($checkout))',
    "if ($drive.DriveFormat -ne 'NTFS') { throw ('O checkout precisa estar em NTFS; encontrado ' + $drive.DriveFormat) }",
    "$stageName = 'karaoke-queue-windows-stage-' + $payload.runId",
    '$localStage = Join-Path $env:TEMP $stageName',
    "if (Test-Path -LiteralPath $localStage) { throw 'Diretório temporário já existe; nada foi sobrescrito.' }",
    'New-Item -ItemType Directory -Path $localStage | Out-Null',
    'try {',
    "  Copy-Item -Path ($payload.stagePath.TrimEnd('\\') + '\\*') -Destination $localStage -Recurse -Force",
    "  $worker = Join-Path $localStage 'tree\\scripts\\run-windows-native-tests.cjs'",
    "  if (-not (Test-Path -LiteralPath $worker -PathType Leaf)) { throw 'Worker nativo ausente no snapshot.' }",
    '  Push-Location $checkout',
    '  try {',
    '    $workerArgs = @("--windows-worker", $checkout, $localStage)',
    '    if ($payload.playbackEvaluation) { $workerArgs += "--playback-evaluation" }',
    '    if ($payload.playbackMode -eq "--playback-chromium-final") { $workerArgs += "--playback-chromium-final" }',
    '    elseif ($payload.playbackMode -eq "--playback-chromium-interactive") { $workerArgs += "--playback-chromium-interactive" }',
    '    elseif ($payload.playbackMode -eq "--player-playback") { $workerArgs += "--player-playback" }',
    '    elseif ($payload.playbackMode -eq "--standalone-playback") { $workerArgs += "--standalone-playback" }',
    '    elseif ($payload.playbackMode -eq "--standalone-integration") { $workerArgs += "--standalone-integration" }',
    '    elseif ($payload.playbackMode -eq "--player-recovery") { $workerArgs += "--player-recovery" }',
    '    elseif ($payload.playbackMode -eq "--player-control") { $workerArgs += "--player-control" }',
    '    elseif ($payload.playbackMode -eq "--standalone-options") { $workerArgs += "--standalone-options" }',
    '    elseif ($payload.playbackMode -eq "--standalone-production") { $workerArgs += "--standalone-production" }',
    '    & node.exe $worker @workerArgs',
    '    $workerExit = $LASTEXITCODE',
    '  } finally { Pop-Location }',
    '} finally {',
    '  if (Test-Path -LiteralPath $localStage) { Remove-Item -LiteralPath $localStage -Recurse -Force }',
    '}',
    'if ($null -eq $workerExit) { $workerExit = 1 }',
    'exit $workerExit'
  ].join('\n')
}

function powershellCancellation(runId, recoveryOnly = false) {
  if (typeof runId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId)) {
    fail('runId inválido para recuperação de cancelamento.')
  }
  if (typeof recoveryOnly !== 'boolean') fail('Modo de recuperação do runner inválido.')
  return [
    "$ErrorActionPreference = 'Stop'",
    "$runId = '" + runId + "'",
    '$recoveryOnly = $' + String(recoveryOnly).toLowerCase(),
    '$checkout = $env:KARAOKE_QUEUE_WIN_CHECKOUT',
    "if ([string]::IsNullOrWhiteSpace($checkout)) { $checkout = Join-Path $env:USERPROFILE 'source\\karaoke-queue-win' }",
    '$checkout = [IO.Path]::GetFullPath($checkout)',
    '$gitDir = Join-Path $checkout ".git"',
    '$lock = Join-Path $gitDir "' + LOCK + '"',
    '$reportPath = Join-Path $gitDir "' + REPORT + '"',
    '$deadline = (Get-Date).AddSeconds(5)',
    '$worker = $null',
    '$lockInfo = $null',
    'function Save-CancelReport($path, $value) {',
    '  $temp = $path + "." + [guid]::NewGuid().ToString() + ".tmp"',
    '  [IO.File]::WriteAllText($temp, ($value | ConvertTo-Json -Depth 8), (New-Object Text.UTF8Encoding($false)))',
    '  Move-Item -LiteralPath $temp -Destination $path -Force',
    '}',
    'try {',
    '  while ((Get-Date) -lt $deadline -and -not $worker) {',
    '    if (Test-Path -LiteralPath $lock) {',
    '      try {',
    '        $info = Get-Content -Raw -LiteralPath $lock | ConvertFrom-Json',
    '        if ($info.runId -eq $runId) {',
    '          $lockInfo = $info',
    '          $candidate = Get-CimInstance Win32_Process -Filter ("ProcessId = " + [int]$info.pid) -ErrorAction Stop',
    '          if ($candidate -and $candidate.Name -eq "node.exe" -and $candidate.CommandLine -and $candidate.CommandLine.Contains($runId) -and $candidate.CommandLine.Contains("--windows-worker") -and $candidate.CommandLine.Contains("run-windows-native-tests.cjs")) { $worker = $candidate }',
    '        }',
    '      } catch { }',
    '    }',
    '    if (-not $worker) {',
    '      try { $worker = Get-CimInstance Win32_Process -Filter "Name = \'node.exe\'" -ErrorAction Stop | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($runId) -and $_.CommandLine.Contains("--windows-worker") -and $_.CommandLine.Contains("run-windows-native-tests.cjs") } | Select-Object -First 1 } catch { Write-Output ("CANCEL NOT VERIFIED: CIM query failed: " + $_.Exception.Message); exit 5 }',
    '    }',
    '    if (-not $worker) { Start-Sleep -Milliseconds 100 }',
    '  }',
    '  if (-not $lockInfo) { Write-Output "CANCEL NOT VERIFIED: owned run lock was not found."; exit 2 }',
    '  if (-not (Test-Path -LiteralPath $reportPath -PathType Leaf)) { Write-Output "CANCEL NOT VERIFIED: owned report is missing."; exit 8 }',
    '  $report = Get-Content -Raw -LiteralPath $reportPath | ConvertFrom-Json',
    '  $validReportStatuses = @("RUNNING")',
    '  if ($recoveryOnly) { $validReportStatuses += "CANCELLED_RECOVERY_REQUIRED" }',
    '  if ($report.owner -ne "' + REPORT_OWNER + '" -or $report.runId -ne $runId -or $report.status -notin $validReportStatuses) { Write-Output "CANCEL NOT VERIFIED: report owner/runId/status mismatch."; exit 8 }',
    '  if ($recoveryOnly -and $worker) { Write-Output "CANCEL NOT VERIFIED: the matching worker is still active; use the normal runner cancellation path."; exit 3 }',
    '  if ($worker) {',
    '    $processes = @(Get-CimInstance Win32_Process -ErrorAction Stop)',
    '    $treeIds = New-Object \'System.Collections.Generic.HashSet[int]\'',
    '    [void]$treeIds.Add([int]$worker.ProcessId)',
    '    $changed = $true',
    '    while ($changed) {',
    '      $changed = $false',
    '      foreach ($process in $processes) { if ($treeIds.Contains([int]$process.ParentProcessId) -and $treeIds.Add([int]$process.ProcessId)) { $changed = $true } }',
    '    }',
    '    $original = @{}',
    '    foreach ($process in $processes) { if ($treeIds.Contains([int]$process.ProcessId)) { $original[[int]$process.ProcessId] = [string]$process.CreationDate } }',
    '    Write-Output ("CANCEL TARGETED WORKER pid=" + $worker.ProcessId + " runId=" + $runId + " tree=" + $treeIds.Count)',
    '    & taskkill.exe /PID ([int]$worker.ProcessId) /T /F | Out-Null',
    '    $stopDeadline = (Get-Date).AddSeconds(8)',
    '    do {',
    '      $current = @(Get-CimInstance Win32_Process -ErrorAction Stop)',
    '      $liveIds = New-Object \'System.Collections.Generic.HashSet[int]\'',
    '      foreach ($process in $current) { if ($original.ContainsKey([int]$process.ProcessId) -and [string]$process.CreationDate -eq $original[[int]$process.ProcessId]) { [void]$liveIds.Add([int]$process.ProcessId) } }',
    '      $changed = $true',
    '      while ($changed) {',
    '        $changed = $false',
    '        foreach ($process in $current) { if ($liveIds.Contains([int]$process.ParentProcessId) -and $liveIds.Add([int]$process.ProcessId)) { $changed = $true } }',
    '      }',
    '      $live = @($current | Where-Object { $liveIds.Contains([int]$_.ProcessId) })',
    '      if ($live.Count -and (Get-Date) -lt $stopDeadline) { Start-Sleep -Milliseconds 100 }',
    '    } while ($live.Count -and (Get-Date) -lt $stopDeadline)',
    '    if ($live.Count) { Write-Output ("CANCEL NOT VERIFIED: worker process IDs still alive=" + (($live | ForEach-Object { $_.ProcessId }) -join ",")); exit 6 }',
    '  } elseif (-not $recoveryOnly) { Write-Output "CANCEL RESUMING: matching worker already exited; validating its isolated profile and lock." }',
    '  $expectedProfileName = "karaoke-queue-windows-e2e-" + $runId',
    '  if ($report.profileName -and [string]$report.profileName -ne $expectedProfileName) { Write-Output "CANCEL NOT VERIFIED: profile name does not match the runId."; exit 8 }',
    '  if (-not $report.profileName -and [string]$report.stage -eq "TEST") { Write-Output "CANCEL NOT VERIFIED: TEST started without a recorded temporary profile identity."; exit 8 }',
    '  $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar)',
    '  $profilePath = [IO.Path]::GetFullPath((Join-Path $tempRoot $expectedProfileName))',
    '  if (-not $profilePath.StartsWith($tempRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw "Profile path escaped the Windows temp directory." }',
    '  $electronPath = [IO.Path]::GetFullPath((Join-Path $checkout "node_modules\\electron\\dist\\electron.exe"))',
    '  $matchesProfile = { param($process) $process.Name -eq "electron.exe" -and $process.CommandLine -and $process.CommandLine.IndexOf($profilePath, [StringComparison]::OrdinalIgnoreCase) -ge 0 }',
    '  if (-not $report.profileName -and (Test-Path -LiteralPath $profilePath)) { throw "An unrecorded test profile exists; preserving it for manual inspection." }',
    '  $allProfileCheckProcesses = @(Get-CimInstance Win32_Process -ErrorAction Stop)',
    '  $profileProcesses = @($allProfileCheckProcesses | Where-Object { & $matchesProfile $_ })',
    '  foreach ($process in $profileProcesses) { if ($process.CommandLine.IndexOf($electronPath, [StringComparison]::OrdinalIgnoreCase) -lt 0) { throw "A process referenced the isolated profile but did not match the expected Electron binary." } }',
    '  if ($profileProcesses.Count) {',
    '    Write-Output ("CANCEL TARGETED ELECTRON profile=" + $expectedProfileName + " processes=" + $profileProcesses.Count)',
    '    $electronTreeIds = New-Object \'System.Collections.Generic.HashSet[int]\'',
    '    foreach ($process in $profileProcesses) { [void]$electronTreeIds.Add([int]$process.ProcessId) }',
    '    $electronTreeChanged = $true',
    '    while ($electronTreeChanged) {',
    '      $electronTreeChanged = $false',
    '      foreach ($process in $allProfileCheckProcesses) { if ($electronTreeIds.Contains([int]$process.ParentProcessId) -and $electronTreeIds.Add([int]$process.ProcessId)) { $electronTreeChanged = $true } }',
    '    }',
    '    $electronTreeOriginal = @{}',
    '    foreach ($process in $allProfileCheckProcesses) { if ($electronTreeIds.Contains([int]$process.ProcessId)) { $electronTreeOriginal[[int]$process.ProcessId] = [string]$process.CreationDate } }',
    '    foreach ($process in $profileProcesses | Where-Object { $_.CommandLine -notmatch "--type=" }) { & taskkill.exe /PID ([int]$process.ProcessId) /T /F | Out-Null }',
    '    $electronStopDeadline = (Get-Date).AddSeconds(8)',
    '    do {',
    '      $currentProcesses = @(Get-CimInstance Win32_Process -ErrorAction Stop)',
    '      $profileProcesses = @($currentProcesses | Where-Object { & $matchesProfile $_ })',
    '      $liveTree = @($currentProcesses | Where-Object { $electronTreeOriginal.ContainsKey([int]$_.ProcessId) -and [string]$_.CreationDate -eq $electronTreeOriginal[[int]$_.ProcessId] })',
    '      foreach ($process in $profileProcesses) { & taskkill.exe /PID ([int]$process.ProcessId) /T /F | Out-Null }',
    '      foreach ($process in $liveTree) { & taskkill.exe /PID ([int]$process.ProcessId) /F | Out-Null }',
    '      if (($profileProcesses.Count -or $liveTree.Count) -and (Get-Date) -lt $electronStopDeadline) { Start-Sleep -Milliseconds 100 }',
    '    } while (($profileProcesses.Count -or $liveTree.Count) -and (Get-Date) -lt $electronStopDeadline)',
    '    if ($profileProcesses.Count -or $liveTree.Count) { Write-Output ("CANCEL NOT VERIFIED: isolated Electron process tree remains; PIDs=" + ((@($profileProcesses) + @($liveTree) | ForEach-Object { $_.ProcessId } | Sort-Object -Unique) -join ",")); exit 6 }',
    '  }',
    '  $buildPath = Join-Path $checkout "build"',
    '  $backupPath = Join-Path $gitDir ("karaoke-queue-build-backup-" + $runId)',
    '  $cancelledBuildPath = Join-Path $gitDir ("karaoke-queue-build-cancelled-" + $runId)',
    '  if (Test-Path -LiteralPath $backupPath) {',
    '    if (Test-Path -LiteralPath $cancelledBuildPath) { Write-Output "CANCEL NOT VERIFIED: cancellation build path already exists."; exit 9 }',
    '    if (Test-Path -LiteralPath $buildPath) { Move-Item -LiteralPath $buildPath -Destination $cancelledBuildPath }',
    '    Move-Item -LiteralPath $backupPath -Destination $buildPath',
    '    $report | Add-Member -NotePropertyName buildRecovery -NotePropertyValue "Original build restored; interrupted build preserved under .git/karaoke-queue-build-cancelled-<runId>." -Force',
    '  } else { $report | Add-Member -NotePropertyName buildRecovery -NotePropertyValue "No pre-run build backup required restoration." -Force }',
    '  $profileClean = $true',
    '  if ($report.profileName) {',
    '    if (Test-Path -LiteralPath $profilePath) {',
    '      $profileItem = Get-Item -LiteralPath $profilePath -Force',
    '      if (-not $profileItem.PSIsContainer -or ($profileItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Profile root is not a plain directory." }',
    '      $pendingDirs = New-Object System.Collections.Queue',
    '      $pendingDirs.Enqueue($profilePath)',
    '      while ($pendingDirs.Count) { foreach ($child in Get-ChildItem -LiteralPath $pendingDirs.Dequeue() -Force) { if ($child.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Profile contains a reparse point." }; if ($child.PSIsContainer) { $pendingDirs.Enqueue($child.FullName) } } }',
    '      Remove-Item -LiteralPath $profilePath -Recurse -Force',
    '    }',
    '  }',
    '  $pendingPath = Join-Path $gitDir "' + PENDING + '"',
    '  $syncBackupPath = Join-Path $gitDir ("karaoke-queue-sync-backup-" + $runId)',
    '  $syncRecoveryRequired = (Test-Path -LiteralPath $pendingPath) -or (Test-Path -LiteralPath $syncBackupPath)',
    '  $ownedLock = $false',
    '  if ($lockInfo -and (Test-Path -LiteralPath $lock)) {',
    '    $currentLock = Get-Content -Raw -LiteralPath $lock | ConvertFrom-Json',
    '    $ownedLock = ($currentLock.runId -eq $lockInfo.runId -and [int]$currentLock.pid -eq [int]$lockInfo.pid -and $currentLock.token -eq $lockInfo.token)',
    '  }',
    '  $canRelease = $ownedLock -and -not $syncRecoveryRequired -and $profileClean',
    '  $finalStatus = if ($canRelease) { "CANCELLED" } else { "CANCELLED_RECOVERY_REQUIRED" }',
    '  $finalReason = if ($syncRecoveryRequired) { "Interrupted sync requires checkout recovery." } elseif (-not $profileClean) { "Temporary profile requires review." } elseif (-not $ownedLock) { "Runner lock ownership could not be confirmed." } else { "Owned worker and Electron profile processes stopped; temporary data cleaned." }',
    '  $report | Add-Member -NotePropertyName status -NotePropertyValue $finalStatus -Force',
    '  $report | Add-Member -NotePropertyName reason -NotePropertyValue $finalReason -Force',
    '  $report | Add-Member -NotePropertyName cancelledAt -NotePropertyValue ((Get-Date).ToUniversalTime().ToString("o")) -Force',
    '  $report | Add-Member -NotePropertyName lockRelease -NotePropertyValue $(if ($canRelease) { "attempted after PID/runId/token and process-tree verification" } else { "retained for manual recovery" }) -Force',
    '  Save-CancelReport $reportPath $report',
    '  if (-not $canRelease) { Write-Output ("CANCEL NOT VERIFIED: " + $finalReason); exit 10 }',
    '  Remove-Item -LiteralPath $lock -Force',
    '  if (Test-Path -LiteralPath $lock) { throw "Verified runner lock could not be removed." }',
    '  Write-Output "CANCEL PASS: worker tree stopped, temporary data recovered, owned lock released."',
    '  exit 0',
    '} catch {',
    '  $cancelError = $_.Exception.Message',
    '  try {',
    '    $reportPath = Join-Path (Join-Path $checkout ".git") "' + REPORT + '"',
    '    if (Test-Path -LiteralPath $reportPath) { $report = Get-Content -Raw -LiteralPath $reportPath | ConvertFrom-Json; if ($report.owner -eq "' + REPORT_OWNER + '" -and $report.runId -eq $runId) { $report | Add-Member -NotePropertyName status -NotePropertyValue "CANCELLED_RECOVERY_REQUIRED" -Force; $report | Add-Member -NotePropertyName reason -NotePropertyValue $cancelError -Force; $report | Add-Member -NotePropertyName cancelledAt -NotePropertyValue ((Get-Date).ToUniversalTime().ToString("o")) -Force; Save-CancelReport $reportPath $report } }',
    '  } catch { }',
    '  Write-Output ("CANCEL NOT VERIFIED: " + $cancelError)',
    '  exit 7',
    '}'
  ].join('\n')
}

function runWindowsCancellation(runId, recoveryOnly) {
  const result = spawnPowerShellScript(powershellCancellation(runId, recoveryOnly))
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.status !== 0) {
    fail(recoveryOnly
      ? 'A recuperação do cancelamento Windows não foi confirmada.'
      : 'O cancelamento do runner Windows não foi confirmado.', result.status || 1)
  }
}

function recoverWindowsCancellation(runId) {
  return runWindowsCancellation(runId, true)
}

function spawnPowerShellScript(script) {
  const env = { ...process.env }
  if (process.platform === 'linux' && typeof env.PATH === 'string') {
    env.PATH = env.PATH.split(path.delimiter)
      .map(entry => entry.replace(/\/+$/, '') || '/')
      .join(path.delimiter)
  }
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'karaoke-queue-windows-runner-ps-'))
  try {
    const scriptPath = path.join(temporaryDirectory, 'runner.ps1')
    fs.writeFileSync(scriptPath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(script, 'utf8')]),
      { flag: 'wx', mode: 0o600 })
    const convertedPath = spawnSync('wslpath', ['-w', scriptPath], { encoding: 'utf8', shell: false, env })
    if (convertedPath.error || convertedPath.status !== 0) {
      const detail = convertedPath.stderr || convertedPath.error?.message || String(convertedPath.status)
      throw new Error('Não foi possível preparar o caminho NTFS do script PowerShell temporário: ' + detail)
    }
    return spawnSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', convertedPath.stdout.trim()
    ], { encoding: 'utf8', shell: false, env })
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true })
  }
}
function sourceRoot() {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', shell: false })
  if (result.status !== 0) fail('Não foi possível localizar a raiz Git: ' + (result.stderr || result.error))
  return result.stdout.trim()
}

function readWindowsTargetMarker() {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$checkout = $env:KARAOKE_QUEUE_WIN_CHECKOUT',
    "if ([string]::IsNullOrWhiteSpace($checkout)) { $checkout = Join-Path $env:USERPROFILE 'source\\karaoke-queue-win' }",
    '$checkout = [IO.Path]::GetFullPath($checkout)',
    'if (-not (Test-Path -LiteralPath $checkout -PathType Container)) { Write-Output "KQ_TARGET_CHECKOUT=ABSENT"; exit 0 }',
    '$drive = New-Object IO.DriveInfo ([IO.Path]::GetPathRoot($checkout))',
    'if ($drive.DriveFormat -ne "NTFS") { Write-Output ("KQ_TARGET_CHECKOUT=NOT_NTFS:" + $drive.DriveFormat); exit 0 }',
    '$gitDir = Join-Path $checkout ".git"',
    'if (-not (Test-Path -LiteralPath $gitDir -PathType Container)) { Write-Output "KQ_TARGET_CHECKOUT=INVALID_GIT_CLONE"; exit 0 }',
    "$gitDir = Join-Path $checkout '.git'",
    "$markerPath = Join-Path $gitDir '" + MARKER + "'",
    'if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf)) {',
    '  $legacyPath = Join-Path $gitDir "karaoke-queue-wsl-sync.json"',
    '  if (-not (Test-Path -LiteralPath $legacyPath -PathType Leaf)) { Write-Output "KQ_TARGET_CHECKOUT=READY"; Write-Output "KQ_TARGET_MARKER=NONE"; exit 0 }',
    '  $marker = Get-Content -Raw -LiteralPath $legacyPath | ConvertFrom-Json',
    '  if ($marker.version -ne ' + VERSION + ' -or -not $marker.head -or -not $marker.branch -or -not $marker.fingerprint -or -not $marker.files -or -not $marker.trackedPaths) { throw "Legacy target snapshot metadata is invalid." }',
    '  $json = ConvertTo-Json -InputObject $marker -Depth 100 -Compress',
    '  $legacy = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))',
    '  Write-Output "KQ_TARGET_CHECKOUT=READY"',
    '  Write-Output ("KQ_TARGET_BRANCH=" + $marker.branch)',
    '  Write-Output ("KQ_TARGET_HEAD=" + $marker.head)',
    '  Write-Output ("KQ_TARGET_LEGACY=" + $legacy)',
    '  exit 0',
    '}',
    '$marker = Get-Content -Raw -LiteralPath $markerPath | ConvertFrom-Json',
    'if ($marker.version -ne ' + VERSION + ' -or -not $marker.head -or -not $marker.branch) { throw "Target snapshot metadata is invalid." }',
    'Write-Output "KQ_TARGET_CHECKOUT=READY"',
    'Write-Output ("KQ_TARGET_BRANCH=" + $marker.branch)',
    'Write-Output ("KQ_TARGET_HEAD=" + $marker.head)'
  ].join('\n')
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  const result = spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded
  ], { encoding: 'utf8', shell: false, maxBuffer: 16 * 1024 * 1024 })
  if (result.status === null || result.status !== 0) {
    fail('Não foi possível validar o manifesto anterior do checkout Windows: ' +
      String(result.stderr || (result.error && result.error.message) || ('exit ' + result.status)))
  }
  const lines = result.stdout.split(/\r?\n/)
  const checkoutStatus = lines.find(line => line.startsWith('KQ_TARGET_CHECKOUT='))
  if (!checkoutStatus || checkoutStatus === 'KQ_TARGET_CHECKOUT=ABSENT' || checkoutStatus.startsWith('KQ_TARGET_CHECKOUT=NOT_NTFS:')) {
    process.stderr.write('WINDOWS NOT RUN: validation checkout is absent or not on NTFS.\n')
    fail('O clone Windows isolado não está disponível para validação.', 2)
  }
  if (checkoutStatus !== 'KQ_TARGET_CHECKOUT=READY') fail('O destino Windows não é um clone Git independente válido.')
  if (lines.includes('KQ_TARGET_MARKER=NONE')) return null
  const branchLine = lines.find(line => line.startsWith('KQ_TARGET_BRANCH='))
  const headLine = lines.find(line => line.startsWith('KQ_TARGET_HEAD='))
  const legacyLine = lines.find(line => line.startsWith('KQ_TARGET_LEGACY='))
  const branch = branchLine && branchLine.slice('KQ_TARGET_BRANCH='.length)
  const head = headLine && headLine.slice('KQ_TARGET_HEAD='.length)
  if (!branch || !/^[a-f0-9]{40,64}$/.test(head || '')) fail('Manifesto anterior do checkout Windows está incompleto.')
  let legacyManifest
  if (legacyLine) {
    try { legacyManifest = validateLegacyManifest(JSON.parse(Buffer.from(legacyLine.slice('KQ_TARGET_LEGACY='.length), 'base64').toString('utf8'))) } catch (error) {
      fail('O manifesto de baseline legado não é válido: ' + error.message)
    }
    if (legacyManifest.branch !== branch || legacyManifest.head !== head) fail('O manifesto legado tem metadados conflitantes.')
  }
  return { branch, head, legacyManifest }
}

async function approveUntracked(files) {
  if (!files.length) return
  process.stdout.write('\nArquivos não rastreados que seriam incluídos; revise o conteúdo antes de aprovar:\n')
  for (const file of files) process.stdout.write('  ' + file.sha256 + '  ' + file.path + '\n')
  if (process.argv.includes('--approve-untracked')) {
    process.stdout.write('SYNC untracked explicitamente aprovado via --approve-untracked\n')
    return
  }
  if (!process.stdin.isTTY) fail('Revise os arquivos listados e execute novamente com --approve-untracked.')
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await new Promise(resolve => rl.question('Digite SYNC para incluir exatamente esses arquivos: ', resolve))
    if (answer !== 'SYNC') fail('Sincronização cancelada.', 2)
  } finally {
    rl.close()
  }
}

async function runOrchestrator() {
  if (process.platform === 'win32') fail('Este comando precisa ser iniciado no WSL2; ele sincroniza e valida o checkout Windows.', 2)
  const unexpectedArguments = process.argv.slice(2).filter(argument =>
    !['--approve-untracked', '--playback-evaluation', '--playback-chromium-final', '--playback-chromium-interactive', '--player-playback', '--standalone-playback', '--standalone-integration', '--player-recovery', '--player-control', '--standalone-options', '--standalone-production'].includes(argument)
  )
  if (unexpectedArguments.length) fail('Argumento não permitido: ' + unexpectedArguments.join(' '))
  const playbackModes = process.argv.slice(2).filter(argument =>
    ['--playback-evaluation', '--playback-chromium-final', '--playback-chromium-interactive', '--player-playback', '--standalone-playback', '--standalone-integration', '--player-recovery', '--player-control', '--standalone-options', '--standalone-production'].includes(argument)
  )
  if (playbackModes.length > 1) fail('Escolha apenas um modo de avaliação de playback.')
  const playbackEvaluation = process.argv.includes('--playback-evaluation')
  const playbackMode = playbackModes.find(argument => argument !== '--playback-evaluation') || null
  const root = sourceRoot()
  const preflight = spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    '$ErrorActionPreference = \'Stop\'; $PSVersionTable.PSVersion.ToString(); (Get-Command node.exe -ErrorAction Stop).Name; (Get-Command npm.cmd -ErrorAction Stop).Name; (Get-Command git.exe -ErrorAction Stop).Name'
  ], { encoding: 'utf8', shell: false })
  if (preflight.status === null || preflight.status !== 0) {
    process.stderr.write('WINDOWS NOT RUN: PowerShell/WSL interop or native Node.js/npm is unavailable. ' +
      String(preflight.stderr || (preflight.error && preflight.error.message) || ('exit ' + preflight.status)).trim() + '\n')
    fail('A validação Windows não foi executada.', 2)
  }
  process.stdout.write('WINDOWS INTEROP PASS PowerShell=' + preflight.stdout.trim().split(/\r?\n/)[0] + ' native Node.js/npm/Git found\n')
  const targetMarker = readWindowsTargetMarker()
  const manifest = readSourceSnapshot(root)
  await approveUntracked(manifest.files.filter(item => item.kind === 'untracked'))
  process.stdout.write('SOURCE branch=' + manifest.branch + ' HEAD=' + manifest.head + ' fingerprint=' +
    manifest.fingerprint + ' tracked=' + manifest.trackedPaths.length + ' files=' + manifest.files.length + '\n')
  process.stdout.write('SOURCE TRACKED CHANGES ' + JSON.stringify(manifest.trackedChanges) + '\n')
  process.stdout.write('SOURCE DELETED TRACKED ' + JSON.stringify(manifest.deletedTracked) + '\n')
  const stage = stageSnapshot(root, manifest, targetMarker)
  const stageWindows = run('wslpath', ['-w', stage]).stdout.trim()
  const runId = crypto.randomUUID()
  const encoded = Buffer.from(powershellLauncher(stageWindows, runId, playbackEvaluation, playbackMode), 'utf16le').toString('base64')
  const child = require('node:child_process').spawn('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded
  ], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env })
  let output = ''
  let cancellationRequested = false
  let cancellationPromise = null
  let workerInputError
  observeWorkerInputErrors(child.stdin, () => cancellationRequested, error => {
    workerInputError = workerInputError || error
    process.stderr.write('WORKER INPUT ERROR: ' + String(error && (error.stack || error)) + '\n')
  })
  const approvedGates = new Set()
  const lines = readline.createInterface({ input: child.stdout })
  lines.on('line', line => {
    process.stdout.write(line + '\n')
    output += line + '\n'
    const syncMatch = line.match(/^KQ_SYNC_READY ([a-f0-9]{64}) ([^ ]+) ([a-f0-9]{40,64})$/)
    const sourceMatch = line.match(/^KQ_SOURCE_GATE (BUILD|TEST) ([a-f0-9]{64})$/)
    const gate = syncMatch ? 'SYNC' : sourceMatch ? sourceMatch[1] : null
    const expectedFingerprint = syncMatch ? syncMatch[1] : sourceMatch ? sourceMatch[2] : null
    if (!gate || approvedGates.has(gate) || cancellationRequested) return
    try {
      const current = readSourceSnapshot(root)
      if (current.fingerprint !== manifest.fingerprint || current.fingerprint !== expectedFingerprint) {
        process.stderr.write('SYNC STALE: a origem mudou antes da etapa ' + gate + '; execução bloqueada.\n')
        child.stdin.write('ABORT\n')
        child.stdin.end()
      } else {
        approvedGates.add(gate)
        process.stdout.write('SOURCE VERIFY PASS stage=' + gate + ' fingerprint=' + current.fingerprint + '\n')
        child.stdin.write('CONTINUE ' + current.fingerprint + '\n')
      }
    } catch (error) {
      process.stderr.write('SOURCE VERIFY FAIL: ' + error.message + '\n')
      child.stdin.write('ABORT\n')
      child.stdin.end()
    }
  })
  child.stderr.on('data', data => process.stderr.write(data))
  const requestCancellation = signal => {
    if (cancellationRequested) return
    cancellationRequested = true
    process.stderr.write('CANCEL requested (' + signal + '); stopping only the worker identified by this runId.\n')
    try { child.stdin.write('ABORT\n') } catch {}
    try { child.stdin.end() } catch {}
    cancellationPromise = new Promise(resolve => {
      const stopped = spawnPowerShellScript(powershellCancellation(runId))
      if (stopped.stdout) process.stdout.write(stopped.stdout)
      if (stopped.stderr) process.stderr.write(stopped.stderr)
      if (stopped.status !== 0) {
        process.stderr.write('CANCEL WARNING: worker tree was not confirmed stopped; inspect the runner lock and processes before retrying.\n')
        if (!child.killed) child.kill('SIGTERM')
      }
      resolve()
    })
  }
  const onSigint = () => requestCancellation('SIGINT')
  const onSigterm = () => requestCancellation('SIGTERM')
  process.once('SIGINT', onSigint)
  process.once('SIGTERM', onSigterm)
  try {
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => resolve({ code, signal }))
    })
    if (cancellationPromise) await cancellationPromise
    process.removeListener('SIGINT', onSigint)
    process.removeListener('SIGTERM', onSigterm)
    if (cancellationRequested) fail('Execução cancelada; status Windows não é PASS.', 130)
    if (workerInputError) fail('Falha ao enviar controle ao worker Windows: ' + String(workerInputError.message || workerInputError))
    const finalFingerprint = readSourceSnapshot(root).fingerprint
    if (!approvedGates.has('SYNC')) fail('O Windows não confirmou SYNC/VERIFY; build e teste não são válidos.')
    if (finalFingerprint !== manifest.fingerprint) fail('SYNC STALE: a origem mudou durante build/test; resultado inválido.')
    if (result.code !== 0) fail('Pipeline Windows terminou com código ' + result.code + (result.signal ? ' (' + result.signal + ')' : '') + '.')
    for (const gate of ['BUILD', 'TEST']) if (!approvedGates.has(gate)) fail('O worker não revalidou a origem antes de ' + gate + '.')
    process.stdout.write('WINDOWS REPORT PASS branch=' + manifest.branch + ' HEAD=' + manifest.head + ' fingerprint=' + manifest.fingerprint + '\n')
    return output
  } finally {
    process.removeListener('SIGINT', onSigint)
    process.removeListener('SIGTERM', onSigterm)
    fs.rmSync(stage, { recursive: true, force: true })
  }
}

async function divergenceSelfTest() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'karaoke-windows-divergence-'))
  try {
    fs.writeFileSync(path.join(root, 'source.txt'), 'unexpected destination\n')
    const manifest = validateManifest({
      version: VERSION,
      branch: 'fixture',
      head: '0123456789012345678901234567890123456789',
      trackedPaths: ['source.txt'],
      files: [{ path: 'source.txt', sha256: crypto.createHash('sha256').update('expected source\n').digest('hex'), kind: 'tracked' }]
    })
    let buildTestSentinel = false
    let rejected = false
    try { verifyThenRun(root, manifest, () => { buildTestSentinel = true }) } catch (error) {
      rejected = /Divergência/.test(error.message)
    }
    if (!rejected || buildTestSentinel) fail('Divergência não bloqueou o estágio de build/teste.')
    process.stdout.write('DIVERGENCE GUARD PASS mismatch rejected; build/test sentinel untouched\n')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

async function main() {
  const cancellationIndex = process.argv.indexOf('--cancel-windows-run')
  if (cancellationIndex >= 0) {
    const args = process.argv.slice(cancellationIndex)
    if (cancellationIndex !== 2 || args.length !== 2) fail('Uso: --cancel-windows-run <runId>.')
    return runWindowsCancellation(args[1], false)
  }
  const recoveryIndex = process.argv.indexOf('--recover-windows-cancel')
  if (recoveryIndex >= 0) {
    const args = process.argv.slice(recoveryIndex)
    if (recoveryIndex !== 2 || args.length !== 2) fail('Uso: --recover-windows-cancel <runId>.')
    return recoverWindowsCancellation(args[1])
  }
  const worker = process.argv.indexOf('--windows-worker')
  if (worker >= 0) {
    const root = process.argv[worker + 1]
    const stage = process.argv[worker + 2]
    if (!root || !stage) fail('Worker requer checkout e staging.')
    const workerArguments = process.argv.slice(worker + 3)
    if (workerArguments.some(argument => !['--playback-evaluation', '--playback-chromium-final', '--playback-chromium-interactive', '--player-playback', '--standalone-playback', '--standalone-integration', '--player-recovery', '--player-control', '--standalone-options', '--standalone-production'].includes(argument))) {
      fail('O worker recebeu argumentos não permitidos.')
    }
    const playbackModes = workerArguments.filter(argument =>
      ['--playback-evaluation', '--playback-chromium-final', '--playback-chromium-interactive', '--player-playback', '--standalone-playback', '--standalone-integration', '--player-recovery', '--player-control', '--standalone-options', '--standalone-production'].includes(argument)
    )
    if (playbackModes.length > 1) fail('O worker recebeu modos de playback conflitantes.')
    const playbackMode = playbackModes.find(argument => argument !== '--playback-evaluation') || null
    return windowsWorker(root, stage, workerArguments.includes('--playback-evaluation'), playbackMode)
  }
  if (process.argv.includes('--verify-divergence')) return divergenceSelfTest()
  return runOrchestrator()
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write('WINDOWS RUNNER FAIL: ' + (error.stack || error) + '\n')
    process.exitCode = error.exitCode || 1
  })
}

module.exports = {
  approveUntracked,
  observeWorkerInputErrors,
  generatedBuildPaths,
  isExcludedPath,
  isSensitivePath,
  lastNonEmptyLine,
  makeFingerprint,
  normalizePath,
  prepareFreshBuild,
  powershellCancellation,
  powershellLauncher,
  readSourceSnapshot,
  requiresWindowFocus,
  selectWindowsTestSuites,
  restorePreviousBuild,
  stageSnapshot,
  cleanupSyncBackup,
  syncSnapshot,
  validateLegacyManifest,
  validateManifest,
  verifyBuildOutput,
  verifySnapshotDirectory,
  verifyThenRun
}
