import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readdir } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'

import { STANDALONE_TARGETS } from './build-all-standalone.mjs'
import {
  parseStandaloneChecksums,
  STANDALONE_CHECKSUMS_FILE,
  validateReleaseIdentity,
} from './generate-release-manifest.mjs'
import { archiveNameForTarget, validateStandaloneArchiveBuffer } from './standalone-archive.mjs'

export const NPM_PUBLISH_PLAN_FILE = 'publish-plan.json'
export const NPM_OUTPUT_MARKER = '.volund-npm-output.json'
export const NPM_CANDIDATE_LAYOUTS = Object.freeze(['full', 'packed-only'])
export const NPM_PACK_TOOL = Object.freeze({ nodeVersion: '22.14.0', npmVersion: '10.9.2' })
export const NPM_PACKAGING_ARCHIVE_LIMITS = Object.freeze({
  compressedBytes: 192 * 1024 * 1024,
  uncompressedBytes: 256 * 1024 * 1024,
  entryBytes: 192 * 1024 * 1024,
  entryCount: 2_000,
  aggregateCompressedBytes: 1024 * 1024 * 1024,
  aggregateUncompressedBytes: 1536 * 1024 * 1024,
  aggregateEntryCount: 14_000,
})
export const NPM_PUBLISH_LIMITS = Object.freeze({
  markerBytes: 4096,
  planBytes: 1024 * 1024,
  tarballBytes: 192 * 1024 * 1024,
  tarBytes: 288 * 1024 * 1024,
  tarEntries: 20_000,
  tarEntryBytes: 192 * 1024 * 1024,
  packageJsonBytes: 1024 * 1024,
  nativeManifestBytes: 1024 * 1024,
  checksumBytes: 64 * 1024,
  wrapperBytes: 1024 * 1024,
  metadataBytes: 128 * 1024 * 1024,
  releaseManifestBytes: 1024 * 1024,
  standaloneChecksumsBytes: 64 * 1024,
  readmeBytes: 4 * 1024 * 1024,
  licenseBytes: 1024 * 1024,
})

const PLATFORM_FIELDS = Object.freeze({
  'darwin-arm64': { os: ['darwin'], cpu: ['arm64'] },
  'darwin-x64': { os: ['darwin'], cpu: ['x64'] },
  'linux-x64-gnu': { os: ['linux'], cpu: ['x64'], libc: ['glibc'] },
  'linux-arm64-gnu': { os: ['linux'], cpu: ['arm64'], libc: ['glibc'] },
  'linux-x64-musl': { os: ['linux'], cpu: ['x64'], libc: ['musl'] },
  'linux-arm64-musl': { os: ['linux'], cpu: ['arm64'], libc: ['musl'] },
  'win32-x64-msvc': { os: ['win32'], cpu: ['x64', 'arm64'] },
})

const PLATFORM_PACKAGE_NAMES = Object.freeze(
  STANDALONE_TARGETS.map((target) => `@volund/${target}`),
)
const META_PACKAGE_NAMES = Object.freeze(['volund-cli', 'volund-code'])
export const NPM_PUBLISH_ORDER = Object.freeze([...PLATFORM_PACKAGE_NAMES, ...META_PACKAGE_NAMES])

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function parseTarString(header, offset, length, label = 'string', allowSpaceAfterNul = false) {
  const field = header.subarray(offset, offset + length)
  const end = field.indexOf(0)
  if (
    end !== -1 &&
    field.subarray(end + 1).some((byte) => byte !== 0 && (!allowSpaceAfterNul || byte !== 0x20))
  )
    throw new Error(`invalid npm tar ${label}: data follows NUL terminator`)
  return field.subarray(0, end === -1 ? field.length : end).toString()
}

function parseTarOctal(header, offset, length, label) {
  const text = parseTarString(header, offset, length, label, true).trim()
  if (text === '') return 0
  if (!/^[0-7]+$/.test(text)) throw new Error(`invalid npm tar ${label}`)
  return Number.parseInt(text, 8)
}

function assertSafePackagePath(path) {
  if (!path.startsWith('package/') || path.includes('\\') || path.includes('\0'))
    throw new Error(`unsafe npm tar path '${path}'`)
  const segments = path.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..'))
    throw new Error(`unsafe npm tar path '${path}'`)
}

