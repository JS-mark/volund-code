import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'

import {
  parseTemporaryRegistryCli,
  runTemporaryRegistryNpxE2E,
  VERDACCIO_VERSION,
} from './test-npx-temporary-registry.mjs'
import { NPM_PUBLISH_ORDER } from './verify-npm-publish-plan.mjs'

const root = new URL('../../', import.meta.url).pathname
const VERSION = '1.2.3'
const directories = []

async function tempDir() {
  const directory = await mkdtemp(join(tmpdir(), 'volund-npx-e2e-'))
  directories.push(directory)
  return directory
}

test.afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

function platformFields(target) {
  if (target.startsWith('darwin-'))
    return { os: ['darwin'], cpu: [target.endsWith('arm64') ? 'arm64' : 'x64'] }
  if (target === 'win32-x64-msvc') return { os: ['win32'], cpu: ['x64', 'arm64'] }
  return {
    os: ['linux'],
    cpu: [target.includes('arm64') ? 'arm64' : 'x64'],
    libc: [target.endsWith('-musl') ? 'musl' : 'glibc'],
  }
}

function fakeExecutable() {
  return `#!/usr/bin/env node
const args = process.argv.slice(2)
if (args.includes('--version')) process.stdout.write('${VERSION}\\n')
else if (args.includes('--help')) process.stdout.write('Usage: volund [command]\\n')
else if (args[0] === 'doctor' && args[1] === '--json') process.stdout.write('{"ok":true}\\n')
else process.stdout.write('volund fixture\\n')
`
}

async function pack(directory, tarballs) {
  const npmCli = resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')
  const result = spawnSync(
    process.execPath,
    [npmCli, 'pack', '.', '--json', '--ignore-scripts', '--pack-destination', tarballs],
    {
      cwd: directory,
      encoding: 'utf8',
      shell: false,
      env: {
        HOME: directory,
        PATH: dirname(process.execPath),
        LANG: 'C',
        LC_ALL: 'C',
        npm_config_ignore_scripts: 'true',
        npm_config_audit: 'false',
        npm_config_fund: 'false',
        npm_config_update_notifier: 'false',
      },
    },
  )
  assert.equal(result.status, 0, result.stderr)
  const [metadata] = JSON.parse(result.stdout)
  const body = await readFile(join(tarballs, metadata.filename))
  return {
    name: metadata.name,
    version: VERSION,
    tarball: `tarballs/${metadata.filename}`,
    integrity: `sha512-${createHash('sha512').update(body).digest('base64')}`,
  }
}

async function npmCandidateFixture() {
  const candidateDirectory = await tempDir()
  const packages = join(candidateDirectory, 'packages')
  const tarballs = join(candidateDirectory, 'tarballs')
  await mkdir(packages)
  await mkdir(tarballs)
  const descriptors = []
  for (const packageName of NPM_PUBLISH_ORDER.slice(0, 7)) {
    const target = packageName.slice('@volund/'.length)
    const directory = join(packages, `volund-${target}`)
    await mkdir(directory)
    const executable = target.startsWith('win32-') ? 'volund.exe' : 'volund'
    await writeFile(join(directory, executable), fakeExecutable(), { mode: 0o755 })
    await writeFile(
      join(directory, 'package.json'),
      `${JSON.stringify(
        {
          name: packageName,
          version: VERSION,
          description: `Volund temporary registry fixture (${target})`,
          license: 'Apache-2.0',
          files: [executable],
          ...platformFields(target),
        },
        null,
        2,
      )}\n`,
    )
    descriptors.push(await pack(directory, tarballs))
  }
  const optionalDependencies = Object.fromEntries(
    NPM_PUBLISH_ORDER.slice(0, 7).map((name) => [name, VERSION]),
  )
  for (const name of ['volund-cli', 'volund-code']) {
    const directory = join(packages, name)
    await mkdir(join(directory, 'bin'), { recursive: true })
    await cp(join(root, 'apps/cli/bin/volund.cjs'), join(directory, 'bin/volund.cjs'))
    await writeFile(
      join(directory, 'package.json'),
      `${JSON.stringify(
        {
          name,
          version: VERSION,
          description: 'Volund temporary registry fixture',
          license: 'Apache-2.0',
          bin: { volund: 'bin/volund.cjs' },
          files: ['bin'],
          engines: { node: '>=20.19.0' },
          optionalDependencies,
        },
        null,
        2,
      )}\n`,
    )
    descriptors.push(await pack(directory, tarballs))
  }
  const plan = {
    release: { version: VERSION },
    platformPackages: descriptors.slice(0, 7),
    canonicalMeta: descriptors[7],
    legacyMeta: descriptors[8],
  }
  await writeFile(join(candidateDirectory, 'publish-plan.json'), `${JSON.stringify(plan)}\n`)
  return { candidateDirectory, plan }
}

void test('publishes all nine packages to offline Verdaccio and runs real npx contracts', async () => {
  const fixture = await npmCandidateFixture()
  const result = await runTemporaryRegistryNpxE2E({
    candidateDirectory: fixture.candidateDirectory,
    trustedArchiveDirectory: '/fixture/archives',
    trustedSourceRoot: '/fixture/source',
    verifyCandidate: async () => fixture.plan,
  })
  assert.equal(result.packageCount, 9)
  assert.equal(result.version, VERSION)
  assert.match(result.versionOutput, new RegExp(VERSION.replaceAll('.', '\\.')))
  assert.match(result.helpOutput, /Usage: volund/)
  assert.equal(result.anonymousPublishRejected, true)
})

void test('temporary registry contract is pinned, offline, strict, and normally wired', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  assert.equal(manifest.devDependencies.verdaccio, VERDACCIO_VERSION)
  const source = await readFile(new URL('test-npx-temporary-registry.mjs', import.meta.url), 'utf8')
  assert.match(source, /uplinks: \{\}/)
  assert.match(source, /publish: \$authenticated/)
  assert.doesNotMatch(source, /publish: \$all/)
  assert.match(source, /anonymous publish was not rejected safely/)
  assert.match(source, /VERDACCIO_LOG_LIMIT/)
  assert.match(source, /AbortSignal\.timeout/)
  assert.match(source, /--omit=optional/)
  assert.match(source, /--yes[\s\S]*--registry[\s\S]*`volund-cli@\$\{version\}`/)
  const args = [
    '--candidate',
    'candidate',
    '--archives',
    'archives',
    '--source-root',
    '.',
    '--dist-tag',
    'test',
    '--layout',
    'packed-only',
  ]
  assert.deepEqual(parseTemporaryRegistryCli(args), {
    candidateDirectory: resolve('candidate'),
    trustedArchiveDirectory: resolve('archives'),
    trustedSourceRoot: resolve('.'),
    distTag: 'test',
    candidateLayout: 'packed-only',
    runDoctor: true,
  })
  assert.throws(() => parseTemporaryRegistryCli(args.slice(0, -2)), /missing required flag/)
  assert.throws(() => parseTemporaryRegistryCli([...args, '--token', 'secret']), /unknown flag/)
})
