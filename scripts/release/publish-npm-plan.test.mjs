import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

import {
  executeNpmPublishPlan,
  NPM_OIDC_ENVIRONMENT_KEYS,
  parsePublishNpmPlanCli,
  validateRegistryToolVersions,
  validateRegistryUrl,
} from './publish-npm-plan.mjs'
import { NPM_PUBLISH_ORDER } from './verify-npm-publish-plan.mjs'

const directories = []
const VERSION = '1.2.3'

async function tempDir() {
  const directory = await mkdtemp(join(tmpdir(), 'volund-publish-plan-'))
  directories.push(directory)
  return directory
}

test.afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

async function planFixture() {
  const candidateDirectory = await tempDir()
  const tarballsDirectory = join(candidateDirectory, 'tarballs')
  await mkdir(tarballsDirectory)
  const descriptors = []
  for (const [index, name] of NPM_PUBLISH_ORDER.entries()) {
    const filename = `${name.replace('@volund/', '').replaceAll('/', '-')}-${VERSION}.tgz`
    const body = Buffer.from(`npm tarball ${index}:${name}`)
    await writeFile(join(tarballsDirectory, filename), body)
    descriptors.push({
      name,
      version: VERSION,
      tarball: `tarballs/${filename}`,
      integrity: `sha512-${createHash('sha512').update(body).digest('base64')}`,
    })
  }
  return {
    candidateDirectory,
    descriptors,
    plan: {
      platformPackages: descriptors.slice(0, 7),
      canonicalMeta: descriptors[7],
      legacyMeta: descriptors[8],
    },
  }
}

function successfulVersionView(descriptor, body) {
  return {
    status: 0,
    stdout: JSON.stringify({
      'dist.integrity': descriptor.integrity,
      'dist.shasum': createHash('sha1').update(body).digest('hex'),
    }),
    stderr: '',
  }
}

function mockRegistry(
  fixture,
  initial = {},
  { conflicts = new Set(), conflictDifferent = new Set() } = {},
) {
  const descriptorsByName = new Map(fixture.descriptors.map((item) => [item.name, item]))
  const remote = new Map(Object.entries(initial))
  const mutations = []
  const runner = async (args) => {
    if (args[0] === 'view') {
      if (args[2] === 'dist-tags') {
        const state = remote.get(args[1])
        if (!state) return { status: 1, stdout: '', stderr: 'npm error code E404' }
        return { status: 0, stdout: JSON.stringify(state.distTags ?? {}), stderr: '' }
      }
      const spec = args[1]
      const name = spec.slice(0, spec.lastIndexOf('@'))
      const state = remote.get(name)
      if (!state?.versionPresent) return { status: 1, stdout: '', stderr: 'npm error code E404' }
      const descriptor = descriptorsByName.get(name)
      const body = await readFile(join(fixture.candidateDirectory, descriptor.tarball))
      return successfulVersionView(
        { ...descriptor, integrity: state.integrity ?? descriptor.integrity },
        state.body ?? body,
      )
    }
    if (args[0] === 'publish') {
      const descriptor = fixture.descriptors.find(
        (item) => resolve(fixture.candidateDirectory, item.tarball) === args[1],
      )
      mutations.push(['publish', descriptor.name])
      const body = await readFile(join(fixture.candidateDirectory, descriptor.tarball))
      const publishesDifferentBytes = conflictDifferent.has(descriptor.name)
      remote.set(descriptor.name, {
        versionPresent: true,
        body: publishesDifferentBytes ? Buffer.from('different registry bytes') : body,
        integrity: descriptor.integrity,
        distTags: { [args[args.indexOf('--tag') + 1]]: VERSION },
      })
      if (conflicts.delete(descriptor.name) || conflictDifferent.delete(descriptor.name))
        return { status: 1, stdout: '', stderr: 'npm error code E409 409 Conflict' }
      return { status: 0, stdout: '+ package', stderr: '' }
    }
    throw new Error(`unexpected npm command ${args.join(' ')}`)
  }
  return { remote, mutations, runner }
}

function request(fixture, registry, overrides = {}) {
  return {
    candidateDirectory: fixture.candidateDirectory,
    trustedArchiveDirectory: '/trusted/archives',
    trustedSourceRoot: '/trusted/source',
    registry,
    distTag: 'next',
    mode: 'publish',
    candidateLayout: 'full',
    npmCli: '/fixture/npm-cli.js',
    probeRegistry: async () => {},
    verifyCandidate: async () => fixture.plan,
    ...overrides,
  }
}

