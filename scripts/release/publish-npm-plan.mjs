import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import {
  NPM_CANDIDATE_LAYOUTS,
  NPM_PUBLISH_LIMITS,
  NPM_PUBLISH_ORDER,
  readBoundedRegularFile,
  verifyNpmPublishPlan,
} from './verify-npm-publish-plan.mjs'

export const NPM_REGISTRY_TOOL = Object.freeze({
  nodeVersion: '24.5.0',
  npmVersion: '11.5.1',
})
export const NPM_DIST_TAGS = Object.freeze(['next', 'latest', 'test'])
export const NPM_PUBLISH_MODES = Object.freeze(['preflight', 'publish'])
export const NPM_REGISTRY_TIMEOUT_MS = 120_000
export const NPM_REGISTRY_OUTPUT_LIMIT = 4 * 1024 * 1024
export const NPM_OIDC_ENVIRONMENT_KEYS = Object.freeze([
  'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
  'ACTIONS_ID_TOKEN_REQUEST_URL',
  'CI',
  'GITHUB_ACTION',
  'GITHUB_ACTIONS',
  'GITHUB_ACTOR',
  'GITHUB_ACTOR_ID',
  'GITHUB_API_URL',
  'GITHUB_EVENT_NAME',
  'GITHUB_JOB',
  'GITHUB_REF',
  'GITHUB_REF_NAME',
  'GITHUB_REF_PROTECTED',
  'GITHUB_REF_TYPE',
  'GITHUB_REPOSITORY',
  'GITHUB_REPOSITORY_ID',
  'GITHUB_REPOSITORY_OWNER',
  'GITHUB_REPOSITORY_OWNER_ID',
  'GITHUB_RUN_ATTEMPT',
  'GITHUB_RUN_ID',
  'GITHUB_RUN_NUMBER',
  'GITHUB_SERVER_URL',
  'GITHUB_SHA',
  'GITHUB_WORKFLOW',
  'GITHUB_WORKFLOW_REF',
  'GITHUB_WORKFLOW_SHA',
  'RUNNER_ARCH',
  'RUNNER_ENVIRONMENT',
  'RUNNER_OS',
])

function sha1(body) {
  return createHash('sha1').update(body).digest('hex')
}

function isLoopbackHostname(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

export function validateRegistryUrl(value) {
  let registry
  try {
    registry = new URL(value)
  } catch (error) {
    throw new Error('registry must be an absolute URL', { cause: error })
  }
  if (registry.username || registry.password || registry.search || registry.hash)
    throw new Error('registry URL must not contain credentials, query parameters, or a fragment')
  if (
    registry.protocol !== 'https:' &&
    !(registry.protocol === 'http:' && isLoopbackHostname(registry.hostname))
  )
    throw new Error('registry must use HTTPS; HTTP is allowed only for loopback test registries')
  registry.pathname = registry.pathname.replace(/\/+$/, '') || '/'
  return registry.toString().replace(/\/$/, '')
}

export async function probeRegistryEndpoint(registry, fetchImpl = fetch) {
  const response = await fetchImpl(`${registry}/`, {
    method: 'GET',
    redirect: 'manual',
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  })
  if (response.status >= 300 && response.status < 400)
    throw new Error(`registry endpoint redirects with HTTP ${response.status}`)
  if (!response.ok) throw new Error(`registry endpoint returned HTTP ${response.status}`)
}

export function validateRegistryToolVersions({ nodeVersion, npmVersion }) {
  const normalizedNode = nodeVersion.startsWith('v') ? nodeVersion.slice(1) : nodeVersion
  if (
    normalizedNode !== NPM_REGISTRY_TOOL.nodeVersion ||
    npmVersion.trim() !== NPM_REGISTRY_TOOL.npmVersion
  )
    throw new Error(
      `npm registry operations require Node ${NPM_REGISTRY_TOOL.nodeVersion} and npm ${NPM_REGISTRY_TOOL.npmVersion}; ` +
        `found Node ${normalizedNode} and npm ${npmVersion.trim()}`,
    )
  return { ...NPM_REGISTRY_TOOL }
}

async function resolveRegistryTool() {
  const npmCli = await realpath(
    resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
  )
  const result = spawnSync(process.execPath, [npmCli, '--version'], {
    encoding: 'utf8',
    shell: false,
    env: { PATH: dirname(process.execPath), LANG: 'C', LC_ALL: 'C' },
    timeout: NPM_REGISTRY_TIMEOUT_MS,
    maxBuffer: NPM_REGISTRY_OUTPUT_LIMIT,
  })
  if (result.error || result.status !== 0)
    throw new Error('failed to verify npm registry tool', { cause: result.error })
  validateRegistryToolVersions({ nodeVersion: process.version, npmVersion: result.stdout })
  return npmCli
}

function parseStableCore(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version)
  return match ? match.slice(1).map(Number) : null
}

