import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, mkdtemp, open, readdir, rm, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

import { STANDALONE_TARGETS } from './build-all-standalone.mjs'
import {
  generateReleaseManifest,
  serializeReleaseManifest,
  STANDALONE_CHECKSUMS_FILE,
} from './generate-release-manifest.mjs'
import { archiveNameForTarget } from './standalone-archive.mjs'

export const SIDECAR_CHECKSUMS_FILE = 'sidecars-checksums.sha256'
export const RELEASE_MANIFEST_FILE = 'release-manifest.json'
export const RELEASE_ASSET_LIMITS = Object.freeze({
  checksumBytes: 256 * 1024,
  manifestBytes: 8 * 1024 * 1024,
  remoteListBytes: 256 * 1024,
  sidecarBytes: 512 * 1024 * 1024,
  archiveBytes: 512 * 1024 * 1024,
})
const IO_CHUNK_BYTES = 1024 * 1024

export const RAW_SIDECAR_TARGETS = Object.freeze([
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64-gnu',
  'linux-x64-gnu',
  'linux-arm64-musl',
  'linux-x64-musl',
  'win32-arm64-msvc',
  'win32-x64-msvc',
])
export const SIDECAR_KINDS = Object.freeze(['sandbox', 'search', 'fs'])

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function sidecarName(kind, target) {
  const extension = target.startsWith('win32-') ? '.exe' : ''
  return `volund-${kind}-${target}${extension}`
}

export const RAW_SIDECAR_NAMES = Object.freeze(
  RAW_SIDECAR_TARGETS.flatMap((target) =>
    SIDECAR_KINDS.map((kind) => sidecarName(kind, target)),
  ).toSorted(compareText),
)
export const STANDALONE_SIDECAR_NAMES = Object.freeze(
  STANDALONE_TARGETS.flatMap((target) =>
    SIDECAR_KINDS.map((kind) => sidecarName(kind, target)),
  ).toSorted(compareText),
)
export const STANDALONE_ARCHIVE_NAMES = Object.freeze(
  STANDALONE_TARGETS.map(archiveNameForTarget).toSorted(compareText),
)
export const EXPECTED_RELEASE_ASSET_NAMES = Object.freeze(
  [
    ...RAW_SIDECAR_NAMES,
    SIDECAR_CHECKSUMS_FILE,
    ...STANDALONE_ARCHIVE_NAMES,
    STANDALONE_CHECKSUMS_FILE,
    RELEASE_MANIFEST_FILE,
  ].toSorted(compareText),
)

function formatNames(names) {
  return names.length === 0 ? '(none)' : names.join(', ')
}

export function releaseAssetLimitForName(name) {
  if (name === SIDECAR_CHECKSUMS_FILE || name === STANDALONE_CHECKSUMS_FILE)
    return RELEASE_ASSET_LIMITS.checksumBytes
  if (name === RELEASE_MANIFEST_FILE) return RELEASE_ASSET_LIMITS.manifestBytes
  if (RAW_SIDECAR_NAMES.includes(name)) return RELEASE_ASSET_LIMITS.sidecarBytes
  if (STANDALONE_ARCHIVE_NAMES.includes(name)) return RELEASE_ASSET_LIMITS.archiveBytes
  throw new Error(`unknown release asset name '${name}'`)
}

export async function describeReleaseAssetFile(path) {
  const name = basename(path)
  const { sha256, size } = await digestBoundedFile(path, {
    limit: releaseAssetLimitForName(name),
    label: `release asset '${name}'`,
  })
  return { name, size, digest: `sha256:${sha256}` }
}

function sameFileMetadata(before, after) {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  )
}

async function openBoundedRegularFile(path, { limit, label }) {
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const metadata = await handle.stat()
    if (!metadata.isFile()) throw new Error(`${label} must be a regular file: ${path}`)
    if (metadata.size > limit) throw new Error(`${label} exceeds ${limit} byte limit: ${path}`)
    return { handle, metadata }
  } catch (error) {
    await handle?.close().catch(() => {})
    if (error?.code === 'ELOOP')
      throw new Error(`${label} must not be a symlink: ${path}`, { cause: error })
    throw error
  }
}

async function assertInputUnchanged(handle, before, label) {
  const after = await handle.stat()
  if (!sameFileMetadata(before, after)) throw new Error(`${label} changed while being read`)
}

