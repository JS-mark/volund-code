import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  buildAllStandalone,
  discoverStandaloneTargets,
  STANDALONE_OUTPUT_MARKER,
  STANDALONE_TARGETS,
} from './build-all-standalone.mjs'

async function withFixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'volund standalone all '))
  const assetsDirectory = join(root, 'assets')
  const metadataDirectory = join(root, 'metadata')
  const outDirectory = join(root, 'out')
  await mkdir(assetsDirectory)
  await mkdir(metadataDirectory)
  await writeFile(join(metadataDirectory, 'LICENSE'), 'license fixture\n')
  await writeFile(join(metadataDirectory, 'NOTICE'), 'notice fixture\n')
  await writeFile(join(metadataDirectory, 'sbom.cdx.json'), '{"bomFormat":"CycloneDX"}\n')
  try {
    await run({ root, assetsDirectory, metadataDirectory, outDirectory })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function writeTargetAssets(assetsDirectory, targets) {
  for (const target of targets.toReversed()) {
    const suffix = target.startsWith('win32-') ? '.exe' : ''
    await writeFile(join(assetsDirectory, `volund-sandbox-${target}${suffix}`), target)
  }
}

function fixtureBuilders() {
  return {
    async buildStandaloneFn({ target, outDirectory }) {
      await writeCompleteStandalone(outDirectory, target)
      return { out: outDirectory }
    },
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
    assets.push({ kind, target, file, sha256: createHash('sha256').update(body).digest('hex') })
  }
  await writeFile(
    join(outDirectory, 'native', 'manifest.json'),
    `${JSON.stringify({ schemaVersion: 1, assets }, null, 2)}\n`,
  )
  await writeFile(join(outDirectory, 'plugins', 'index.mjs'), 'export default {}\n')
  await writeFile(
    join(outDirectory, 'checksums.sha256'),
    `${createHash('sha256').update(executable).digest('hex')}  ${executableName}\n`,
  )
}

void test('requires exactly the seven Bun standalone targets by default', async () => {
  await withFixture(async ({ root, assetsDirectory, metadataDirectory, outDirectory }) => {
    await writeTargetAssets(assetsDirectory, STANDALONE_TARGETS)
    const built = await buildAllStandalone({
      root,
      assetsDirectory,
      metadataDirectory,
      outDirectory,
      ...fixtureBuilders(),
    })
    assert.deepEqual(built, STANDALONE_TARGETS)
  })
})

void test('permits a target subset only with explicit allowPartialTargets', async () => {
  await withFixture(async ({ root, assetsDirectory, metadataDirectory, outDirectory }) => {
    const targets = ['darwin-arm64', 'linux-x64-gnu']
    await writeTargetAssets(assetsDirectory, targets)
    const built = await buildAllStandalone({
      root,
      assetsDirectory,
      metadataDirectory,
      outDirectory,
      allowPartialTargets: true,
      ...fixtureBuilders(),
    })
    assert.deepEqual(built, targets)
  })
})

void test('writes deterministic archive checksums under the standalone-specific name', async () => {
  await withFixture(async ({ root, assetsDirectory, metadataDirectory, outDirectory }) => {
    const targets = ['darwin-arm64', 'linux-x64-gnu']
    await writeTargetAssets(assetsDirectory, targets)
    await buildAllStandalone({
      root,
      assetsDirectory,
      metadataDirectory,
      outDirectory,
      allowPartialTargets: true,
      ...fixtureBuilders(),
    })

    const expected = []
    for (const target of targets) {
      const archiveName = `volund-standalone-${target}.tar.gz`
      const body = await readFile(join(outDirectory, 'archives', archiveName))
      expected.push(`${createHash('sha256').update(body).digest('hex')}  ${archiveName}`)
    }
    assert.equal(
      await readFile(join(outDirectory, 'archives', 'standalone-checksums.sha256'), 'utf8'),
      `${expected.join('\n')}\n`,
    )
    await assert.rejects(() => access(join(outDirectory, 'archives', 'checksums.sha256')))
  })
})

void test('fails before building when a production target is missing', async () => {
  await withFixture(async ({ root, assetsDirectory, metadataDirectory, outDirectory }) => {
    await writeTargetAssets(assetsDirectory, STANDALONE_TARGETS.slice(0, -1))
    let buildCalls = 0
    await assert.rejects(
      () =>
        buildAllStandalone({
          root,
          assetsDirectory,
          metadataDirectory,
          outDirectory,
          buildStandaloneFn: async () => {
            buildCalls += 1
          },
        }),
      /target set mismatch; missing: win32-x64-msvc/,
    )
    assert.equal(buildCalls, 0)
  })
})

void test('rejects unexpected and duplicate target assets', () => {
  assert.throws(
    () =>
      discoverStandaloneTargets([
        ...STANDALONE_TARGETS.map(
          (target) => `volund-sandbox-${target}${target.startsWith('win32-') ? '.exe' : ''}`,
        ),
        'volund-sandbox-aix-x64',
      ]),
    /unexpected: aix-x64/,
  )
  assert.throws(
    () =>
      discoverStandaloneTargets(['volund-sandbox-darwin-arm64', 'volund-sandbox-darwin-arm64'], {
        allowPartialTargets: true,
      }),
    /duplicate standalone target 'darwin-arm64'/,
  )
  assert.throws(
    () =>
      discoverStandaloneTargets(['volund-sandbox-darwin-arm64.exe'], {
        allowPartialTargets: true,
      }),
    /invalid target-specific standalone sandbox filename/,
  )
  assert.throws(
    () =>
      discoverStandaloneTargets([{ name: 'volund-sandbox-darwin-arm64', isFile: () => false }], {
        allowPartialTargets: true,
      }),
    /must be a regular file/,
  )
})

void test('the CLI path cannot opt into a partial target set', async () => {
  await withFixture(async ({ assetsDirectory, metadataDirectory, outDirectory }) => {
    await writeTargetAssets(assetsDirectory, ['darwin-arm64'])
    const result = spawnSync(
      process.execPath,
      [
        join(import.meta.dirname, 'build-all-standalone.mjs'),
        assetsDirectory,
        metadataDirectory,
        outDirectory,
      ],
      { encoding: 'utf8' },
    )
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /standalone target set mismatch; missing:/)
  })
})