function compareStableCore(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1
  }
  return 0
}

function isNotFound(result) {
  return (
    result.status !== 0 && /(?:\bE404\b|404 Not Found)/i.test(`${result.stderr}\n${result.stdout}`)
  )
}

function isConflict(result) {
  return (
    result.status !== 0 && /(?:\bE409\b|409 Conflict)/i.test(`${result.stderr}\n${result.stdout}`)
  )
}

function parseVersionResult(result, descriptor) {
  if (isNotFound(result)) return { kind: 'absent' }
  if (result.error || result.status !== 0)
    throw new Error(
      `npm view failed for '${descriptor.name}@${descriptor.version}': ${result.stderr || result.stdout}`,
      { cause: result.error },
    )
  let document
  try {
    document = JSON.parse(result.stdout)
  } catch (error) {
    throw new Error(`npm view returned malformed JSON for '${descriptor.name}'`, { cause: error })
  }
  if (!document || typeof document !== 'object' || Array.isArray(document))
    throw new Error(`npm view returned an invalid document for '${descriptor.name}'`)
  const keys = Object.keys(document).toSorted()
  if (keys.join('\0') !== ['dist.integrity', 'dist.shasum'].toSorted().join('\0'))
    throw new Error(`npm view returned unexpected fields for '${descriptor.name}'`)
  if (typeof document['dist.integrity'] !== 'string' || typeof document['dist.shasum'] !== 'string')
    throw new Error(`npm view returned incomplete metadata for '${descriptor.name}'`)
  return {
    kind: 'present',
    integrity: document['dist.integrity'],
    shasum: document['dist.shasum'],
  }
}

function parseDistTagsResult(result, descriptor) {
  if (isNotFound(result)) return Object.create(null)
  if (result.error || result.status !== 0)
    throw new Error(
      `npm dist-tag read failed for '${descriptor.name}': ${result.stderr || result.stdout}`,
      {
        cause: result.error,
      },
    )
  let document
  try {
    document = JSON.parse(result.stdout)
  } catch (error) {
    throw new Error(`npm dist-tag read returned malformed JSON for '${descriptor.name}'`, {
      cause: error,
    })
  }
  if (!document || typeof document !== 'object' || Array.isArray(document))
    throw new Error(`npm dist-tag read returned an invalid document for '${descriptor.name}'`)
  if (
    Object.entries(document).some(
      ([key, value]) => !/^[a-z0-9][a-z0-9._-]*$/i.test(key) || typeof value !== 'string',
    )
  )
    throw new Error(`npm dist-tag read returned malformed tags for '${descriptor.name}'`)
  return { ...document }
}

function assertRemoteBytes(state, descriptor, expectedSha1) {
  if (
    state.kind !== 'present' ||
    state.integrity !== descriptor.integrity ||
    state.shasum !== expectedSha1
  )
    throw new Error(`registry bytes differ for '${descriptor.name}@${descriptor.version}'`)
}