export function inspectNpmTarballBuffer(body, { limits = NPM_PUBLISH_LIMITS } = {}) {
  if (body.byteLength > limits.tarballBytes)
    throw new Error(`npm tarball exceeds ${limits.tarballBytes} bytes`)
  if (
    body.length < 10 ||
    body[0] !== 0x1f ||
    body[1] !== 0x8b ||
    body[2] !== 0x08 ||
    body[3] !== 0 ||
    body.subarray(4, 8).some((byte) => byte !== 0) ||
    body[8] !== 0x02 ||
    body[9] !== 0xff
  )
    throw new Error('npm tarball has non-canonical gzip metadata')
  let tar
  try {
    tar = gunzipSync(body, { maxOutputLength: limits.tarBytes })
  } catch (error) {
    throw new Error('npm package is not a bounded gzip tarball', { cause: error })
  }
  const entries = new Map()
  let offset = 0
  let zeroBlocks = 0
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    offset += 512
    if (header.every((byte) => byte === 0)) {
      zeroBlocks += 1
      if (zeroBlocks === 2) break
      continue
    }
    if (zeroBlocks > 0) throw new Error('npm tar contains data after its end marker')
    const expectedChecksum = parseTarOctal(header, 148, 8, 'header checksum')
    const checksumHeader = Buffer.from(header)
    checksumHeader.fill(0x20, 148, 156)
    if (checksumHeader.reduce((sum, byte) => sum + byte, 0) !== expectedChecksum)
      throw new Error('npm tar header checksum mismatch')
    const name = parseTarString(header, 0, 100, 'name')
    const prefix = parseTarString(header, 345, 155, 'prefix')
    let path = prefix ? `${prefix}/${name}` : name
    const typeFlag = header[156]
    const type =
      typeFlag === 0 || typeFlag === 0x30 ? 'file' : typeFlag === 0x35 ? 'directory' : null
    if (!type)
      throw new Error(
        `npm tar entry '${path}' has forbidden type '${String.fromCharCode(typeFlag)}'`,
      )
    if (type === 'directory' && path.endsWith('/')) path = path.slice(0, -1)
    assertSafePackagePath(path)
    if (entries.has(path)) throw new Error(`duplicate npm tar entry '${path}'`)
    if (entries.size >= limits.tarEntries)
      throw new Error(`npm tar entry count exceeds ${limits.tarEntries}`)
    const size = parseTarOctal(header, 124, 12, 'entry size')
    if (size > limits.tarEntryBytes)
      throw new Error(`npm tar entry '${path}' exceeds ${limits.tarEntryBytes} bytes`)
    if (type === 'directory' && size !== 0)
      throw new Error(`npm tar directory '${path}' has non-zero size`)
    if (offset + size > tar.length) throw new Error(`truncated npm tar entry '${path}'`)
    const entryBody = Buffer.from(tar.subarray(offset, offset + size))
    const paddedSize = Math.ceil(size / 512) * 512
    if (tar.subarray(offset + size, offset + paddedSize).some((byte) => byte !== 0))
      throw new Error(`npm tar entry '${path}' has non-zero padding`)
    offset += paddedSize
    const mode = parseTarOctal(header, 100, 8, 'entry mode')
    const uid = parseTarOctal(header, 108, 8, 'uid')
    const gid = parseTarOctal(header, 116, 8, 'gid')
    const mtime = parseTarOctal(header, 136, 12, 'mtime')
    const linkName = parseTarString(header, 157, 100, 'link name')
    const magic = parseTarString(header, 257, 6, 'magic')
    const version = parseTarString(header, 263, 2, 'version')
    const uname = parseTarString(header, 265, 32, 'user name')
    const gname = parseTarString(header, 297, 32, 'group name')
    const deviceMajor = parseTarOctal(header, 329, 8, 'device major')
    const deviceMinor = parseTarOctal(header, 337, 8, 'device minor')
    if (
      uid !== 0 ||
      gid !== 0 ||
      mtime !== 499_162_500 ||
      linkName !== '' ||
      magic !== 'ustar' ||
      version !== '00' ||
      uname !== '' ||
      gname !== '' ||
      deviceMajor !== 0 ||
      deviceMinor !== 0 ||
      !header.subarray(500).every((byte) => byte === 0) ||
      (type === 'directory' ? mode !== 0o755 : mode !== 0o644 && mode !== 0o755)
    )
      throw new Error(`npm tar entry '${path}' has non-canonical npm@10 metadata`)
    entries.set(path, {
      path,
      type,
      body: entryBody,
      mode,
    })
  }
  if (zeroBlocks !== 2) throw new Error('npm tar is missing its two-block end marker')
  if (offset !== tar.length) throw new Error('npm tar must end after exactly two zero blocks')
  const canonical = Buffer.from(gzipSync(tar, { level: 9, mtime: 0 }))
  canonical.fill(0, 4, 8)
  canonical[9] = 0xff
  if (!body.equals(canonical))
    throw new Error('npm tarball is not the canonical single-member npm@10 gzip encoding')
  return entries
}

export async function readBoundedRegularFile(path, limit, label) {
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const metadata = await handle.stat()
    if (!metadata.isFile()) throw new Error(`${label} must be a regular file`)
    if (metadata.size > limit) throw new Error(`${label} exceeds ${limit} bytes`)
    const body = Buffer.alloc(metadata.size)
    let offset = 0
    while (offset < body.length) {
      const { bytesRead } = await handle.read(body, offset, body.length - offset, offset)
      if (bytesRead === 0) throw new Error(`${label} changed while reading`)
      offset += bytesRead
    }
    const after = await handle.stat()
    if (
      after.dev !== metadata.dev ||
      after.ino !== metadata.ino ||
      after.size !== metadata.size ||
      after.mtimeMs !== metadata.mtimeMs ||
      after.ctimeMs !== metadata.ctimeMs
    )
      throw new Error(`${label} changed while reading`)
    return body
  } finally {
    await handle?.close().catch(() => {})
  }
}

async function exactDirectoryNames(directory, expected, label) {
  const metadata = await lstat(directory)
  if (metadata.isSymbolicLink() || !metadata.isDirectory())
    throw new Error(`${label} must be a real directory`)
  const entries = await readdir(directory, { withFileTypes: true })
  const actual = entries.map((entry) => entry.name).toSorted(compareText)
  const wanted = [...expected].toSorted(compareText)
  if (actual.join('\0') !== wanted.join('\0'))
    throw new Error(`${label} contents mismatch; expected ${wanted.join(', ')}`)
  return entries
}

