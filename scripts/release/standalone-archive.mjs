import { createHash } from 'node:crypto'
import { lstat, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'

const TAR_BLOCK_SIZE = 512
const TAR_END_SIZE = TAR_BLOCK_SIZE * 2
const NATIVE_KINDS = Object.freeze(['sandbox', 'search', 'fs'])
export const REQUIRED_STANDALONE_METADATA_FILES = Object.freeze([
  'LICENSE',
  'NOTICE',
  'sbom.cdx.json',
])
export const STANDALONE_ARCHIVE_LIMITS = Object.freeze({
  compressedBytes: 512 * 1024 * 1024,
  uncompressedBytes: 1024 * 1024 * 1024,
  entryBytes: 512 * 1024 * 1024,
  entryCount: 10_000,
})

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function sha256(body) {
  return createHash('sha256').update(body).digest('hex')
}

function executableNameFor(target) {
  return target.startsWith('win32-') ? 'volund.exe' : 'volund'
}

function nativeNameFor(kind, target) {
  return `volund-${kind}-${target}${target.startsWith('win32-') ? '.exe' : ''}`
}

function assertSafeArchivePath(path) {
  if (
    !path ||
    path.startsWith('/') ||
    /^[A-Za-z]:/.test(path) ||
    path.includes('\\') ||
    path.includes('\0')
  )
    throw new Error(`unsafe archive path '${path}'`)
  const segments = path.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..'))
    throw new Error(`unsafe archive path '${path}'`)
}

function requiredTopLevelFiles(additionalRequiredTopLevelFiles) {
  for (const file of additionalRequiredTopLevelFiles) {
    assertSafeArchivePath(file)
    if (file.includes('/'))
      throw new Error(`required standalone metadata file must be top-level: '${file}'`)
  }
  return [...new Set([...REQUIRED_STANDALONE_METADATA_FILES, ...additionalRequiredTopLevelFiles])]
}

function resolveArchiveLimits(overrides = {}) {
  const limits = { ...STANDALONE_ARCHIVE_LIMITS, ...overrides }
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error(`standalone archive ${name} limit must be a positive safe integer`)
  }
  return limits
}

function splitTarPath(path) {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: '' }
  const separators = [...path.matchAll(/\//g)].map((match) => match.index)
  for (const separator of separators.toReversed()) {
    const prefix = path.slice(0, separator)
    const name = path.slice(separator + 1)
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix }
  }
  throw new Error(`archive path is too long for canonical ustar: ${path}`)
}

function writeString(buffer, offset, length, value) {
  const body = Buffer.from(value)
  if (body.length > length) throw new Error(`tar field exceeds ${length} bytes: ${value}`)
  body.copy(buffer, offset)
}

function writeOctal(buffer, offset, length, value) {
  const encoded = value.toString(8).padStart(length - 1, '0')
  if (encoded.length >= length) throw new Error(`tar numeric field overflow: ${value}`)
  writeString(buffer, offset, length, `${encoded}\0`)
}