function assertNoTagDowngrade(state, descriptor, distTag) {
  const taggedVersion = state.distTags[distTag]
  if (!taggedVersion || taggedVersion === descriptor.version) return
  const taggedStable = parseStableCore(taggedVersion)
  const candidateStable = parseStableCore(descriptor.version)
  if (!taggedStable || !candidateStable)
    throw new Error(`registry dist-tag '${distTag}' for '${descriptor.name}' is not stable SemVer`)
  if (compareStableCore(taggedStable, candidateStable) > 0)
    throw new Error(
      `refusing to downgrade '${descriptor.name}' dist-tag '${distTag}' from ${taggedVersion} to ${descriptor.version}`,
    )
}

function assertPresentTagIdentity(state, descriptor, distTag) {
  assertRemoteBytes(state, descriptor, state.expectedSha1)
  if (state.distTags[distTag] !== descriptor.version)
    throw new Error(
      `registry version '${descriptor.name}@${descriptor.version}' exists but dist-tag '${distTag}' does not identify it; repair the tag manually before retrying`,
    )
}

async function createRegistryEnvironment(sourceEnvironment) {
  const directory = await mkdtemp(join(tmpdir(), 'volund-npm-registry-'))
  const env = {
    HOME: directory,
    USERPROFILE: directory,
    PATH: dirname(process.execPath),
    LANG: 'C',
    LC_ALL: 'C',
    npm_config_cache: join(directory, 'cache'),
    npm_config_userconfig: join(directory, 'user.npmrc'),
    npm_config_globalconfig: join(directory, 'global.npmrc'),
    npm_config_ignore_scripts: 'true',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
  }
  for (const key of NPM_OIDC_ENVIRONMENT_KEYS) {
    const value = sourceEnvironment[key]
    if (typeof value === 'string' && value.length > 0) env[key] = value
  }
  return { directory, env }
}

function defaultRunNpm(npmCli, args, env) {
  return spawnSync(process.execPath, [npmCli, ...args], {
    encoding: 'utf8',
    shell: false,
    env,
    timeout: NPM_REGISTRY_TIMEOUT_MS,
    maxBuffer: NPM_REGISTRY_OUTPUT_LIMIT,
  })
}

function packageDescriptors(plan) {
  const descriptors = [...plan.platformPackages, plan.canonicalMeta, plan.legacyMeta]
  if (descriptors.map((item) => item.name).join('\0') !== NPM_PUBLISH_ORDER.join('\0'))
    throw new Error('publish plan descriptors do not follow the frozen nine-package order')
  return descriptors
}

