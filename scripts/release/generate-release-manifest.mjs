// release 元数据工具：默认生成 release-manifest.json 并校验归档 digest；
// `normalize-sbom` 子命令把 syft 产出的 CycloneDX SBOM 归一化（去时间戳、绑定
// release version/commit 身份、语义集合排序），保证同一 tag 重复构建字节一致。
//
// 用法：
//   node scripts/release/generate-release-manifest.mjs --archives <dir> --version <v> --tag <v> --commit <sha> --bun-version <v> --output <file>
//   node scripts/release/generate-release-manifest.mjs normalize-sbom --input <raw.cdx.json> --output <sbom.cdx.json> --version <v> --commit <sha>
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  link,
  lstat,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
} from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

import { STANDALONE_TARGETS } from './build-all-standalone.mjs'
import {
  archiveNameForTarget,
  targetForArchiveName,
  validateStandaloneArchiveBuffer,
} from './standalone-archive.mjs'

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/
export const STANDALONE_CHECKSUMS_FILE = 'standalone-checksums.sha256'

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function formatList(values) {
  return values.length === 0 ? '(none)' : values.join(', ')
}

function executableNameFor(target) {
  return target.startsWith('win32-') ? 'volund.exe' : 'volund'
}

function isSemVer(value) {
  return typeof value === 'string' && SEMVER_PATTERN.test(value)
}

export function validateReleaseIdentity({ version, tag, commit, bunVersion }) {
  if (!isSemVer(version)) throw new Error(`invalid release version '${version}'`)
  const coreVersion = version.split(/[+-]/, 1)[0]
  if (coreVersion === '0.0.0') throw new Error('placeholder release version 0.0.0 is forbidden')
  if (tag !== `v${version}`)
    throw new Error(`release tag '${tag}' must equal version '${version}' with a leading v`)
  if (typeof commit !== 'string' || !/^[0-9a-fA-F]{40}$/.test(commit))
    throw new Error(`release commit '${commit}' must be a full 40-hex SHA`)
  if (/^0{40}$/.test(commit)) throw new Error('all-zero release commit SHA is forbidden')
  if (!isSemVer(bunVersion)) throw new Error(`invalid Bun version '${bunVersion}'`)

  return { version, tag, commit: commit.toLowerCase(), bunVersion }
}

export function parseStandaloneChecksums(contents) {
  const checksums = new Map()
  const lines = contents.split(/\r?\n/)
  for (const [index, line] of lines.entries()) {
    if (line === '') continue
    const match = /^([0-9a-f]{64})  ([^/\\]+)$/.exec(line)
    if (!match)
      throw new Error(
        `invalid ${STANDALONE_CHECKSUMS_FILE} entry at line ${index + 1}; ` +
          'expected "<lowercase-sha256>  <archive-name>"',
      )
    const [, digest, archiveName] = match
    if (checksums.has(archiveName))
      throw new Error(`duplicate checksum entry for archive '${archiveName}'`)
    checksums.set(archiveName, digest)
  }
  return checksums
}

function validateTargetSet(discoveredTargets, { allowPartialTargets }) {
  const targetSet = new Set(discoveredTargets)
  const unexpected = discoveredTargets.filter((target) => !STANDALONE_TARGETS.includes(target))
  const missing = STANDALONE_TARGETS.filter((target) => !targetSet.has(target))
  if (unexpected.length > 0 || (!allowPartialTargets && missing.length > 0))
    throw new Error(
      `standalone archive target set mismatch; missing: ${formatList(missing)}; ` +
        `unexpected: ${formatList(unexpected.toSorted(compareText))}; expected exactly: ${STANDALONE_TARGETS.join(', ')}`,
    )
  if (discoveredTargets.length === 0) throw new Error('no standalone archives found')
  return STANDALONE_TARGETS.filter((target) => targetSet.has(target))
}

async function canonicalPath(path) {
  try {
    return await realpath(path)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    return join(await realpath(dirname(path)), basename(path))
  }
}

