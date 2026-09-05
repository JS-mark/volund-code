import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import {
  cp,
  chmod,
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
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'

import { STANDALONE_TARGETS } from './build-all-standalone.mjs'
import { generateReleaseManifest, serializeReleaseManifest } from './generate-release-manifest.mjs'
import {
  packStandaloneNpm,
  parseCliArguments,
  validatePackToolVersions,
  validateStandaloneNpmCandidate,
} from './pack-standalone-npm.mjs'
import { createCanonicalStandaloneArchive } from './standalone-archive.mjs'
import { NPM_PUBLISH_ORDER, verifyNpmPublishPlan } from './verify-npm-publish-plan.mjs'

const root = new URL('../../', import.meta.url).pathname
const COMMIT = '0123456789abcdef0123456789abcdef01234567'
const IDENTITY = { version: '1.2.3', tag: 'v1.2.3', commit: COMMIT, bunVersion: '1.3.6' }
const dirs = []

function sha256(body) {
  return createHash('sha256').update(body).digest('hex')
}

async function tempDir() {
  const directory = await mkdtemp(join(tmpdir(), 'volund-npm-pack-'))
  dirs.push(directory)
  return directory
}

test.afterEach(async () => {
  for (const directory of dirs.splice(0)) await rm(directory, { recursive: true, force: true })
})

function fakeExecutable(target) {
  if (target.startsWith('win32-')) return Buffer.from(`fake windows executable:${target}`)
  return Buffer.from(`#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
const input = fs.readFileSync(0, 'utf8')
process.stdout.write(JSON.stringify({ args, input }) + '\\n')
process.stderr.write('fake-stderr\\n')
const trapPid = args.find((arg) => arg.startsWith('--trap-pid='))
const trapSignal = args.find((arg) => arg.startsWith('--trap-signal='))
if (trapPid && trapSignal) {
  for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(name, () => {
      fs.writeFileSync(trapSignal.slice(14), name)
      process.exit(0)
    })
  }
  fs.writeFileSync(trapPid.slice(11), String(process.pid))
  setInterval(() => {}, 1000)
}
const exit = args.find((arg) => arg.startsWith('--exit='))
if (exit) process.exit(Number(exit.slice(7)))
const signal = args.find((arg) => arg.startsWith('--signal='))
if (signal) process.kill(process.pid, signal.slice(9))
`)
}

async function writeStandaloneSource(directory, target) {
  const executableName = target.startsWith('win32-') ? 'volund.exe' : 'volund'
  const executable = fakeExecutable(target)
  await mkdir(join(directory, 'native'), { recursive: true })
  await mkdir(join(directory, 'plugins', 'builtin'), { recursive: true })
  await writeFile(join(directory, executableName), executable)
  const assets = []
  for (const kind of ['sandbox', 'search', 'fs']) {
    const file = `volund-${kind}-${target}${target.startsWith('win32-') ? '.exe' : ''}`
    const body = Buffer.from(`${kind}:${target}`)
    await writeFile(join(directory, 'native', file), body)
    assets.push({ kind, target, file, sha256: sha256(body) })
  }
  await writeFile(
    join(directory, 'native', 'manifest.json'),
    `${JSON.stringify({ schemaVersion: 1, assets }, null, 2)}\n`,
  )
  await writeFile(join(directory, 'plugins', 'builtin', 'index.mjs'), 'export default {}\n')
  await writeFile(join(directory, 'checksums.sha256'), `${sha256(executable)}  ${executableName}\n`)
  await writeFile(join(directory, 'LICENSE'), 'archive license\n')
  await writeFile(join(directory, 'NOTICE'), 'archive notice\n')
  await writeFile(
    join(directory, 'sbom.cdx.json'),
    '{"bomFormat":"CycloneDX","specVersion":"1.6","components":[{"name":"fixture"}]}\n',
  )
}

async function createCandidate(parent, identity = IDENTITY) {
  const archives = join(parent, `archives-${Math.random().toString(16).slice(2)}`)
  await mkdir(archives)
  const checksumLines = []
  for (const target of STANDALONE_TARGETS) {
    const source = join(parent, `source-${target}-${Math.random().toString(16).slice(2)}`)
    await writeStandaloneSource(source, target)
    const archiveName = `volund-standalone-${target}.tar.gz`
    const body = await createCanonicalStandaloneArchive({
      sourceDirectory: source,
      archivePath: join(archives, archiveName),
      target,
    })
    checksumLines.push(`${sha256(body)}  ${archiveName}`)
  }
  await writeFile(join(archives, 'standalone-checksums.sha256'), `${checksumLines.join('\n')}\n`)
  const manifest = await generateReleaseManifest({ archiveDirectory: archives, ...identity })
  await writeFile(join(archives, 'release-manifest.json'), serializeReleaseManifest(manifest))
  return archives
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function snapshotFiles(directory) {
  const snapshot = []
  for (const name of (await readdir(directory)).toSorted()) {
    const body = await readFile(join(directory, name))
    snapshot.push({ name, size: body.byteLength, sha256: sha256(body) })
  }
  return snapshot
}

async function createTrustedSourceRoot(parent) {
  const sourceRoot = join(parent, 'trusted-source')
  await mkdir(join(sourceRoot, 'apps/cli/bin'), { recursive: true })
  await cp(join(root, 'apps/cli/bin/volund.cjs'), join(sourceRoot, 'apps/cli/bin/volund.cjs'))
  await cp(join(root, 'README.md'), join(sourceRoot, 'README.md'))
  await cp(join(root, 'LICENSE'), join(sourceRoot, 'LICENSE'))
  return sourceRoot
}

async function repackDescriptor(output, descriptor) {
  const destination = join(output, '.test-repack')
  await rm(destination, { recursive: true, force: true })
  await mkdir(destination)
  const npmCli = resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')
  const result = spawnSync(
    process.execPath,
    [npmCli, 'pack', '.', '--json', '--ignore-scripts', '--pack-destination', destination],
    {
      cwd: join(output, descriptor.directory),
      encoding: 'utf8',
      shell: false,
      env: {
        HOME: destination,
        PATH: dirname(process.execPath),
        LANG: 'C',
        LC_ALL: 'C',
        npm_config_ignore_scripts: 'true',
        npm_config_audit: 'false',
        npm_config_fund: 'false',
        npm_config_update_notifier: 'false',
        npm_config_provenance: 'false',
      },
    },
  )
  assert.equal(result.status, 0, result.stderr)
  const packed = JSON.parse(result.stdout)
  assert.equal(packed.length, 1)
  const body = await readFile(join(destination, packed[0].filename))
  await writeFile(join(output, descriptor.tarball), body)
  descriptor.sha256 = sha256(body)
  descriptor.integrity = `sha512-${createHash('sha512').update(body).digest('base64')}`
  descriptor.size = body.byteLength
  await rm(destination, { recursive: true, force: true })
}

function verifyPlan(outputDirectory, archiveDirectory, expectedIdentity) {
  return verifyNpmPublishPlan({
    outputDirectory,
    trustedArchiveDirectory: archiveDirectory,
    trustedSourceRoot: root,
    expectedIdentity,
  })
}

async function waitForText(path, timeoutMilliseconds = 5_000) {
  const deadline = Date.now() + timeoutMilliseconds
  while (Date.now() < deadline) {
    try {
      return await readFile(path, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 20))
  }
  throw new Error(`timed out waiting for ${path}`)
}

function waitForExit(child, timeoutMilliseconds = 5_000) {
  return new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      rejectExit(new Error(`timed out waiting for wrapper PID ${child.pid}`))
    }, timeoutMilliseconds)
    child.once('error', (error) => {
      clearTimeout(timer)
      rejectExit(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolveExit({ code, signal })
    })
  })
}