export async function executeNpmPublishPlan({
  candidateDirectory,
  trustedArchiveDirectory,
  trustedSourceRoot,
  registry: registryValue,
  distTag,
  mode,
  npmCli: injectedNpmCli,
  runNpm: injectedRunNpm,
  probeRegistry = probeRegistryEndpoint,
  verifyCandidate = verifyNpmPublishPlan,
  sourceEnvironment = process.env,
  candidateLayout = 'full',
  createEnvironment = createRegistryEnvironment,
} = {}) {
  if (!NPM_DIST_TAGS.includes(distTag)) throw new Error(`unsupported npm dist-tag '${distTag}'`)
  if (!NPM_PUBLISH_MODES.includes(mode)) throw new Error(`unsupported npm publish mode '${mode}'`)
  if (!NPM_CANDIDATE_LAYOUTS.includes(candidateLayout))
    throw new Error(`unsupported npm candidate layout '${candidateLayout}'`)
  const registry = validateRegistryUrl(registryValue)
  const plan = await verifyCandidate({
    outputDirectory: candidateDirectory,
    trustedArchiveDirectory,
    trustedSourceRoot,
    candidateLayout,
  })
  const descriptors = packageDescriptors(plan)
  const environment = await createEnvironment(sourceEnvironment)
  try {
    await probeRegistry(registry)
    const npmCli = injectedNpmCli ?? (await resolveRegistryTool())
    const runNpm = injectedRunNpm ?? ((args, env) => defaultRunNpm(npmCli, args, env))
    const commands = []
    const callNpm = async (args) => {
      commands.push([...args])
      return runNpm(args, environment.env)
    }
    const view = async (descriptor, expectedSha1) => {
      const version = parseVersionResult(
        await callNpm([
          'view',
          `${descriptor.name}@${descriptor.version}`,
          'dist.integrity',
          'dist.shasum',
          '--json',
          '--registry',
          registry,
        ]),
        descriptor,
      )
      const distTags = parseDistTagsResult(
        await callNpm(['view', descriptor.name, 'dist-tags', '--json', '--registry', registry]),
        descriptor,
      )
      return { ...version, distTags, expectedSha1 }
    }
    const initial = []
    for (const descriptor of descriptors) {
      const tarball = await readBoundedRegularFile(
        join(resolve(candidateDirectory), descriptor.tarball),
        NPM_PUBLISH_LIMITS.tarballBytes,
        `npm tarball '${descriptor.name}'`,
      )
      const expectedSha1 = sha1(tarball)
      const state = await view(descriptor, expectedSha1)
      if (state.kind === 'present') assertPresentTagIdentity(state, descriptor, distTag)
      assertNoTagDowngrade(state, descriptor, distTag)
      initial.push({ descriptor, state, expectedSha1 })
    }
    if (mode === 'preflight') return { mode, registry, commands, states: initial }

    for (const item of initial) {
      let state = item.state
      if (state.kind === 'absent') {
        // npm has no publish CAS. The dist-tag-scoped workflow concurrency plus this
        // mutation-adjacent reread narrows the race; other registry writers remain a trusted boundary.
        state = await view(item.descriptor, item.expectedSha1)
        if (state.kind === 'present') {
          assertPresentTagIdentity(state, item.descriptor, distTag)
          continue
        }
        assertNoTagDowngrade(state, item.descriptor, distTag)
        const result = await callNpm([
          'publish',
          resolve(candidateDirectory, item.descriptor.tarball),
          '--registry',
          registry,
          '--tag',
          distTag,
          '--access',
          'public',
        ])
        if (result.error || result.status !== 0) {
          if (!isConflict(result))
            throw new Error(
              `npm publish failed for '${item.descriptor.name}': ${result.stderr || result.stdout}`,
              { cause: result.error },
            )
          state = await view(item.descriptor, item.expectedSha1)
          assertPresentTagIdentity(state, item.descriptor, distTag)
        } else {
          state = await view(item.descriptor, item.expectedSha1)
          assertPresentTagIdentity(state, item.descriptor, distTag)
        }
      }
    }

    const finalStates = []
    for (const item of initial) {
      const state = await view(item.descriptor, item.expectedSha1)
      assertPresentTagIdentity(state, item.descriptor, distTag)
      finalStates.push(state)
    }
    return { mode, registry, commands, states: finalStates }
  } finally {
    await rm(environment.directory, { recursive: true, force: true })
  }
}

export function parsePublishNpmPlanCli(argv) {
  const supported = new Set([
    '--candidate',
    '--archives',
    '--source-root',
    '--registry',
    '--dist-tag',
    '--mode',
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
  for (const flag of supported)
    if (!values.has(flag)) throw new Error(`missing required flag '${flag}'`)
  return {
    candidateDirectory: resolve(values.get('--candidate')),
    trustedArchiveDirectory: resolve(values.get('--archives')),
    trustedSourceRoot: resolve(values.get('--source-root')),
    registry: values.get('--registry'),
    distTag: values.get('--dist-tag'),
    mode: values.get('--mode'),
    candidateLayout: values.get('--layout'),
  }
}

async function main() {
  const result = await executeNpmPublishPlan(parsePublishNpmPlanCli(process.argv.slice(2)))
  console.log(
    `${result.mode} verified ${NPM_PUBLISH_ORDER.length} npm packages at ${result.registry}`,
  )
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) await main()