void test('preflights all nine packages before the first ordered mutation', async () => {
  const fixture = await planFixture()
  const registry = mockRegistry(fixture)
  const result = await executeNpmPublishPlan({
    ...request(fixture, 'http://127.0.0.1:4873'),
    runNpm: registry.runner,
  })
  assert.deepEqual(
    registry.mutations,
    NPM_PUBLISH_ORDER.map((name) => ['publish', name]),
  )
  const firstMutation = result.commands.findIndex((command) => command[0] !== 'view')
  assert.equal(firstMutation, 20)
  for (const command of result.commands.filter((item) => item[0] === 'publish')) {
    const index = result.commands.indexOf(command)
    assert.equal(result.commands[index - 2][0], 'view')
    assert.match(result.commands[index - 2][1], /@1\.2\.3$/)
    assert.deepEqual(result.commands[index - 1].slice(0, 3), [
      'view',
      result.commands[index - 2][1].replace(/@1\.2\.3$/, ''),
      'dist-tags',
    ])
  }
  assert.deepEqual(
    result.commands.filter((command) => command[0] === 'publish').map((command) => command[1]),
    fixture.descriptors.map((item) => resolve(fixture.candidateDirectory, item.tarball)),
  )
  assert.equal(result.states.length, 9)
  assert.ok(result.states.every((state) => state.distTags.next === VERSION))
})

void test('preflight mode is read-only and validates present package bytes', async () => {
  const fixture = await planFixture()
  const initial = Object.fromEntries(
    fixture.descriptors.map((descriptor) => [
      descriptor.name,
      { versionPresent: true, distTags: { next: VERSION } },
    ]),
  )
  const registry = mockRegistry(fixture, initial)
  const result = await executeNpmPublishPlan({
    ...request(fixture, 'https://registry.npmjs.org', { mode: 'preflight' }),
    runNpm: registry.runner,
  })
  assert.equal(result.commands.length, 18)
  assert.deepEqual(registry.mutations, [])

  registry.remote.get(fixture.descriptors[0].name).body = Buffer.from('different')
  await assert.rejects(
    () =>
      executeNpmPublishPlan({
        ...request(fixture, 'https://registry.npmjs.org', { mode: 'preflight' }),
        runNpm: registry.runner,
      }),
    /registry bytes differ/,
  )
})

void test('passes only the fixed GitHub OIDC context into the isolated npm environment', async () => {
  const fixture = await planFixture()
  const seenEnvironments = []
  const registry = mockRegistry(fixture)
  await executeNpmPublishPlan({
    ...request(fixture, 'http://127.0.0.1:4873', { mode: 'preflight' }),
    sourceEnvironment: {
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'ephemeral-request-token',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://pipelines.actions.githubusercontent.com/token',
      GITHUB_ACTIONS: 'true',
      GITHUB_SHA: 'a'.repeat(40),
      NODE_AUTH_TOKEN: 'must-not-pass',
      NPM_TOKEN: 'must-not-pass',
      npm_config_registry: 'https://attacker.invalid',
    },
    runNpm: async (args, env) => {
      seenEnvironments.push(env)
      return registry.runner(args)
    },
  })
  assert.equal(seenEnvironments.length, 18)
  const environment = seenEnvironments[0]
  assert.equal(environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN, 'ephemeral-request-token')
  assert.equal(
    environment.ACTIONS_ID_TOKEN_REQUEST_URL,
    'https://pipelines.actions.githubusercontent.com/token',
  )
  assert.equal(environment.GITHUB_ACTIONS, 'true')
  assert.equal(environment.GITHUB_SHA, 'a'.repeat(40))
  assert.equal(environment.NODE_AUTH_TOKEN, undefined)
  assert.equal(environment.NPM_TOKEN, undefined)
  assert.equal(environment.npm_config_registry, undefined)
  assert.ok(
    NPM_OIDC_ENVIRONMENT_KEYS.every((key) => key !== 'NODE_AUTH_TOKEN' && key !== 'NPM_TOKEN'),
  )
})

void test('reuses only correctly tagged bytes and handles a correctly tagged same-byte E409 race', async () => {
  const fixture = await planFixture()
  const present = fixture.descriptors[0]
  const initial = {
    [present.name]: { versionPresent: true, distTags: { next: VERSION } },
  }
  const raced = fixture.descriptors[1].name
  const registry = mockRegistry(fixture, initial, { conflicts: new Set([raced]) })
  await executeNpmPublishPlan({
    ...request(fixture, 'http://localhost:4873'),
    runNpm: registry.runner,
  })
  assert.ok(!registry.mutations.some((mutation) => mutation[1] === present.name))
  assert.equal(
    registry.mutations.filter(([kind, name]) => kind === 'publish' && name === raced).length,
    1,
  )
  assert.ok(NPM_PUBLISH_ORDER.every((name) => registry.remote.get(name).distTags.next === VERSION))

  const differentFixture = await planFixture()
  const first = differentFixture.descriptors[0].name
  const differentRace = mockRegistry(differentFixture, {}, { conflictDifferent: new Set([first]) })
  await assert.rejects(
    () =>
      executeNpmPublishPlan({
        ...request(differentFixture, 'http://localhost:4873'),
        runNpm: differentRace.runner,
      }),
    /registry bytes differ/,
  )
})

