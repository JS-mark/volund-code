import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'

import { STANDALONE_TARGETS } from './build-all-standalone.mjs'
import {
  parseStandaloneChecksums,
  STANDALONE_CHECKSUMS_FILE,
  validateReleaseIdentity,
} from './generate-release-manifest.mjs'
import { archiveNameForTarget, validateStandaloneArchiveBuffer } from './standalone-archive.mjs'
import {
  inspectNpmTarballBuffer,
  NPM_OUTPUT_MARKER,
  NPM_PACK_TOOL,
  NPM_PACKAGING_ARCHIVE_LIMITS,
  NPM_PUBLISH_LIMITS,
  NPM_PUBLISH_ORDER,
  NPM_PUBLISH_PLAN_FILE,
  readBoundedRegularFile,
  verifyNpmPublishPlan,
} from './verify-npm-publish-plan.mjs'

const REPOSITORY_URL = 'git+https://github.com/JS-mark/volund-code.git'
const HOMEPAGE = 'https://github.com/JS-mark/volund-code#readme'
const BUGS_URL = 'https://github.com/JS-mark/volund-code/issues'
const PACKAGE_SCOPE = '@volund'
const CANDIDATE_FILES = Object.freeze([
  ...STANDALONE_TARGETS.map(archiveNameForTarget),
  STANDALONE_CHECKSUMS_FILE,
  'release-manifest.json',
])
const PLATFORM_FIELDS = Object.freeze({
  'darwin-arm64': { os: ['darwin'], cpu: ['arm64'] },
  'darwin-x64': { os: ['darwin'], cpu: ['x64'] },
  'linux-x64-gnu': { os: ['linux'], cpu: ['x64'], libc: ['glibc'] },
  'linux-arm64-gnu': { os: ['linux'], cpu: ['arm64'], libc: ['glibc'] },
  'linux-x64-musl': { os: ['linux'], cpu: ['x64'], libc: ['musl'] },
  'linux-arm64-musl': { os: ['linux'], cpu: ['arm64'], libc: ['musl'] },
  'win32-x64-msvc': { os: ['win32'], cpu: ['x64', 'arm64'] },
})

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function digest(body, algorithm, encoding = 'hex') {
  return createHash(algorithm).update(body).digest(encoding)
}

function packageDirectoryName(name) {
  return name.startsWith(`${PACKAGE_SCOPE}/`)
    ? `volund-${name.slice(PACKAGE_SCOPE.length + 1)}`
    : name
}

function tarballName(name, version) {
  return `${packageDirectoryName(name)}-${version}.tgz`
}

function packageMetadata() {
  return {
    license: 'Apache-2.0',
    repository: { type: 'git', url: REPOSITORY_URL },
    bugs: { url: BUGS_URL },
    homepage: HOMEPAGE,
    publishConfig: { access: 'public', provenance: true },
  }
}

function parseJson(body, label) {
  try {
    return JSON.parse(body.toString('utf8'))
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error })
  }
}

async function exactDirectoryNames(directory, expected, label) {
  const entries = await readdir(directory, { withFileTypes: true })
  const actual = entries.map((entry) => entry.name).toSorted(compareText)
  const wanted = [...expected].toSorted(compareText)
  if (actual.join('\0') !== wanted.join('\0'))
    throw new Error(`${label} contents mismatch; expected exactly ${wanted.join(', ')}`)
  return entries
}

function validateStableReleaseIdentity(manifest) {
  const identity = validateReleaseIdentity(manifest)
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(identity.version))
    throw new Error('npm package version must be stable SemVer core')
  if (identity.bunVersion.split(/[+-]/, 1)[0] === '0.0.0')
    throw new Error('Bun version must not be a placeholder')
  return identity
}

function validateArchiveForPackaging(body, target, totals, limits = NPM_PACKAGING_ARCHIVE_LIMITS) {
  const validated = validateStandaloneArchiveBuffer(body, {
    target,
    limits: {
      compressedBytes: limits.compressedBytes,
      uncompressedBytes: limits.uncompressedBytes,
      entryBytes: limits.entryBytes,
      entryCount: limits.entryCount,
    },
  })
  const uncompressedBytes = [...validated.entries.values()].reduce(
    (sum, entry) => sum + entry.body.byteLength,
    0,
  )
  totals.uncompressedBytes += uncompressedBytes
  totals.entryCount += validated.entries.size
  if (totals.uncompressedBytes > limits.aggregateUncompressedBytes)
    throw new Error('standalone candidate aggregate uncompressed size exceeds packaging limit')
  if (totals.entryCount > limits.aggregateEntryCount)
    throw new Error('standalone candidate aggregate entry count exceeds packaging limit')
  return validated
}