export async function validateManifestOutputPath({ archiveDirectory, output }) {
  const resolvedArchiveDirectory = resolve(archiveDirectory)
  const resolvedOutput = resolve(output)
  if (resolvedOutput === resolvedArchiveDirectory)
    throw new Error('release manifest output must not be the archive directory')
  const outputIdentity = await canonicalPath(resolvedOutput)
  const inputNames = [STANDALONE_CHECKSUMS_FILE, ...STANDALONE_TARGETS.map(archiveNameForTarget)]
  for (const inputName of inputNames) {
    const inputPath = join(resolvedArchiveDirectory, inputName)
    if (resolvedOutput === inputPath)
      throw new Error(`release manifest output collides with input '${inputName}'`)
    let inputIdentity
    try {
      inputIdentity = await realpath(inputPath)
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }
    if (outputIdentity === inputIdentity)
      throw new Error(`release manifest output collides with input '${inputName}'`)
  }
}

export async function generateReleaseManifest({
  archiveDirectory,
  version,
  tag,
  commit,
  bunVersion,
  allowPartialTargets = false,
  output,
}) {
  const identity = validateReleaseIdentity({ version, tag, commit, bunVersion })
  if (output) await validateManifestOutputPath({ archiveDirectory, output })
  const entries = await readdir(archiveDirectory, { withFileTypes: true })
  const discoveredTargets = []
  const allowedOutputName =
    output && dirname(resolve(output)) === resolve(archiveDirectory) ? basename(output) : null
  for (const entry of entries) {
    if (entry.name === allowedOutputName) {
      if (!entry.isFile())
        throw new Error(`existing release manifest output must be a regular file`)
      continue
    }
    if (entry.name === STANDALONE_CHECKSUMS_FILE) {
      if (!entry.isFile()) throw new Error(`${STANDALONE_CHECKSUMS_FILE} must be a regular file`)
      continue
    }
    const target = targetForArchiveName(entry.name)
    if (!target) {
      if (entry.name.startsWith('volund-standalone-'))
        throw new Error(`invalid standalone archive filename '${entry.name}'`)
      throw new Error(`foreign file in standalone archive directory: '${entry.name}'`)
    }
    if (!entry.isFile()) throw new Error(`invalid standalone archive filename '${entry.name}'`)
    discoveredTargets.push(target)
  }
  const targets = validateTargetSet(discoveredTargets, { allowPartialTargets })

  let checksumContents
  try {
    checksumContents = await readFile(join(archiveDirectory, STANDALONE_CHECKSUMS_FILE), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT')
      throw new Error(`${STANDALONE_CHECKSUMS_FILE} is missing from ${archiveDirectory}`, {
        cause: error,
      })
    throw error
  }
  const declaredChecksums = parseStandaloneChecksums(checksumContents)
  const expectedArchiveNames = targets.map(archiveNameForTarget)
  const missingChecksumEntries = expectedArchiveNames.filter((name) => !declaredChecksums.has(name))
  const extraChecksumEntries = [...declaredChecksums.keys()].filter(
    (name) => !expectedArchiveNames.includes(name),
  )
  if (missingChecksumEntries.length > 0 || extraChecksumEntries.length > 0)
    throw new Error(
      `${STANDALONE_CHECKSUMS_FILE} archive set mismatch; missing: ` +
        `${formatList(missingChecksumEntries)}; unexpected: ${formatList(extraChecksumEntries.toSorted(compareText))}`,
    )

  const artifacts = []
  for (const target of targets) {
    const archiveName = archiveNameForTarget(target)
    const archivePath = join(archiveDirectory, archiveName)
    const body = await readFile(archivePath)
    const sha256 = createHash('sha256').update(body).digest('hex')
    if (declaredChecksums.get(archiveName) !== sha256)
      throw new Error(
        `checksum mismatch for ${archiveName}: declared ${declaredChecksums.get(archiveName)}, ` +
          `computed ${sha256}`,
      )
    validateStandaloneArchiveBuffer(body, { target })
    artifacts.push({
      target,
      archiveName,
      sha256,
      size: body.byteLength,
      executableName: executableNameFor(target),
    })
  }

  return { schemaVersion: 1, ...identity, artifacts }
}

export function serializeReleaseManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`
}

export async function writeReleaseManifestAtomically({ output, manifest, renameFn = rename }) {
  const outputDirectory = dirname(output)
  const temporaryPath = join(
    outputDirectory,
    `.${basename(output)}.tmp-${process.pid}-${randomUUID()}`,
  )
  let handle
  try {
    handle = await open(temporaryPath, 'wx', 0o600)
    await handle.writeFile(serializeReleaseManifest(manifest))
    await handle.sync()
    await handle.close()
    handle = undefined
    await renameFn(temporaryPath, output)
  } catch (error) {
    await handle?.close().catch(() => {})
    await rm(temporaryPath, { force: true }).catch(() => {})
    throw error
  }
}

// ---- CycloneDX SBOM 归一化（normalize-sbom 子命令）----

export const RELEASE_SBOM_COMPONENT_NAME = 'volund-cli'
export const RELEASE_SBOM_LIMITS = Object.freeze({
  inputBytes: 16 * 1024 * 1024,
  jsonDepth: 128,
  jsonNodes: 250_000,
  components: 50_000,
})
export const SUPPORTED_CYCLONEDX_SPEC_VERSIONS = Object.freeze(['1.4', '1.5', '1.6'])
export const RELEASE_SBOM_IDENTITY_PROPERTIES = Object.freeze({
  commit: 'volund.release.commit',
  version: 'volund.release.version',
})

const SEMANTIC_SET_ARRAY_KEYS = new Set([
  'authors',
  'annotations',
  'ancestors',
  'components',
  'compositions',
  'descendants',
  'dependencies',
  'dependsOn',
  'externalReferences',
  'formulation',
  'hashes',
  'licenses',
  'properties',
  'provides',
  'services',
  'tags',
  'tools',
  'variants',
  'vulnerabilities',
])

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function setOwn(record, key, value) {
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  })
}

function copyRecord(record) {
  const copy = Object.create(null)
  for (const key of Object.keys(record)) setOwn(copy, key, record[key])
  return copy
}

export function validateReleaseSbomIdentity({ version, commit }) {
  if (typeof version !== 'string' || !SEMVER_PATTERN.test(version))
    throw new Error(`invalid release version '${version}'`)
  if (version.split(/[+-]/, 1)[0] === '0.0.0')
    throw new Error('placeholder release version 0.0.0 is forbidden')
  if (typeof commit !== 'string' || !/^[0-9a-fA-F]{40}$/.test(commit))
    throw new Error(`release commit '${commit}' must be a full 40-hex SHA`)
  if (/^0{40}$/.test(commit)) throw new Error('all-zero release commit SHA is forbidden')
  return { version, commit: commit.toLowerCase() }
}

function canonicalize(value, parentKey = '') {
  if (Array.isArray(value)) {
    const normalized = value.map((entry) => canonicalize(entry))
    if (SEMANTIC_SET_ARRAY_KEYS.has(parentKey)) {
      const keyed = normalized.map((entry) => ({ entry, key: JSON.stringify(entry) }))
      return keyed
        .toSorted((left, right) => compareText(left.key, right.key))
        .map(({ entry }) => entry)
    }
    return normalized
  }
  if (!isRecord(value)) return value

  const normalized = {}
  Object.setPrototypeOf(normalized, null)
  for (const key of Object.keys(value).toSorted(compareText))
    setOwn(normalized, key, canonicalize(value[key], key))
  return normalized
}

function bindReleaseIdentity(sbom, identity) {
  const metadata = isRecord(sbom.metadata) ? copyRecord(sbom.metadata) : Object.create(null)
  delete metadata.timestamp
  const existingComponent = isRecord(metadata.component)
    ? copyRecord(metadata.component)
    : Object.create(null)
  const existingProperties = Array.isArray(existingComponent.properties)
    ? existingComponent.properties.filter(
        (property) =>
          !isRecord(property) ||
          !Object.values(RELEASE_SBOM_IDENTITY_PROPERTIES).includes(property.name),
      )
    : []
  setOwn(existingComponent, 'type', 'application')
  setOwn(existingComponent, 'name', RELEASE_SBOM_COMPONENT_NAME)
  setOwn(existingComponent, 'version', identity.version)
  setOwn(existingComponent, 'properties', [
    ...existingProperties,
    { name: RELEASE_SBOM_IDENTITY_PROPERTIES.commit, value: identity.commit },
    { name: RELEASE_SBOM_IDENTITY_PROPERTIES.version, value: identity.version },
  ])
  setOwn(metadata, 'component', existingComponent)
  setOwn(sbom, 'metadata', metadata)
}

function validateJsonTree(value, limits) {
  let nodes = 0
  const stack = [{ value, depth: 0 }]
  while (stack.length > 0) {
    const current = stack.pop()
    nodes += 1
    if (nodes > limits.jsonNodes)
      throw new Error(`CycloneDX SBOM exceeds JSON node limit ${limits.jsonNodes}`)
    if (current.depth > limits.jsonDepth)
      throw new Error(`CycloneDX SBOM exceeds JSON depth limit ${limits.jsonDepth}`)
    if (Array.isArray(current.value)) {
      for (const child of current.value) stack.push({ value: child, depth: current.depth + 1 })
      continue
    }
    if (isRecord(current.value)) {
      for (const key of Object.keys(current.value))
        stack.push({ value: current.value[key], depth: current.depth + 1 })
      continue
    }
    if (
      current.value !== null &&
      typeof current.value !== 'string' &&
      typeof current.value !== 'boolean' &&
      !(typeof current.value === 'number' && Number.isFinite(current.value))
    )
      throw new Error('CycloneDX SBOM contains a non-JSON value')
  }
}

export function normalizeReleaseSbom(input, { version, commit }, limits = RELEASE_SBOM_LIMITS) {
  const identity = validateReleaseSbomIdentity({ version, commit })
  if (!isRecord(input)) throw new Error('CycloneDX SBOM must be a JSON object')
  validateJsonTree(input, limits)
  if (input.bomFormat !== 'CycloneDX')
    throw new Error("CycloneDX SBOM must declare bomFormat 'CycloneDX'")
  if (!SUPPORTED_CYCLONEDX_SPEC_VERSIONS.includes(input.specVersion))
    throw new Error(
      `unsupported CycloneDX specVersion '${input.specVersion}'; expected one of ${SUPPORTED_CYCLONEDX_SPEC_VERSIONS.join(', ')}`,
    )
  if (!Number.isInteger(input.version) || input.version < 1)
    throw new Error('CycloneDX SBOM must declare a positive integer version')
  if (!Array.isArray(input.components) || input.components.length === 0)
    throw new Error('CycloneDX SBOM must contain at least one component')
  if (input.components.length > limits.components)
    throw new Error(`CycloneDX SBOM exceeds component limit ${limits.components}`)
  if (input.components.some((component) => !isRecord(component)))
    throw new Error('CycloneDX SBOM components must be JSON objects')

  const normalized = copyRecord(input)
  delete normalized.serialNumber
  bindReleaseIdentity(normalized, identity)
  return canonicalize(normalized)
}

export function serializeReleaseSbom(sbom) {
  return `${JSON.stringify(sbom, null, 2)}\n`
}

export async function validateReleaseSbomPaths({ input, output }) {
  const inputPath = resolve(input)
  const outputPath = resolve(output)
  if (inputPath === outputPath) throw new Error('SBOM input and output paths must be different')
  const inputMetadata = await lstat(inputPath)
  if (inputMetadata.isSymbolicLink() || !inputMetadata.isFile())
    throw new Error('SBOM input must be a non-symlink regular file')
  let outputMetadata
  try {
    outputMetadata = await lstat(outputPath)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  if (outputMetadata) throw new Error('SBOM output must not already exist')
  const [inputIdentity, outputIdentity] = await Promise.all([
    realpath(inputPath),
    canonicalPath(outputPath),
  ])
  if (inputIdentity === outputIdentity)
    throw new Error('SBOM input and output paths must not alias the same file')
}

export async function writeReleaseSbomAtomically({ output, sbom, linkFn = link }) {
  const outputPath = resolve(output)
  const temporaryPath = join(
    dirname(outputPath),
    `.${basename(outputPath)}.tmp-${process.pid}-${randomUUID()}`,
  )
  let handle
  try {
    handle = await open(temporaryPath, 'wx', 0o600)
    await handle.writeFile(serializeReleaseSbom(sbom))
    await handle.sync()
    await handle.close()
    handle = undefined
    await linkFn(temporaryPath, outputPath)
    await unlink(temporaryPath)
  } catch (error) {
    await handle?.close().catch(() => {})
    await unlink(temporaryPath).catch((cleanupError) => {
      if (cleanupError?.code !== 'ENOENT') throw cleanupError
    })
    throw error
  }
}

export async function readReleaseSbomInput(input, limits = RELEASE_SBOM_LIMITS) {
  const inputPath = resolve(input)
  const before = await lstat(inputPath)
  if (before.isSymbolicLink() || !before.isFile())
    throw new Error('SBOM input must be a non-symlink regular file')
  if (before.size > limits.inputBytes)
    throw new Error(`CycloneDX SBOM input exceeds byte limit ${limits.inputBytes}`)

  const handle = await open(inputPath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const after = await handle.stat()
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino)
      throw new Error('SBOM input changed during validation')
    if (after.size > limits.inputBytes)
      throw new Error(`CycloneDX SBOM input exceeds byte limit ${limits.inputBytes}`)
    const contents = Buffer.allocUnsafe(limits.inputBytes + 1)
    let bytesRead = 0
    while (bytesRead < contents.byteLength) {
      const result = await handle.read(contents, bytesRead, contents.byteLength - bytesRead, null)
      if (result.bytesRead === 0) break
      bytesRead += result.bytesRead
    }
    if (bytesRead > limits.inputBytes)
      throw new Error(`CycloneDX SBOM input exceeds byte limit ${limits.inputBytes}`)
    const finalMetadata = await handle.stat()
    if (
      finalMetadata.size !== after.size ||
      finalMetadata.mtimeMs !== after.mtimeMs ||
      finalMetadata.ctimeMs !== after.ctimeMs
    )
      throw new Error('SBOM input changed while being read')
    return contents.subarray(0, bytesRead).toString('utf8')
  } finally {
    await handle.close()
  }
}

export async function normalizeReleaseSbomFile({
  input,
  output,
  version,
  commit,
  limits = RELEASE_SBOM_LIMITS,
}) {
  await validateReleaseSbomPaths({ input, output })
  let parsed
  try {
    parsed = JSON.parse(await readReleaseSbomInput(input, limits))
  } catch (error) {
    throw new Error(`failed to parse CycloneDX SBOM input '${input}'`, { cause: error })
  }
  const sbom = normalizeReleaseSbom(parsed, { version, commit }, limits)
  await writeReleaseSbomAtomically({ output, sbom })
  return sbom
}

export function parseSbomCliArguments(argv) {
  const supported = new Set(['--input', '--output', '--version', '--commit'])
  const values = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!supported.has(flag)) throw new Error(`unknown argument '${flag}'`)
    if (values.has(flag)) throw new Error(`duplicate argument '${flag}'`)
    if (value === undefined || value.startsWith('--'))
      throw new Error(`missing value for '${flag}'`)
    values.set(flag, value)
  }
  const missing = [...supported].filter((flag) => !values.has(flag))
  if (missing.length > 0) throw new Error(`missing required arguments: ${missing.join(', ')}`)
  return {
    input: resolve(values.get('--input')),
    output: resolve(values.get('--output')),
    version: values.get('--version'),
    commit: values.get('--commit'),
  }
}

export function parseCliArguments(argv) {
  const supported = new Set([
    '--archives',
    '--version',
    '--tag',
    '--commit',
    '--bun-version',
    '--output',
  ])
  const values = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!supported.has(flag)) throw new Error(`unknown argument '${flag}'`)
    if (values.has(flag)) throw new Error(`duplicate argument '${flag}'`)
    if (value === undefined || value.startsWith('--'))
      throw new Error(`missing value for '${flag}'`)
    values.set(flag, value)
  }
  const missing = [...supported].filter((flag) => !values.has(flag))
  if (missing.length > 0) throw new Error(`missing required arguments: ${missing.join(', ')}`)
  return {
    archiveDirectory: resolve(values.get('--archives')),
    version: values.get('--version'),
    tag: values.get('--tag'),
    commit: values.get('--commit'),
    bunVersion: values.get('--bun-version'),
    output: resolve(values.get('--output')),
  }
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv[0] === 'normalize-sbom') {
    const options = parseSbomCliArguments(argv.slice(1))
    await normalizeReleaseSbomFile(options)
    console.log(`normalized CycloneDX SBOM: ${options.output}`)
    return
  }
  const { output, ...options } = parseCliArguments(argv)
  const manifest = await generateReleaseManifest({ ...options, output })
  await writeReleaseManifestAtomically({ output, manifest })
  console.log(`release manifest: ${manifest.artifacts.length} targets -> ${output}`)
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) await main()