void test('rejects higher stable tags, malformed metadata, and non-404 failures before mutation', async () => {
  const fixture = await planFixture()
  const first = fixture.descriptors[0]
  const higher = mockRegistry(fixture, {
    [first.name]: { versionPresent: false, distTags: { next: '9.0.0' } },
  })
  await assert.rejects(
    () =>
      executeNpmPublishPlan({
        ...request(fixture, 'http://127.0.0.1:4873'),
        runNpm: higher.runner,
      }),
    /refusing to downgrade/,
  )
  assert.deepEqual(higher.mutations, [])

  const malformed = async () => ({ status: 0, stdout: '{bad json', stderr: '' })
  await assert.rejects(
    () =>
      executeNpmPublishPlan({
        ...request(fixture, 'http://127.0.0.1:4873'),
        runNpm: malformed,
      }),
    /malformed JSON/,
  )
  const forbidden = async () => ({ status: 1, stdout: '', stderr: 'npm error code E403' })
  await assert.rejects(
    () =>
      executeNpmPublishPlan({
        ...request(fixture, 'http://127.0.0.1:4873'),
        runNpm: forbidden,
      }),
    /npm view failed/,
  )
})

void test('fails closed when an existing version is missing the requested tag', async () => {
  const fixture = await planFixture()
  const first = fixture.descriptors[0]
  const registry = mockRegistry(fixture, {
    [first.name]: { versionPresent: true, distTags: { latest: VERSION } },
  })
  await assert.rejects(
    () =>
      executeNpmPublishPlan({
        ...request(fixture, 'http://127.0.0.1:4873'),
        runNpm: registry.runner,
      }),
    /repair the tag manually/,
  )
  assert.deepEqual(registry.mutations, [])
})

void test('cleans the isolated npm environment when preflight fails', async () => {
  const fixture = await planFixture()
  const environmentDirectory = await tempDir()
  await assert.rejects(
    () =>
      executeNpmPublishPlan({
        ...request(fixture, 'http://127.0.0.1:4873', { mode: 'preflight' }),
        createEnvironment: async () => ({ directory: environmentDirectory, env: {} }),
        probeRegistry: async () => {
          throw new Error('injected registry failure')
        },
      }),
    /injected registry failure/,
  )
  await assert.rejects(() => access(environmentDirectory), /ENOENT/)
})

void test('validates registry URLs, toolchain pins, and strict CLI flags', () => {
  assert.equal(validateRegistryUrl('https://registry.npmjs.org/'), 'https://registry.npmjs.org')
  assert.equal(validateRegistryUrl('http://127.0.0.1:4873/'), 'http://127.0.0.1:4873')
  for (const url of ['http://registry.npmjs.org', 'https://user:secret@example.com', 'file:///tmp'])
    assert.throws(() => validateRegistryUrl(url))
  assert.deepEqual(
    validateRegistryToolVersions({ nodeVersion: 'v24.5.0', npmVersion: '11.5.1\n' }),
    { nodeVersion: '24.5.0', npmVersion: '11.5.1' },
  )
  assert.throws(
    () => validateRegistryToolVersions({ nodeVersion: '24.6.0', npmVersion: '11.5.1' }),
    /require Node 24\.5\.0 and npm 11\.5\.1/,
  )
  const args = [
    '--candidate',
    'candidate',
    '--archives',
    'archives',
    '--source-root',
    '.',
    '--registry',
    'https://registry.npmjs.org',
    '--dist-tag',
    'next',
    '--mode',
    'preflight',
    '--layout',
    'packed-only',
  ]
  assert.deepEqual(parsePublishNpmPlanCli(args), {
    candidateDirectory: resolve('candidate'),
    trustedArchiveDirectory: resolve('archives'),
    trustedSourceRoot: resolve('.'),
    registry: 'https://registry.npmjs.org',
    distTag: 'next',
    mode: 'preflight',
    candidateLayout: 'packed-only',
  })
  assert.throws(
    () => parsePublishNpmPlanCli([...args.slice(0, 10), ...args.slice(12)]),
    /missing required flag '--mode'/,
  )
  assert.throws(() => parsePublishNpmPlanCli([...args, '--mode', 'publish']), /duplicate flag/)
  assert.throws(() => parsePublishNpmPlanCli([...args, '--token', 'secret']), /unknown flag/)
})
