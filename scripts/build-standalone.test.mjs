import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createNativeManifest, targetTripleFor } from './build-standalone.mjs'

void test('targetTripleFor maps supported host platforms', () => {
  assert.equal(targetTripleFor('darwin', 'arm64'), 'darwin-arm64')
  assert.equal(targetTripleFor('darwin', 'x64'), 'darwin-x64')
  assert.equal(targetTripleFor('linux', 'x64', 'glibc'), 'linux-x64-gnu')
  assert.equal(targetTripleFor('linux', 'arm64', 'musl'), 'linux-arm64-musl')
  assert.equal(targetTripleFor('win32', 'x64'), 'win32-x64-msvc')
  assert.equal(targetTripleFor('freebsd', 'x64'), null)
  assert.equal(targetTripleFor('linux', 'ia32'), null)
})

void test('adopts plain cargo-layout binaries (apollo-<kind>) for the target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'apollo manifest '))
  const source = join(root, 'input')
  const output = join(root, 'output')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(source)
  for (const kind of ['sandbox', 'search', 'fs'])
    await writeFile(join(source, `apollo-${kind}`), kind)
  try {
    const manifest = await createNativeManifest(source, output, 'darwin-arm64')
    assert.deepEqual(
      manifest.assets.map((asset) => asset.file),
      ['apollo-sandbox-darwin-arm64', 'apollo-search-darwin-arm64', 'apollo-fs-darwin-arm64'],
    )
    assert.equal(await readFile(join(output, 'apollo-search-darwin-arm64'), 'utf8'), 'search')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

void test('fails with an actionable error when a native asset is missing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'apollo manifest '))
  const source = join(root, 'input')
  const output = join(root, 'output')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(source)
  await writeFile(join(source, 'apollo-sandbox'), 'sandbox')
  try {
    await assert.rejects(
      () => createNativeManifest(source, output, 'darwin-arm64'),
      /missing native asset for search.*apollo-search-darwin-arm64/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

void test('creates a complete, stable native asset manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'apollo manifest '))
  const source = join(root, 'input')
  const output = join(root, 'output')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(source)
  for (const kind of ['sandbox', 'search', 'fs'])
    await writeFile(join(source, `apollo-${kind}-darwin-arm64`), kind)
  try {
    const manifest = await createNativeManifest(source, output, 'darwin-arm64')
    assert.equal(manifest.schemaVersion, 1)
    assert.deepEqual(
      manifest.assets.map((asset) => asset.kind),
      ['sandbox', 'search', 'fs'],
    )
    assert.equal(manifest.assets[0].sha256, createHash('sha256').update('sandbox').digest('hex'))
    assert.deepEqual(JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8')), manifest)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