async function readBoundedText(path, { limit, label }) {
  const { handle, metadata } = await openBoundedRegularFile(path, { limit, label })
  try {
    const body = Buffer.alloc(metadata.size)
    let offset = 0
    while (offset < body.length) {
      const { bytesRead } = await handle.read(body, offset, body.length - offset, offset)
      if (bytesRead === 0) throw new Error(`${label} was truncated while being read`)
      offset += bytesRead
    }
    const extra = Buffer.alloc(1)
    if ((await handle.read(extra, 0, 1, metadata.size)).bytesRead !== 0)
      throw new Error(`${label} grew while being read`)
    await assertInputUnchanged(handle, metadata, label)
    return body.toString('utf8')
  } finally {
    await handle.close()
  }
}

async function digestBoundedFile(path, { limit, label }) {
  const { handle, metadata } = await openBoundedRegularFile(path, { limit, label })
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(Math.min(IO_CHUNK_BYTES, Math.max(1, metadata.size)))
  try {
    let position = 0
    while (position < metadata.size) {
      const length = Math.min(buffer.length, metadata.size - position)
      const { bytesRead } = await handle.read(buffer, 0, length, position)
      if (bytesRead === 0) throw new Error(`${label} was truncated while being hashed`)
      hash.update(buffer.subarray(0, bytesRead))
      position += bytesRead
    }
    await assertInputUnchanged(handle, metadata, label)
    return { sha256: hash.digest('hex'), size: metadata.size }
  } finally {
    await handle.close()
  }
}

async function copyBoundedFileExclusive(source, destination, { limit, label }) {
  const { handle: sourceHandle, metadata } = await openBoundedRegularFile(source, {
    limit,
    label,
  })
  let destinationHandle
  try {
    destinationHandle = await open(destination, 'wx', 0o644)
    const buffer = Buffer.allocUnsafe(Math.min(IO_CHUNK_BYTES, Math.max(1, metadata.size)))
    let position = 0
    while (position < metadata.size) {
      const length = Math.min(buffer.length, metadata.size - position)
      const { bytesRead } = await sourceHandle.read(buffer, 0, length, position)
      if (bytesRead === 0) throw new Error(`${label} was truncated while being copied`)
      let written = 0
      while (written < bytesRead) {
        const result = await destinationHandle.write(buffer, written, bytesRead - written, null)
        if (result.bytesWritten === 0) throw new Error(`${label} could not be copied completely`)
        written += result.bytesWritten
      }
      position += bytesRead
    }
    await assertInputUnchanged(sourceHandle, metadata, label)
    await destinationHandle.sync()
    await destinationHandle.close()
    destinationHandle = undefined
  } catch (error) {
    await destinationHandle?.close().catch(() => {})
    await unlink(destination).catch(() => {})
    throw error
  } finally {
    await sourceHandle.close()
  }
}

async function assertExactFileNames(directory, expectedNames, label) {
  const entries = await readdir(directory, { withFileTypes: true })
  const expected = new Set(expectedNames)
  const actual = entries.map((entry) => entry.name)
  const missing = expectedNames.filter((name) => !actual.includes(name))
  const unexpected = actual.filter((name) => !expected.has(name)).toSorted(compareText)
  if (missing.length > 0 || unexpected.length > 0)
    throw new Error(
      `${label} set mismatch; missing: ${formatNames(missing)}; unexpected: ${formatNames(unexpected)}`,
    )
  for (const entry of entries) {
    if (!entry.isFile()) throw new Error(`${label} entry must be a regular file: ${entry.name}`)
  }
}

async function assertExactBoundedFiles(directory, expectedNames, label) {
  await assertExactFileNames(directory, expectedNames, label)
  for (const name of expectedNames) {
    const { handle } = await openBoundedRegularFile(join(directory, name), {
      limit: releaseAssetLimitForName(name),
      label: `${label} entry '${name}'`,
    })
    await handle.close()
  }
}

