import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { gzipSync } from 'node:zlib'

import {
  createCanonicalStandaloneArchive,
  readStandaloneArchive,
  STANDALONE_ARCHIVE_LIMITS,
  validateStandaloneArchiveBuffer,
} from './standalone-archive.mjs'

const TARGET = 'darwin-arm64'

function digest(body) {
  return createHash('sha256').update(body).digest('hex')
}

async function writeCompleteStandalone(outDirectory, target = TARGET) {
  const executableName = target.startsWith('win32-') ? 'volund.exe' : 'volund'
  const executable = Buffer.from(`executable:${target}`)
  await mkdir(join(outDirectory, 'native'), { recursive: true })
  await mkdir(join(outDirectory, 'plugins', 'builtin'), { recursive: true })
  await writeFile(join(outDirectory, executableName), executable)
  const assets = []
  for (const kind of ['sandbox', 'search', 'fs']) {
    const file = `volund-${kind}-${target}${target.startsWith('win32-') ? '.exe' : ''}`
    const body = Buffer.from(`${kind}:${target}`)
    await writeFile(join(outDirectory, 'native', file), body)
    assets.push({ kind, target, file, sha256: digest(body) })
  }
  await writeFile(
    join(outDirectory, 'native', 'manifest.json'),
    `${JSON.stringify({ schemaVersion: 1, assets }, null, 2)}\n`,
  )
  await writeFile(join(outDirectory, 'plugins', 'builtin', 'index.mjs'), 'export default {}\n')
  await writeFile(
    join(outDirectory, 'checksums.sha256'),
    `${digest(executable)}  ${executableName}\n`,
  )
  await writeFile(join(outDirectory, 'LICENSE'), 'license fixture\n')
  await writeFile(join(outDirectory, 'NOTICE'), 'notice fixture\n')
  await writeFile(join(outDirectory, 'sbom.cdx.json'), '{"bomFormat":"CycloneDX"}\n')
}

function writeField(buffer, offset, length, value) {
  Buffer.from(value).copy(buffer, offset, 0, length)
}

function writeOctal(buffer, offset, length, value) {
  writeField(buffer, offset, length, `${value.toString(8).padStart(length - 1, '0')}\0`)
}

