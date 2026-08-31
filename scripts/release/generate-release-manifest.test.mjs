import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { STANDALONE_TARGETS } from './build-all-standalone.mjs'
import {
  generateReleaseManifest,
  normalizeReleaseSbom,
  normalizeReleaseSbomFile,
  parseCliArguments,
  readReleaseSbomInput,
  RELEASE_SBOM_LIMITS,
  serializeReleaseManifest,
  serializeReleaseSbom,
  validateReleaseIdentity,
  validateReleaseSbomIdentity,
  validateManifestOutputPath,
  writeReleaseManifestAtomically,
  writeReleaseSbomAtomically,
} from './generate-release-manifest.mjs'
import { createCanonicalStandaloneArchive } from './standalone-archive.mjs'

const COMMIT = '0123456789abcdef0123456789abcdef01234567'
const IDENTITY = {
  version: '0.1.0',
  tag: 'v0.1.0',
  commit: COMMIT,
  bunVersion: '1.2.21',
}

const SBOM_VERSION = '1.2.3'
const SBOM_COMMIT = '1234567890abcdef1234567890abcdef12345678'

function archiveName(target) {
  return `volund-standalone-${target}.tar.gz`
}

function digest(body) {
  return createHash('sha256').update(body).digest('hex')
}

async function withArchives(targets, run) {
  const root = await mkdtemp(join(tmpdir(), 'volund release manifest '))
  const archiveDirectory = join(root, 'archives')
  await mkdir(archiveDirectory)
  const checksums = []
  for (const target of targets) {
    const name = archiveName(target)
    const sourceDirectory = join(root, `source-${target}`)
    await writeCompleteStandalone(sourceDirectory, target)
    const body = await createCanonicalStandaloneArchive({
      sourceDirectory,
      archivePath: join(archiveDirectory, name),
      target,
    })
    checksums.push(`${digest(body)}  ${name}`)
  }
  await writeFile(
    join(archiveDirectory, 'standalone-checksums.sha256'),
    `${checksums.join('\n')}\n`,
  )
  try {
    await run({ root, archiveDirectory })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function writeCompleteStandalone(outDirectory, target) {
  const executableName = target.startsWith('win32-') ? 'volund.exe' : 'volund'
  const executable = Buffer.from(`executable:${target}`)
  await mkdir(join(outDirectory, 'native'), { recursive: true })
  await mkdir(join(outDirectory, 'plugins'), { recursive: true })
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
  await writeFile(join(outDirectory, 'plugins', 'index.mjs'), 'export default {}\n')
  await writeFile(
    join(outDirectory, 'checksums.sha256'),
    `${digest(executable)}  ${executableName}\n`,
  )
  await writeFile(join(outDirectory, 'LICENSE'), 'license fixture\n')
  await writeFile(join(outDirectory, 'NOTICE'), 'notice fixture\n')
  await writeFile(join(outDirectory, 'sbom.cdx.json'), '{"bomFormat":"CycloneDX"}\n')
}

void test('generates a deterministic manifest for the exact seven-target artifact set', async () => {
  await withArchives(STANDALONE_TARGETS, async ({ archiveDirectory }) => {
    const first = await generateReleaseManifest({ archiveDirectory, ...IDENTITY })
    const second = await generateReleaseManifest({ archiveDirectory, ...IDENTITY })
    assert.equal(serializeReleaseManifest(first), serializeReleaseManifest(second))
    assert.equal(first.schemaVersion, 1)
    assert.deepEqual(
      first.artifacts.map((artifact) => artifact.target),
      STANDALONE_TARGETS,
    )
    assert.equal(first.artifacts[0].archiveName, archiveName('darwin-arm64'))
    assert.equal(first.artifacts[0].executableName, 'volund')
    assert.equal(first.artifacts.at(-1).executableName, 'volund.exe')
    const firstArchive = await readFile(join(archiveDirectory, archiveName('darwin-arm64')))
    assert.equal(first.artifacts[0].size, firstArchive.byteLength)
    assert.equal(first.artifacts[0].sha256, digest(firstArchive))
  })
})

void test('normalizes a valid full commit SHA to lowercase', () => {
  const identity = validateReleaseIdentity({ ...IDENTITY, commit: COMMIT.toUpperCase() })
  assert.equal(identity.commit, COMMIT)
})

void test('rejects malformed release versions, tags, commits, and Bun versions', () => {
  assert.throws(
    () => validateReleaseIdentity({ ...IDENTITY, version: '1.0' }),
    /invalid release version/,
  )
  assert.throws(() => validateReleaseIdentity({ ...IDENTITY, tag: '0.1.0' }), /must equal version/)
  assert.throws(() => validateReleaseIdentity({ ...IDENTITY, tag: 'v0.2.0' }), /must equal version/)
  assert.throws(() => validateReleaseIdentity({ ...IDENTITY, commit: 'abc123' }), /full 40-hex SHA/)
  assert.throws(
    () => validateReleaseIdentity({ ...IDENTITY, commit: '0'.repeat(40) }),
    /all-zero release commit SHA is forbidden/,
  )
  assert.throws(
    () => validateReleaseIdentity({ ...IDENTITY, bunVersion: 'latest' }),
    /invalid Bun version/,
  )
})

void test('rejects placeholder 0.0.0 versions including prereleases', () => {
  assert.throws(
    () =>
      validateReleaseIdentity({
        ...IDENTITY,
        version: '0.0.0-dev.1',
        tag: 'v0.0.0-dev.1',
      }),
    /placeholder release version 0.0.0 is forbidden/,
  )
})

void test('rejects a missing production target', async () => {
  await withArchives(STANDALONE_TARGETS.slice(0, -1), async ({ archiveDirectory }) => {
    await assert.rejects(
      () => generateReleaseManifest({ archiveDirectory, ...IDENTITY }),
      /archive target set mismatch; missing: win32-x64-msvc/,
    )
  })
})

void test('rejects an unexpected target archive', async () => {
  await withArchives([...STANDALONE_TARGETS, 'aix-x64'], async ({ archiveDirectory }) => {
    await assert.rejects(
      () => generateReleaseManifest({ archiveDirectory, ...IDENTITY }),
      /unexpected: aix-x64/,
    )
  })
})

void test('rejects malformed archive filenames', async () => {
  await withArchives(STANDALONE_TARGETS, async ({ archiveDirectory }) => {
    await copyFile(
      join(archiveDirectory, archiveName('darwin-arm64')),
      join(archiveDirectory, 'volund-standalone-darwin-arm64.tgz'),
    )
    await assert.rejects(
      () => generateReleaseManifest({ archiveDirectory, ...IDENTITY }),
      /invalid standalone archive filename 'volund-standalone-darwin-arm64.tgz'/,
    )
  })
})

void test('rejects arbitrary bytes even when their outer checksum matches', async () => {
  await withArchives(STANDALONE_TARGETS, async ({ archiveDirectory }) => {
    const name = archiveName('darwin-arm64')
    const invalidBody = Buffer.from('not a tar.gz archive')
    await writeFile(join(archiveDirectory, name), invalidBody)
    const checksumPath = join(archiveDirectory, 'standalone-checksums.sha256')
    const lines = (await readFile(checksumPath, 'utf8'))
      .trimEnd()
      .split('\n')
      .map((line) => (line.endsWith(`  ${name}`) ? `${digest(invalidBody)}  ${name}` : line))
    await writeFile(checksumPath, `${lines.join('\n')}\n`)
    await assert.rejects(
      () => generateReleaseManifest({ archiveDirectory, ...IDENTITY }),
      /non-canonical gzip metadata|not a valid gzip stream/,
    )
  })
})

void test('rejects foreign files in the standalone archive directory', async () => {
  await withArchives(STANDALONE_TARGETS, async ({ archiveDirectory }) => {
    await writeFile(join(archiveDirectory, 'foreign.txt'), 'unexpected')
    await assert.rejects(
      () => generateReleaseManifest({ archiveDirectory, ...IDENTITY }),
      /foreign file in standalone archive directory: 'foreign.txt'/,
    )
  })
})

void test('recomputes archive digests and rejects a stale checksum', async () => {
  await withArchives(STANDALONE_TARGETS, async ({ archiveDirectory }) => {
    await writeFile(join(archiveDirectory, archiveName('darwin-arm64')), 'mutated archive')
    await assert.rejects(
      () => generateReleaseManifest({ archiveDirectory, ...IDENTITY }),
      /checksum mismatch for volund-standalone-darwin-arm64.tar.gz/,
    )
  })
})

void test('rejects a checksum entry for a missing archive', async () => {
  await withArchives(['darwin-arm64'], async ({ archiveDirectory }) => {
    const missingName = archiveName('linux-x64-gnu')
    const existing = await readFile(join(archiveDirectory, 'standalone-checksums.sha256'), 'utf8')
    await writeFile(
      join(archiveDirectory, 'standalone-checksums.sha256'),
      `${existing}${'0'.repeat(64)}  ${missingName}\n`,
    )
    await assert.rejects(
      () =>
        generateReleaseManifest({
          archiveDirectory,
          ...IDENTITY,
          allowPartialTargets: true,
        }),
      /archive set mismatch; missing: \(none\); unexpected: volund-standalone-linux-x64-gnu.tar.gz/,
    )
  })
})

void test('rejects missing checksum entries and a missing checksum file', async () => {
  await withArchives(['darwin-arm64'], async ({ archiveDirectory }) => {
    await writeFile(join(archiveDirectory, 'standalone-checksums.sha256'), '')
    await assert.rejects(
      () =>
        generateReleaseManifest({
          archiveDirectory,
          ...IDENTITY,
          allowPartialTargets: true,
        }),
      /archive set mismatch; missing: volund-standalone-darwin-arm64.tar.gz/,
    )
    await unlink(join(archiveDirectory, 'standalone-checksums.sha256'))
    await assert.rejects(
      () =>
        generateReleaseManifest({
          archiveDirectory,
          ...IDENTITY,
          allowPartialTargets: true,
        }),
      /standalone-checksums.sha256 is missing/,
    )
  })
})

void test('rejects duplicate checksum entries', async () => {
  await withArchives(['darwin-arm64'], async ({ archiveDirectory }) => {
    const checksumPath = join(archiveDirectory, 'standalone-checksums.sha256')
    const line = await readFile(checksumPath, 'utf8')
    await writeFile(checksumPath, `${line}${line}`)
    await assert.rejects(
      () =>
        generateReleaseManifest({
          archiveDirectory,
          ...IDENTITY,
          allowPartialTargets: true,
        }),
      /duplicate checksum entry for archive 'volund-standalone-darwin-arm64.tar.gz'/,
    )
  })
})

void test('rejects output collisions including symlink aliases to inputs', async () => {
  await withArchives(STANDALONE_TARGETS, async ({ root, archiveDirectory }) => {
    await assert.rejects(
      () =>
        validateManifestOutputPath({
          archiveDirectory,
          output: join(archiveDirectory, 'standalone-checksums.sha256'),
        }),
      /output collides with input 'standalone-checksums.sha256'/,
    )
    await assert.rejects(
      () =>
        validateManifestOutputPath({
          archiveDirectory,
          output: join(archiveDirectory, archiveName('darwin-arm64')),
        }),
      /output collides with input 'volund-standalone-darwin-arm64.tar.gz'/,
    )
    const alias = join(root, 'checksum-alias.json')
    await symlink(join(archiveDirectory, 'standalone-checksums.sha256'), alias)
    await assert.rejects(
      () => validateManifestOutputPath({ archiveDirectory, output: alias }),
      /output collides with input 'standalone-checksums.sha256'/,
    )
  })
})

void test('atomic manifest writes preserve the old output and clean temp files on failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'volund manifest atomic '))
  const output = join(root, 'release-manifest.json')
  await writeFile(output, 'previous manifest\n')
  try {
    await assert.rejects(
      () =>
        writeReleaseManifestAtomically({
          output,
          manifest: { schemaVersion: 1 },
          renameFn: async () => {
            throw new Error('injected rename failure')
          },
        }),
      /injected rename failure/,
    )
    assert.equal(await readFile(output, 'utf8'), 'previous manifest\n')
    assert.deepEqual(await readdir(root), ['release-manifest.json'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

void test('requires every explicit CLI flag and never exposes the partial-target option', () => {
  assert.throws(
    () => parseCliArguments(['--archives', '/tmp/archives']),
    /missing required arguments/,
  )
  assert.throws(
    () =>
      parseCliArguments([
        '--archives',
        '/tmp/archives',
        '--version',
        '0.1.0',
        '--tag',
        'v0.1.0',
        '--commit',
        COMMIT,
        '--bun-version',
        '1.2.21',
        '--output',
        '/tmp/release-manifest.json',
        '--allow-partial-targets',
        'true',
      ]),
    /unknown argument '--allow-partial-targets'/,
  )
})

void test('CLI writes the same validated deterministic manifest', async () => {
  await withArchives(STANDALONE_TARGETS, async ({ root, archiveDirectory }) => {
    const output = join(root, 'release-manifest.json')
    const result = spawnSync(
      process.execPath,
      [
        join(import.meta.dirname, 'generate-release-manifest.mjs'),
        '--archives',
        archiveDirectory,
        '--version',
        IDENTITY.version,
        '--tag',
        IDENTITY.tag,
        '--commit',
        IDENTITY.commit,
        '--bun-version',
        IDENTITY.bunVersion,
        '--output',
        output,
      ],
      { encoding: 'utf8' },
    )
    assert.equal(result.status, 0, result.stderr)
    const expected = await generateReleaseManifest({ archiveDirectory, ...IDENTITY })
    assert.equal(await readFile(output, 'utf8'), serializeReleaseManifest(expected))
  })
})

// ---- CycloneDX SBOM 归一化（normalize-sbom 子命令）----

function sbomFixture({ timestamp = '2026-08-28T01:02:03Z', reversed = false } = {}) {
  const components = [
    { type: 'library', name: 'zeta', version: '2.0.0', 'bom-ref': 'pkg:zeta' },
    { type: 'library', name: 'alpha', version: '1.0.0', 'bom-ref': 'pkg:alpha' },
  ]
  const dependencies = [
    { ref: 'pkg:zeta', dependsOn: ['pkg:alpha', 'pkg:beta'] },
    { ref: 'pkg:alpha', dependsOn: [] },
  ]
  if (reversed) {
    components.reverse()
    dependencies.reverse()
    dependencies.find((entry) => entry.ref === 'pkg:zeta').dependsOn.reverse()
  }
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    serialNumber: reversed ? 'urn:uuid:second' : 'urn:uuid:first',
    version: 1,
    metadata: {
      timestamp,
      component: {
        type: 'application',
        name: 'syft-source',
        version: '0.0.1',
        properties: [{ name: 'preserved', value: 'yes' }],
      },
    },
    components,
    dependencies,
  }
}

void test('normalizes volatile Syft identity and semantic set ordering deterministically', () => {
  const first = normalizeReleaseSbom(sbomFixture(), { version: SBOM_VERSION, commit: SBOM_COMMIT })
  const second = normalizeReleaseSbom(
    sbomFixture({ timestamp: '2030-01-01T00:00:00Z', reversed: true }),
    { version: SBOM_VERSION, commit: SBOM_COMMIT.toUpperCase() },
  )
  assert.equal(serializeReleaseSbom(first), serializeReleaseSbom(second))
  assert.equal(first.serialNumber, undefined)
  assert.equal(first.metadata.timestamp, undefined)
  assert.equal(first.metadata.component.name, 'volund-cli')
  assert.equal(first.metadata.component.version, SBOM_VERSION)
  assert.deepEqual(
    first.components.map((component) => component.name),
    ['alpha', 'zeta'],
  )
  assert.deepEqual(
    first.dependencies.find((dependency) => dependency.ref === 'pkg:zeta').dependsOn,
    ['pkg:alpha', 'pkg:beta'],
  )
  assert.ok(first.metadata.component.properties.some((property) => property.name === 'preserved'))
})

void test('rejects malformed, empty, and component-free CycloneDX documents', () => {
  const identity = { version: SBOM_VERSION, commit: SBOM_COMMIT }
  assert.throws(() => normalizeReleaseSbom(null, identity), /JSON object/)
  assert.throws(() => normalizeReleaseSbom({}, identity), /bomFormat/)
  assert.throws(
    () =>
      normalizeReleaseSbom(
        { bomFormat: 'CycloneDX', specVersion: '1.6', version: 1, components: [] },
        identity,
      ),
    /at least one component/,
  )
  assert.throws(
    () =>
      normalizeReleaseSbom({ bomFormat: 'CycloneDX', specVersion: '1.6', version: 1 }, identity),
    /at least one component/,
  )
  assert.throws(
    () => normalizeReleaseSbom({ ...sbomFixture(), specVersion: '1.3' }, identity),
    /unsupported CycloneDX specVersion/,
  )
})

void test('rejects malformed and placeholder release identities', () => {
  for (const version of ['1', 'v1.2.3', '0.0.0', '0.0.0+build'])
    assert.throws(() => validateReleaseSbomIdentity({ version, commit: SBOM_COMMIT }))
  for (const commit of ['abc', '0'.repeat(40)])
    assert.throws(() => validateReleaseSbomIdentity({ version: SBOM_VERSION, commit }))
})

void test('rejects input symlinks and every kind of existing output', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'volund-sbom-collision-'))
  const input = join(directory, 'raw.json')
  await writeFile(input, JSON.stringify(sbomFixture()))
  await assert.rejects(
    normalizeReleaseSbomFile({ input, output: input, version: SBOM_VERSION, commit: SBOM_COMMIT }),
    /must be different/,
  )
  const inputAlias = join(directory, 'input-alias.json')
  await symlink(input, inputAlias)
  await assert.rejects(
    normalizeReleaseSbomFile({
      input: inputAlias,
      output: join(directory, 'normalized.json'),
      version: SBOM_VERSION,
      commit: SBOM_COMMIT,
    }),
    /non-symlink regular file/,
  )
  const inputDirectory = join(directory, 'input-directory')
  await mkdir(inputDirectory)
  await assert.rejects(
    normalizeReleaseSbomFile({
      input: inputDirectory,
      output: join(directory, 'directory-input-output.json'),
      version: SBOM_VERSION,
      commit: SBOM_COMMIT,
    }),
    /non-symlink regular file/,
  )
  for (const kind of ['file', 'symlink', 'directory']) {
    const output = join(directory, `existing-${kind}`)
    if (kind === 'file') await writeFile(output, 'sentinel')
    else if (kind === 'symlink') await symlink(input, output)
    else await mkdir(output)
    await assert.rejects(
      normalizeReleaseSbomFile({ input, output, version: SBOM_VERSION, commit: SBOM_COMMIT }),
      /must not already exist/,
    )
  }
  context.after(() =>
    import('node:fs/promises').then(({ rm }) => rm(directory, { recursive: true })),
  )
})

void test('invalid input preserves an existing output', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'volund-sbom-invalid-'))
  const input = join(directory, 'raw.json')
  const output = join(directory, 'normalized.json')
  await writeFile(input, '{broken')
  await writeFile(output, 'sentinel')
  await assert.rejects(
    normalizeReleaseSbomFile({ input, output, version: SBOM_VERSION, commit: SBOM_COMMIT }),
    /must not already exist/,
  )
  assert.equal(await readFile(output, 'utf8'), 'sentinel')
  context.after(() =>
    import('node:fs/promises').then(({ rm }) => rm(directory, { recursive: true })),
  )
})

