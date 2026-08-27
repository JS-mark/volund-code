import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  canonicalPayload,
  validateUpdateManifest,
  verifyUpdateManifest,
} from './verify-update-manifest.mjs'

const fixtureUrl = new URL('../docs/releases/update-dry-run/manifest.json', import.meta.url)
const fixtureRoot = fileURLToPath(new URL('../docs/releases/update-dry-run', import.meta.url))
const load = async () => JSON.parse(await readFile(fixtureUrl, 'utf8'))

void test('verifies the fixture manifest, artifact digest, signature and rollback plan', async () => {
  const result = await verifyUpdateManifest(await load(), fixtureRoot)
  assert.deepEqual(result, {
    verified: true,
    dryRun: true,
    rollback: {
      action: 'restore-previous',
      fromVersion: '0.2.0-rc.1',
      toVersion: '0.1.0-rc.1',
      executed: false,
    },
  })
})

void test('fails closed on artifact digest mismatch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'volund-update-'))
  try {
    await cp(fixtureRoot, root, { recursive: true })
    await writeFile(join(root, 'artifacts/volund-code-darwin-arm64.txt'), 'tampered\n')
    const manifest = await load()
    await assert.rejects(() => verifyUpdateManifest(manifest, root), /digest mismatch/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

void test('fails closed on a changed signed manifest', async () => {
  const manifest = await load()
  manifest.version = '0.2.1-rc.1'
  await assert.rejects(() => verifyUpdateManifest(manifest, fixtureRoot), /signature verification/)
})

void test('fails closed on an unauthorized channel or rollback target', async () => {
  const manifest = await load()
  manifest.channel = 'stable'
  manifest.published = true
  manifest.rollback.targetVersion = manifest.version
  const errors = validateUpdateManifest(manifest).join('\n')
  assert.match(errors, /channel must equal dry-run/)
  assert.match(errors, /published must be false/)
  assert.match(errors, /rollback.targetVersion must equal previousVersion/)
})

void test('accepts an ephemeral fixture signature without exposing a private key', async () => {
  const manifest = await load()
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  manifest.signature.publicKey = publicKey.export({ type: 'spki', format: 'pem' })
  manifest.signature.value = sign(
    null,
    Buffer.from(canonicalPayload(manifest)),
    privateKey,
  ).toString('base64')
  assert.equal((await verifyUpdateManifest(manifest, fixtureRoot)).verified, true)
})