async function collectPackageStagingFiles(packageDirectory) {
  const files = new Map()
  async function visit(directory, prefix) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink())
        throw new Error(`npm package staging entry '${relative}' must not be a symlink`)
      if (entry.isDirectory()) {
        await visit(path, relative)
        continue
      }
      if (!entry.isFile())
        throw new Error(`npm package staging entry '${relative}' must be a regular file`)
      const fileMetadata = await lstat(path)
      files.set(relative, {
        body: await readBoundedRegularFile(
          path,
          NPM_PUBLISH_LIMITS.tarEntryBytes,
          `npm package staging entry '${relative}'`,
        ),
        executable: (fileMetadata.mode & 0o111) !== 0,
      })
    }
  }
  await visit(packageDirectory, '')
  return files
}

function readJson(body, label) {
  try {
    return JSON.parse(body.toString('utf8'))
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error })
  }
}

function validateStableIdentity(release) {
  assertExactObjectKeys(release, ['version', 'tag', 'commit', 'bunVersion'], 'release identity')
  const identity = validateReleaseIdentity(release)
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(identity.version))
    throw new Error('npm publish plan version must be stable SemVer core')
  if (identity.bunVersion.split(/[+-]/, 1)[0] === '0.0.0')
    throw new Error('npm publish plan Bun version must not be a placeholder')
  return identity
}

function assertExactObjectKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} must be an object`)
  const actual = Object.keys(value).toSorted(compareText)
  const expected = [...keys].toSorted(compareText)
  if (actual.join('\0') !== expected.join('\0'))
    throw new Error(`${label} keys must be exactly: ${expected.join(', ')}`)
}

function validateSourceFileDescriptor(descriptor, expectedPath, label) {
  assertExactObjectKeys(descriptor, ['path', 'sha256', 'size'], `${label} source`)
  if (
    descriptor.path !== expectedPath ||
    !/^[0-9a-f]{64}$/.test(descriptor.sha256) ||
    !Number.isSafeInteger(descriptor.size) ||
    descriptor.size <= 0
  )
    throw new Error(`${label} source evidence is invalid`)
}

function validatePlanSource(source, identity) {
  assertExactObjectKeys(
    source,
    ['releaseManifest', 'standaloneChecksums', 'archives', 'wrapper', 'readme', 'license'],
    'publish plan source',
  )
  for (const [key, name] of [
    ['releaseManifest', 'release-manifest.json'],
    ['standaloneChecksums', STANDALONE_CHECKSUMS_FILE],
  ]) {
    assertExactObjectKeys(source[key], ['name', 'sha256', 'size'], `${key} source`)
    if (
      source[key].name !== name ||
      !/^[0-9a-f]{64}$/.test(source[key].sha256) ||
      !Number.isSafeInteger(source[key].size) ||
      source[key].size <= 0
    )
      throw new Error(`${key} source evidence is invalid`)
  }
  validateSourceFileDescriptor(source.wrapper, 'apps/cli/bin/volund.cjs', 'wrapper')
  validateSourceFileDescriptor(source.readme, 'README.md', 'README')
  validateSourceFileDescriptor(source.license, 'LICENSE', 'LICENSE')
  if (!Array.isArray(source.archives) || source.archives.length !== STANDALONE_TARGETS.length)
    throw new Error('publish plan source must bind exactly seven standalone archives')
  for (const [index, target] of STANDALONE_TARGETS.entries()) {
    const archive = source.archives[index]
    assertExactObjectKeys(
      archive,
      ['target', 'archiveName', 'sha256', 'size'],
      `archive source '${target}'`,
    )
    if (
      archive.target !== target ||
      archive.archiveName !== archiveNameForTarget(target) ||
      !/^[0-9a-f]{64}$/.test(archive.sha256) ||
      !Number.isSafeInteger(archive.size) ||
      archive.size <= 0
    )
      throw new Error(`archive source evidence is invalid for '${target}'`)
  }
  return { ...identity, source }
}

function descriptorList(plan) {
  if (
    !Array.isArray(plan.platformPackages) ||
    plan.platformPackages.length !== STANDALONE_TARGETS.length
  )
    throw new Error('publish plan must contain exactly seven platform packages')
  return [...plan.platformPackages, plan.canonicalMeta, plan.legacyMeta]
}

function directoryNameForPackage(name) {
  return name.startsWith('@volund/') ? `volund-${name.slice('@volund/'.length)}` : name
}

function validatePlanShape(plan) {
  assertExactObjectKeys(
    plan,
    [
      'schemaVersion',
      'release',
      'packTool',
      'source',
      'platformPackages',
      'canonicalMeta',
      'legacyMeta',
      'publishOrder',
    ],
    'publish plan',
  )
  if (plan.schemaVersion !== 1 || !plan.release)
    throw new Error('publish plan has an invalid schema')
  const identity = validateStableIdentity(plan.release)
  assertExactObjectKeys(plan.packTool, ['nodeVersion', 'npmVersion'], 'publish plan packTool')
  if (JSON.stringify(plan.packTool) !== JSON.stringify(NPM_PACK_TOOL))
    throw new Error('publish plan packTool does not match the pinned Node/npm toolchain')
  validatePlanSource(plan.source, identity)
  const descriptors = descriptorList(plan)
  if (descriptors.some((descriptor) => !descriptor || typeof descriptor !== 'object'))
    throw new Error('publish plan package descriptor is missing')
  const names = descriptors.map((descriptor) => descriptor.name)
  if (names.join('\0') !== NPM_PUBLISH_ORDER.join('\0'))
    throw new Error('publish plan package descriptors are not in frozen publish order')
  if (
    !Array.isArray(plan.publishOrder) ||
    plan.publishOrder.join('\0') !== NPM_PUBLISH_ORDER.join('\0')
  )
    throw new Error(
      'publish plan publishOrder must be seven platforms, volund-cli, then volund-code',
    )
  const directories = new Set()
  const tarballs = new Set()
  for (const descriptor of descriptors) {
    assertExactObjectKeys(
      descriptor,
      ['name', 'version', 'directory', 'tarball', 'sha256', 'integrity', 'size'],
      `package descriptor '${descriptor.name ?? '(unknown)'}'`,
    )
    if (descriptor.version !== identity.version)
      throw new Error(`publish plan package '${descriptor.name}' has the wrong version`)
    if (
      !/^packages\/[A-Za-z0-9._-]+$/.test(descriptor.directory) ||
      directories.has(descriptor.directory)
    )
      throw new Error(`invalid or duplicate package directory '${descriptor.directory}'`)
    if (
      !/^tarballs\/[A-Za-z0-9._-]+\.tgz$/.test(descriptor.tarball) ||
      tarballs.has(descriptor.tarball)
    )
      throw new Error(`invalid or duplicate package tarball '${descriptor.tarball}'`)
    if (!/^[0-9a-f]{64}$/.test(descriptor.sha256))
      throw new Error(`invalid sha256 for '${descriptor.name}'`)
    if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(descriptor.integrity))
      throw new Error(`invalid integrity for '${descriptor.name}'`)
    if (!Number.isSafeInteger(descriptor.size) || descriptor.size <= 0)
      throw new Error(`invalid tarball size for '${descriptor.name}'`)
    const expectedDirectory = `packages/${directoryNameForPackage(descriptor.name)}`
    const expectedTarball = `tarballs/${directoryNameForPackage(descriptor.name)}-${identity.version}.tgz`
    if (descriptor.directory !== expectedDirectory || descriptor.tarball !== expectedTarball)
      throw new Error(`publish plan paths are not canonical for '${descriptor.name}'`)
    directories.add(descriptor.directory)
    tarballs.add(descriptor.tarball)
  }
  return { descriptors, identity }
}

function requireTarFile(entries, path) {
  const entry = entries.get(path)
  if (!entry || entry.type !== 'file')
    throw new Error(`npm tarball is missing regular file '${path}'`)
  return entry
}

function validateCommonManifestMetadata(manifest, packageName) {
  if (
    manifest.license !== 'Apache-2.0' ||
    JSON.stringify(manifest.repository) !==
      JSON.stringify({ type: 'git', url: 'git+https://github.com/JS-mark/volund-code.git' }) ||
    JSON.stringify(manifest.bugs) !==
      JSON.stringify({ url: 'https://github.com/JS-mark/volund-code/issues' }) ||
    manifest.homepage !== 'https://github.com/JS-mark/volund-code#readme' ||
    JSON.stringify(manifest.publishConfig) !==
      JSON.stringify({ access: 'public', provenance: true })
  )
    throw new Error(`npm package '${packageName}' has invalid publication metadata`)
}

function validatePackageTarball(entries, descriptor, version, source) {
  const manifestEntry = requireTarFile(entries, 'package/package.json')
  if (manifestEntry.body.byteLength > NPM_PUBLISH_LIMITS.packageJsonBytes)
    throw new Error(`package.json is oversized for '${descriptor.name}'`)
  const manifest = readJson(manifestEntry.body, `${descriptor.name} package.json`)
  if (manifest.name !== descriptor.name || manifest.version !== version)
    throw new Error(`npm tarball identity mismatch for '${descriptor.name}'`)
  const target = descriptor.name.startsWith('@volund/')
    ? descriptor.name.slice('@volund/'.length)
    : null
  if (target) {
    assertExactObjectKeys(
      manifest,
      [
        'name',
        'version',
        'description',
        'license',
        'repository',
        'bugs',
        'homepage',
        'publishConfig',
        'files',
        'os',
        'cpu',
        ...(target.startsWith('linux-') ? ['libc'] : []),
      ],
      `platform package manifest '${descriptor.name}'`,
    )
    validateCommonManifestMetadata(manifest, descriptor.name)
    if (!STANDALONE_TARGETS.includes(target))
      throw new Error(`unexpected platform package '${descriptor.name}'`)
    if (manifest.description !== `Volund CLI standalone runtime (${target})`)
      throw new Error(`platform package '${descriptor.name}' has an invalid description`)
    const executable = target.startsWith('win32-') ? 'volund.exe' : 'volund'
    const expectedFiles = [
      executable,
      'native',
      'plugins',
      'checksums.sha256',
      'LICENSE',
      'NOTICE',
      'sbom.cdx.json',
    ]
    if (!Array.isArray(manifest.files) || manifest.files.join('\0') !== expectedFiles.join('\0'))
      throw new Error(`platform package '${descriptor.name}' has an invalid files contract`)
    const fields = PLATFORM_FIELDS[target]
    for (const key of ['os', 'cpu', 'libc']) {
      const actual = manifest[key]
      const expected = fields[key]
      if (JSON.stringify(actual) !== JSON.stringify(expected))
        throw new Error(`platform package '${descriptor.name}' has invalid ${key} metadata`)
    }
    const executableEntry = requireTarFile(entries, `package/${executable}`)
    if (executableEntry.mode !== 0o755)
      throw new Error(`platform executable for '${descriptor.name}' is not executable`)
    requireTarFile(entries, 'package/native/manifest.json')
    const nativeManifestEntry = requireTarFile(entries, 'package/native/manifest.json')
    if (nativeManifestEntry.body.byteLength > NPM_PUBLISH_LIMITS.nativeManifestBytes)
      throw new Error(`native manifest is oversized for '${descriptor.name}'`)
    const nativeManifest = readJson(nativeManifestEntry.body, `${descriptor.name} native manifest`)
    if (nativeManifest?.schemaVersion !== 1 || !Array.isArray(nativeManifest.assets))
      throw new Error(`platform package '${descriptor.name}' has an invalid native manifest`)
    for (const kind of ['sandbox', 'search', 'fs']) {
      const matches = nativeManifest.assets.filter((asset) => asset?.kind === kind)
      const nativeName = `volund-${kind}-${target}${target.startsWith('win32-') ? '.exe' : ''}`
      if (
        matches.length !== 1 ||
        matches[0].target !== target ||
        matches[0].file !== nativeName ||
        !/^[0-9a-f]{64}$/.test(matches[0].sha256)
      )
        throw new Error(`platform package '${descriptor.name}' has an invalid ${kind} native asset`)
      const nativeEntry = requireTarFile(entries, `package/native/${nativeName}`)
      if (
        nativeEntry.mode !== 0o755 ||
        createHash('sha256').update(nativeEntry.body).digest('hex') !== matches[0].sha256
      )
        throw new Error(`platform package '${descriptor.name}' has a corrupt ${kind} native asset`)
    }
    if (nativeManifest.assets.length !== 3)
      throw new Error(
        `platform package '${descriptor.name}' must contain exactly three native assets`,
      )
    const checksums = requireTarFile(entries, 'package/checksums.sha256').body.toString('utf8')
    if (Buffer.byteLength(checksums) > NPM_PUBLISH_LIMITS.checksumBytes)
      throw new Error(`checksums.sha256 is oversized for '${descriptor.name}'`)
    if (
      checksums !==
      `${createHash('sha256').update(executableEntry.body).digest('hex')}  ${executable}\n`
    )
      throw new Error(`platform package '${descriptor.name}' has an invalid executable checksum`)
    for (const file of ['LICENSE', 'NOTICE', 'sbom.cdx.json']) {
      const metadata = requireTarFile(entries, `package/${file}`)
      if (metadata.body.byteLength > NPM_PUBLISH_LIMITS.metadataBytes)
        throw new Error(`${file} is oversized for '${descriptor.name}'`)
    }
    const pluginFiles = [...entries.keys()].filter(
      (path) => path.startsWith('package/plugins/') && entries.get(path).type === 'file',
    )
    if (pluginFiles.length === 0)
      throw new Error(`platform package '${descriptor.name}' has no plugins`)
    for (const entry of entries.values()) {
      const relative = entry.path.slice('package/'.length)
      const top = relative.split('/')[0]
      if (!['package.json', ...expectedFiles].includes(top))
        throw new Error(`foreign file in platform tarball '${entry.path}'`)
      if (entry.type === 'file') {
        const expectedMode =
          relative === executable ||
          (relative.startsWith('native/') && relative !== 'native/manifest.json')
            ? 0o755
            : 0o644
        if (entry.mode !== expectedMode) throw new Error(`invalid npm tar mode for '${entry.path}'`)
      }
    }
  } else {
    if (!META_PACKAGE_NAMES.includes(descriptor.name))
      throw new Error(`unexpected meta package '${descriptor.name}'`)
    assertExactObjectKeys(
      manifest,
      [
        'name',
        'version',
        'description',
        'license',
        'repository',
        'bugs',
        'homepage',
        'publishConfig',
        'bin',
        'files',
        'engines',
        'optionalDependencies',
      ],
      `meta package manifest '${descriptor.name}'`,
    )
    validateCommonManifestMetadata(manifest, descriptor.name)
    const expectedDescription =
      descriptor.name === 'volund-cli'
        ? 'Open, model-agnostic AI coding CLI'
        : 'Compatibility package for volund-cli; migrate installs to volund-cli'
    if (manifest.description !== expectedDescription)
      throw new Error(`meta package '${descriptor.name}' has an invalid description`)
    const expected = [
      'package/LICENSE',
      'package/README.md',
      'package/bin/volund.cjs',
      'package/package.json',
    ]
    const actual = [...entries.values()]
      .filter((entry) => entry.type === 'file')
      .map((entry) => entry.path)
      .toSorted(compareText)
    if (actual.join('\0') !== expected.join('\0'))
      throw new Error(`meta package '${descriptor.name}' contains foreign or missing files`)
    const wrapper = requireTarFile(entries, 'package/bin/volund.cjs')
    if (
      wrapper.body.byteLength > NPM_PUBLISH_LIMITS.wrapperBytes ||
      wrapper.mode !== 0o755 ||
      createHash('sha256').update(wrapper.body).digest('hex') !== source.wrapper.sha256 ||
      wrapper.body.byteLength !== source.wrapper.size
    )
      throw new Error(`meta package '${descriptor.name}' wrapper does not match trusted source`)
    for (const [path, evidence] of [
      ['package/README.md', source.readme],
      ['package/LICENSE', source.license],
    ]) {
      const entry = requireTarFile(entries, path)
      if (
        entry.body.byteLength !== evidence.size ||
        createHash('sha256').update(entry.body).digest('hex') !== evidence.sha256
      )
        throw new Error(`meta package '${descriptor.name}' ${path} does not match trusted source`)
    }
    if (JSON.stringify(manifest.bin) !== JSON.stringify({ volund: 'bin/volund.cjs' }))
      throw new Error(`meta package '${descriptor.name}' must expose exactly one volund bin`)
    if (JSON.stringify(manifest.files) !== JSON.stringify(['bin']))
      throw new Error(`meta package '${descriptor.name}' has an invalid files contract`)
    if (JSON.stringify(manifest.engines) !== JSON.stringify({ node: '>=20.19.0' }))
      throw new Error(`meta package '${descriptor.name}' has an invalid Node engine`)
    const expectedOptional = Object.fromEntries(
      PLATFORM_PACKAGE_NAMES.map((name) => [name, version]),
    )
    if (JSON.stringify(manifest.optionalDependencies) !== JSON.stringify(expectedOptional))
      throw new Error(`meta package '${descriptor.name}' has an invalid optional dependency graph`)
  }
  return manifest
}

function assertSourceDescriptorMatchesBody(descriptor, body, label) {
  if (
    descriptor.size !== body.byteLength ||
    descriptor.sha256 !== createHash('sha256').update(body).digest('hex')
  )
    throw new Error(`${label} does not match publish plan source evidence`)
}

async function validateTrustedSources(source, identity, archiveDirectory, sourceRoot) {
  const archives = resolve(archiveDirectory)
  const root = resolve(sourceRoot)
  const candidateNames = [
    ...STANDALONE_TARGETS.map(archiveNameForTarget),
    STANDALONE_CHECKSUMS_FILE,
    'release-manifest.json',
  ]
  const entries = await exactDirectoryNames(archives, candidateNames, 'trusted standalone source')
  if (entries.some((entry) => !entry.isFile()))
    throw new Error('trusted standalone source entries must be regular files')
  const releaseManifestBody = await readBoundedRegularFile(
    join(archives, 'release-manifest.json'),
    NPM_PUBLISH_LIMITS.releaseManifestBytes,
    'trusted release-manifest.json',
  )
  const checksumsBody = await readBoundedRegularFile(
    join(archives, STANDALONE_CHECKSUMS_FILE),
    NPM_PUBLISH_LIMITS.standaloneChecksumsBytes,
    `trusted ${STANDALONE_CHECKSUMS_FILE}`,
  )
  assertSourceDescriptorMatchesBody(source.releaseManifest, releaseManifestBody, 'release manifest')
  assertSourceDescriptorMatchesBody(
    source.standaloneChecksums,
    checksumsBody,
    STANDALONE_CHECKSUMS_FILE,
  )
  const releaseManifest = readJson(releaseManifestBody, 'trusted release-manifest.json')
  const trustedIdentity = validateStableIdentity({
    version: releaseManifest.version,
    tag: releaseManifest.tag,
    commit: releaseManifest.commit,
    bunVersion: releaseManifest.bunVersion,
  })
  if (
    releaseManifest.schemaVersion !== 1 ||
    JSON.stringify(trustedIdentity) !== JSON.stringify(identity) ||
    !Array.isArray(releaseManifest.artifacts) ||
    releaseManifest.artifacts.length !== STANDALONE_TARGETS.length
  )
    throw new Error('trusted release manifest identity or artifact set is invalid')
  const checksums = parseStandaloneChecksums(checksumsBody.toString('utf8'))
  const canonicalChecksumLines = []
  let aggregateCompressedBytes = 0
  const aggregateTotals = { uncompressedBytes: 0, entryCount: 0 }
  for (const [index, target] of STANDALONE_TARGETS.entries()) {
    const evidence = source.archives[index]
    const artifact = releaseManifest.artifacts[index]
    if (
      artifact.target !== target ||
      artifact.archiveName !== evidence.archiveName ||
      artifact.sha256 !== evidence.sha256 ||
      artifact.size !== evidence.size ||
      artifact.executableName !== (target.startsWith('win32-') ? 'volund.exe' : 'volund') ||
      checksums.get(evidence.archiveName) !== evidence.sha256
    )
      throw new Error(`trusted release source contract mismatch for '${target}'`)
    canonicalChecksumLines.push(`${evidence.sha256}  ${evidence.archiveName}`)
    aggregateCompressedBytes += evidence.size
    if (aggregateCompressedBytes > NPM_PACKAGING_ARCHIVE_LIMITS.aggregateCompressedBytes)
      throw new Error('trusted standalone source aggregate compressed size exceeds limit')
    const body = await readBoundedRegularFile(
      join(archives, evidence.archiveName),
      NPM_PACKAGING_ARCHIVE_LIMITS.compressedBytes,
      `trusted standalone archive '${evidence.archiveName}'`,
    )
    assertSourceDescriptorMatchesBody(evidence, body, `trusted archive '${evidence.archiveName}'`)
    const validated = validateStandaloneArchiveBuffer(body, {
      target,
      limits: {
        compressedBytes: NPM_PACKAGING_ARCHIVE_LIMITS.compressedBytes,
        uncompressedBytes: NPM_PACKAGING_ARCHIVE_LIMITS.uncompressedBytes,
        entryBytes: NPM_PACKAGING_ARCHIVE_LIMITS.entryBytes,
        entryCount: NPM_PACKAGING_ARCHIVE_LIMITS.entryCount,
      },
    })
    aggregateTotals.uncompressedBytes += [...validated.entries.values()].reduce(
      (sum, entry) => sum + entry.body.byteLength,
      0,
    )
    aggregateTotals.entryCount += validated.entries.size
    if (
      aggregateTotals.uncompressedBytes > NPM_PACKAGING_ARCHIVE_LIMITS.aggregateUncompressedBytes ||
      aggregateTotals.entryCount > NPM_PACKAGING_ARCHIVE_LIMITS.aggregateEntryCount
    )
      throw new Error('trusted standalone source aggregate expanded content exceeds limit')
  }
  if (checksums.size !== STANDALONE_TARGETS.length)
    throw new Error(`${STANDALONE_CHECKSUMS_FILE} must bind exactly seven archives`)
  if (checksumsBody.toString('utf8') !== `${canonicalChecksumLines.join('\n')}\n`)
    throw new Error(`${STANDALONE_CHECKSUMS_FILE} is not in canonical target order`)
  for (const [descriptor, limit, label] of [
    [source.wrapper, NPM_PUBLISH_LIMITS.wrapperBytes, 'trusted wrapper'],
    [source.readme, NPM_PUBLISH_LIMITS.readmeBytes, 'trusted README'],
    [source.license, NPM_PUBLISH_LIMITS.licenseBytes, 'trusted LICENSE'],
  ]) {
    const body = await readBoundedRegularFile(join(root, descriptor.path), limit, label)
    assertSourceDescriptorMatchesBody(descriptor, body, label)
  }
}

async function comparePlatformTarballToTrustedArchive(
  tarEntries,
  target,
  source,
  archiveDirectory,
) {
  const evidence = source.archives[STANDALONE_TARGETS.indexOf(target)]
  const body = await readBoundedRegularFile(
    join(archiveDirectory, evidence.archiveName),
    NPM_PACKAGING_ARCHIVE_LIMITS.compressedBytes,
    `trusted standalone archive '${evidence.archiveName}'`,
  )
  const trusted = validateStandaloneArchiveBuffer(body, {
    target,
    limits: {
      compressedBytes: NPM_PACKAGING_ARCHIVE_LIMITS.compressedBytes,
      uncompressedBytes: NPM_PACKAGING_ARCHIVE_LIMITS.uncompressedBytes,
      entryBytes: NPM_PACKAGING_ARCHIVE_LIMITS.entryBytes,
      entryCount: NPM_PACKAGING_ARCHIVE_LIMITS.entryCount,
    },
  })
  const trustedFiles = [...trusted.entries.values()].filter((entry) => entry.type === 'file')
  const packedFiles = [...tarEntries.values()].filter((entry) => entry.type === 'file')
  if (packedFiles.length !== trustedFiles.length + 1)
    throw new Error(`platform package '${target}' does not exactly mirror its trusted archive`)
  for (const trustedEntry of trustedFiles) {
    const packed = requireTarFile(tarEntries, `package/${trustedEntry.path}`)
    if (!packed.body.equals(trustedEntry.body) || packed.mode !== trustedEntry.mode)
      throw new Error(`platform package '${target}' differs from trusted '${trustedEntry.path}'`)
  }
}

export async function verifyNpmPublishPlan({
  outputDirectory,
  expectedIdentity,
  trustedArchiveDirectory,
  trustedSourceRoot,
  candidateLayout = 'full',
} = {}) {
  if (!trustedArchiveDirectory || !trustedSourceRoot)
    throw new Error('trustedArchiveDirectory and trustedSourceRoot are required')
  if (!NPM_CANDIDATE_LAYOUTS.includes(candidateLayout))
    throw new Error(`unsupported npm candidate layout '${candidateLayout}'`)
  const output = resolve(outputDirectory)
  const expectedTopLevel =
    candidateLayout === 'full'
      ? [NPM_OUTPUT_MARKER, NPM_PUBLISH_PLAN_FILE, 'packages', 'tarballs']
      : [NPM_OUTPUT_MARKER, NPM_PUBLISH_PLAN_FILE, 'tarballs']
  const topLevelEntries = await exactDirectoryNames(
    output,
    expectedTopLevel,
    'npm candidate output',
  )
  const topLevelByName = new Map(topLevelEntries.map((entry) => [entry.name, entry]))
  if (
    !topLevelByName.get(NPM_OUTPUT_MARKER)?.isFile() ||
    !topLevelByName.get(NPM_PUBLISH_PLAN_FILE)?.isFile() ||
    (candidateLayout === 'full' && !topLevelByName.get('packages')?.isDirectory()) ||
    !topLevelByName.get('tarballs')?.isDirectory()
  )
    throw new Error('npm candidate top-level entry types are invalid')
  const markerBody = await readBoundedRegularFile(
    join(output, NPM_OUTPUT_MARKER),
    NPM_PUBLISH_LIMITS.markerBytes,
    NPM_OUTPUT_MARKER,
  )
  const marker = readJson(markerBody, NPM_OUTPUT_MARKER)
  assertExactObjectKeys(marker, ['schemaVersion', 'product', 'kind', 'version'], 'npm marker')
  if (
    marker?.schemaVersion !== 1 ||
    marker.product !== 'volund' ||
    marker.kind !== 'npm-publish-candidate'
  )
    throw new Error('invalid npm candidate ownership marker')
  if (
    markerBody.toString('utf8') !==
    `${JSON.stringify({
      schemaVersion: 1,
      product: 'volund',
      kind: 'npm-publish-candidate',
      version: marker.version,
    })}\n`
  )
    throw new Error('npm candidate ownership marker is not canonical')
  const plan = readJson(
    await readBoundedRegularFile(
      join(output, NPM_PUBLISH_PLAN_FILE),
      NPM_PUBLISH_LIMITS.planBytes,
      NPM_PUBLISH_PLAN_FILE,
    ),
    NPM_PUBLISH_PLAN_FILE,
  )
  const { descriptors, identity } = validatePlanShape(plan)
  if (marker.version !== identity.version)
    throw new Error('npm candidate marker version does not match plan')
  if (expectedIdentity) {
    const expected = validateStableIdentity(expectedIdentity)
    if (JSON.stringify(identity) !== JSON.stringify(expected))
      throw new Error('npm publish plan does not match expected release identity')
  }
  await validateTrustedSources(plan.source, identity, trustedArchiveDirectory, trustedSourceRoot)
  if (candidateLayout === 'full') {
    const packageEntries = await exactDirectoryNames(
      join(output, 'packages'),
      descriptors.map((item) => basename(item.directory)),
      'npm package staging',
    )
    if (packageEntries.some((entry) => !entry.isDirectory()))
      throw new Error('npm package staging entries must be real directories')
  }
  const tarballEntries = await exactDirectoryNames(
    join(output, 'tarballs'),
    descriptors.map((item) => basename(item.tarball)),
    'npm tarballs',
  )
  if (tarballEntries.some((entry) => !entry.isFile()))
    throw new Error('npm tarball entries must be regular files')
  for (const descriptor of descriptors) {
    const tarball = await readBoundedRegularFile(
      join(output, descriptor.tarball),
      NPM_PUBLISH_LIMITS.tarballBytes,
      `npm tarball '${descriptor.name}'`,
    )
    const sha256 = createHash('sha256').update(tarball).digest('hex')
    const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`
    if (
      tarball.byteLength !== descriptor.size ||
      sha256 !== descriptor.sha256 ||
      integrity !== descriptor.integrity
    )
      throw new Error(`npm tarball bytes do not match publish plan for '${descriptor.name}'`)
    const tarEntries = inspectNpmTarballBuffer(tarball)
    validatePackageTarball(tarEntries, descriptor, identity.version, plan.source)
    if (descriptor.name.startsWith('@volund/'))
      await comparePlatformTarballToTrustedArchive(
        tarEntries,
        descriptor.name.slice('@volund/'.length),
        plan.source,
        trustedArchiveDirectory,
      )
    if (candidateLayout === 'full') {
      const stagingFiles = await collectPackageStagingFiles(join(output, descriptor.directory))
      const packedFiles = new Map(
        [...tarEntries.values()]
          .filter((entry) => entry.type === 'file')
          .map((entry) => [entry.path.slice('package/'.length), entry]),
      )
      if (
        [...stagingFiles.keys()].toSorted(compareText).join('\0') !==
        [...packedFiles.keys()].toSorted(compareText).join('\0')
      )
        throw new Error(`npm staging contents do not match tarball for '${descriptor.name}'`)
      for (const [path, staged] of stagingFiles) {
        const packed = packedFiles.get(path)
        if (!packed.body.equals(staged.body) || staged.executable !== ((packed.mode & 0o111) !== 0))
          throw new Error(
            `npm staging bytes or mode do not match tarball for '${descriptor.name}/${path}'`,
          )
      }
    }
  }
  return plan
}