void test('invalid JSON creates no output or temporary file', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'volund-sbom-invalid-new-'))
  const input = join(directory, 'raw.json')
  const output = join(directory, 'normalized.json')
  await writeFile(input, '{broken')
  await assert.rejects(
    normalizeReleaseSbomFile({ input, output, version: SBOM_VERSION, commit: SBOM_COMMIT }),
    /failed to parse/,
  )
  assert.deepEqual((await readdir(directory)).toSorted(), ['raw.json'])
  context.after(() =>
    import('node:fs/promises').then(({ rm }) => rm(directory, { recursive: true })),
  )
})

void test('atomic no-replace commit loses races safely and removes temporary files', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'volund-sbom-atomic-'))
  const output = join(directory, 'normalized.json')
  await assert.rejects(
    writeReleaseSbomAtomically({
      output,
      sbom: normalizeReleaseSbom(sbomFixture(), { version: SBOM_VERSION, commit: SBOM_COMMIT }),
      linkFn: async (temporaryPath, outputPath) => {
        await writeFile(outputPath, 'racing writer')
        await link(temporaryPath, outputPath)
      },
    }),
    { code: 'EEXIST' },
  )
  assert.equal(await readFile(output, 'utf8'), 'racing writer')
  const { rm } = await import('node:fs/promises')
  assert.deepEqual((await readdir(directory)).toSorted(), ['normalized.json'])
  context.after(() => rm(directory, { recursive: true }))
})

