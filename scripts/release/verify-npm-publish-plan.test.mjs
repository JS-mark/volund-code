import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { gzipSync } from 'node:zlib'

import {
  inspectNpmTarballBuffer,
  NPM_PUBLISH_LIMITS,
  parseVerifyNpmPlanCli,
  readBoundedRegularFile,
} from './verify-npm-publish-plan.mjs'

const dirs = []

async function tempDir() {
  const directory = await mkdtemp(join(tmpdir(), 'volund-plan-verify-'))
  dirs.push(directory)
  return directory
}

test.afterEach(async () => {
  for (const directory of dirs.splice(0)) await rm(directory, { recursive: true, force: true })
})

function tarGzip(entries) {
  const chunks = []
  for (const entry of entries) {
    const body = Buffer.from(entry.body ?? '')
    const header = Buffer.alloc(512)
    Buffer.from(entry.path).copy(header, 0)
    if (entry.nameTailGarbage) header[Buffer.byteLength(entry.path) + 1] = 0x78
    const octal = (offset, length, value) =>
      Buffer.from(`${value.toString(8).padStart(length - 1, '0')}\0`).copy(header, offset)
    octal(100, 8, entry.mode ?? 0o644)
    octal(108, 8, entry.uid ?? 0)
    octal(116, 8, entry.gid ?? 0)
    octal(124, 12, body.length)
    octal(136, 12, entry.mtime ?? 499_162_500)
    header.fill(0x20, 148, 156)
    header[156] = (entry.type ?? '0').charCodeAt(0)
    Buffer.from(entry.linkName ?? '').copy(header, 157)
    Buffer.from('ustar\0').copy(header, 257)
    Buffer.from('00').copy(header, 263)
    const checksum = header.reduce((sum, byte) => sum + byte, 0)
    Buffer.from(`${checksum.toString(8).padStart(6, '0')}\0 `).copy(header, 148)
    chunks.push(header, body)
    const padding = (512 - (body.length % 512)) % 512
    if (padding > 0) chunks.push(Buffer.alloc(padding))
  }
  chunks.push(Buffer.alloc(1024))
  const compressed = Buffer.from(gzipSync(Buffer.concat(chunks), { level: 9, mtime: 0 }))
  compressed.fill(0, 4, 8)
  compressed[9] = 0xff
  return compressed
}

void test('npm tar parser accepts bounded regular package files and rejects links, traversal, and duplicates', () => {
  const valid = inspectNpmTarballBuffer(
    tarGzip([
      { path: 'package/bin/volund.cjs', body: '#!/usr/bin/env node\n', mode: 0o755 },
      { path: 'package/package.json', body: '{}' },
    ]),
  )
  assert.equal(valid.get('package/bin/volund.cjs').mode, 0o755)
  assert.throws(
    () => inspectNpmTarballBuffer(tarGzip([{ path: 'package/link', type: '2', linkName: 'x' }])),
    /forbidden type/,
  )
  assert.throws(
    () => inspectNpmTarballBuffer(tarGzip([{ path: 'package/../escape', body: 'x' }])),
    /unsafe npm tar path/,
  )
  assert.throws(
    () =>
      inspectNpmTarballBuffer(
        tarGzip([
          { path: 'package/a', body: '1' },
          { path: 'package/a', body: '2' },
        ]),
      ),
    /duplicate npm tar entry/,
  )
  assert.throws(
    () =>
      inspectNpmTarballBuffer(tarGzip([{ path: 'package/a', body: '1234' }]), {
        limits: { ...NPM_PUBLISH_LIMITS, tarEntryBytes: 3 },
      }),
    /exceeds 3 bytes/,
  )
  assert.throws(
    () => inspectNpmTarballBuffer(tarGzip([{ path: 'package/a', body: 'x', mtime: 0 }])),
    /non-canonical npm@10 metadata/,
  )
  assert.throws(
    () => inspectNpmTarballBuffer(tarGzip([{ path: 'package/a', body: 'x', uid: 501 }])),
    /non-canonical npm@10 metadata/,
  )
  assert.throws(
    () =>
      inspectNpmTarballBuffer(tarGzip([{ path: 'package/a', body: 'x', nameTailGarbage: true }])),
    /data follows NUL terminator/,
  )
  const member = tarGzip([{ path: 'package/a', body: 'x' }])
  assert.throws(
    () => inspectNpmTarballBuffer(Buffer.concat([member, member])),
    /canonical single-member npm@10 gzip encoding|end marker|exactly two zero blocks/,
  )
  assert.throws(
    () =>
      inspectNpmTarballBuffer(member, {
        limits: { ...NPM_PUBLISH_LIMITS, tarballBytes: member.byteLength - 1 },
      }),
    /npm tarball exceeds/,
  )
})

void test('bounded publish-plan reads reject symlinks and oversized files', async () => {
  const fixture = await tempDir()
  const regular = join(fixture, 'regular')
  await writeFile(regular, 'abcd')
  assert.equal((await readBoundedRegularFile(regular, 4, 'fixture')).toString(), 'abcd')
  await assert.rejects(() => readBoundedRegularFile(regular, 3, 'fixture'), /exceeds 3 bytes/)
  const alias = join(fixture, 'alias')
  await symlink(regular, alias)
  await assert.rejects(() => readBoundedRegularFile(alias, 4, 'fixture'))
})

void test('publish-plan CLI rejects missing, duplicate, unknown, and partial identity flags', () => {
  assert.deepEqual(
    parseVerifyNpmPlanCli([
      '--output',
      'candidate',
      '--archives',
      'archives',
      '--source-root',
      '.',
    ]),
    {
      outputDirectory: resolve('candidate'),
      trustedArchiveDirectory: resolve('archives'),
      trustedSourceRoot: resolve('.'),
      candidateLayout: 'full',
      expectedIdentity: undefined,
    },
  )
  assert.throws(() => parseVerifyNpmPlanCli([]), /missing required flag '--output'/)
  assert.throws(() => parseVerifyNpmPlanCli(['--output', 'a', '--output', 'b']), /duplicate flag/)
  assert.throws(() => parseVerifyNpmPlanCli(['--directory', 'a']), /unknown flag/)
  assert.throws(
    () =>
      parseVerifyNpmPlanCli([
        '--output',
        'a',
        '--archives',
        'archives',
        '--source-root',
        '.',
        '--version',
        '1.2.3',
      ]),
    /supplied together/,
  )
  assert.equal(
    parseVerifyNpmPlanCli([
      '--output',
      'candidate',
      '--archives',
      'archives',
      '--source-root',
      '.',
      '--layout',
      'packed-only',
    ]).candidateLayout,
    'packed-only',
  )
})

void test('normal pnpm test command includes both npm candidate contract suites', async () => {
  const rootManifest = JSON.parse(
    await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
  )
  assert.match(rootManifest.scripts.test, /scripts\/release\/pack-standalone-npm\.test\.mjs/)
  assert.match(rootManifest.scripts.test, /scripts\/release\/verify-npm-publish-plan\.test\.mjs/)
})
