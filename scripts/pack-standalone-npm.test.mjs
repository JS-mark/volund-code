import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { BUN_TARGETS, buildStandalone } from './build-standalone.mjs'
import { packStandaloneNpm } from './pack-standalone-npm.mjs'

const root = new URL('../', import.meta.url).pathname
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'))
const dirs = []
async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'volund-npm-pack-'))
  dirs.push(dir)
  return dir
}
test.afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function fakeStandalone(parent, triple) {
  const dir = join(parent, triple)
  const isWindows = triple.startsWith('win32-')
  const exe = join(dir, isWindows ? 'volund.exe' : 'volund')
  await mkdir(join(dir, 'native'), { recursive: true })
  await mkdir(join(dir, 'plugins'), { recursive: true })
  await writeFile(exe, '#!/bin/sh\necho fake-volund "$@"\n')
  await chmod(exe, 0o755)
  await writeFile(join(dir, 'native', 'manifest.json'), '{"schemaVersion":1,"assets":[]}\n')
  await writeFile(join(dir, 'checksums.sha256'), '0'.repeat(64) + '  volund\n')
  return dir
}

void test('packs meta shell + per-platform packages with npm platform fields', async () => {
  const fixture = await tempDir()
  const standalone = join(fixture, 'standalone')
  await fakeStandalone(standalone, 'darwin-arm64')
  await fakeStandalone(standalone, 'linux-x64-musl')
  await fakeStandalone(standalone, 'win32-x64-msvc')
  const out = join(fixture, 'staging')

  const result = await packStandaloneNpm({
    root,
    standaloneDirectory: standalone,
    outDirectory: out,
    version: '9.9.9-test',
  })
  assert.deepEqual(result.triples, ['darwin-arm64', 'linux-x64-musl', 'win32-x64-msvc'])
  assert.deepEqual(result.metaPackages, ['volund-cli', 'volund-code'])

  const darwin = await readJson(join(out, 'volund-darwin-arm64/package.json'))
  assert.equal(darwin.name, '@volund/darwin-arm64')
  assert.equal(darwin.version, '9.9.9-test')
  assert.deepEqual(darwin.os, ['darwin'])
  assert.deepEqual(darwin.cpu, ['arm64'])
  assert.equal(darwin.libc, undefined)
  assert.deepEqual(darwin.files, ['volund', 'native', 'plugins', 'checksums.sha256'])

  const musl = await readJson(join(out, 'volund-linux-x64-musl/package.json'))
  assert.deepEqual(musl.libc, ['musl'])

  // Windows arm64 由 x64 包经 Prism 仿真覆盖：cpu 必须同时声明 arm64，
  // 否则 npm 会在 win32/arm64 上跳过安装，壳解析不到包。
  const windows = await readJson(join(out, 'volund-win32-x64-msvc/package.json'))
  assert.deepEqual(windows.os, ['win32'])
  assert.deepEqual(windows.cpu, ['x64', 'arm64'])
  assert.deepEqual(windows.files, ['volund.exe', 'native', 'plugins', 'checksums.sha256'])

  const meta = await readJson(join(out, 'volund-cli/package.json'))
  assert.equal(meta.name, 'volund-cli')
  assert.deepEqual(meta.bin, { volund: 'bin/volund.cjs' })
  assert.deepEqual(meta.files, ['bin'])
  assert.equal(meta.dependencies, undefined)
  assert.deepEqual(meta.optionalDependencies, {
    '@volund/darwin-arm64': '9.9.9-test',
    '@volund/linux-x64-musl': '9.9.9-test',
    '@volund/win32-x64-msvc': '9.9.9-test',
  })

  const legacy = await readJson(join(out, 'volund-code/package.json'))
  assert.equal(legacy.name, 'volund-code')
  assert.match(legacy.description, /Compatibility package for volund-cli/)
  assert.deepEqual(legacy.bin, { volund: 'bin/volund.cjs' })
  assert.deepEqual(legacy.optionalDependencies, meta.optionalDependencies)
})

void test('thin shell resolves the platform package and forwards argv/exit code', async (t) => {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    t.skip('shell e2e fixture is darwin-arm64 only')
    return
  }
  const fixture = await tempDir()
  const standalone = join(fixture, 'standalone')
  await fakeStandalone(standalone, 'darwin-arm64')
  const out = join(fixture, 'staging')
  await packStandaloneNpm({
    root,
    standaloneDirectory: standalone,
    outDirectory: out,
    version: '9.9.9-test',
  })

  // 模拟 npm 安装后的布局：consumer/node_modules/{volund-cli, @volund/darwin-arm64}
  const consumer = join(fixture, 'consumer')
  await mkdir(join(consumer, 'node_modules', '@volund'), { recursive: true })
  spawnSync('cp', ['-R', join(out, 'volund-cli'), join(consumer, 'node_modules', 'volund-cli')])
  spawnSync('cp', [
    '-R',
    join(out, 'volund-darwin-arm64'),
    join(consumer, 'node_modules', '@volund', 'darwin-arm64'),
  ])

  const run = spawnSync(
    process.execPath,
    [join(consumer, 'node_modules', 'volund-cli', 'bin', 'volund.cjs'), '--version'],
    { encoding: 'utf8' },
  )
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /fake-volund --version/)
})

void test('win32-arm64-msvc is rejected with the Prism emulation explanation', async () => {
  await assert.rejects(
    () =>
      buildStandalone({
        root,
        target: 'win32-arm64-msvc',
        assetDirectory: '/nonexistent',
        outDirectory: '/nonexistent',
      }),
    /bun-windows-arm64 does not exist.*Prism emulation/s,
  )
  assert.equal(Object.keys(BUN_TARGETS).length, 7)
})