void test('writes a new output successfully without overwrite semantics', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'volund-sbom-success-'))
  const input = join(directory, 'raw.json')
  const output = join(directory, 'normalized.json')
  await writeFile(input, JSON.stringify(sbomFixture()))
  await normalizeReleaseSbomFile({ input, output, version: SBOM_VERSION, commit: SBOM_COMMIT })
  assert.equal(JSON.parse(await readFile(output, 'utf8')).metadata.component.version, SBOM_VERSION)
  await assert.rejects(
    normalizeReleaseSbomFile({ input, output, version: SBOM_VERSION, commit: SBOM_COMMIT }),
    /must not already exist/,
  )
  context.after(() =>
    import('node:fs/promises').then(({ rm }) => rm(directory, { recursive: true })),
  )
})

void test('enforces input byte, JSON depth/node, and component limits', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'volund-sbom-limits-'))
  const input = join(directory, 'raw.json')
  await writeFile(input, JSON.stringify(sbomFixture()))
  await assert.rejects(
    readReleaseSbomInput(input, { ...RELEASE_SBOM_LIMITS, inputBytes: 8 }),
    /byte limit/,
  )
  const identity = { version: SBOM_VERSION, commit: SBOM_COMMIT }
  assert.throws(
    () => normalizeReleaseSbom(sbomFixture(), identity, { ...RELEASE_SBOM_LIMITS, jsonNodes: 3 }),
    /node limit/,
  )
  assert.throws(
    () => normalizeReleaseSbom(sbomFixture(), identity, { ...RELEASE_SBOM_LIMITS, jsonDepth: 1 }),
    /depth limit/,
  )
  assert.throws(
    () => normalizeReleaseSbom(sbomFixture(), identity, { ...RELEASE_SBOM_LIMITS, components: 1 }),
    /component limit/,
  )
  context.after(() =>
    import('node:fs/promises').then(({ rm }) => rm(directory, { recursive: true })),
  )
})