function hostTarget() {
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : null
  if (!arch) return null
  if (process.platform === 'darwin') return `darwin-${arch}`
  if (process.platform === 'win32') return 'win32-x64-msvc'
  if (process.platform === 'linux') {
    const report = process.report?.getReport?.()
    const header = report && typeof report.header === 'object' ? report.header : null
    return `linux-${arch}-${header && 'glibcVersionRuntime' in header ? 'gnu' : 'musl'}`
  }
  return null
}

void test('packs exactly nine validated packages from final archives and hardens the wrapper', async (t) => {
  const fixture = await tempDir()
  const archives = await createCandidate(fixture)
  const output = join(fixture, 'candidate')
  const result = await packStandaloneNpm({ root, archiveDirectory: archives, outDirectory: output })
  assert.deepEqual(result.plan.publishOrder, NPM_PUBLISH_ORDER)
  assert.equal((await readdir(join(output, 'tarballs'))).length, 9)
  await verifyPlan(output, archives, IDENTITY)

  const packedOnly = join(fixture, 'packed-only')
  await mkdir(packedOnly)
  await cp(join(output, '.volund-npm-output.json'), join(packedOnly, '.volund-npm-output.json'))
  await cp(join(output, 'publish-plan.json'), join(packedOnly, 'publish-plan.json'))
  await cp(join(output, 'tarballs'), join(packedOnly, 'tarballs'), { recursive: true })
  await chmod(join(packedOnly, '.volund-npm-output.json'), 0o644)
  await chmod(join(packedOnly, 'publish-plan.json'), 0o644)
  for (const filename of await readdir(join(packedOnly, 'tarballs')))
    await chmod(join(packedOnly, 'tarballs', filename), 0o644)
  await verifyNpmPublishPlan({
    outputDirectory: packedOnly,
    trustedArchiveDirectory: archives,
    trustedSourceRoot: root,
    expectedIdentity: IDENTITY,
    candidateLayout: 'packed-only',
  })
  await assert.rejects(
    () =>
      verifyNpmPublishPlan({
        outputDirectory: packedOnly,
        trustedArchiveDirectory: archives,
        trustedSourceRoot: root,
        expectedIdentity: IDENTITY,
        candidateLayout: 'full',
      }),
    /npm candidate output contents mismatch/,
  )
  await mkdir(join(packedOnly, 'packages'))
  await assert.rejects(
    () =>
      verifyNpmPublishPlan({
        outputDirectory: packedOnly,
        trustedArchiveDirectory: archives,
        trustedSourceRoot: root,
        expectedIdentity: IDENTITY,
        candidateLayout: 'packed-only',
      }),
    /npm candidate output contents mismatch/,
  )
  await rm(join(packedOnly, 'packages'), { recursive: true })

  const darwin = await readJson(join(output, 'packages/volund-darwin-arm64/package.json'))
  assert.equal(darwin.name, '@volund/darwin-arm64')
  assert.equal(darwin.version, IDENTITY.version)
  assert.deepEqual(darwin.files, [
    'volund',
    'native',
    'plugins',
    'checksums.sha256',
    'LICENSE',
    'NOTICE',
    'sbom.cdx.json',
  ])
  assert.deepEqual(darwin.publishConfig, { access: 'public', provenance: true })
  const windows = await readJson(join(output, 'packages/volund-win32-x64-msvc/package.json'))
  assert.deepEqual(windows.cpu, ['x64', 'arm64'])

  const canonical = await readJson(join(output, 'packages/volund-cli/package.json'))
  const legacy = await readJson(join(output, 'packages/volund-code/package.json'))
  assert.deepEqual(canonical.bin, { volund: 'bin/volund.cjs' })
  assert.deepEqual(canonical.engines, { node: '>=20.19.0' })
  assert.deepEqual(legacy.optionalDependencies, canonical.optionalDependencies)
  assert.deepEqual(Object.keys(canonical.optionalDependencies), NPM_PUBLISH_ORDER.slice(0, 7))

  const target = hostTarget()
  if (!target || process.platform === 'win32') {
    t.diagnostic('wrapper process contract is exercised on POSIX supported hosts only')
    return
  }
  const consumer = join(fixture, 'consumer/node_modules')
  await mkdir(join(consumer, '@volund'), { recursive: true })
  await cp(join(output, 'packages/volund-cli'), join(consumer, '@volund/cli'), { recursive: true })
  await cp(join(output, `packages/volund-${target}`), join(consumer, '@volund', target), {
    recursive: true,
  })
  const wrapper = join(consumer, '@volund/cli/bin/volund.cjs')
  const args = ['space value', '雪', '--', '--literal']
  const run = spawnSync(process.execPath, [wrapper, ...args], {
    input: 'stdin payload 雪',
    encoding: 'utf8',
  })
  assert.equal(run.status, 0, run.stderr)
  assert.deepEqual(JSON.parse(run.stdout), { args, input: 'stdin payload 雪' })
  assert.equal(run.stderr, 'fake-stderr\n')
  const exit = spawnSync(process.execPath, [wrapper, '--exit=7'], { encoding: 'utf8' })
  assert.equal(exit.status, 7)
  const signal = spawnSync(process.execPath, [wrapper, '--signal=SIGTERM'], { encoding: 'utf8' })
  assert.equal(signal.signal, 'SIGTERM')

  const missing = join(fixture, 'missing/node_modules/@volund/cli')
  await mkdir(join(fixture, 'missing/node_modules'), { recursive: true })
  await cp(join(output, 'packages/volund-cli'), missing, { recursive: true })
  const missingRun = spawnSync(process.execPath, [join(missing, 'bin/volund.cjs')], {
    encoding: 'utf8',
  })
  assert.equal(missingRun.status, 1)
  assert.match(missingRun.stderr, /--omit=optional/)

  for (const forwardedSignal of ['SIGTERM', 'SIGINT']) {
    const pidPath = join(fixture, `${forwardedSignal}.pid`)
    const signalPath = join(fixture, `${forwardedSignal}.signal`)
    const wrapperProcess = spawn(
      process.execPath,
      [wrapper, `--trap-pid=${pidPath}`, `--trap-signal=${signalPath}`],
      { stdio: ['ignore', 'ignore', 'ignore'] },
    )
    const exitPromise = waitForExit(wrapperProcess)
    const nativePid = Number(await waitForText(pidPath))
    assert.notEqual(nativePid, wrapperProcess.pid)
    process.kill(wrapperProcess.pid, forwardedSignal)
    assert.deepEqual(await exitPromise, { code: null, signal: forwardedSignal })
    assert.equal(await waitForText(signalPath), forwardedSignal)
    assert.throws(() => process.kill(nativePid, 0), /ESRCH/)
  }

  const planPath = join(output, 'publish-plan.json')
  const originalPlan = await readFile(planPath)
  const badOrder = JSON.parse(originalPlan)
  badOrder.publishOrder = badOrder.publishOrder.toReversed()
  await writeFile(planPath, `${JSON.stringify(badOrder, null, 2)}\n`)
  await assert.rejects(() => verifyPlan(output, archives), /publishOrder/)
  const badDigest = JSON.parse(originalPlan)
  badDigest.platformPackages[0].sha256 = '0'.repeat(64)
  await writeFile(planPath, `${JSON.stringify(badDigest, null, 2)}\n`)
  await assert.rejects(() => verifyPlan(output, archives), /tarball bytes/)
  await writeFile(planPath, originalPlan)
})

