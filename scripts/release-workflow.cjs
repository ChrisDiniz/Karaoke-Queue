'use strict'

const fs = require('node:fs')
const path = require('node:path')

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/

function validateReleasePlan({ ref, sha, requestedVersion, packageVersion }) {
  if (ref !== 'refs/heads/main') {
    throw new Error(`Release bloqueado: publicação permitida somente em main (ref recebida: ${ref || '(vazia)'}).`)
  }
  if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/i.test(sha)) {
    throw new Error('Release bloqueado: não foi possível identificar o commit SHA do workflow_dispatch.')
  }
  if (typeof requestedVersion !== 'string' || !SEMVER.test(requestedVersion)) {
    throw new Error('Release bloqueado: informe uma versão SemVer válida, sem o prefixo v (ex.: 0.5.0).')
  }
  if (typeof packageVersion !== 'string' || !SEMVER.test(packageVersion)) {
    throw new Error(`Release bloqueado: versão inválida no package.json (${String(packageVersion)}).`)
  }
  if (requestedVersion !== packageVersion) {
    throw new Error(`Release bloqueado: a versão informada (${requestedVersion}) não corresponde à versão do package.json (${packageVersion}).`)
  }
  return { version: packageVersion, tag: `v${packageVersion}`, sha, branch: 'main' }
}

async function assertNoExistingRelease({ repository, tag, token, fetchImpl = globalThis.fetch }) {
  if (typeof repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error('Release bloqueado: repositório GitHub inválido.')
  }
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('Release bloqueado: token de leitura do GitHub indisponível para verificar duplicidade.')
  }

  const base = `https://api.github.com/repos/${repository}`
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28'
  }
  const checks = [
    { url: `${base}/git/ref/tags/${encodeURIComponent(tag)}`, label: 'tag' },
    { url: `${base}/releases/tags/${encodeURIComponent(tag)}`, label: 'GitHub Release' }
  ]

  for (const check of checks) {
    let response
    try {
      response = await fetchImpl(check.url, { headers })
    } catch (error) {
      throw new Error(`Release bloqueado: não foi possível verificar se a ${check.label} ${tag} já existe (${error.message}).`)
    }
    if (response.status === 200) {
      throw new Error(`Release bloqueado: a ${check.label} ${tag} já existe. Releases publicados são imutáveis.`)
    }
    if (response.status !== 404) {
      throw new Error(`Release bloqueado: a verificação da ${check.label} falhou com HTTP ${response.status}.`)
    }
  }
}

async function runCli() {
  const root = path.resolve(__dirname, '..')
  const packageVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
  const plan = validateReleasePlan({
    ref: process.env.KQUEUE_DISPATCH_REF,
    sha: process.env.KQUEUE_COMMIT_SHA,
    requestedVersion: process.env.RELEASE_VERSION,
    packageVersion
  })
  await assertNoExistingRelease({
    repository: process.env.KQUEUE_REPOSITORY,
    tag: plan.tag,
    token: process.env.KQUEUE_API_TOKEN
  })

  const output = process.env.GITHUB_OUTPUT
  if (!output) throw new Error('GITHUB_OUTPUT não está definido.')
  fs.appendFileSync(output, `version=${plan.version}\ntag=${plan.tag}\nsha=${plan.sha}\nbranch=${plan.branch}\n`)
  console.log(`Release validado: branch=${plan.branch}; SHA=${plan.sha}; versão=${plan.version}; tag=${plan.tag}`)
}

module.exports = { SEMVER, validateReleasePlan, assertNoExistingRelease }

if (require.main === module) {
  runCli().catch(error => {
    console.error(error.message)
    process.exitCode = 1
  })
}
