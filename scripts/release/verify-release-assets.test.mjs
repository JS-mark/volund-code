import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { serializeReleaseManifest } from './generate-release-manifest.mjs'
import {
  EXPECTED_RELEASE_ASSET_NAMES,
  compareReleaseAssetFiles,
  parseCliRequest,
  parseRulesetIndex,
  RAW_SIDECAR_NAMES,
  RELEASE_ASSET_LIMITS,
  RELEASE_MANIFEST_FILE,
  RELEASE_TAG_RULESET_CONTRACT,
  REQUIRED_RULE_TYPES,
  RULESET_BYPASS_TRUST_BOUNDARY,
  SIDECAR_CHECKSUMS_FILE,
  stageStandaloneSidecars,
  STANDALONE_ARCHIVE_NAMES,
  STANDALONE_SIDECAR_NAMES,
  verifyGithubReleaseState,
  verifyImmutableReleasePolicy,
  verifyReleaseTagRulesets,
  verifyRemoteAssetNames,
  verifyRemoteAssetListFile,
  verifySidecarChecksums,
  verifyStandaloneCandidate,
  writeSidecarChecksums,
  releaseAssetLimitForName,
} from './verify-release-assets.mjs'

async function makeDirectory(context, prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  context.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

async function writeNamedFiles(directory, names) {
  for (const name of names) await writeFile(join(directory, name), `bytes:${name}`)
}

void test('defines exact 24 raw sidecars, 21 standalone inputs, and 34 Release assets', () => {
  assert.equal(RAW_SIDECAR_NAMES.length, 24)
  assert.equal(STANDALONE_SIDECAR_NAMES.length, 21)
  assert.equal(EXPECTED_RELEASE_ASSET_NAMES.length, 34)
  assert.equal(
    STANDALONE_SIDECAR_NAMES.some((name) => name.includes('win32-arm64-msvc')),
    false,
  )
})

void test('stages only the exact seven-target sidecar set', async (context) => {
  const source = await makeDirectory(context, 'volund-raw-sidecars-')
  const output = join(source, '..', `volund-standalone-sidecars-${process.pid}-${Date.now()}`)
  context.after(() => rm(output, { recursive: true, force: true }))
  await writeNamedFiles(source, RAW_SIDECAR_NAMES)
  await stageStandaloneSidecars({ sourceDirectory: source, outputDirectory: output })
  assert.deepEqual((await readdir(output)).toSorted(), STANDALONE_SIDECAR_NAMES)
  await writeFile(join(source, 'foreign.bin'), 'foreign')
  await assert.rejects(
    stageStandaloneSidecars({
      sourceDirectory: source,
      outputDirectory: `${output}-foreign`,
    }),
    /exactly 24 sidecars/,
  )
})

void test('writes and verifies an exact deterministic 24-entry sidecar checksum file', async (context) => {
  const directory = await makeDirectory(context, 'volund-sidecar-checksums-')
  await writeNamedFiles(directory, RAW_SIDECAR_NAMES)
  const output = join(directory, SIDECAR_CHECKSUMS_FILE)
  await writeSidecarChecksums({ directory, output })
  const checksumContents = await readFile(output, 'utf8')
  const lines = checksumContents.trimEnd().split('\n')
  assert.equal(lines.length, 24)
  assert.deepEqual(
    lines.map((line) => line.slice(66)),
    RAW_SIDECAR_NAMES,
  )
  await verifySidecarChecksums(directory)
  await writeFile(join(directory, RAW_SIDECAR_NAMES[0]), 'tampered')
  await assert.rejects(verifySidecarChecksums(directory), /checksum mismatch/)
  await writeFile(join(directory, RAW_SIDECAR_NAMES[0]), `bytes:${RAW_SIDECAR_NAMES[0]}`)
  await writeFile(output, `${checksumContents}${lines[0]}\n`)
  await assert.rejects(verifySidecarChecksums(directory), /duplicate sidecar checksum/)
})

void test('rejects missing, foreign, and duplicate remote Release asset names', () => {
  const complete = `${EXPECTED_RELEASE_ASSET_NAMES.join('\n')}\n`
  assert.doesNotThrow(() => verifyRemoteAssetNames('', { exact: false }))
  assert.doesNotThrow(() => verifyRemoteAssetNames(complete, { exact: true }))
  assert.doesNotThrow(() =>
    verifyRemoteAssetNames(`${EXPECTED_RELEASE_ASSET_NAMES.join('\r\n')}\r\n`, { exact: true }),
  )
  assert.throws(
    () => verifyRemoteAssetNames(`${complete}foreign.zip\n`, { exact: false }),
    /unexpected: foreign.zip/,
  )
  assert.throws(
    () => verifyRemoteAssetNames(`${EXPECTED_RELEASE_ASSET_NAMES[0]}\n`, { exact: true }),
    /missing:/,
  )
  assert.throws(
    () =>
      verifyRemoteAssetNames(
        `${EXPECTED_RELEASE_ASSET_NAMES[0]}\n${EXPECTED_RELEASE_ASSET_NAMES[0]}\n`,
        { exact: false },
      ),
    /duplicate/,
  )
})

void test('rejects static and swapped symlinks and cleans failed staging', async (context) => {
  const source = await makeDirectory(context, 'volund-sidecar-symlink-')
  await writeNamedFiles(source, RAW_SIDECAR_NAMES)
  const target = join(source, '..', `volund-sidecar-target-${process.pid}-${Date.now()}`)
  const output = join(source, '..', `volund-sidecar-output-${process.pid}-${Date.now()}`)
  context.after(() => rm(target, { force: true }))
  context.after(() => rm(output, { recursive: true, force: true }))
  await writeFile(target, 'replacement')

  const swappedName = STANDALONE_SIDECAR_NAMES[0]
  await rm(join(source, swappedName))
  await symlink(target, join(source, swappedName))
  await assert.rejects(
    stageStandaloneSidecars({ sourceDirectory: source, outputDirectory: output }),
    /regular file/,
  )
  await assert.rejects(readdir(output), /ENOENT/)

  await rm(join(source, swappedName))
  await writeFile(join(source, swappedName), `bytes:${swappedName}`)
  await assert.rejects(
    stageStandaloneSidecars({
      sourceDirectory: source,
      outputDirectory: output,
      beforeCopy: async ({ index, name }) => {
        if (index !== 0) return
        await rm(join(source, name))
        await symlink(target, join(source, name))
      },
    }),
    /must not be a symlink/,
  )
  await assert.rejects(readdir(output), /ENOENT/)
})

void test('enforces sidecar, checksum, manifest, and remote-list size limits', async (context) => {
  const sidecars = await makeDirectory(context, 'volund-sidecar-limits-')
  await writeNamedFiles(sidecars, RAW_SIDECAR_NAMES)
  const oversizedSidecar = await open(join(sidecars, STANDALONE_SIDECAR_NAMES[0]), 'w')
  await oversizedSidecar.truncate(RELEASE_ASSET_LIMITS.sidecarBytes + 1)
  await oversizedSidecar.close()
  const output = join(sidecars, '..', `volund-sidecar-limit-output-${process.pid}-${Date.now()}`)
  context.after(() => rm(output, { recursive: true, force: true }))
  await assert.rejects(
    stageStandaloneSidecars({ sourceDirectory: sidecars, outputDirectory: output }),
    /byte limit/,
  )
  await assert.rejects(readdir(output), /ENOENT/)

  await writeFile(join(sidecars, STANDALONE_SIDECAR_NAMES[0]), 'restored')
  const checksum = await open(join(sidecars, SIDECAR_CHECKSUMS_FILE), 'w')
  await checksum.truncate(RELEASE_ASSET_LIMITS.checksumBytes + 1)
  await checksum.close()
  await assert.rejects(verifySidecarChecksums(sidecars), /byte limit/)

  const remoteList = join(sidecars, '..', `volund-remote-list-${process.pid}-${Date.now()}`)
  context.after(() => rm(remoteList, { force: true }))
  const remoteHandle = await open(remoteList, 'w')
  await remoteHandle.truncate(RELEASE_ASSET_LIMITS.remoteListBytes + 1)
  await remoteHandle.close()
  await assert.rejects(verifyRemoteAssetListFile(remoteList, { exact: true }), /byte limit/)

  const standalone = await makeDirectory(context, 'volund-manifest-limit-')
  await writeNamedFiles(standalone, [...STANDALONE_ARCHIVE_NAMES, 'standalone-checksums.sha256'])
  const manifest = await open(join(standalone, RELEASE_MANIFEST_FILE), 'w')
  await manifest.truncate(RELEASE_ASSET_LIMITS.manifestBytes + 1)
  await manifest.close()
  await assert.rejects(
    verifyStandaloneCandidate({
      directory: standalone,
      version: '1.2.3',
      tag: 'v1.2.3',
      commit: '1'.repeat(40),
      bunVersion: '1.3.6',
      generateManifestFn: async () => assert.fail('oversized manifest must fail before parsing'),
    }),
    /byte limit/,
  )
})

void test('compares regular release files incrementally and rejects differences and symlinks', async (context) => {
  const leftDirectory = await makeDirectory(context, 'volund-compare-left-')
  const rightDirectory = await makeDirectory(context, 'volund-compare-right-')
  const name = RAW_SIDECAR_NAMES[0]
  const left = join(leftDirectory, name)
  const right = join(rightDirectory, name)
  await writeFile(left, 'matching bytes')
  await writeFile(right, 'matching bytes')
  await compareReleaseAssetFiles(left, right)
  await writeFile(right, 'different bytes')
  await assert.rejects(compareReleaseAssetFiles(left, right), /differs from local bytes/)
  await rm(right)
  await symlink(left, right)
  await assert.rejects(compareReleaseAssetFiles(left, right), /must not be a symlink/)
})

void test('rejects missing, repeated, unknown, and command-inapplicable CLI flags', () => {
  assert.throws(() => parseCliRequest('unknown', []), /unknown command/)
  assert.throws(() => parseCliRequest('verify-sidecars', []), /missing required/)
  assert.throws(
    () => parseCliRequest('verify-sidecars', ['--directory', 'a', '--directory', 'b']),
    /duplicate/,
  )
  assert.throws(
    () => parseCliRequest('verify-sidecars', ['--directory', 'a', '--mode', 'exact']),
    /unknown argument '--mode'/,
  )
  assert.throws(() => parseCliRequest('list-release-assets', ['--input', 'a']), /unknown argument/)
  assert.doesNotThrow(() => parseCliRequest('list-release-assets', []))
})

void test('compares the downloaded manifest byte-for-byte with regenerated identity', async (context) => {
  const directory = await makeDirectory(context, 'volund-standalone-candidate-')
  const manifest = {
    schemaVersion: 1,
    version: '1.2.3',
    tag: 'v1.2.3',
    commit: '1'.repeat(40),
    bunVersion: '1.3.6',
    artifacts: [],
  }
  await writeNamedFiles(directory, [...STANDALONE_ARCHIVE_NAMES, 'standalone-checksums.sha256'])
  await writeFile(join(directory, RELEASE_MANIFEST_FILE), serializeReleaseManifest(manifest))
  const options = {
    directory,
    version: '1.2.3',
    tag: 'v1.2.3',
    commit: '1'.repeat(40),
    bunVersion: '1.3.6',
    generateManifestFn: async () => manifest,
  }
  await verifyStandaloneCandidate(options)
  await writeFile(join(directory, RELEASE_MANIFEST_FILE), '{}\n')
  await assert.rejects(verifyStandaloneCandidate(options), /does not match/)
  await writeFile(join(directory, 'foreign.zip'), 'foreign')
  await assert.rejects(verifyStandaloneCandidate(options), /unexpected: foreign.zip/)
})

// ---- GitHub Release 策略门子命令 ----

const TAG = 'v1.2.3'
const COMMIT = '1'.repeat(40)
const execFileAsync = promisify(execFile)
const verifierScript = new URL('./verify-release-assets.mjs', import.meta.url)

function digestFor(name) {
  return `sha256:${createHash('sha256').update(name).digest('hex')}`
}

function localAssets() {
  return EXPECTED_RELEASE_ASSET_NAMES.map((name) => ({
    name,
    size: Buffer.byteLength(name),
    digest: digestFor(name),
  }))
}

function releaseDocument({
  state = 'draft',
  commit = COMMIT,
  assets = localAssets(),
  totalCount = assets.length,
} = {}) {
  if (state === 'absent') return { data: { repository: { release: null } } }
  return {
    data: {
      repository: {
        release: {
          id: 'R_test',
          isDraft: state === 'draft',
          immutable: state === 'published',
          tagName: TAG,
          tagCommit: { oid: commit },
          assets: { totalCount, nodes: assets },
        },
      },
    },
  }
}

function validRuleset(overrides = {}) {
  return {
    id: 42,
    name: 'release-tag-integrity',
    target: RELEASE_TAG_RULESET_CONTRACT.target,
    enforcement: RELEASE_TAG_RULESET_CONTRACT.enforcement,
    conditions: {
      ref_name: { include: [RELEASE_TAG_RULESET_CONTRACT.requiredInclude], exclude: [] },
    },
    rules: RELEASE_TAG_RULESET_CONTRACT.requiredRules.map((type) => ({ type })),
    ...overrides,
  }
}

void test('requires the immutable releases endpoint to report enabled=true', () => {
  assert.equal(verifyImmutableReleasePolicy({ enabled: true, enforced_by_owner: false }), true)
  assert.throws(() => verifyImmutableReleasePolicy({ enabled: false }), /must be enabled/)
  assert.throws(() => verifyImmutableReleasePolicy({}), /must be enabled/)
  assert.throws(() => verifyImmutableReleasePolicy([]), /JSON object/)
})

void test('accepts only the fixed active tag ruleset semantic contract', () => {
  assert.equal(verifyReleaseTagRulesets([validRuleset()]), true)
  for (const ruleset of [
    validRuleset({ target: 'branch' }),
    validRuleset({ enforcement: 'evaluate' }),
    validRuleset({
      conditions: { ref_name: { include: ['~ALL'], exclude: [] } },
    }),
    validRuleset({
      conditions: {
        ref_name: { include: [RELEASE_TAG_RULESET_CONTRACT.requiredInclude], exclude: ['v1.*'] },
      },
    }),
  ])
    assert.throws(() => verifyReleaseTagRulesets([ruleset]), /no active tag ruleset/)

  assert.deepEqual(REQUIRED_RULE_TYPES, ['creation', 'update', 'deletion'])
  for (const missing of REQUIRED_RULE_TYPES) {
    const rules = REQUIRED_RULE_TYPES.filter((type) => type !== missing).map((type) => ({ type }))
    assert.throws(
      () => verifyReleaseTagRulesets([validRuleset({ rules })]),
      /creation\/update\/deletion rules/,
    )
  }
})

void test('treats ruleset administrators as the explicit bypass trust boundary', () => {
  assert.match(RULESET_BYPASS_TRUST_BOUNDARY, /trusted deployment boundary/)
  assert.match(RULESET_BYPASS_TRUST_BOUNDARY, /create, update, or delete refs\/tags\/v\*/)
  assert.match(RULESET_BYPASS_TRUST_BOUNDARY, /hides bypass_actors/)
  assert.doesNotThrow(() =>
    verifyReleaseTagRulesets([
      validRuleset({
        bypass_actors: [{ actor_id: 1, actor_type: 'RepositoryRole', bypass_mode: 'always' }],
      }),
    ]),
  )
  assert.doesNotThrow(() => verifyReleaseTagRulesets([validRuleset({ bypass_actors: undefined })]))
})

void test('parses paginated ruleset indexes and rejects duplicate or ambiguous ids', () => {
  assert.deepEqual(parseRulesetIndex([[{ id: 2 }], [{ id: 1 }]]), [1, 2])
  assert.throws(() => parseRulesetIndex([{ id: 1 }, { id: 1 }]), /duplicate ruleset id/)
  assert.throws(() => parseRulesetIndex([[{ id: 1 }], { id: 2 }]), /ambiguous pagination/)
  assert.throws(() => parseRulesetIndex([{ id: '../1' }]), /invalid id/)
})

void test('distinguishes absent, complete draft, and immutable published release states', () => {
  assert.equal(
    verifyGithubReleaseState(releaseDocument({ state: 'absent' }), {
      tag: TAG,
      commit: COMMIT,
      localAssets: localAssets(),
    }).state,
    'absent',
  )
  assert.equal(
    verifyGithubReleaseState(releaseDocument({ state: 'draft' }), {
      tag: TAG,
      commit: COMMIT,
      localAssets: localAssets(),
      expect: 'draft',
    }).state,
    'draft',
  )
  assert.equal(
    verifyGithubReleaseState(releaseDocument({ state: 'published' }), {
      tag: TAG,
      commit: COMMIT,
      localAssets: localAssets(),
      expect: 'published',
    }).state,
    'published',
  )
})

void test('rejects mutable published releases and wrong release identity', () => {
  const mutable = releaseDocument({ state: 'published' })
  mutable.data.repository.release.immutable = false
  assert.throws(
    () =>
      verifyGithubReleaseState(mutable, {
        tag: TAG,
        commit: COMMIT,
        localAssets: localAssets(),
      }),
    /published release is mutable/,
  )
  assert.throws(
    () =>
      verifyGithubReleaseState(releaseDocument({ commit: '2'.repeat(40) }), {
        tag: TAG,
        commit: COMMIT,
        localAssets: localAssets(),
      }),
    /tagCommit/,
  )
  const wrongTag = releaseDocument()
  wrongTag.data.repository.release.tagName = 'v9.9.9'
  assert.throws(
    () =>
      verifyGithubReleaseState(wrongTag, {
        tag: TAG,
        commit: COMMIT,
        localAssets: localAssets(),
      }),
    /tagName/,
  )
})

void test('fails the metadata gate on partial, duplicate, oversized, or bad-digest assets', () => {
  const local = localAssets()
  const partial = local.slice(0, -1)
  assert.throws(
    () =>
      verifyGithubReleaseState(releaseDocument({ assets: partial }), {
        tag: TAG,
        commit: COMMIT,
        localAssets: local,
      }),
    /exactly 34 assets/,
  )

  const duplicate = local.map((asset) => ({ ...asset }))
  duplicate[1].name = duplicate[0].name
  assert.throws(
    () =>
      verifyGithubReleaseState(releaseDocument({ assets: duplicate }), {
        tag: TAG,
        commit: COMMIT,
        localAssets: local,
      }),
    /duplicate release asset/,
  )

  const oversized = local.map((asset) => ({ ...asset }))
  oversized[0].size = releaseAssetLimitForName(oversized[0].name) + 1
  assert.throws(
    () =>
      verifyGithubReleaseState(releaseDocument({ assets: oversized }), {
        tag: TAG,
        commit: COMMIT,
        localAssets: local,
      }),
    /type size limit/,
  )

  const badDigest = local.map((asset) => ({ ...asset }))
  badDigest[0].digest = 'md5:bad'
  assert.throws(
    () =>
      verifyGithubReleaseState(releaseDocument({ assets: badDigest }), {
        tag: TAG,
        commit: COMMIT,
        localAssets: local,
      }),
    /invalid digest/,
  )
})

void test('enforces totalCount, page completeness, expected state, and strict CLI flags', () => {
  const local = localAssets()
  assert.throws(
    () =>
      verifyGithubReleaseState(releaseDocument({ totalCount: 101 }), {
        tag: TAG,
        commit: COMMIT,
        localAssets: local,
      }),
    /first:100 contract/,
  )
  assert.throws(
    () =>
      verifyGithubReleaseState(releaseDocument({ totalCount: 35 }), {
        tag: TAG,
        commit: COMMIT,
        localAssets: local,
      }),
    /incomplete for totalCount/,
  )
  assert.throws(
    () =>
      verifyGithubReleaseState(releaseDocument({ state: 'absent' }), {
        tag: TAG,
        commit: COMMIT,
        localAssets: local,
        expect: 'draft',
      }),
    /expected draft release/,
  )
  assert.throws(() => parseCliRequest('verify-immutable', []), /missing required/)
  assert.throws(
    () => parseCliRequest('verify-immutable', ['--input', 'a', '--input', 'b']),
    /duplicate/,
  )
  assert.throws(
    () => parseCliRequest('verify-immutable', ['--input', 'a', '--tag', TAG]),
    /unknown argument/,
  )
})

void test('CLI accepts bounded regular JSON and rejects symlink and oversized policy inputs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'volund-release-policy-'))
  try {
    const policy = join(directory, 'policy.json')
    const alias = join(directory, 'policy-alias.json')
    const oversized = join(directory, 'oversized.json')
    await writeFile(policy, '{"enabled":true}\n')
    await symlink(policy, alias)
    await writeFile(oversized, `{"padding":"${'x'.repeat(1024 * 1024)}"}`)

    await execFileAsync(process.execPath, [
      verifierScript.pathname,
      'verify-immutable',
      '--input',
      policy,
    ])
    await assert.rejects(
      execFileAsync(process.execPath, [
        verifierScript.pathname,
        'verify-immutable',
        '--input',
        alias,
      ]),
      /must not be a symlink/,
    )
    await assert.rejects(
      execFileAsync(process.execPath, [
        verifierScript.pathname,
        'verify-immutable',
        '--input',
        oversized,
      ]),
      /exceeds the JSON byte limit/,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

void test('the normal pnpm test command includes the release asset verifier suite', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
  )
  assert.match(manifest.scripts.test, /scripts\/release\/verify-release-assets\.test\.mjs/)
})
