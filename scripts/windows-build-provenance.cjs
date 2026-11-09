'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const SEAL_NAME = '.kq-windows-build-seal.json'
const INPUT_ROOTS = [
  'src', 'build-resources', 'scripts', 'tests',
  'main.ts', 'main-runtime.ts', 'preload.ts', 'player-preload.ts', 'welcome-preload.ts',
  'standalone-player-preload.ts', 'database.ts', 'types.d.ts',
  'package.json', 'package-lock.json', 'tsconfig.json',
]
const GENERATED_INPUT_EXCLUDES = [
  'build-resources/native/build/', 'build-resources/native/win32-x64/'
]

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function trackedInputFiles(root) {
  const files = []
  const visit = (absolutePath, relativePath) => {
    const normalized = relativePath.replaceAll('\\', '/')
    if (GENERATED_INPUT_EXCLUDES.some(prefix => `${normalized}/`.startsWith(prefix))) return
    const stat = fs.statSync(absolutePath)
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(absolutePath).sort((a, b) => a.localeCompare(b, 'en'))) {
        visit(path.join(absolutePath, name), path.join(relativePath, name))
      }
    } else if (stat.isFile()) files.push(normalized)
  }
  for (const input of INPUT_ROOTS) {
    const absolutePath = path.join(root, input)
    if (!fs.existsSync(absolutePath)) throw new Error(`Windows build input root is missing: ${input}`)
    visit(absolutePath, input)
  }
  return files.sort((left, right) => left.localeCompare(right, 'en'))
}

function buildInputFingerprint(root) {
  const hash = crypto.createHash('sha256')
  const files = trackedInputFiles(root)
  if (!files.length) throw new Error('No Windows build inputs were found in the repository.')
  for (const relativePath of files) {
    const absolutePath = path.join(root, relativePath)
    if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
      throw new Error(`Windows build input is missing or not a file: ${relativePath}`)
    }
    hash.update(relativePath.replaceAll('\\', '/'))
    hash.update('\0')
    hash.update(sha256File(absolutePath))
    hash.update('\0')
  }
  return { fingerprint: hash.digest('hex'), files }
}

function readHead(root) {
  const gitEntry = path.join(root, '.git')
  let gitDirectory = gitEntry
  if (fs.statSync(gitEntry).isFile()) {
    const match = fs.readFileSync(gitEntry, 'utf8').trim().match(/^gitdir:\s*(.+)$/i)
    if (!match) throw new Error('Repository Git directory pointer is invalid.')
    gitDirectory = path.resolve(root, match[1])
  }
  const head = fs.readFileSync(path.join(gitDirectory, 'HEAD'), 'utf8').trim()
  const direct = head.match(/^[0-9a-f]{40}$/i)
  if (direct) return direct[0]
  const refMatch = head.match(/^ref:\s*(refs\/.+)$/)
  if (!refMatch) throw new Error('Repository HEAD is invalid.')
  const refPath = path.join(gitDirectory, refMatch[1])
  try { return fs.readFileSync(refPath, 'utf8').trim() }
  catch (error) {
    if ((error && error.code) !== 'ENOENT') throw error
    const packed = fs.readFileSync(path.join(gitDirectory, 'packed-refs'), 'utf8')
    const escapedRef = refMatch[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const match = packed.match(new RegExp(`^([0-9a-f]{40}) ${escapedRef}$`, 'm'))
    if (!match) throw new Error('Repository HEAD ref is not present in loose or packed Git refs.')
    return match[1]
  }
}

function sealPath(outputDirectory) { return path.join(outputDirectory, SEAL_NAME) }

function writeBuildSeal(root, outputs) {
  const outputDirectory = path.join(root, 'dist')
  const current = buildInputFingerprint(root)
  const seal = {
    format: 1,
    commit: readHead(root),
    inputFingerprint: current.fingerprint,
    outputs: Object.fromEntries(outputs.map(file => [file, sha256File(path.join(outputDirectory, file))]))
  }
  const destination = sealPath(outputDirectory)
  const temporary = `${destination}.${process.pid}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(seal, null, 2)}\n`, { flag: 'wx' })
  try { fs.renameSync(temporary, destination) }
  catch (error) { try { fs.rmSync(temporary, { force: true }) } catch {}; throw error }
  return seal
}

function verifyBuildSeal(root, expectedOutputs) {
  const outputDirectory = path.join(root, 'dist')
  const filePath = sealPath(outputDirectory)
  if (!fs.existsSync(filePath)) throw new Error('No completed Windows build seal exists; the NSIS build did not finish for this candidate.')
  let seal
  try { seal = JSON.parse(fs.readFileSync(filePath, 'utf8')) }
  catch { throw new Error('Windows build seal is unreadable or invalid.') }
  if (!seal || seal.format !== 1 || typeof seal.commit !== 'string' || !/^[0-9a-f]{40}$/i.test(seal.commit) ||
      typeof seal.inputFingerprint !== 'string' || !/^[0-9a-f]{64}$/i.test(seal.inputFingerprint) ||
      !seal.outputs || typeof seal.outputs !== 'object' || Array.isArray(seal.outputs)) {
    throw new Error('Windows build seal has an unsupported format.')
  }
  if (seal.commit !== readHead(root)) throw new Error('Windows installer was built from a different Git commit.')
  const currentInputs = buildInputFingerprint(root)
  if (seal.inputFingerprint !== currentInputs.fingerprint) throw new Error('Windows installer does not match the current build inputs.')
  const sealedNames = Object.keys(seal.outputs).sort()
  if (JSON.stringify(sealedNames) !== JSON.stringify([...expectedOutputs].sort())) {
    throw new Error('Windows build seal does not list the exact required final outputs.')
  }
  for (const relativePath of expectedOutputs) {
    const absolutePath = path.join(outputDirectory, relativePath)
    if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
      throw new Error(`Sealed Windows build output is missing: ${relativePath}`)
    }
    if (sha256File(absolutePath) !== seal.outputs[relativePath]) {
      throw new Error(`Windows build output changed after the successful build: ${relativePath}`)
    }
  }
  return seal
}

module.exports = { SEAL_NAME, buildInputFingerprint, readHead, sha256File, writeBuildSeal, verifyBuildSeal }