void test('npm pack bytes and publish plan semantics are deterministic for identical archives', async () => {
  const fixture = await tempDir()
  const archives = await createCandidate(fixture)
  const originalUmask = process.umask()
  let first
  let second
  try {
    process.umask(0o077)
    first = await packStandaloneNpm({
      root,
      archiveDirectory: archives,
      outDirectory: join(fixture, 'first'),
    })
    process.umask(0o022)
    second = await packStandaloneNpm({
      root,
      archiveDirectory: archives,
      outDirectory: join(fixture, 'second'),
    })
  } finally {
    process.umask(originalUmask)
  }
  assert.deepEqual(first.plan, second.plan)
  for (const descriptor of [
    ...first.plan.platformPackages,
    first.plan.canonicalMeta,
    first.plan.legacyMeta,
  ])
    assert.deepEqual(
      await readFile(join(fixture, 'first', descriptor.tarball)),
      await readFile(join(fixture, 'second', descriptor.tarball)),
    )
})

void test('publish-plan verification is bound to trusted release and repository source bytes', async () => {
  const fixture = await tempDir()
  const archives = await createCandidate(fixture)
  const sourceRoot = await createTrustedSourceRoot(fixture)
  const output = join(fixture, 'candidate')
  await packStandaloneNpm({ root: sourceRoot, archiveDirectory: archives, outDirectory: output })
  const wrapperPath = join(sourceRoot, 'apps/cli/bin/volund.cjs')
  const wrapper = await readFile(wrapperPath)
  await writeFile(wrapperPath, Buffer.concat([wrapper, Buffer.from('\n// tampered\n')]))
  await assert.rejects(
    () =>
      verifyNpmPublishPlan({
        outputDirectory: output,
        trustedArchiveDirectory: archives,
        trustedSourceRoot: sourceRoot,
      }),
    /trusted wrapper does not match publish plan source evidence/,
  )
  await writeFile(wrapperPath, wrapper)

  const archivePath = join(archives, 'volund-standalone-darwin-arm64.tar.gz')
  const archive = await readFile(archivePath)
  await writeFile(archivePath, Buffer.concat([archive, Buffer.from('tampered')]))
  await assert.rejects(
    () =>
      verifyNpmPublishPlan({
        outputDirectory: output,
        trustedArchiveDirectory: archives,
        trustedSourceRoot: sourceRoot,
      }),
    /trusted archive .* does not match publish plan source evidence/,
  )
})