export async function validateStandaloneNpmCandidate(
  archiveDirectory,
  { limits: limitOverrides = {} } = {},
) {
  const limits = { ...NPM_PACKAGING_ARCHIVE_LIMITS, ...limitOverrides }
  const archives = resolve(archiveDirectory)
  const entries = await exactDirectoryNames(archives, CANDIDATE_FILES, 'standalone npm candidate')
  if (entries.some((entry) => !entry.isFile()))
    throw new Error('standalone npm candidate inputs must be regular files')
  const manifestBody = await readBoundedRegularFile(
    join(archives, 'release-manifest.json'),
    NPM_PUBLISH_LIMITS.releaseManifestBytes,
    'release-manifest.json',
  )
  const manifest = parseJson(manifestBody, 'release-manifest.json')
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.artifacts))
    throw new Error('release-manifest.json has an invalid schema')
  const identity = validateStableReleaseIdentity(manifest)
  if (manifest.artifacts.length !== STANDALONE_TARGETS.length)
    throw new Error('release-manifest.json must contain exactly seven artifacts')
  const artifactTargets = manifest.artifacts.map((artifact) => artifact?.target)
  if (artifactTargets.join('\0') !== STANDALONE_TARGETS.join('\0'))
    throw new Error('release-manifest.json artifacts must use the frozen seven-target order')
  if (new Set(artifactTargets).size !== artifactTargets.length)
    throw new Error('release-manifest.json contains duplicate artifact targets')

  const checksumBody = await readBoundedRegularFile(
    join(archives, STANDALONE_CHECKSUMS_FILE),
    NPM_PUBLISH_LIMITS.standaloneChecksumsBytes,
    STANDALONE_CHECKSUMS_FILE,
  )
  const checksums = parseStandaloneChecksums(checksumBody.toString('utf8'))
  if (checksums.size !== STANDALONE_TARGETS.length)
    throw new Error(`${STANDALONE_CHECKSUMS_FILE} must contain exactly seven entries`)

  const canonicalChecksumLines = []
  const totals = { uncompressedBytes: 0, entryCount: 0 }
  const aggregateCompressedBytes = manifest.artifacts.reduce(
    (sum, artifact) => sum + (Number.isSafeInteger(artifact?.size) ? artifact.size : 0),
    0,
  )
  if (aggregateCompressedBytes > limits.aggregateCompressedBytes)
    throw new Error('standalone candidate aggregate compressed size exceeds packaging limit')
  for (const [index, target] of STANDALONE_TARGETS.entries()) {
    const artifact = manifest.artifacts[index]
    const archiveName = archiveNameForTarget(target)
    const executableName = target.startsWith('win32-') ? 'volund.exe' : 'volund'
    if (
      artifact.archiveName !== archiveName ||
      artifact.executableName !== executableName ||
      !/^[0-9a-f]{64}$/.test(artifact.sha256) ||
      !Number.isSafeInteger(artifact.size) ||
      artifact.size <= 0
    )
      throw new Error(`release-manifest.json has an invalid artifact for '${target}'`)
    const body = await readBoundedRegularFile(
      join(archives, archiveName),
      limits.compressedBytes,
      `standalone archive '${archiveName}'`,
    )
    const sha256 = digest(body, 'sha256')
    if (body.byteLength !== artifact.size || sha256 !== artifact.sha256)
      throw new Error(`standalone archive bytes do not match manifest for '${target}'`)
    if (checksums.get(archiveName) !== sha256)
      throw new Error(`standalone archive checksum mismatch for '${target}'`)
    validateArchiveForPackaging(body, target, totals, limits)
    canonicalChecksumLines.push(`${sha256}  ${archiveName}`)
  }
  if (checksumBody.toString('utf8') !== `${canonicalChecksumLines.join('\n')}\n`)
    throw new Error(`${STANDALONE_CHECKSUMS_FILE} is not in canonical target order`)
  return {
    identity,
    manifest,
    artifacts: manifest.artifacts.map((artifact) => ({ ...artifact })),
    source: {
      releaseManifest: {
        name: 'release-manifest.json',
        sha256: digest(manifestBody, 'sha256'),
        size: manifestBody.byteLength,
      },
      standaloneChecksums: {
        name: STANDALONE_CHECKSUMS_FILE,
        sha256: digest(checksumBody, 'sha256'),
        size: checksumBody.byteLength,
      },
      archives: manifest.artifacts.map(({ target, archiveName, sha256, size }) => ({
        target,
        archiveName,
        sha256,
        size,
      })),
    },
  }
}