export async function stageStandaloneSidecars({ sourceDirectory, outputDirectory, beforeCopy }) {
  const sourceNames = (await readdir(sourceDirectory)).toSorted(compareText)
  const validSourceSets = [
    RAW_SIDECAR_NAMES,
    [...RAW_SIDECAR_NAMES, SIDECAR_CHECKSUMS_FILE].toSorted(compareText),
  ]
  if (!validSourceSets.some((names) => names.join('\0') === sourceNames.join('\0')))
    throw new Error(
      'raw sidecar source must contain exactly 24 sidecars and optional checksum file',
    )
  await assertExactFileNames(sourceDirectory, sourceNames, 'raw sidecar source')
  await mkdir(outputDirectory)
  try {
    for (const [index, name] of STANDALONE_SIDECAR_NAMES.entries()) {
      await beforeCopy?.({ index, name, sourceDirectory, outputDirectory })
      await copyBoundedFileExclusive(join(sourceDirectory, name), join(outputDirectory, name), {
        limit: RELEASE_ASSET_LIMITS.sidecarBytes,
        label: `raw sidecar '${name}'`,
      })
    }
    await assertExactBoundedFiles(
      outputDirectory,
      STANDALONE_SIDECAR_NAMES,
      'standalone sidecar staging',
    )
  } catch (error) {
    await rm(outputDirectory, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

function parseSidecarChecksums(contents) {
  const checksums = new Map()
  for (const [index, line] of contents.split(/\r?\n/).entries()) {
    if (line === '') continue
    const match = /^([0-9a-f]{64})  ([^/\\]+)$/.exec(line)
    if (!match) throw new Error(`invalid ${SIDECAR_CHECKSUMS_FILE} entry at line ${index + 1}`)
    const [, digest, name] = match
    if (checksums.has(name)) throw new Error(`duplicate sidecar checksum entry: ${name}`)
    checksums.set(name, digest)
  }
  return checksums
}

export async function writeSidecarChecksums({ directory, output }) {
  const expectedOutput = resolve(directory, SIDECAR_CHECKSUMS_FILE)
  if (resolve(output) !== expectedOutput)
    throw new Error(`${SIDECAR_CHECKSUMS_FILE} must be written inside the sidecar directory`)
  await assertExactFileNames(directory, RAW_SIDECAR_NAMES, 'raw sidecar')
  const lines = []
  for (const name of RAW_SIDECAR_NAMES) {
    const { sha256 } = await digestBoundedFile(join(directory, name), {
      limit: RELEASE_ASSET_LIMITS.sidecarBytes,
      label: `raw sidecar '${name}'`,
    })
    lines.push(`${sha256}  ${name}`)
  }
  const outputHandle = await open(output, 'wx', 0o644)
  try {
    await outputHandle.writeFile(`${lines.join('\n')}\n`)
    await outputHandle.sync()
  } finally {
    await outputHandle.close()
  }
  await verifySidecarChecksums(directory)
}

export async function verifySidecarChecksums(directory) {
  await assertExactFileNames(
    directory,
    [...RAW_SIDECAR_NAMES, SIDECAR_CHECKSUMS_FILE],
    'checksummed raw sidecar',
  )
  const checksums = parseSidecarChecksums(
    await readBoundedText(join(directory, SIDECAR_CHECKSUMS_FILE), {
      limit: RELEASE_ASSET_LIMITS.checksumBytes,
      label: SIDECAR_CHECKSUMS_FILE,
    }),
  )
  const declaredNames = [...checksums.keys()].toSorted(compareText)
  if (declaredNames.join('\0') !== RAW_SIDECAR_NAMES.join('\0'))
    throw new Error(`${SIDECAR_CHECKSUMS_FILE} must contain exactly 24 sidecar entries`)
  for (const name of RAW_SIDECAR_NAMES) {
    const { sha256 } = await digestBoundedFile(join(directory, name), {
      limit: RELEASE_ASSET_LIMITS.sidecarBytes,
      label: `raw sidecar '${name}'`,
    })
    if (checksums.get(name) !== sha256) throw new Error(`sidecar checksum mismatch: ${name}`)
  }
}

export async function verifyStandaloneCandidate({
  directory,
  version,
  tag,
  commit,
  bunVersion,
  generateManifestFn = generateReleaseManifest,
}) {
  const candidateNames = [
    ...STANDALONE_ARCHIVE_NAMES,
    STANDALONE_CHECKSUMS_FILE,
    RELEASE_MANIFEST_FILE,
  ]
  await assertExactFileNames(directory, candidateNames, 'standalone release candidate')
  const snapshotDirectory = await mkdtemp(join(tmpdir(), 'volund-release-candidate-'))
  try {
    for (const name of [...STANDALONE_ARCHIVE_NAMES, STANDALONE_CHECKSUMS_FILE]) {
      await copyBoundedFileExclusive(join(directory, name), join(snapshotDirectory, name), {
        limit: releaseAssetLimitForName(name),
        label: `standalone release candidate '${name}'`,
      })
    }
    const actualBytes = await readBoundedText(join(directory, RELEASE_MANIFEST_FILE), {
      limit: RELEASE_ASSET_LIMITS.manifestBytes,
      label: RELEASE_MANIFEST_FILE,
    })
    const expected = await generateManifestFn({
      archiveDirectory: snapshotDirectory,
      version,
      tag,
      commit,
      bunVersion,
      output: join(snapshotDirectory, RELEASE_MANIFEST_FILE),
    })
    if (actualBytes !== serializeReleaseManifest(expected))
      throw new Error('release-manifest.json does not match the checked-out release identity')
  } finally {
    await rm(snapshotDirectory, { recursive: true, force: true })
  }
}

export async function verifyLocalReleaseAssets({ sidecarDirectory, standaloneDirectory }) {
  await verifySidecarChecksums(sidecarDirectory)
  await assertExactBoundedFiles(
    standaloneDirectory,
    [...STANDALONE_ARCHIVE_NAMES, STANDALONE_CHECKSUMS_FILE, RELEASE_MANIFEST_FILE],
    'standalone release assets',
  )
}

export function verifyRemoteAssetNames(contents, { exact }) {
  let body = contents
  if (body.endsWith('\r\n')) body = body.slice(0, -2)
  else if (body.endsWith('\n')) body = body.slice(0, -1)
  const names = body === '' && contents === '' ? [] : body.split(/\r?\n/)
  if (names.some((name) => name === '')) throw new Error('remote asset list contains a blank name')
  const unique = new Set(names)
  if (unique.size !== names.length) throw new Error('remote asset list contains duplicate names')
  const unexpected = names
    .filter((name) => !EXPECTED_RELEASE_ASSET_NAMES.includes(name))
    .toSorted(compareText)
  const missing = exact ? EXPECTED_RELEASE_ASSET_NAMES.filter((name) => !unique.has(name)) : []
  if (missing.length > 0 || unexpected.length > 0)
    throw new Error(
      `remote release asset set mismatch; missing: ${formatNames(missing)}; unexpected: ${formatNames(unexpected)}`,
    )
}

export async function verifyRemoteAssetListFile(path, { exact }) {
  verifyRemoteAssetNames(
    await readBoundedText(path, {
      limit: RELEASE_ASSET_LIMITS.remoteListBytes,
      label: 'remote release asset list',
    }),
    { exact },
  )
}

export async function compareReleaseAssetFiles(left, right) {
  const leftName = basename(left)
  if (leftName !== basename(right))
    throw new Error('release asset comparison requires matching basenames')
  const limit = releaseAssetLimitForName(leftName)
  const leftInput = await openBoundedRegularFile(left, {
    limit,
    label: `local release asset '${leftName}'`,
  })
  let rightInput
  try {
    rightInput = await openBoundedRegularFile(right, {
      limit,
      label: `downloaded release asset '${leftName}'`,
    })
  } catch (error) {
    await leftInput.handle.close()
    throw error
  }
  const bufferSize = Math.min(
    IO_CHUNK_BYTES,
    Math.max(1, leftInput.metadata.size, rightInput.metadata.size),
  )
  const leftBuffer = Buffer.allocUnsafe(bufferSize)
  const rightBuffer = Buffer.allocUnsafe(bufferSize)
  try {
    if (leftInput.metadata.size !== rightInput.metadata.size)
      throw new Error(`immutable release asset differs from local bytes: ${leftName}`)
    let position = 0
    while (position < leftInput.metadata.size) {
      const length = Math.min(bufferSize, leftInput.metadata.size - position)
      const [leftRead, rightRead] = await Promise.all([
        leftInput.handle.read(leftBuffer, 0, length, position),
        rightInput.handle.read(rightBuffer, 0, length, position),
      ])
      if (
        leftRead.bytesRead !== length ||
        rightRead.bytesRead !== length ||
        !leftBuffer.subarray(0, length).equals(rightBuffer.subarray(0, length))
      )
        throw new Error(`immutable release asset differs from local bytes: ${leftName}`)
      position += length
    }
    await Promise.all([
      assertInputUnchanged(
        leftInput.handle,
        leftInput.metadata,
        `local release asset '${leftName}'`,
      ),
      assertInputUnchanged(
        rightInput.handle,
        rightInput.metadata,
        `downloaded release asset '${leftName}'`,
      ),
    ])
  } finally {
    await Promise.all([leftInput.handle.close(), rightInput.handle.close()])
  }
}

// ---- GitHub Release 策略门（immutable releases、tag rulesets、发布状态）----

export const REQUIRED_RULE_TYPES = Object.freeze(['creation', 'update', 'deletion'])

export const RELEASE_TAG_RULESET_CONTRACT = Object.freeze({
  target: 'tag',
  enforcement: 'active',
  requiredInclude: 'refs/tags/v*',
  requiredRules: REQUIRED_RULE_TYPES,
})

export const RULESET_BYPASS_TRUST_BOUNDARY =
  'Ruleset bypass-capable repository administrators are a trusted deployment boundary and may ' +
  'create, update, or delete refs/tags/v*; ' +
  'GitHub hides bypass_actors from metadata-read callers.'

export const GITHUB_RELEASE_POLICY_LIMITS = Object.freeze({
  jsonBytes: 1024 * 1024,
  rulesets: 100,
  releaseAssets: 100,
})

function assertObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} must be a JSON object`)
  return value
}

function assertStringArray(value, label) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string'))
    throw new Error(`${label} must be an array of strings`)
  return value
}

async function readBoundedJson(path, label) {
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const before = await handle.stat()
    if (!before.isFile()) throw new Error(`${label} must be a regular file`)
    if (before.size > GITHUB_RELEASE_POLICY_LIMITS.jsonBytes)
      throw new Error(`${label} exceeds the JSON byte limit`)
    const body = Buffer.alloc(before.size)
    let offset = 0
    while (offset < body.length) {
      const { bytesRead } = await handle.read(body, offset, body.length - offset, offset)
      if (bytesRead === 0) throw new Error(`${label} was truncated while being read`)
      offset += bytesRead
    }
    const extra = Buffer.alloc(1)
    if ((await handle.read(extra, 0, 1, before.size)).bytesRead !== 0)
      throw new Error(`${label} grew while being read`)
    const after = await handle.stat()
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error(`${label} changed while being read`)
    try {
      return JSON.parse(body.toString('utf8'))
    } catch (error) {
      throw new Error(`${label} is not valid JSON`, { cause: error })
    }
  } catch (error) {
    if (error?.code === 'ELOOP') throw new Error(`${label} must not be a symlink`, { cause: error })
    throw error
  } finally {
    await handle?.close().catch(() => {})
  }
}

export function verifyImmutableReleasePolicy(document) {
  const policy = assertObject(document, 'immutable release policy')
  if (policy.enabled !== true)
    throw new Error('repository immutable releases must be enabled before release mutation')
  return true
}

export function parseRulesetIndex(document) {
  if (!Array.isArray(document)) throw new Error('ruleset index must be a JSON array')
  const summaries = document.every(Array.isArray) ? document.flat() : document
  if (summaries.some(Array.isArray)) throw new Error('ruleset index has ambiguous pagination shape')
  if (summaries.length > GITHUB_RELEASE_POLICY_LIMITS.rulesets)
    throw new Error('ruleset index exceeds the supported ruleset count')
  const ids = []
  const seenIds = new Set()
  for (const [index, summary] of summaries.entries()) {
    const item = assertObject(summary, `ruleset index entry ${index}`)
    if (!Number.isSafeInteger(item.id) || item.id <= 0)
      throw new Error(`ruleset index entry ${index} has an invalid id`)
    if (seenIds.has(item.id)) throw new Error(`duplicate ruleset id ${item.id}`)
    seenIds.add(item.id)
    ids.push(item.id)
  }
  return ids.toSorted((left, right) => left - right)
}

function isReleaseTagContract(ruleset) {
  if (
    ruleset.target !== RELEASE_TAG_RULESET_CONTRACT.target ||
    ruleset.enforcement !== RELEASE_TAG_RULESET_CONTRACT.enforcement
  )
    return false
  const conditions = assertObject(ruleset.conditions, 'ruleset conditions')
  const refName = assertObject(conditions.ref_name, 'ruleset ref_name condition')
  const include = assertStringArray(refName.include, 'ruleset include patterns')
  const exclude = assertStringArray(refName.exclude, 'ruleset exclude patterns')
  if (!include.includes(RELEASE_TAG_RULESET_CONTRACT.requiredInclude) || exclude.length !== 0)
    return false
  if (!Array.isArray(ruleset.rules)) throw new Error('ruleset rules must be an array')
  const ruleTypes = new Set(
    ruleset.rules.map((rule, index) => {
      const item = assertObject(rule, `ruleset rule ${index}`)
      if (typeof item.type !== 'string') throw new Error(`ruleset rule ${index} has no type`)
      return item.type
    }),
  )
  return RELEASE_TAG_RULESET_CONTRACT.requiredRules.every((type) => ruleTypes.has(type))
}

export function verifyReleaseTagRulesets(rulesets) {
  if (!Array.isArray(rulesets)) throw new Error('ruleset details must be a JSON array')
  if (rulesets.length > GITHUB_RELEASE_POLICY_LIMITS.rulesets)
    throw new Error('ruleset details exceed the supported ruleset count')
  const matching = rulesets.filter((ruleset, index) =>
    isReleaseTagContract(assertObject(ruleset, `ruleset detail ${index}`)),
  )
  if (matching.length === 0)
    throw new Error(
      'no active tag ruleset exactly includes refs/tags/v* with no exclusions and ' +
        'creation/update/deletion rules; ' +
        RULESET_BYPASS_TRUST_BOUNDARY,
    )
  return true
}

function validateLocalAssets(localAssets) {
  if (!Array.isArray(localAssets)) throw new Error('local release asset metadata must be an array')
  const metadata = new Map()
  for (const [index, asset] of localAssets.entries()) {
    const item = assertObject(asset, `local release asset ${index}`)
    if (!EXPECTED_RELEASE_ASSET_NAMES.includes(item.name))
      throw new Error(`unexpected local release asset '${item.name}'`)
    if (metadata.has(item.name)) throw new Error(`duplicate local release asset '${item.name}'`)
    if (!Number.isSafeInteger(item.size) || item.size < 0)
      throw new Error(`local release asset '${item.name}' has an invalid size`)
    if (item.size > releaseAssetLimitForName(item.name))
      throw new Error(`local release asset '${item.name}' exceeds its type size limit`)
    if (!/^sha256:[0-9a-f]{64}$/.test(item.digest))
      throw new Error(`local release asset '${item.name}' has an invalid digest`)
    metadata.set(item.name, item)
  }
  const missing = EXPECTED_RELEASE_ASSET_NAMES.filter((name) => !metadata.has(name))
  if (missing.length > 0) throw new Error(`local release assets are missing: ${missing.join(', ')}`)
  return metadata
}

function releaseFromGraphql(document) {
  const root = assertObject(document, 'GraphQL response')
  if ('errors' in root) throw new Error('GraphQL release query returned errors')
  const data = assertObject(root.data, 'GraphQL response data')
  const repository = assertObject(data.repository, 'GraphQL repository')
  if (!Object.hasOwn(repository, 'release'))
    throw new Error('GraphQL repository response omitted release')
  return repository.release
}

export function verifyGithubReleaseState(document, { tag, commit, localAssets, expect = 'any' }) {
  if (!['any', 'absent', 'draft', 'published'].includes(expect))
    throw new Error(`invalid expected release state '${expect}'`)
  if (typeof tag !== 'string' || !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag))
    throw new Error('release tag must be a stable v<SemVer core> value')
  if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/.test(commit) || /^0{40}$/.test(commit))
    throw new Error('release commit must be a non-zero lowercase full SHA')

  const release = releaseFromGraphql(document)
  if (release === null) {
    if (expect !== 'any' && expect !== 'absent')
      throw new Error(`expected ${expect} release but release is absent`)
    return { state: 'absent', assets: [] }
  }

  const item = assertObject(release, 'GraphQL release')
  if (typeof item.id !== 'string' || item.id === '') throw new Error('release id is missing')
  if (item.tagName !== tag)
    throw new Error(`release tagName '${item.tagName}' does not match '${tag}'`)
  if (typeof item.isDraft !== 'boolean' || typeof item.immutable !== 'boolean')
    throw new Error('release draft/immutable state is malformed')
  const tagCommit = assertObject(item.tagCommit, 'release tagCommit')
  if (tagCommit.oid !== commit)
    throw new Error('release tagCommit does not match the release commit')

  const state = item.isDraft ? 'draft' : 'published'
  if (state === 'draft' && item.immutable)
    throw new Error('draft release must not report immutable=true')
  if (state === 'published' && !item.immutable)
    throw new Error(
      'published release is mutable; repository immutable releases configuration is incorrect',
    )
  if (expect !== 'any' && expect !== state)
    throw new Error(`expected ${expect} release but found ${state}`)

  const local = validateLocalAssets(localAssets)
  const assets = assertObject(item.assets, 'release assets')
  if (!Number.isSafeInteger(assets.totalCount) || assets.totalCount < 0)
    throw new Error('release asset totalCount is invalid')
  if (assets.totalCount > GITHUB_RELEASE_POLICY_LIMITS.releaseAssets)
    throw new Error('release asset totalCount exceeds the GraphQL first:100 contract')
  if (!Array.isArray(assets.nodes) || assets.nodes.length !== assets.totalCount)
    throw new Error('release asset nodes are incomplete for totalCount')
  if (assets.totalCount !== EXPECTED_RELEASE_ASSET_NAMES.length)
    throw new Error(`release must contain exactly ${EXPECTED_RELEASE_ASSET_NAMES.length} assets`)

  const remoteNames = new Set()
  for (const [index, asset] of assets.nodes.entries()) {
    const remote = assertObject(asset, `release asset ${index}`)
    if (!EXPECTED_RELEASE_ASSET_NAMES.includes(remote.name))
      throw new Error(`unexpected release asset '${remote.name}'`)
    if (remoteNames.has(remote.name)) throw new Error(`duplicate release asset '${remote.name}'`)
    remoteNames.add(remote.name)
    if (!Number.isSafeInteger(remote.size) || remote.size < 0)
      throw new Error(`release asset '${remote.name}' has an invalid size`)
    if (remote.size > releaseAssetLimitForName(remote.name))
      throw new Error(`release asset '${remote.name}' exceeds its type size limit`)
    if (!/^sha256:[0-9a-f]{64}$/.test(remote.digest))
      throw new Error(`release asset '${remote.name}' has an invalid digest`)
    const expected = local.get(remote.name)
    if (remote.size !== expected.size || remote.digest !== expected.digest)
      throw new Error(`release asset metadata differs from local candidate: ${remote.name}`)
  }
  return { state, assets: assets.nodes }
}

export async function collectLocalReleaseAssetMetadata({ sidecarDirectory, standaloneDirectory }) {
  const metadata = []
  for (const name of EXPECTED_RELEASE_ASSET_NAMES) {
    const directory =
      RAW_SIDECAR_NAMES.includes(name) || name === SIDECAR_CHECKSUMS_FILE
        ? sidecarDirectory
        : standaloneDirectory
    metadata.push(await describeReleaseAssetFile(join(directory, name)))
  }
  return metadata
}

async function readRulesetDetails(indexPath, detailsDirectory) {
  const ids = parseRulesetIndex(await readBoundedJson(indexPath, 'ruleset index'))
  const entries = (await readdir(detailsDirectory, { withFileTypes: true })).map(
    (entry) => entry.name,
  )
  const expectedNames = ids.map((id) => `${id}.json`)
  if (
    entries.length !== expectedNames.length ||
    entries.some((name) => !expectedNames.includes(name))
  )
    throw new Error('ruleset detail directory does not exactly match the ruleset index')
  const details = []
  for (const id of ids) {
    const detail = await readBoundedJson(join(detailsDirectory, `${id}.json`), `ruleset ${id}`)
    if (assertObject(detail, `ruleset ${id}`).id !== id)
      throw new Error(`ruleset detail id does not match ${id}`)
    details.push(detail)
  }
  return details
}

const COMMAND_FLAGS = Object.freeze({
  'stage-standalone': ['--source', '--output'],
  'write-sidecar-checksums': ['--directory', '--output'],
  'verify-sidecars': ['--directory'],
  'verify-standalone': ['--directory', '--version', '--tag', '--commit', '--bun-version'],
  'verify-local-release': ['--sidecars', '--standalone'],
  'verify-remote-assets': ['--input', '--mode'],
  'compare-files': ['--left', '--right'],
  'list-release-assets': [],
  'verify-immutable': ['--input'],
  'list-ruleset-ids': ['--input'],
  'verify-rulesets': ['--index', '--details'],
  'verify-release-state': [
    '--input',
    '--tag',
    '--commit',
    '--sidecars',
    '--standalone',
    '--expect',
  ],
})

export function parseCliRequest(command, argv) {
  const allowed = COMMAND_FLAGS[command]
  if (!allowed) throw new Error(`unknown command '${command}'`)
  const allowedSet = new Set(allowed)
  const values = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!allowedSet.has(flag)) throw new Error(`unknown argument '${flag}' for '${command}'`)
    if (values.has(flag)) throw new Error(`duplicate CLI argument '${flag}'`)
    if (value === undefined || value.startsWith('--'))
      throw new Error(`missing value for CLI argument '${flag}'`)
    values.set(flag, value)
  }
  const missing = allowed.filter((flag) => !values.has(flag))
  if (missing.length > 0) throw new Error(`missing required arguments: ${missing.join(', ')}`)
  return values
}

async function main() {
  const [command, ...argv] = process.argv.slice(2)
  const flags = parseCliRequest(command, argv)
  const value = (name) => flags.get(name)
  if (command === 'stage-standalone') {
    await stageStandaloneSidecars({
      sourceDirectory: resolve(value('--source')),
      outputDirectory: resolve(value('--output')),
    })
  } else if (command === 'write-sidecar-checksums') {
    await writeSidecarChecksums({
      directory: resolve(value('--directory')),
      output: resolve(value('--output')),
    })
  } else if (command === 'verify-sidecars') {
    await verifySidecarChecksums(resolve(value('--directory')))
  } else if (command === 'verify-standalone') {
    await verifyStandaloneCandidate({
      directory: resolve(value('--directory')),
      version: value('--version'),
      tag: value('--tag'),
      commit: value('--commit'),
      bunVersion: value('--bun-version'),
    })
  } else if (command === 'verify-local-release') {
    await verifyLocalReleaseAssets({
      sidecarDirectory: resolve(value('--sidecars')),
      standaloneDirectory: resolve(value('--standalone')),
    })
  } else if (command === 'verify-remote-assets') {
    const mode = value('--mode')
    if (mode !== 'subset' && mode !== 'exact')
      throw new Error("--mode must be either 'subset' or 'exact'")
    await verifyRemoteAssetListFile(resolve(value('--input')), { exact: mode === 'exact' })
  } else if (command === 'compare-files') {
    await compareReleaseAssetFiles(resolve(value('--left')), resolve(value('--right')))
  } else if (command === 'list-release-assets') {
    process.stdout.write(`${EXPECTED_RELEASE_ASSET_NAMES.join('\n')}\n`)
  } else if (command === 'verify-immutable') {
    verifyImmutableReleasePolicy(
      await readBoundedJson(resolve(value('--input')), 'immutable policy'),
    )
  } else if (command === 'list-ruleset-ids') {
    const ids = parseRulesetIndex(await readBoundedJson(resolve(value('--input')), 'ruleset index'))
    process.stdout.write(ids.length === 0 ? '' : `${ids.join('\n')}\n`)
  } else if (command === 'verify-rulesets') {
    verifyReleaseTagRulesets(
      await readRulesetDetails(resolve(value('--index')), resolve(value('--details'))),
    )
  } else if (command === 'verify-release-state') {
    const localAssets = await collectLocalReleaseAssetMetadata({
      sidecarDirectory: resolve(value('--sidecars')),
      standaloneDirectory: resolve(value('--standalone')),
    })
    const result = verifyGithubReleaseState(
      await readBoundedJson(resolve(value('--input')), 'GraphQL release state'),
      {
        tag: value('--tag'),
        commit: value('--commit'),
        localAssets,
        expect: value('--expect'),
      },
    )
    process.stdout.write(`${result.state}\n`)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) await main()