void test('verifier rejects lifecycle manifest keys and wrapper bytes not present in trusted sources', async () => {
  const fixture = await tempDir()
  const archives = await createCandidate(fixture)
  const output = join(fixture, 'candidate')
  await packStandaloneNpm({ root, archiveDirectory: archives, outDirectory: output })
  const planPath = join(output, 'publish-plan.json')
  const originalPlanBody = await readFile(planPath)
  const originalPlan = JSON.parse(originalPlanBody)
  const markerPath = join(output, '.volund-npm-output.json')
  const markerBody = await readFile(markerPath)
  const marker = JSON.parse(markerBody)
  marker.extra = true
  await writeFile(markerPath, `${JSON.stringify(marker)}\n`)
  await assert.rejects(() => verifyPlan(output, archives), /npm marker keys must be exactly/)
  delete marker.extra
  await writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`)
  await assert.rejects(() => verifyPlan(output, archives), /ownership marker is not canonical/)
  await writeFile(markerPath, markerBody)

  const platform = originalPlan.platformPackages[0]
  const platformManifestPath = join(output, platform.directory, 'package.json')
  const platformManifestBody = await readFile(platformManifestPath)
  const platformTarballPath = join(output, platform.tarball)
  const platformTarballBody = await readFile(platformTarballPath)
  const platformManifest = JSON.parse(platformManifestBody)
  platformManifest.scripts = { prepublishOnly: 'exit 42' }
  platformManifest.dependencies = { foreign: '1.0.0' }
  await writeFile(platformManifestPath, `${JSON.stringify(platformManifest, null, 2)}\n`)
  await repackDescriptor(output, platform)
  await writeFile(planPath, `${JSON.stringify(originalPlan, null, 2)}\n`)
  await assert.rejects(() => verifyPlan(output, archives), /keys must be exactly/)

  await writeFile(platformManifestPath, platformManifestBody)
  await writeFile(platformTarballPath, platformTarballBody)
  let cleanPlan = JSON.parse(originalPlanBody)
  const cleanPlatform = cleanPlan.platformPackages[0]
  const badDescription = JSON.parse(platformManifestBody)
  badDescription.description = 'untrusted description'
  await writeFile(platformManifestPath, `${JSON.stringify(badDescription, null, 2)}\n`)
  await repackDescriptor(output, cleanPlatform)
  await writeFile(planPath, `${JSON.stringify(cleanPlan, null, 2)}\n`)
  await assert.rejects(() => verifyPlan(output, archives), /invalid description/)

  await writeFile(platformManifestPath, platformManifestBody)
  await writeFile(platformTarballPath, platformTarballBody)
  cleanPlan = JSON.parse(originalPlanBody)
  const meta = cleanPlan.canonicalMeta
  const wrapperPath = join(output, meta.directory, 'bin/volund.cjs')
  await writeFile(wrapperPath, '#!/usr/bin/env node\nprocess.exit(0)\n')
  await repackDescriptor(output, meta)
  await writeFile(planPath, `${JSON.stringify(cleanPlan, null, 2)}\n`)
  await assert.rejects(() => verifyPlan(output, archives), /wrapper does not match trusted source/)
})

void test('npm pack ignores inherited HOME and npm user configuration', async () => {
  const fixture = await tempDir()
  const archives = await createCandidate(fixture)
  const hostileHome = join(fixture, 'hostile-home')
  const hostileCache = join(fixture, 'hostile-cache')
  const hostileConfig = join(hostileHome, '.npmrc')
  await mkdir(hostileHome)
  await writeFile(
    hostileConfig,
    `cache=${hostileCache}\nregistry=https://127.0.0.1:1/\nignore-scripts=false\n`,
  )
  const previousHome = process.env.HOME
  const previousUserConfig = process.env.npm_config_userconfig
  try {
    process.env.HOME = hostileHome
    process.env.npm_config_userconfig = hostileConfig
    await packStandaloneNpm({
      root,
      archiveDirectory: archives,
      outDirectory: join(fixture, 'candidate'),
    })
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    if (previousUserConfig === undefined) delete process.env.npm_config_userconfig
    else process.env.npm_config_userconfig = previousUserConfig
  }
  await assert.rejects(() => readFile(join(hostileCache, '_logs')), /ENOENT/)
})