void test('preserves magic JSON own keys without prototype mutation', () => {
  const input = JSON.parse(
    `{"bomFormat":"CycloneDX","specVersion":"1.6","version":1,"components":[{"type":"library","name":"safe","__proto__":{"polluted":true}}],"__proto__":"root-value"}`,
  )
  const normalized = normalizeReleaseSbom(input, { version: SBOM_VERSION, commit: SBOM_COMMIT })
  assert.equal(Object.getPrototypeOf(normalized), null)
  assert.equal(normalized.__proto__, 'root-value')
  assert.equal(Object.getPrototypeOf(normalized.components[0].__proto__), null)
  assert.equal(normalized.components[0].__proto__.polluted, true)
  assert.equal({}.polluted, undefined)
})

void test('CLI dispatches the normalize-sbom subcommand', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'volund-sbom-cli-'))
  try {
    const input = join(directory, 'raw.cdx.json')
    const output = join(directory, 'sbom.cdx.json')
    await writeFile(input, JSON.stringify(sbomFixture()))
    const result = spawnSync(
      process.execPath,
      [
        join(import.meta.dirname, 'generate-release-manifest.mjs'),
        'normalize-sbom',
        '--input',
        input,
        '--output',
        output,
        '--version',
        SBOM_VERSION,
        '--commit',
        SBOM_COMMIT,
      ],
      { encoding: 'utf8' },
    )
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /normalized CycloneDX SBOM/)
    const written = JSON.parse(await readFile(output, 'utf8'))
    assert.equal(written.metadata.component.name, 'volund-cli')
    assert.equal(written.metadata.component.version, SBOM_VERSION)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