export function parseVerifyNpmPlanCli(argv) {
  const supported = new Set([
    '--output',
    '--archives',
    '--source-root',
    '--version',
    '--tag',
    '--commit',
    '--bun-version',
    '--layout',
  ])
  const values = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!supported.has(flag)) throw new Error(`unknown flag '${flag}'`)
    if (values.has(flag)) throw new Error(`duplicate flag '${flag}'`)
    if (!value || value.startsWith('--')) throw new Error(`flag '${flag}' requires a value`)
    values.set(flag, value)
  }
  for (const flag of ['--output', '--archives', '--source-root'])
    if (!values.has(flag)) throw new Error(`missing required flag '${flag}'`)
  const identityFlags = ['--version', '--tag', '--commit', '--bun-version']
  const suppliedIdentity = identityFlags.filter((flag) => values.has(flag))
  if (suppliedIdentity.length !== 0 && suppliedIdentity.length !== identityFlags.length)
    throw new Error('expected identity flags must be supplied together')
  return {
    outputDirectory: resolve(values.get('--output')),
    trustedArchiveDirectory: resolve(values.get('--archives')),
    trustedSourceRoot: resolve(values.get('--source-root')),
    candidateLayout: values.get('--layout') ?? 'full',
    expectedIdentity:
      suppliedIdentity.length === 0
        ? undefined
        : {
            version: values.get('--version'),
            tag: values.get('--tag'),
            commit: values.get('--commit'),
            bunVersion: values.get('--bun-version'),
          },
  }
}

async function main() {
  const request = parseVerifyNpmPlanCli(process.argv.slice(2))
  await verifyNpmPublishPlan(request)
  console.log(`verified npm publish plan: ${join(request.outputDirectory, NPM_PUBLISH_PLAN_FILE)}`)
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) await main()