void test('a failed fresh rebuild leaves the previous archive set untouched', async () => {
  await withFixture(async ({ root, assetsDirectory, metadataDirectory, outDirectory }) => {
    const targets = ['darwin-arm64', 'linux-x64-gnu']
    await writeTargetAssets(assetsDirectory, targets)
    await buildAllStandalone({
      root,
      assetsDirectory,
      metadataDirectory,
      outDirectory,
      allowPartialTargets: true,
      ...fixtureBuilders(),
    })
    const previousArchive = await readFile(
      join(outDirectory, 'archives', 'volund-standalone-darwin-arm64.tar.gz'),
    )
    const previousChecksums = await readFile(
      join(outDirectory, 'archives', 'standalone-checksums.sha256'),
    )

    await assert.rejects(
      () =>
        buildAllStandalone({
          root,
          assetsDirectory,
          metadataDirectory,
          outDirectory,
          allowPartialTargets: true,
          buildStandaloneFn: async ({ target, outDirectory: targetOut }) => {
            if (target === 'linux-x64-gnu') throw new Error('injected mid-build failure')
            await writeCompleteStandalone(targetOut, target)
            return { out: targetOut }
          },
        }),
      /injected mid-build failure/,
    )
    assert.deepEqual(
      await readFile(join(outDirectory, 'archives', 'volund-standalone-darwin-arm64.tar.gz')),
      previousArchive,
    )
    assert.deepEqual(
      await readFile(join(outDirectory, 'archives', 'standalone-checksums.sha256')),
      previousChecksums,
    )
  })
})

