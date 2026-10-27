'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { assertNoExistingRelease, validateReleasePlan } = require('./release-workflow.cjs')

const base = {
  ref: 'refs/heads/main',
  sha: '0123456789abcdef0123456789abcdef01234567',
  requestedVersion: '0.5.0',
  packageVersion: '0.5.0'
}

test('accepts exact package version on main and builds the tag from the pinned SHA', () => {
  assert.deepEqual(validateReleasePlan(base), {
    version: '0.5.0', tag: 'v0.5.0', sha: base.sha, branch: 'main'
  })
})

test('rejects a mismatched manual version with the requested message', () => {
  assert.throws(() => validateReleasePlan({ ...base, requestedVersion: '0.6.0' }),
    /versão informada \(0\.6\.0\) não corresponde à versão do package\.json \(0\.5\.0\)/)
})

test('rejects non-main branches before a release plan can be created', () => {
  assert.throws(() => validateReleasePlan({ ...base, ref: 'refs/heads/feature/teste' }), /somente em main/)
})

test('rejects empty, prefixed, malformed and command-like versions', () => {
  for (const requestedVersion of ['', 'v0.5.0', '0.5', '0.5.0;echo-bad', '0.5.0\nother=x']) {
    assert.throws(() => validateReleasePlan({ ...base, requestedVersion }), /SemVer válida/)
  }
})

test('rejects invalid package version and missing or malformed event SHA', () => {
  assert.throws(() => validateReleasePlan({ ...base, packageVersion: 'invalid' }), /versão inválida no package\.json/)
  assert.throws(() => validateReleasePlan({ ...base, sha: 'HEAD' }), /commit SHA/)
})

test('allows publication preflight only when both GitHub lookups return 404', async () => {
  const requests = []
  await assertNoExistingRelease({
    repository: 'owner/repo', tag: 'v0.5.0', token: 'test-token',
    fetchImpl: async (url, options) => {
      requests.push({ url, options })
      return { status: 404 }
    }
  })
  assert.equal(requests.length, 2)
  assert.equal(requests[0].url, 'https://api.github.com/repos/owner/repo/git/ref/tags/v0.5.0')
  assert.equal(requests[1].url, 'https://api.github.com/repos/owner/repo/releases/tags/v0.5.0')
  assert.equal(requests[0].options.headers.Authorization, 'Bearer test-token')
})

test('blocks existing tag, existing release, API errors and unavailable credentials', async () => {
  for (const [statuses, expected] of [
    [[200], /tag v0\.5\.0 já existe/],
    [[404, 200], /GitHub Release v0\.5\.0 já existe/],
    [[403], /HTTP 403/]
  ]) {
    let index = 0
    await assert.rejects(assertNoExistingRelease({
      repository: 'owner/repo', tag: 'v0.5.0', token: 'test-token',
      fetchImpl: async () => ({ status: statuses[index++] })
    }), expected)
  }
  await assert.rejects(assertNoExistingRelease({ repository: 'owner/repo', tag: 'v0.5.0', token: '' }), /token de leitura/)
})