void test('candidate validation fails closed for partial, extra, duplicate, bad identity, digest, and archive bytes', async (t) => {
  const mutations = {
    partial: async (archives) => unlink(join(archives, 'volund-standalone-darwin-arm64.tar.gz')),
    extra: async (archives) => writeFile(join(archives, 'foreign.txt'), 'foreign'),
    symlink: async (archives) => {
      const archive = join(archives, 'volund-standalone-darwin-arm64.tar.gz')
      await unlink(archive)
      await symlink('volund-standalone-darwin-x64.tar.gz', archive)
    },
    malformed: async (archives) =>
      writeFile(join(archives, 'release-manifest.json'), '{not json}\n'),
    duplicate: async (archives) => {
      const manifest = await readJson(join(archives, 'release-manifest.json'))
      manifest.artifacts[1] = manifest.artifacts[0]
      await writeFile(
        join(archives, 'release-manifest.json'),
        `${JSON.stringify(manifest, null, 2)}\n`,
      )
    },
    'bad version': async (archives) => {
      const manifest = await readJson(join(archives, 'release-manifest.json'))
      manifest.version = '1.2.3-rc.1'
      manifest.tag = 'v1.2.3-rc.1'
      await writeFile(
        join(archives, 'release-manifest.json'),
        `${JSON.stringify(manifest, null, 2)}\n`,
      )
    },
    'bad digest': async (archives) => {
      const manifest = await readJson(join(archives, 'release-manifest.json'))
      manifest.artifacts[0].sha256 = '0'.repeat(64)
      await writeFile(
        join(archives, 'release-manifest.json'),
        `${JSON.stringify(manifest, null, 2)}\n`,
      )
    },
    'bad archive': async (archives) => {
      const manifest = await readJson(join(archives, 'release-manifest.json'))
      const artifact = manifest.artifacts[0]
      const body = Buffer.from('not a standalone archive')
      artifact.sha256 = sha256(body)
      artifact.size = body.length
      await writeFile(join(archives, artifact.archiveName), body)
      const lines = manifest.artifacts.map((item) => `${item.sha256}  ${item.archiveName}`)
      await writeFile(join(archives, 'standalone-checksums.sha256'), `${lines.join('\n')}\n`)
      await writeFile(
        join(archives, 'release-manifest.json'),
        `${JSON.stringify(manifest, null, 2)}\n`,
      )
    },
  }
  for (const [name, mutate] of Object.entries(mutations))
    await t.test(name, async () => {
      const fixture = await tempDir()
      const archives = await createCandidate(fixture)
      await mutate(archives)
      await assert.rejects(() => validateStandaloneNpmCandidate(archives))
    })

  await t.test('aggregate compressed limit', async () => {
    const fixture = await tempDir()
    const archives = await createCandidate(fixture)
    await assert.rejects(
      () =>
        validateStandaloneNpmCandidate(archives, {
          limits: { aggregateCompressedBytes: 1 },
        }),
      /aggregate compressed size exceeds packaging limit/,
    )
  })

  await t.test('aggregate expanded limit', async () => {
    const fixture = await tempDir()
    const archives = await createCandidate(fixture)
    await assert.rejects(
      () =>
        validateStandaloneNpmCandidate(archives, {
          limits: { aggregateUncompressedBytes: 1 },
        }),
      /aggregate uncompressed size exceeds packaging limit/,
    )
  })
})