void test('successfully replaces an exact owned output on repeat promotion', async () => {
  await withFixture(async ({ root, assetsDirectory, metadataDirectory, outDirectory }) => {
    const targets = ['darwin-arm64', 'linux-x64-gnu']
    await writeTargetAssets(assetsDirectory, targets)
    const options = {
      root,
      assetsDirectory,
      metadataDirectory,
      outDirectory,
      allowPartialTargets: true,
      ...fixtureBuilders(),
    }
    await buildAllStandalone(options)
    const firstArchive = await readFile(
      join(outDirectory, 'archives', 'volund-standalone-darwin-arm64.tar.gz'),
    )
    await buildAllStandalone(options)
    assert.deepEqual(
      await readFile(join(outDirectory, 'archives', 'volund-standalone-darwin-arm64.tar.gz')),
      firstArchive,
    )
    assert.deepEqual(JSON.parse(await readFile(join(outDirectory, STANDALONE_OUTPUT_MARKER))), {
      schemaVersion: 1,
      product: 'volund',
      kind: 'standalone-build-output',
    })
    const nestedSentinel = join(outDirectory, 'darwin-arm64', 'sentinel.txt')
    await writeFile(nestedSentinel, 'preserve nested unknown content')
    await assert.rejects(
      () => buildAllStandalone(options),
      /unknown top-level standalone archive entry 'sentinel.txt'|modified 'darwin-arm64' contents/,
    )
    assert.equal(await readFile(nestedSentinel, 'utf8'), 'preserve nested unknown content')
  })
})

void test('path fences reject repository roots and ancestors of protected inputs', async () => {
  await withFixture(async ({ root, assetsDirectory, metadataDirectory }) => {
    await writeTargetAssets(assetsDirectory, ['darwin-arm64'])
    const sentinel = join(root, 'sentinel.txt')
    await writeFile(sentinel, 'preserve me')
    const baseOptions = {
      root,
      assetsDirectory,
      metadataDirectory,
      allowPartialTargets: true,
      ...fixtureBuilders(),
    }
    await assert.rejects(
      () => buildAllStandalone({ ...baseOptions, outDirectory: '.' }),
      /unsafe standalone output directory/,
    )
    await assert.rejects(
      () => buildAllStandalone({ ...baseOptions, outDirectory: root }),
      /unsafe standalone output directory/,
    )
    const assetsAlias = join(root, 'assets-alias')
    await symlink(assetsDirectory, assetsAlias)
    await assert.rejects(
      () => buildAllStandalone({ ...baseOptions, outDirectory: assetsAlias }),
      /unsafe standalone output directory/,
    )

    const inputParent = join(root, 'input-parent')
    const nestedAssets = join(inputParent, 'assets')
    await mkdir(nestedAssets, { recursive: true })
    await writeTargetAssets(nestedAssets, ['darwin-arm64'])
    await writeFile(join(inputParent, 'ancestor-sentinel.txt'), 'preserve ancestor')
    await assert.rejects(
      () =>
        buildAllStandalone({
          ...baseOptions,
          assetsDirectory: nestedAssets,
          outDirectory: inputParent,
        }),
      /unsafe standalone output directory/,
    )
    assert.equal(await readFile(sentinel, 'utf8'), 'preserve me')
    assert.equal(
      await readFile(join(inputParent, 'ancestor-sentinel.txt'), 'utf8'),
      'preserve ancestor',
    )
  })
})

void test('refuses to replace an existing unmarked directory and preserves its sentinel', async () => {
  await withFixture(async ({ root, assetsDirectory, metadataDirectory, outDirectory }) => {
    await writeTargetAssets(assetsDirectory, ['darwin-arm64'])
    await mkdir(outDirectory)
    const sentinel = join(outDirectory, 'sentinel.txt')
    await writeFile(sentinel, 'unowned')
    await assert.rejects(
      () =>
        buildAllStandalone({
          root,
          assetsDirectory,
          metadataDirectory,
          outDirectory,
          allowPartialTargets: true,
          ...fixtureBuilders(),
        }),
      /refusing to replace unowned standalone output/,
    )
    assert.equal(await readFile(sentinel, 'utf8'), 'unowned')
  })
})

void test('preflights all three required release metadata files before building', async () => {
  await withFixture(async ({ root, assetsDirectory, metadataDirectory, outDirectory }) => {
    await writeTargetAssets(assetsDirectory, ['darwin-arm64'])
    await rm(join(metadataDirectory, 'NOTICE'))
    let buildCalls = 0
    await assert.rejects(
      () =>
        buildAllStandalone({
          root,
          assetsDirectory,
          metadataDirectory,
          outDirectory,
          allowPartialTargets: true,
          buildStandaloneFn: async () => {
            buildCalls += 1
          },
        }),
      /required standalone metadata file is missing: .*NOTICE/,
    )
    assert.equal(buildCalls, 0)
    await assert.rejects(() => access(outDirectory))
  })
})
