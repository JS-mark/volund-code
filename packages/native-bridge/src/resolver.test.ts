import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  packageTriple,
  releaseAssetName,
  resolveBinary,
  resolveBinaryDetailed,
  standaloneArtifactDir,
} from './resolver'

const originalEnvironment = { ...process.env }

afterEach(() => {
  process.env = { ...originalEnvironment }
  vi.unstubAllGlobals()
})

describe('standaloneArtifactDir', () => {
  it('resolves next to the bundle under a normal node run', () => {
    // fileURLToPath 在 Windows 上要求盘符路径：夹具按当前平台构造合法 file URL。
    const artifactPath =
      process.platform === 'win32'
        ? 'C:\\opt\\volund\\dist\\volund.js'
        : '/opt/volund/dist/volund.js'
    expect(standaloneArtifactDir(pathToFileURL(artifactPath).href, '/usr/local/bin/node')).toBe(
      join(artifactPath, '..'),
    )
  })

  it('falls back to the executable directory inside a bun-compiled binary', () => {
    // bun --compile embeds modules under the virtual /$bunfs/ root; the real
    // on-disk anchor next to the artifact is the executable itself.
    expect(standaloneArtifactDir('file:///$bunfs/root/volund', '/opt/volund/volund')).toBe(
      '/opt/volund',
    )
  })
})

describe('packageTriple', () => {
  it.each([
    ['darwin', 'arm64', undefined, 'darwin-arm64'],
    ['linux', 'x64', 'glibc', 'linux-x64-gnu'],
    ['linux', 'arm64', 'musl', 'linux-arm64-musl'],
    ['win32', 'x64', undefined, 'win32-x64-msvc'],
    ['win32', 'arm64', undefined, 'win32-arm64-msvc'],
  ] as const)('maps %s/%s/%s', (platform, arch, libc, expected) => {
    expect(packageTriple(platform, arch, libc)).toBe(expected)
  })

  it('rejects unsupported targets', () => {
    expect(packageTriple('freebsd', 'x64')).toBeNull()
    expect(packageTriple('linux', 'ia32', 'glibc')).toBeNull()
  })
})

describe('Release asset resolution', () => {
  it('uses stable target-specific asset names', () => {
    expect(releaseAssetName('fs', 'darwin-arm64')).toBe('volund-fs-darwin-arm64')
    expect(releaseAssetName('search', 'win32-x64-msvc')).toBe('volund-search-win32-x64-msvc.exe')
  })

  it('downloads, verifies, and reuses a cached versioned binary', async () => {
    const cache = await mkdtemp(join(tmpdir(), 'volund-native-'))
    const body = Buffer.from('verified native binary')
    const digest = createHash('sha256').update(body).digest('hex')
    const asset = releaseAssetName('fs', packageTriple(process.platform, process.arch)!)
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(`${digest}  ${asset}\n`))
      .mockResolvedValueOnce(new Response(body))
    vi.stubGlobal('fetch', fetchMock)
    process.env.VOLUND_VERSION = '1.2.3'
    process.env.VOLUND_NATIVE_CACHE_DIR = cache
    process.env.VOLUND_NATIVE_RELEASE_BASE_URL = 'https://release.invalid/v1.2.3'

    try {
      const first = await resolveBinary('fs')
      expect(first).not.toBeNull()
      expect(await readFile(first!)).toEqual(body)
      expect(await resolveBinary('fs')).toBe(first)
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      await rm(cache, { recursive: true, force: true })
    }
  })

  it('rejects an asset whose checksum does not match', async () => {
    const cache = await mkdtemp(join(tmpdir(), 'volund-native-'))
    const asset = releaseAssetName('search', packageTriple(process.platform, process.arch)!)
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response(`${'0'.repeat(64)}  ${asset}\n`))
        .mockResolvedValueOnce(new Response('tampered')),
    )
    process.env.VOLUND_VERSION = '1.2.3'
    process.env.VOLUND_NATIVE_CACHE_DIR = cache
    process.env.VOLUND_NATIVE_RELEASE_BASE_URL = 'https://release.invalid/v1.2.3'

    try {
      await expect(resolveBinary('search')).rejects.toThrow('Checksum mismatch')
    } finally {
      await rm(cache, { recursive: true, force: true })
    }
  })

  it('prefers a verified bundled asset for offline standalone execution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'volund standalone assets '))
    const triple = packageTriple(process.platform, process.arch)!
    const file = releaseAssetName('sandbox', triple)
    const body = Buffer.from('offline binary')
    await writeFile(join(root, file), body)
    await writeFile(
      join(root, 'manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        assets: [
          {
            kind: 'sandbox',
            target: triple,
            file,
            sha256: createHash('sha256').update(body).digest('hex'),
          },
        ],
      }),
    )
    process.env.VOLUND_STANDALONE_ASSET_DIR = root
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new Error('offline')
      }),
    )
    try {
      expect(await resolveBinaryDetailed('sandbox')).toMatchObject({
        source: 'bundled',
        target: triple,
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a tampered bundled asset without falling through to network', async () => {
    const root = await mkdtemp(join(tmpdir(), 'volund-native-'))
    const triple = packageTriple(process.platform, process.arch)!
    const file = releaseAssetName('fs', triple)
    await mkdir(root, { recursive: true })
    await writeFile(join(root, file), 'tampered')
    await writeFile(
      join(root, 'manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        assets: [{ kind: 'fs', target: triple, file, sha256: '0'.repeat(64) }],
      }),
    )
    await chmod(root, 0o555)
    process.env.VOLUND_STANDALONE_ASSET_DIR = root
    try {
      await expect(resolveBinary('fs')).rejects.toThrow('Checksum mismatch for bundled')
    } finally {
      await chmod(root, 0o755)
      await rm(root, { recursive: true, force: true })
    }
  })
})