void test('output fences preserve unowned and stale candidates and allow exact owned replacement', async () => {
  const fixture = await tempDir()
  const archives = await createCandidate(fixture)
  const unowned = join(fixture, 'unowned')
  await mkdir(unowned)
  await writeFile(join(unowned, 'sentinel'), 'preserve')
  await assert.rejects(
    () => packStandaloneNpm({ root, archiveDirectory: archives, outDirectory: unowned }),
    /unowned or non-exact/,
  )
  assert.equal(await readFile(join(unowned, 'sentinel'), 'utf8'), 'preserve')
  await assert.rejects(
    () => packStandaloneNpm({ root, archiveDirectory: archives, outDirectory: archives }),
    /protected source root/,
  )
  const archiveSnapshot = await snapshotFiles(archives)
  await assert.rejects(
    () =>
      packStandaloneNpm({
        root,
        archiveDirectory: archives,
        outDirectory: join(archives, 'child'),
      }),
    /protected source root/,
  )
  assert.deepEqual(await snapshotFiles(archives), archiveSnapshot)

  const containingOutput = join(fixture, 'contains-candidate')
  await mkdir(containingOutput)
  const nestedArchives = await createCandidate(containingOutput)
  await writeFile(join(containingOutput, 'sentinel'), 'preserve ancestor')
  await assert.rejects(
    () =>
      packStandaloneNpm({
        root,
        archiveDirectory: nestedArchives,
        outDirectory: containingOutput,
      }),
    /protected source root/,
  )
  assert.equal(await readFile(join(containingOutput, 'sentinel'), 'utf8'), 'preserve ancestor')
  const containingAlias = join(fixture, 'contains-candidate-alias')
  await symlink(containingOutput, containingAlias)
  await assert.rejects(
    () =>
      packStandaloneNpm({
        root,
        archiveDirectory: nestedArchives,
        outDirectory: containingAlias,
      }),
    /protected source root/,
  )
  assert.equal(await readFile(join(containingOutput, 'sentinel'), 'utf8'), 'preserve ancestor')

  const archiveAlias = join(fixture, 'archives-alias')
  await symlink(archives, archiveAlias)
  await assert.rejects(
    () =>
      packStandaloneNpm({
        root,
        archiveDirectory: archives,
        outDirectory: join(archiveAlias, 'symlink-child'),
      }),
    /protected source root/,
  )
  assert.deepEqual(await snapshotFiles(archives), archiveSnapshot)

  await assert.rejects(
    () => packStandaloneNpm({ root, archiveDirectory: archives, outDirectory: '.' }),
    /protected source root/,
  )

  const owned = join(fixture, 'owned')
  const first = await packStandaloneNpm({ root, archiveDirectory: archives, outDirectory: owned })
  const firstPlan = await readFile(join(owned, 'publish-plan.json'))
  await packStandaloneNpm({ root, archiveDirectory: archives, outDirectory: owned })
  assert.deepEqual(await readFile(join(owned, 'publish-plan.json')), firstPlan)
  const foreign = join(owned, 'packages/volund-cli/sentinel')
  await writeFile(foreign, 'unknown')
  await assert.rejects(
    () => packStandaloneNpm({ root, archiveDirectory: archives, outDirectory: owned }),
    /unowned or non-exact/,
  )
  assert.equal(await readFile(foreign, 'utf8'), 'unknown')
  await unlink(foreign)
  const tarball = join(owned, first.plan.platformPackages[0].tarball)
  await writeFile(tarball, 'stale')
  await assert.rejects(
    () => packStandaloneNpm({ root, archiveDirectory: archives, outDirectory: owned }),
    /unowned or non-exact/,
  )
  assert.equal(await readFile(tarball, 'utf8'), 'stale')
})