async function writeExclusive(path, body, mode = 0o644) {
  const handle = await open(path, 'wx', mode)
  try {
    await handle.writeFile(body)
    await handle.chmod(mode)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function extractValidatedEntries(entries, packageDirectory) {
  await mkdir(packageDirectory)
  for (const entry of entries.values()) {
    const destination = join(packageDirectory, entry.path)
    if (entry.type === 'directory') {
      await mkdir(destination, { mode: 0o755 })
      await chmod(destination, 0o755)
      continue
    }
    await writeExclusive(destination, entry.body, entry.mode === 0o755 ? 0o755 : 0o644)
  }
}

async function buildPlatformPackage(packagesDirectory, artifact, version, entries) {
  const name = `${PACKAGE_SCOPE}/${artifact.target}`
  const directoryName = packageDirectoryName(name)
  const packageDirectory = join(packagesDirectory, directoryName)
  await extractValidatedEntries(entries, packageDirectory)
  const executableName = artifact.target.startsWith('win32-') ? 'volund.exe' : 'volund'
  const manifest = {
    name,
    version,
    description: `Volund CLI standalone runtime (${artifact.target})`,
    ...packageMetadata(),
    files: [
      executableName,
      'native',
      'plugins',
      'checksums.sha256',
      'LICENSE',
      'NOTICE',
      'sbom.cdx.json',
    ],
    ...PLATFORM_FIELDS[artifact.target],
  }
  await writeExclusive(
    join(packageDirectory, 'package.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  )
  return { name, directoryName, packageDirectory }
}

async function buildMetaPackage({
  packagesDirectory,
  name,
  version,
  optionalDependencies,
  wrapper,
  readme,
  license,
}) {
  const directoryName = packageDirectoryName(name)
  const packageDirectory = join(packagesDirectory, directoryName)
  await mkdir(join(packageDirectory, 'bin'), { recursive: true, mode: 0o755 })
  await writeExclusive(join(packageDirectory, 'bin/volund.cjs'), wrapper, 0o755)
  await writeExclusive(join(packageDirectory, 'README.md'), readme)
  await writeExclusive(join(packageDirectory, 'LICENSE'), license)
  const manifest = {
    name,
    version,
    description:
      name === '@volund/cli'
        ? 'Open, model-agnostic AI coding CLI'
        : 'Compatibility package for @volund/cli; migrate installs to @volund/cli',
    ...packageMetadata(),
    bin: { volund: 'bin/volund.cjs' },
    files: ['bin'],
    engines: { node: '>=20.19.0' },
    optionalDependencies,
  }
  await writeExclusive(
    join(packageDirectory, 'package.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  )
  return { name, directoryName, packageDirectory }
}

function parsePackJson(stdout, packageName) {
  let result
  try {
    result = JSON.parse(stdout)
  } catch (error) {
    throw new Error(`npm pack returned invalid JSON for '${packageName}'`, { cause: error })
  }
  if (!Array.isArray(result) || result.length !== 1 || !result[0])
    throw new Error(`npm pack must return exactly one result for '${packageName}'`)
  return result[0]
}

async function runNpmPack({
  packageInfo,
  tarballsDirectory,
  version,
  npmCli,
  packEnvironment,
  spawn = spawnSync,
}) {
  const result = spawn(
    process.execPath,
    [npmCli, 'pack', '.', '--json', '--ignore-scripts', '--pack-destination', tarballsDirectory],
    {
      cwd: packageInfo.packageDirectory,
      encoding: 'utf8',
      shell: false,
      env: packEnvironment,
    },
  )
  if (result.error)
    throw new Error(`failed to run npm pack for '${packageInfo.name}'`, { cause: result.error })
  if (result.status !== 0)
    throw new Error(`npm pack failed for '${packageInfo.name}': ${result.stderr || result.stdout}`)
  const packed = parsePackJson(result.stdout, packageInfo.name)
  const expectedFilename = tarballName(packageInfo.name, version)
  if (
    packed.name !== packageInfo.name ||
    packed.version !== version ||
    packed.filename !== expectedFilename ||
    !Array.isArray(packed.files)
  )
    throw new Error(`npm pack identity mismatch for '${packageInfo.name}'`)
  const tarball = await readBoundedRegularFile(
    join(tarballsDirectory, expectedFilename),
    NPM_PUBLISH_LIMITS.tarballBytes,
    `npm tarball '${packageInfo.name}'`,
  )
  const tarEntries = inspectNpmTarballBuffer(tarball)
  const tarFiles = [...tarEntries.values()]
    .filter((entry) => entry.type === 'file')
    .map((entry) => entry.path.slice('package/'.length))
    .toSorted(compareText)
  const reportedFiles = packed.files.map((file) => file.path).toSorted(compareText)
  if (tarFiles.join('\0') !== reportedFiles.join('\0'))
    throw new Error(`npm pack file report mismatch for '${packageInfo.name}'`)
  return {
    name: packageInfo.name,
    version,
    directory: `packages/${packageInfo.directoryName}`,
    tarball: `tarballs/${expectedFilename}`,
    sha256: digest(tarball, 'sha256'),
    integrity: `sha512-${digest(tarball, 'sha512', 'base64')}`,
    size: tarball.byteLength,
  }
}

export function validatePackToolVersions({ nodeVersion, npmVersion }) {
  const normalizedNodeVersion = nodeVersion.startsWith('v') ? nodeVersion.slice(1) : nodeVersion
  if (
    normalizedNodeVersion !== NPM_PACK_TOOL.nodeVersion ||
    npmVersion.trim() !== NPM_PACK_TOOL.npmVersion
  )
    throw new Error(
      `npm candidate packing requires Node ${NPM_PACK_TOOL.nodeVersion} and npm ${NPM_PACK_TOOL.npmVersion}; ` +
        `found Node ${normalizedNodeVersion} and npm ${npmVersion.trim()}`,
    )
  return { ...NPM_PACK_TOOL }
}

async function resolveAndValidatePackTool() {
  const npmCli = await realpath(
    resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
  )
  await readBoundedRegularFile(npmCli, 4 * 1024 * 1024, 'pinned npm CLI')
  const result = spawnSync(process.execPath, [npmCli, '--version'], {
    encoding: 'utf8',
    shell: false,
    env: { PATH: dirname(process.execPath), LANG: 'C', LC_ALL: 'C' },
  })
  if (result.error || result.status !== 0)
    throw new Error('failed to verify the pinned npm pack tool', { cause: result.error })
  const packTool = validatePackToolVersions({
    nodeVersion: process.version,
    npmVersion: result.stdout,
  })
  return { npmCli, packTool }
}

async function createIsolatedPackEnvironment(stagingRoot) {
  const environmentRoot = join(stagingRoot, '.npm-environment')
  const home = join(environmentRoot, 'home')
  const cache = join(environmentRoot, 'cache')
  const userconfig = join(environmentRoot, 'user.npmrc')
  const globalconfig = join(environmentRoot, 'global.npmrc')
  await mkdir(home, { recursive: true })
  await mkdir(cache)
  await writeExclusive(userconfig, '')
  await writeExclusive(globalconfig, '')
  return {
    HOME: home,
    USERPROFILE: home,
    PATH: dirname(process.execPath),
    LANG: 'C',
    LC_ALL: 'C',
    npm_config_cache: cache,
    npm_config_userconfig: userconfig,
    npm_config_globalconfig: globalconfig,
    npm_config_ignore_scripts: 'true',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
    npm_config_provenance: 'false',
    npm_config_package_lock: 'false',
    npm_config_registry: 'https://registry.npmjs.org/',
  }
}

async function canonicalPath(path) {
  const missingSegments = []
  let cursor = resolve(path)
  for (;;) {
    try {
      return join(await realpath(cursor), ...missingSegments.toReversed())
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      const parent = dirname(cursor)
      if (parent === cursor) throw error
      missingSegments.push(basename(cursor))
      cursor = parent
    }
  }
}

function isSameOrAncestor(ancestor, candidate) {
  const pathFromAncestor = relative(ancestor, candidate)
  return (
    pathFromAncestor === '' ||
    (pathFromAncestor !== '..' &&
      !pathFromAncestor.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromAncestor))
  )
}

async function assertSafeOutput({ root, archiveDirectory, outDirectory }) {
  const output = resolve(outDirectory)
  if (output === parse(output).root)
    throw new Error('npm candidate output must not be a filesystem root')
  const [outputIdentity, rootIdentity, archiveIdentity, cwdIdentity] = await Promise.all([
    canonicalPath(output),
    realpath(root),
    realpath(archiveDirectory),
    realpath(process.cwd()),
  ])
  if (
    isSameOrAncestor(outputIdentity, rootIdentity) ||
    isSameOrAncestor(outputIdentity, cwdIdentity) ||
    isSameOrAncestor(outputIdentity, archiveIdentity) ||
    isSameOrAncestor(archiveIdentity, outputIdentity)
  )
    throw new Error('npm candidate output collides with or contains a protected source root')
}

async function pathExists(path) {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

async function assertReplaceableOutput(outDirectory, { archiveDirectory, sourceRoot }) {
  if (!(await pathExists(outDirectory))) return
  const metadata = await lstat(outDirectory)
  if (metadata.isSymbolicLink() || !metadata.isDirectory())
    throw new Error('existing npm candidate output must be a real directory')
  const names = await readdir(outDirectory)
  if (names.length === 0) return
  try {
    await verifyNpmPublishPlan({
      outputDirectory: outDirectory,
      trustedArchiveDirectory: archiveDirectory,
      trustedSourceRoot: sourceRoot,
    })
  } catch (error) {
    throw new Error('refusing to replace an unowned or non-exact npm candidate output', {
      cause: error,
    })
  }
}

async function promoteFreshOutput(freshOutput, outDirectory, trustedSources) {
  const exists = await pathExists(outDirectory)
  const backup = join(dirname(outDirectory), `.${basename(outDirectory)}.backup-${randomUUID()}`)
  if (exists) {
    await rename(outDirectory, backup)
    try {
      await assertReplaceableOutput(backup, trustedSources)
    } catch (error) {
      await rename(backup, outDirectory).catch(() => {})
      throw new Error('npm candidate output changed before promotion; refusing replacement', {
        cause: error,
      })
    }
  }
  try {
    await rename(freshOutput, outDirectory)
  } catch (error) {
    if (exists) await rename(backup, outDirectory).catch(() => {})
    throw error
  }
  if (exists) await rm(backup, { recursive: true })
}

export async function packStandaloneNpm({
  root,
  archiveDirectory,
  outDirectory,
  spawn = spawnSync,
}) {
  if (!root || !archiveDirectory || !outDirectory)
    throw new Error('root, archiveDirectory, and outDirectory are required')
  const repositoryRoot = resolve(root)
  const archives = resolve(archiveDirectory)
  const output = resolve(outDirectory)
  await assertSafeOutput({ root: repositoryRoot, archiveDirectory: archives, outDirectory: output })
  const trustedSources = { archiveDirectory: archives, sourceRoot: repositoryRoot }
  await assertReplaceableOutput(output, trustedSources)
  const { npmCli, packTool } = await resolveAndValidatePackTool()
  const candidate = await validateStandaloneNpmCandidate(archives)
  const wrapper = await readBoundedRegularFile(
    join(repositoryRoot, 'apps/cli/bin/volund.cjs'),
    NPM_PUBLISH_LIMITS.wrapperBytes,
    'npm wrapper',
  )
  if (!wrapper.toString('utf8').startsWith('#!/usr/bin/env node\n'))
    throw new Error('npm wrapper must have a Node shebang')
  const [readme, license] = await Promise.all([
    readBoundedRegularFile(
      join(repositoryRoot, 'README.md'),
      NPM_PUBLISH_LIMITS.readmeBytes,
      'README.md',
    ),
    readBoundedRegularFile(
      join(repositoryRoot, 'LICENSE'),
      NPM_PUBLISH_LIMITS.licenseBytes,
      'LICENSE',
    ),
  ])
  const source = {
    ...candidate.source,
    wrapper: {
      path: 'apps/cli/bin/volund.cjs',
      sha256: digest(wrapper, 'sha256'),
      size: wrapper.byteLength,
    },
    readme: { path: 'README.md', sha256: digest(readme, 'sha256'), size: readme.byteLength },
    license: { path: 'LICENSE', sha256: digest(license, 'sha256'), size: license.byteLength },
  }

  await mkdir(dirname(output), { recursive: true })
  const stagingRoot = await mkdtemp(join(dirname(output), '.volund-npm-stage-'))
  const freshOutput = join(stagingRoot, 'candidate')
  try {
    const packEnvironment = await createIsolatedPackEnvironment(stagingRoot)
    const packagesDirectory = join(freshOutput, 'packages')
    const tarballsDirectory = join(freshOutput, 'tarballs')
    await mkdir(packagesDirectory, { recursive: true })
    await mkdir(tarballsDirectory)
    const packageInfos = []
    const extractionTotals = { uncompressedBytes: 0, entryCount: 0 }
    for (const artifact of candidate.artifacts) {
      const body = await readBoundedRegularFile(
        join(archives, artifact.archiveName),
        NPM_PACKAGING_ARCHIVE_LIMITS.compressedBytes,
        `standalone archive '${artifact.archiveName}'`,
      )
      if (body.byteLength !== artifact.size || digest(body, 'sha256') !== artifact.sha256)
        throw new Error(`standalone archive changed before extraction for '${artifact.target}'`)
      const validated = validateArchiveForPackaging(body, artifact.target, extractionTotals)
      packageInfos.push(
        await buildPlatformPackage(
          packagesDirectory,
          artifact,
          candidate.identity.version,
          validated.entries,
        ),
      )
    }
    const optionalDependencies = Object.fromEntries(
      STANDALONE_TARGETS.map((target) => [
        `${PACKAGE_SCOPE}/${target}`,
        candidate.identity.version,
      ]),
    )
    for (const name of ['@volund/cli', 'volund-code'])
      packageInfos.push(
        await buildMetaPackage({
          packagesDirectory,
          name,
          version: candidate.identity.version,
          optionalDependencies,
          wrapper,
          readme,
          license,
        }),
      )

    const descriptors = []
    for (const packageInfo of packageInfos)
      descriptors.push(
        await runNpmPack({
          packageInfo,
          tarballsDirectory,
          version: candidate.identity.version,
          npmCli,
          packEnvironment,
          spawn,
        }),
      )
    if (descriptors.map((item) => item.name).join('\0') !== NPM_PUBLISH_ORDER.join('\0'))
      throw new Error('npm package construction order diverged from the frozen publish order')
    const plan = {
      schemaVersion: 1,
      release: candidate.identity,
      packTool,
      source,
      platformPackages: descriptors.slice(0, STANDALONE_TARGETS.length),
      canonicalMeta: descriptors.at(-2),
      legacyMeta: descriptors.at(-1),
      publishOrder: [...NPM_PUBLISH_ORDER],
    }
    await writeExclusive(
      join(freshOutput, NPM_OUTPUT_MARKER),
      `${JSON.stringify({
        schemaVersion: 1,
        product: 'volund',
        kind: 'npm-publish-candidate',
        version: candidate.identity.version,
      })}\n`,
    )
    await writeExclusive(
      join(freshOutput, NPM_PUBLISH_PLAN_FILE),
      `${JSON.stringify(plan, null, 2)}\n`,
    )
    await verifyNpmPublishPlan({
      outputDirectory: freshOutput,
      expectedIdentity: candidate.identity,
      trustedArchiveDirectory: archives,
      trustedSourceRoot: repositoryRoot,
    })
    await promoteFreshOutput(freshOutput, output, trustedSources)
    console.log(`npm candidate: 9 packages -> ${output}`)
    return { out: output, plan }
  } finally {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => {})
  }
}

export function parseCliArguments(argv) {
  const supported = new Set(['--archives', '--output'])
  const values = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!supported.has(flag)) throw new Error(`unknown flag '${flag}'`)
    if (values.has(flag)) throw new Error(`duplicate flag '${flag}'`)
    if (!value || value.startsWith('--')) throw new Error(`flag '${flag}' requires a value`)
    values.set(flag, value)
  }
  for (const flag of supported)
    if (!values.has(flag)) throw new Error(`missing required flag '${flag}'`)
  return {
    archiveDirectory: resolve(values.get('--archives')),
    outDirectory: resolve(values.get('--output')),
  }
}

async function main() {
  const root = resolve(import.meta.dirname, '../..')
  await packStandaloneNpm({ root, ...parseCliArguments(process.argv.slice(2)) })
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) await main()
