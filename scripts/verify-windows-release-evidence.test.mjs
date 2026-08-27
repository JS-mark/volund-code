import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { verifyWindowsReleaseEvidence } from './verify-windows-release-evidence.mjs'

const sha = (character) => character.repeat(64)
const artifact = (architecture, character) => ({
  name: `volund-${architecture}.exe`,
  architecture,
  unsignedSha256: sha(character),
  signedSha256: sha(character === 'a' ? 'b' : 'c'),
  sbomSha256: sha('d'),
  attestationSha256: sha('e'),
  logsRedacted: true,
  verification: { outcome: 'valid', architecture },
})
const fixture = () => ({
  schemaVersion: 1,
  certificate: {
    kind: 'fixture',
    organizationValidated: false,
    keyCustody: 'ephemeral-test-key',
    revoked: false,
  },
  identity: { oidc: false, staticCredential: false },
  approval: { twoPerson: true, changeControlId: 'FIXTURE-ONLY' },
  timestamp: { verified: true, url: 'https://timestamp.invalid.test' },
  store: { identityMatches: true, upgradeTested: true, uninstallTested: true },
  artifacts: [artifact('x64', 'a'), artifact('arm64', 'f')],
})

void test('accepts an explicitly non-production fixture for both architectures', () => {
  assert.deepEqual(verifyWindowsReleaseEvidence(fixture()), { ok: true, errors: [] })
})

for (const outcome of ['unsigned', 'invalid-chain', 'timestamp-mismatch', 'tampered', 'revoked'])
  void test(`rejects the offline ${outcome} fixture`, () => {
    const document = fixture()
    document.artifacts[0].verification.outcome = outcome
    assert.equal(verifyWindowsReleaseEvidence(document).ok, false)
  })

void test('rejects wrong architecture, missing approval, and unredacted logs', () => {
  const document = fixture()
  document.artifacts[0].verification.architecture = 'arm64'
  document.approval.twoPerson = false
  document.artifacts[1].logsRedacted = false
  const result = verifyWindowsReleaseEvidence(document)
  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /architecture does not match/)
  assert.match(result.errors.join('\n'), /two-person approval/)
  assert.match(result.errors.join('\n'), /logs must be marked redacted/)
})

void test('production mode fails closed without EV, OIDC, and managed key custody', () => {
  const result = verifyWindowsReleaseEvidence(fixture(), { production: true })
  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /EV certificate/)
  assert.match(result.errors.join('\n'), /organization validation/)
  assert.match(result.errors.join('\n'), /managed signing or HSM/)
  assert.match(result.errors.join('\n'), /workload OIDC/)
})

void test('self-signed evidence cannot be presented as production evidence', () => {
  const document = fixture()
  document.certificate.kind = 'self-signed'
  assert.equal(verifyWindowsReleaseEvidence(document).ok, true)
  assert.match(
    verifyWindowsReleaseEvidence(document, { production: true }).errors.join('\n'),
    /EV certificate/,
  )
})

void test('workflow is least-privilege, no-secret, and proves production rejection', async () => {
  const workflow = await readFile(
    new URL('../.github/workflows/windows-signing-dry-run.yml', import.meta.url),
    'utf8',
  )
  assert.match(workflow, /permissions:\n  contents: read/)
  assert.match(workflow, /--production/)
  assert.match(workflow, /production_signing=false/)
  assert.match(workflow, /store_submission=false/)
  assert.doesNotMatch(workflow, /secrets\.|id-token: write|packages: write|contents: write/)
})