void test('failed npm pack leaves an existing exact candidate untouched', async () => {
  const fixture = await tempDir()
  const archives = await createCandidate(fixture)
  const output = join(fixture, 'candidate')
  await packStandaloneNpm({ root, archiveDirectory: archives, outDirectory: output })
  const before = await readFile(join(output, 'publish-plan.json'))
  let calls = 0
  const failingSpawn = (...args) => {
    calls += 1
    if (calls === 2) return { status: 42, stdout: '', stderr: 'injected npm pack failure' }
    return spawnSync(...args)
  }
  await assert.rejects(
    () =>
      packStandaloneNpm({
        root,
        archiveDirectory: archives,
        outDirectory: output,
        spawn: failingSpawn,
      }),
    /injected npm pack failure/,
  )
  assert.deepEqual(await readFile(join(output, 'publish-plan.json')), before)
  await verifyPlan(output, archives, IDENTITY)
})

void test('promotion revalidates an existing output changed during packing and preserves it', async () => {
  const fixture = await tempDir()
  const archives = await createCandidate(fixture)
  const output = join(fixture, 'candidate')
  await packStandaloneNpm({ root, archiveDirectory: archives, outDirectory: output })
  let calls = 0
  const mutatingSpawn = (...args) => {
    calls += 1
    const result = spawnSync(...args)
    if (calls === 9) writeFileSync(join(output, 'sentinel'), 'concurrent owner data')
    return result
  }
  await assert.rejects(
    () =>
      packStandaloneNpm({
        root,
        archiveDirectory: archives,
        outDirectory: output,
        spawn: mutatingSpawn,
      }),
    /changed before promotion/,
  )
  assert.equal(await readFile(join(output, 'sentinel'), 'utf8'), 'concurrent owner data')
})

void test('CLI requires exactly --archives and --output without a partial or build escape hatch', () => {
  assert.deepEqual(parseCliArguments(['--archives', 'a', '--output', 'b']), {
    archiveDirectory: resolve('a'),
    outDirectory: resolve('b'),
  })
  assert.throws(() => parseCliArguments(['--archives', 'a']), /missing required flag '--output'/)
  assert.throws(
    () => parseCliArguments(['--archives', 'a', '--archives', 'b', '--output', 'c']),
    /duplicate flag/,
  )
  assert.throws(() => parseCliArguments(['--standalone', 'a', '--output', 'b']), /unknown flag/)
  assert.throws(() => parseCliArguments(['--archives', '--output', 'b']), /requires a value/)
  assert.deepEqual(validatePackToolVersions({ nodeVersion: 'v22.14.0', npmVersion: '10.9.2\n' }), {
    nodeVersion: '22.14.0',
    npmVersion: '10.9.2',
  })
  assert.throws(
    () => validatePackToolVersions({ nodeVersion: '22.15.0', npmVersion: '10.9.2' }),
    /requires Node 22\.14\.0 and npm 10\.9\.2/,
  )
})