function testTarGzip(entries, { endBlocks = 2 } = {}) {
  const chunks = []
  for (const entry of entries) {
    const body = Buffer.from(entry.body ?? '')
    const header = Buffer.alloc(512)
    writeField(header, 0, 100, entry.path)
    writeOctal(header, 100, 8, entry.mode ?? 0o644)
    writeOctal(header, 108, 8, 0)
    writeOctal(header, 116, 8, 0)
    writeOctal(header, 124, 12, body.length)
    writeOctal(header, 136, 12, 0)
    header.fill(0x20, 148, 156)
    header[156] = (entry.type ?? '0').charCodeAt(0)
    writeField(header, 157, 100, entry.linkName ?? '')
    writeField(header, 257, 6, 'ustar\0')
    writeField(header, 263, 2, '00')
    const checksum = header.reduce((sum, byte) => sum + byte, 0)
    writeField(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `)
    chunks.push(header, body)
    const padding = (512 - (body.length % 512)) % 512
    if (padding > 0) chunks.push(Buffer.alloc(padding, entry.paddingByte ?? 0))
  }
  chunks.push(Buffer.alloc(512 * endBlocks))
  const compressed = Buffer.from(gzipSync(Buffer.concat(chunks), { level: 9, mtime: 0 }))
  compressed.fill(0, 4, 8)
  compressed[9] = 0xff
  return compressed
}

void test('creates and validates a real complete canonical standalone tar.gz', async () => {
  const root = await mkdtemp(join(tmpdir(), 'volund archive positive '))
  const source = join(root, 'source')
  const archive = join(root, 'standalone.tar.gz')
  try {
    await writeCompleteStandalone(source)
    const body = await createCanonicalStandaloneArchive({
      sourceDirectory: source,
      archivePath: archive,
      target: TARGET,
    })
    const validated = validateStandaloneArchiveBuffer(body, { target: TARGET })
    assert.equal(validated.executableName, 'volund')
    assert.deepEqual(
      validated.nativeManifest.assets.map((asset) => asset.kind),
      ['sandbox', 'search', 'fs'],
    )
    assert.deepEqual(await readFile(archive), body)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

void test('identical content produces identical archives despite source modes and mtimes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'volund archive reproducible '))
  const first = join(root, 'first')
  const second = join(root, 'second')
  try {
    await writeCompleteStandalone(first)
    await writeCompleteStandalone(second)
    await chmod(join(first, 'volund'), 0o700)
    await chmod(join(second, 'volund'), 0o777)
    await chmod(join(first, 'plugins', 'builtin', 'index.mjs'), 0o600)
    await chmod(join(second, 'plugins', 'builtin', 'index.mjs'), 0o644)
    await utimes(join(first, 'volund'), new Date(1_000), new Date(2_000))
    await utimes(join(second, 'volund'), new Date(3_000_000), new Date(4_000_000))
    const firstBody = await createCanonicalStandaloneArchive({
      sourceDirectory: first,
      archivePath: join(root, 'first.tar.gz'),
      target: TARGET,
    })
    const secondBody = await createCanonicalStandaloneArchive({
      sourceDirectory: second,
      archivePath: join(root, 'second.tar.gz'),
      target: TARGET,
    })
    assert.deepEqual(firstBody, secondBody)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

void test('rejects absolute and parent-traversal tar paths', () => {
  for (const path of ['/tmp/evil', '../evil', 'plugins/../../evil'])
    assert.throws(
      () => readStandaloneArchive(testTarGzip([{ path, body: 'evil' }])),
      /unsafe archive path/,
    )
})

void test('rejects duplicate tar entries', () => {
  const archive = testTarGzip([
    { path: 'volund', body: 'first' },
    { path: 'volund', body: 'second' },
  ])
  assert.throws(() => readStandaloneArchive(archive), /duplicate archive entry 'volund'/)
})

void test('rejects non-zero tar padding and anything beyond exactly two end blocks', () => {
  assert.throws(
    () => readStandaloneArchive(testTarGzip([{ path: 'file', body: 'x', paddingByte: 1 }])),
    /non-zero tar padding/,
  )
  assert.throws(
    () => readStandaloneArchive(testTarGzip([{ path: 'file', body: 'x' }], { endBlocks: 3 })),
    /exactly two zero end blocks/,
  )
})

void test('rejects symlink, hardlink, and device tar entries', () => {
  for (const [type, label] of [
    ['2', 'symlink'],
    ['1', 'hardlink'],
    ['3', 'device'],
  ]) {
    const archive = testTarGzip([{ path: label, type, linkName: 'volund' }])
    assert.throws(() => readStandaloneArchive(archive), /unsupported tar entry type/)
  }
})

void test('rejects unknown top-level content from a real tar.gz', () => {
  const archive = testTarGzip([{ path: 'unexpected.txt', body: 'unexpected' }])
  assert.throws(
    () => validateStandaloneArchiveBuffer(archive, { target: TARGET }),
    /unknown top-level standalone archive entry 'unexpected.txt'/,
  )
})

void test('rejects source symlinks and wrong target-specific native names', async () => {
  const root = await mkdtemp(join(tmpdir(), 'volund archive invalid source '))
  const source = join(root, 'source')
  try {
    await writeCompleteStandalone(source)
    await symlink('index.mjs', join(source, 'plugins', 'builtin', 'alias.mjs'))
    await assert.rejects(
      () =>
        createCanonicalStandaloneArchive({
          sourceDirectory: source,
          archivePath: join(root, 'symlink.tar.gz'),
          target: TARGET,
        }),
      /must not be a symlink/,
    )
    await rm(join(source, 'plugins', 'builtin', 'alias.mjs'))
    const manifestPath = join(source, 'native', 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.assets[0].file += '.exe'
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    await assert.rejects(
      () =>
        createCanonicalStandaloneArchive({
          sourceDirectory: source,
          archivePath: join(root, 'wrong-native.tar.gz'),
          target: TARGET,
        }),
      /invalid sandbox entry for darwin-arm64/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

void test('rejects a missing base metadata file and cannot weaken the base contract', async () => {
  const root = await mkdtemp(join(tmpdir(), 'volund archive missing metadata '))
  const source = join(root, 'source')
  try {
    await writeCompleteStandalone(source)
    await rm(join(source, 'NOTICE'))
    await assert.rejects(
      () =>
        createCanonicalStandaloneArchive({
          sourceDirectory: source,
          archivePath: join(root, 'missing-notice.tar.gz'),
          target: TARGET,
          additionalRequiredTopLevelFiles: [],
        }),
      /missing required entry 'NOTICE'/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

void test('rejects concatenated gzip members instead of accepting alternate bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'volund archive concatenated '))
  const source = join(root, 'source')
  try {
    await writeCompleteStandalone(source)
    const canonical = await createCanonicalStandaloneArchive({
      sourceDirectory: source,
      archivePath: join(root, 'canonical.tar.gz'),
      target: TARGET,
    })
    const concatenated = Buffer.concat([canonical, testTarGzip([])])
    assert.throws(
      () => validateStandaloneArchiveBuffer(concatenated, { target: TARGET }),
      /exactly two zero end blocks|canonical single-member encoding/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

void test('enforces bounded compressed, uncompressed, entry-count, and entry-size limits', () => {
  assert.ok(STANDALONE_ARCHIVE_LIMITS.compressedBytes > 0)
  const archive = testTarGzip([
    { path: 'first', body: '12' },
    { path: 'second', body: '34' },
  ])
  assert.throws(
    () =>
      readStandaloneArchive(archive, {
        limits: { compressedBytes: archive.byteLength - 1 },
      }),
    /compressed size .* exceeds limit/,
  )
  assert.throws(
    () => readStandaloneArchive(archive, { limits: { uncompressedBytes: 100 } }),
    /uncompressed size exceeds limit/,
  )
  assert.throws(
    () => readStandaloneArchive(archive, { limits: { entryCount: 1 } }),
    /entry count exceeds limit/,
  )
  assert.throws(
    () => readStandaloneArchive(archive, { limits: { entryBytes: 1 } }),
    /entry 'first' size 2 exceeds limit/,
  )
})

void test('the canonical archive contract can require future top-level metadata files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'volund archive extension '))
  const source = join(root, 'source')
  try {
    await writeCompleteStandalone(source)
    await writeFile(join(source, 'THIRD_PARTY_NOTICES'), 'third-party notices\n')
    const body = await createCanonicalStandaloneArchive({
      sourceDirectory: source,
      archivePath: join(root, 'with-license.tar.gz'),
      target: TARGET,
      additionalRequiredTopLevelFiles: ['THIRD_PARTY_NOTICES'],
    })
    assert.ok(
      validateStandaloneArchiveBuffer(body, {
        target: TARGET,
        additionalRequiredTopLevelFiles: ['THIRD_PARTY_NOTICES'],
      }).entries.has('THIRD_PARTY_NOTICES'),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

void test('the normal pnpm test command includes every standalone artifact contract suite', async () => {
  const packageJson = JSON.parse(
    await readFile(resolve(import.meta.dirname, '../..', 'package.json'), 'utf8'),
  )
  for (const suite of [
    'scripts/release/build-all-standalone.test.mjs',
    'scripts/release/generate-release-manifest.test.mjs',
    'scripts/release/standalone-archive.test.mjs',
  ])
    assert.match(
      packageJson.scripts.test,
      new RegExp(`(?:^| )${suite.replaceAll('.', '\\.')}($| )`),
    )
})