function createTarHeader({ path, type, size, mode }) {
  const header = Buffer.alloc(TAR_BLOCK_SIZE)
  const tarPath = type === 'directory' ? `${path}/` : path
  const { name, prefix } = splitTarPath(tarPath)
  writeString(header, 0, 100, name)
  writeOctal(header, 100, 8, mode)
  writeOctal(header, 108, 8, 0)
  writeOctal(header, 116, 8, 0)
  writeOctal(header, 124, 12, size)
  writeOctal(header, 136, 12, 0)
  header.fill(0x20, 148, 156)
  header[156] = type === 'directory' ? 0x35 : 0x30
  writeString(header, 257, 6, 'ustar\0')
  writeString(header, 263, 2, '00')
  writeString(header, 345, 155, prefix)
  const checksum = header.reduce((sum, byte) => sum + byte, 0)
  writeString(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `)
  return header
}

function encodeCanonicalTar(entries) {
  const chunks = []
  for (const entry of entries) {
    assertSafeArchivePath(entry.path)
    const body = entry.type === 'file' ? entry.body : Buffer.alloc(0)
    const mode = entry.type === 'directory' ? 0o755 : entry.executable ? 0o755 : 0o644
    chunks.push(createTarHeader({ path: entry.path, type: entry.type, size: body.length, mode }))
    if (body.length > 0) {
      chunks.push(body)
      const padding = (TAR_BLOCK_SIZE - (body.length % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE
      if (padding > 0) chunks.push(Buffer.alloc(padding))
    }
  }
  chunks.push(Buffer.alloc(TAR_END_SIZE))
  return Buffer.concat(chunks)
}

function gzipCanonical(body) {
  const compressed = Buffer.from(gzipSync(body, { level: 9, mtime: 0 }))
  compressed.fill(0, 4, 8)
  compressed[9] = 0xff
  return compressed
}

function parseTarString(header, offset, length) {
  const field = header.subarray(offset, offset + length)
  const end = field.indexOf(0)
  return field.subarray(0, end === -1 ? field.length : end).toString()
}

function parseTarOctal(header, offset, length, fieldName) {
  const value = parseTarString(header, offset, length).trim()
  if (value === '') return 0
  if (!/^[0-7]+$/.test(value)) throw new Error(`invalid tar ${fieldName} field`)
  return Number.parseInt(value, 8)
}

export function readStandaloneArchive(archiveBody, { limits: limitOverrides } = {}) {
  const limits = resolveArchiveLimits(limitOverrides)
  if (archiveBody.byteLength > limits.compressedBytes)
    throw new Error(
      `standalone archive compressed size ${archiveBody.byteLength} exceeds limit ${limits.compressedBytes}`,
    )
  let tar
  try {
    tar = gunzipSync(archiveBody, { maxOutputLength: limits.uncompressedBytes })
  } catch (error) {
    if (error?.code === 'ERR_BUFFER_TOO_LARGE' || /larger than/i.test(error?.message ?? ''))
      throw new Error(
        `standalone archive uncompressed size exceeds limit ${limits.uncompressedBytes}`,
        { cause: error },
      )
    throw new Error('standalone archive is not a valid gzip stream', { cause: error })
  }
  if (tar.byteLength > limits.uncompressedBytes)
    throw new Error(
      `standalone archive uncompressed size ${tar.byteLength} exceeds limit ${limits.uncompressedBytes}`,
    )
  const entries = new Map()
  let offset = 0
  let endBlocks = 0
  while (offset + TAR_BLOCK_SIZE <= tar.length) {
    const header = tar.subarray(offset, offset + TAR_BLOCK_SIZE)
    offset += TAR_BLOCK_SIZE
    if (header.every((byte) => byte === 0)) {
      endBlocks += 1
      if (endBlocks === 2) break
      continue
    }
    if (endBlocks > 0) throw new Error('non-zero tar entry after end marker')

    const declaredChecksum = parseTarOctal(header, 148, 8, 'checksum')
    const checksumHeader = Buffer.from(header)
    checksumHeader.fill(0x20, 148, 156)
    const computedChecksum = checksumHeader.reduce((sum, byte) => sum + byte, 0)
    if (declaredChecksum !== computedChecksum) throw new Error('tar header checksum mismatch')

    const name = parseTarString(header, 0, 100)
    const prefix = parseTarString(header, 345, 155)
    let path = prefix ? `${prefix}/${name}` : name
    const typeFlag = header[156]
    const type =
      typeFlag === 0 || typeFlag === 0x30 ? 'file' : typeFlag === 0x35 ? 'directory' : null
    if (!type)
      throw new Error(`unsupported tar entry type '${String.fromCharCode(typeFlag)}' for '${path}'`)
    if (type === 'directory' && path.endsWith('/')) path = path.slice(0, -1)
    assertSafeArchivePath(path)
    if (entries.has(path)) throw new Error(`duplicate archive entry '${path}'`)
    if (entries.size >= limits.entryCount)
      throw new Error(`standalone archive entry count exceeds limit ${limits.entryCount}`)

    const size = parseTarOctal(header, 124, 12, 'size')
    if (size > limits.entryBytes)
      throw new Error(`archive entry '${path}' size ${size} exceeds limit ${limits.entryBytes}`)
    if (type === 'directory' && size !== 0)
      throw new Error(`directory archive entry '${path}' has non-zero size`)
    if (offset + size > tar.length) throw new Error(`truncated archive entry '${path}'`)
    const body = Buffer.from(tar.subarray(offset, offset + size))
    const paddedSize = Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE
    if (tar.subarray(offset + size, offset + paddedSize).some((byte) => byte !== 0))
      throw new Error(`archive entry '${path}' has non-zero tar padding`)
    offset += paddedSize
    entries.set(path, {
      path,
      type,
      body,
      mode: parseTarOctal(header, 100, 8, 'mode'),
      uid: parseTarOctal(header, 108, 8, 'uid'),
      gid: parseTarOctal(header, 116, 8, 'gid'),
      mtime: parseTarOctal(header, 136, 12, 'mtime'),
      linkName: parseTarString(header, 157, 100),
      magic: parseTarString(header, 257, 6),
      version: parseTarString(header, 263, 2),
      uname: parseTarString(header, 265, 32),
      gname: parseTarString(header, 297, 32),
      deviceMajor: parseTarOctal(header, 329, 8, 'device major'),
      deviceMinor: parseTarOctal(header, 337, 8, 'device minor'),
      trailingHeaderBytesAreZero: header.subarray(500).every((byte) => byte === 0),
    })
  }
  if (endBlocks !== 2) throw new Error('tar archive is missing its two-block end marker')
  if (offset !== tar.length)
    throw new Error('tar archive must end after exactly two zero end blocks')
  return entries
}

function validateCanonicalMetadata(entries, executableName) {
  const paths = [...entries.keys()]
  const sortedPaths = paths.toSorted(compareText)
  if (paths.some((path, index) => path !== sortedPaths[index]))
    throw new Error('standalone archive entries are not in canonical order')
  for (const entry of entries.values()) {
    const expectedMode =
      entry.type === 'directory' ||
      entry.path === executableName ||
      (entry.path.startsWith('native/') && entry.path !== 'native/manifest.json')
        ? 0o755
        : 0o644
    if (
      entry.uid !== 0 ||
      entry.gid !== 0 ||
      entry.mtime !== 0 ||
      entry.linkName !== '' ||
      entry.magic !== 'ustar' ||
      entry.version !== '00' ||
      entry.uname !== '' ||
      entry.gname !== '' ||
      entry.deviceMajor !== 0 ||
      entry.deviceMinor !== 0 ||
      !entry.trailingHeaderBytesAreZero ||
      entry.mode !== expectedMode
    )
      throw new Error(`non-canonical tar metadata for '${entry.path}'`)
  }
}

function requireEntry(entries, path, type) {
  const entry = entries.get(path)
  if (!entry) throw new Error(`standalone archive is missing required entry '${path}'`)
  if (entry.type !== type) throw new Error(`standalone archive entry '${path}' must be a ${type}`)
  return entry
}

function validateStandaloneEntries(entries, target, additionalRequiredTopLevelFiles) {
  const executableName = executableNameFor(target)
  const metadataFiles = requiredTopLevelFiles(additionalRequiredTopLevelFiles)
  const allowedTopLevel = new Set([
    executableName,
    'native',
    'plugins',
    'checksums.sha256',
    ...metadataFiles,
  ])
  for (const path of entries.keys()) {
    const topLevel = path.split('/')[0]
    if (!allowedTopLevel.has(topLevel))
      throw new Error(`unknown top-level standalone archive entry '${topLevel}'`)
  }

  const executable = requireEntry(entries, executableName, 'file')
  requireEntry(entries, 'native', 'directory')
  requireEntry(entries, 'plugins', 'directory')
  const checksumEntry = requireEntry(entries, 'checksums.sha256', 'file')
  for (const file of metadataFiles) requireEntry(entries, file, 'file')

  const nativeManifestEntry = requireEntry(entries, 'native/manifest.json', 'file')
  let nativeManifest
  try {
    nativeManifest = JSON.parse(nativeManifestEntry.body.toString('utf8'))
  } catch {
    throw new Error('native/manifest.json is not valid JSON')
  }
  if (nativeManifest?.schemaVersion !== 1 || !Array.isArray(nativeManifest.assets))
    throw new Error('native/manifest.json has an invalid schema')
  if (nativeManifest.assets.length !== NATIVE_KINDS.length)
    throw new Error('native/manifest.json must reference exactly sandbox, search, and fs')

  const expectedNativePaths = new Set(['native/manifest.json'])
  for (const kind of NATIVE_KINDS) {
    const assets = nativeManifest.assets.filter((asset) => asset?.kind === kind)
    if (assets.length !== 1)
      throw new Error(`native/manifest.json must reference ${kind} exactly once`)
    const asset = assets[0]
    const expectedFile = nativeNameFor(kind, target)
    if (
      asset.target !== target ||
      asset.file !== expectedFile ||
      !/^[0-9a-f]{64}$/.test(asset.sha256)
    )
      throw new Error(`native/manifest.json has an invalid ${kind} entry for ${target}`)
    const path = `native/${expectedFile}`
    const nativeEntry = requireEntry(entries, path, 'file')
    if (sha256(nativeEntry.body) !== asset.sha256)
      throw new Error(`native asset checksum mismatch for '${path}'`)
    expectedNativePaths.add(path)
  }
  for (const [path] of entries) {
    if (path.startsWith('native/') && !expectedNativePaths.has(path))
      throw new Error(`unknown native archive entry '${path}'`)
  }

  const pluginFiles = [...entries.values()].filter(
    (entry) => entry.path.startsWith('plugins/') && entry.type === 'file',
  )
  if (pluginFiles.length === 0)
    throw new Error('standalone archive plugins/ must contain at least one regular file')

  const checksumLine = checksumEntry.body.toString('utf8')
  const expectedChecksum = `${sha256(executable.body)}  ${executableName}\n`
  if (checksumLine !== expectedChecksum)
    throw new Error(`inner checksums.sha256 does not match ${executableName}`)
  return { executableName, nativeManifest }
}

export function validateStandaloneArchiveBuffer(
  archiveBody,
  { target, additionalRequiredTopLevelFiles = [], limits },
) {
  if (
    archiveBody.length < 10 ||
    archiveBody[0] !== 0x1f ||
    archiveBody[1] !== 0x8b ||
    archiveBody[2] !== 0x08 ||
    archiveBody[3] !== 0 ||
    archiveBody.subarray(4, 8).some((byte) => byte !== 0) ||
    archiveBody[8] !== 0x02 ||
    archiveBody[9] !== 0xff
  )
    throw new Error('standalone archive has non-canonical gzip metadata')
  const entries = readStandaloneArchive(archiveBody, { limits })
  const result = validateStandaloneEntries(entries, target, additionalRequiredTopLevelFiles)
  validateCanonicalMetadata(entries, result.executableName)
  const canonicalEntries = [...entries.values()].map((entry) => ({
    path: entry.path,
    type: entry.type,
    body: entry.body,
    executable: entry.type === 'file' && entry.mode === 0o755,
  }))
  const canonicalBody = gzipCanonical(encodeCanonicalTar(canonicalEntries))
  if (!archiveBody.equals(canonicalBody))
    throw new Error('standalone archive bytes are not the canonical single-member encoding')
  return { ...result, entries }
}

async function collectSourceEntries(sourceDirectory, target, additionalRequiredTopLevelFiles) {
  const entries = []
  async function visit(relativePath) {
    const absolutePath = join(sourceDirectory, relativePath)
    const metadata = await lstat(absolutePath)
    if (metadata.isSymbolicLink())
      throw new Error(`standalone source entry '${relativePath}' must not be a symlink`)
    if (metadata.isDirectory()) {
      entries.push({ path: relativePath, type: 'directory' })
      const children = (await readdir(absolutePath)).toSorted(compareText)
      for (const child of children) await visit(`${relativePath}/${child}`)
      return
    }
    if (!metadata.isFile())
      throw new Error(
        `standalone source entry '${relativePath}' must be a regular file or directory`,
      )
    entries.push({
      path: relativePath,
      type: 'file',
      body: await readFile(absolutePath),
      executable:
        relativePath === executableNameFor(target) ||
        (relativePath.startsWith('native/') && relativePath !== 'native/manifest.json'),
    })
  }

  const rootEntries = (await readdir(sourceDirectory)).toSorted(compareText)
  for (const entry of rootEntries) await visit(entry)
  const entryMap = new Map(entries.map((entry) => [entry.path, entry]))
  validateStandaloneEntries(entryMap, target, additionalRequiredTopLevelFiles)
  return entries.toSorted((left, right) => compareText(left.path, right.path))
}

export async function createCanonicalStandaloneArchive({
  sourceDirectory,
  archivePath,
  target,
  additionalRequiredTopLevelFiles = [],
}) {
  const archiveBody = await createCanonicalStandaloneArchiveBuffer({
    sourceDirectory,
    target,
    additionalRequiredTopLevelFiles,
  })
  await writeFile(archivePath, archiveBody)
  return archiveBody
}

export async function createCanonicalStandaloneArchiveBuffer({
  sourceDirectory,
  target,
  additionalRequiredTopLevelFiles = [],
}) {
  const entries = await collectSourceEntries(
    sourceDirectory,
    target,
    additionalRequiredTopLevelFiles,
  )
  const archiveBody = gzipCanonical(encodeCanonicalTar(entries))
  validateStandaloneArchiveBuffer(archiveBody, { target, additionalRequiredTopLevelFiles })
  return archiveBody
}

export function archiveNameForTarget(target) {
  return `volund-standalone-${target}.tar.gz`
}

export function targetForArchiveName(name) {
  const prefix = 'volund-standalone-'
  const suffix = '.tar.gz'
  if (!name.startsWith(prefix) || !name.endsWith(suffix)) return null
  const target = name.slice(prefix.length, -suffix.length)
  return target && name === archiveNameForTarget(target) ? target : null
}
