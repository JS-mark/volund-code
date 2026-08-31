import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'

import { executeNpmPublishPlan } from './publish-npm-plan.mjs'
import {
  NPM_PUBLISH_LIMITS,
  readBoundedRegularFile,
  verifyNpmPublishPlan,
} from './verify-npm-publish-plan.mjs'

const require = createRequire(import.meta.url)
export const VERDACCIO_VERSION = '6.10.1'
export const TEMPORARY_REGISTRY_TIMEOUT_MS = 120_000
export const VERDACCIO_LOG_LIMIT = 256 * 1024
const VERDACCIO_START_ATTEMPTS = 5

async function reserveLoopbackPort() {
  const server = createServer()
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : null
  await new Promise((resolveClose, rejectClose) =>
    server.close((error) => (error ? rejectClose(error) : resolveClose())),
  )
  if (!port) throw new Error('failed to reserve a loopback port for Verdaccio')
  return port
}

function verdaccioConfiguration(root) {
  return `storage: ${JSON.stringify(join(root, 'storage'))}
auth:
  htpasswd:
    file: ${JSON.stringify(join(root, 'htpasswd'))}
    max_users: 1000
uplinks: {}
packages:
  '@*/*':
    access: $all
    publish: $authenticated
    unpublish: $authenticated
  '**':
    access: $all
    publish: $authenticated
    unpublish: $authenticated
log:
  type: stdout
  format: pretty
  level: warn
`
}

async function waitForVerdaccio(registry, child, timeoutMilliseconds = 15_000) {
  const deadline = Date.now() + timeoutMilliseconds
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`Verdaccio exited before readiness with status ${child.exitCode}`)
    try {
      const response = await fetch(`${registry}/-/ping`, {
        redirect: 'manual',
        signal: AbortSignal.timeout(1_000),
      })
      if (response.ok) return
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 50))
  }
  throw new Error(`Verdaccio did not become ready within ${timeoutMilliseconds}ms`)
}

async function terminateChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  await new Promise((resolveExit) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolveExit()
    }, 5_000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolveExit()
    })
  })
}

async function registerTemporaryPublisher(registry, temporaryRoot) {
  const username = 'volund-e2e'
  const response = await fetch(
    `${registry}/-/user/org.couchdb.user:${encodeURIComponent(username)}`,
    {
      method: 'PUT',
      redirect: 'manual',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: username,
        password: 'temporary-loopback-only-password',
        type: 'user',
        roles: [],
      }),
      signal: AbortSignal.timeout(10_000),
    },
  )
  if (!response.ok)
    throw new Error(`temporary Verdaccio user creation returned HTTP ${response.status}`)
  const document = await response.json()
  if (!document || typeof document.token !== 'string' || document.token.length < 16)
    throw new Error('temporary Verdaccio user creation returned no bounded-lifetime token')
  const authConfig = join(temporaryRoot, 'publisher.npmrc')
  const registryUrl = new URL(registry)
  await writeFile(
    authConfig,
    `//${registryUrl.host}/:_authToken=${document.token}\nalways-auth=true\n`,
    { mode: 0o600 },
  )
  return authConfig
}

function runNodeCli(nodeExecutable, cli, args, options = {}) {
  return spawnSync(nodeExecutable, [cli, ...args], {
    encoding: 'utf8',
    shell: false,
    timeout: TEMPORARY_REGISTRY_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
    ...options,
  })
}

function captureBoundedOutput(child) {
  let output = Buffer.alloc(0)
  const capture = (chunk) => {
    output = Buffer.concat([output, chunk])
    if (output.byteLength > VERDACCIO_LOG_LIMIT)
      output = output.subarray(output.byteLength - VERDACCIO_LOG_LIMIT)
  }
  child.stdout.on('data', capture)
  child.stderr.on('data', capture)
  return () => output.toString('utf8')
}

async function startVerdaccio({ nodeExecutable, verdaccioBin, config }) {
  let lastError
  for (let attempt = 1; attempt <= VERDACCIO_START_ATTEMPTS; attempt += 1) {
    const port = await reserveLoopbackPort()
    const registry = `http://127.0.0.1:${port}`
    const child = spawn(nodeExecutable, [verdaccioBin, '--config', config, '--listen', registry], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      env: { PATH: dirname(nodeExecutable), LANG: 'C', LC_ALL: 'C' },
    })
    const readOutput = captureBoundedOutput(child)
    try {
      await Promise.race([
        waitForVerdaccio(registry, child),
        new Promise((_, rejectSpawn) => child.once('error', rejectSpawn)),
      ])
      return { child, registry, readOutput }
    } catch (error) {
      lastError = error
      const output = readOutput()
      await terminateChild(child)
      if (
        !/EADDRINUSE|address already in use/i.test(output) ||
        attempt === VERDACCIO_START_ATTEMPTS
      )
        throw new Error(`${error.message}\nVerdaccio output:\n${output}`, { cause: error })
    }
  }
  throw lastError
}

function minimalExecutablePath(nodeExecutable) {
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot || 'C:\\Windows'
    return [dirname(nodeExecutable), join(systemRoot, 'System32')].join(delimiter)
  }
  return [dirname(nodeExecutable), '/usr/bin', '/bin'].join(delimiter)
}

function requireSuccess(result, label) {
  if (result.error || result.status !== 0)
    throw new Error(`${label} failed: ${result.stderr || result.stdout}`, { cause: result.error })
  return result
}

export async function runTemporaryRegistryNpxE2E({
  candidateDirectory,
  trustedArchiveDirectory,
  trustedSourceRoot,
  distTag = 'test',
  nodeExecutable = process.execPath,
  npmCli = resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
  npxCli = resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npx-cli.js'),
  verifyCandidate,
  candidateLayout = 'full',
  runDoctor = false,
} = {}) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'volund-verdaccio-'))
  let verdaccio
  try {
    const config = join(temporaryRoot, 'config.yaml')
    await writeFile(config, verdaccioConfiguration(temporaryRoot), { mode: 0o600 })
    const verdaccioPackage = require('verdaccio/package.json')
    if (verdaccioPackage.version !== VERDACCIO_VERSION)
      throw new Error(`expected Verdaccio ${VERDACCIO_VERSION}, found ${verdaccioPackage.version}`)
    const validator = verifyCandidate ?? verifyNpmPublishPlan
    const verifiedPlan = await validator({
      outputDirectory: candidateDirectory,
      trustedArchiveDirectory,
      trustedSourceRoot,
      candidateLayout,
    })
    const descriptors = [
      ...verifiedPlan.platformPackages,
      verifiedPlan.canonicalMeta,
      verifiedPlan.legacyMeta,
    ]
    const verdaccioBin = join(dirname(require.resolve('verdaccio/package.json')), 'bin/verdaccio')
    verdaccio = await startVerdaccio({ nodeExecutable, verdaccioBin, config })
    const { registry } = verdaccio

    const anonymousHome = join(temporaryRoot, 'anonymous-home')
    await mkdir(anonymousHome)
    const anonymousPublish = runNodeCli(
      nodeExecutable,
      npmCli,
      [
        'publish',
        resolve(candidateDirectory, descriptors[0].tarball),
        '--registry',
        registry,
        '--tag',
        distTag,
        '--access',
        'public',
      ],
      {
        env: {
          HOME: anonymousHome,
          USERPROFILE: anonymousHome,
          PATH: minimalExecutablePath(nodeExecutable),
          LANG: 'C',
          LC_ALL: 'C',
          npm_config_cache: join(anonymousHome, 'cache'),
          npm_config_userconfig: join(anonymousHome, 'user.npmrc'),
          npm_config_globalconfig: join(anonymousHome, 'global.npmrc'),
          npm_config_ignore_scripts: 'true',
        },
      },
    )
    if (
      anonymousPublish.status === 0 ||
      !/(?:E401|E403|ENEEDAUTH|not authorized|authentication required)/i.test(
        `${anonymousPublish.stderr}\n${anonymousPublish.stdout}`,
      )
    )
      throw new Error(
        `Verdaccio anonymous publish was not rejected safely: ${anonymousPublish.stderr || anonymousPublish.stdout}`,
      )

    const authConfig = await registerTemporaryPublisher(registry, temporaryRoot)
    const result = await executeNpmPublishPlan({
      candidateDirectory,
      trustedArchiveDirectory,
      trustedSourceRoot,
      registry,
      distTag,
      mode: 'publish',
      npmCli,
      verifyCandidate,
      candidateLayout,
      probeRegistry: async (url) => {
        const response = await fetch(`${url}/-/ping`, {
          redirect: 'manual',
          signal: AbortSignal.timeout(10_000),
        })
        if (!response.ok || (response.status >= 300 && response.status < 400))
          throw new Error(`temporary registry probe returned HTTP ${response.status}`)
      },
      runNpm: (args, env) =>
        runNodeCli(nodeExecutable, npmCli, args, {
          env: { ...env, npm_config_userconfig: authConfig },
        }),
    })
    const planBody = await readBoundedRegularFile(
      join(candidateDirectory, 'publish-plan.json'),
      NPM_PUBLISH_LIMITS.planBytes,
      'publish-plan.json',
    ).catch(() => null)
    const version = planBody
      ? JSON.parse(planBody.toString('utf8')).release.version
      : result.states[0]?.distTags[distTag]
    if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version))
      throw new Error('temporary registry E2E could not determine a stable candidate version')

    const npxHome = join(temporaryRoot, 'npx-home')
    await mkdir(npxHome)
    const npxEnvironment = {
      HOME: npxHome,
      USERPROFILE: npxHome,
      PATH: minimalExecutablePath(nodeExecutable),
      LANG: 'C',
      LC_ALL: 'C',
      npm_config_cache: join(npxHome, 'cache'),
      npm_config_userconfig: join(npxHome, 'user.npmrc'),
      npm_config_globalconfig: join(npxHome, 'global.npmrc'),
      npm_config_registry: registry,
      npm_config_audit: 'false',
      npm_config_fund: 'false',
      npm_config_update_notifier: 'false',
    }
    const npx = (args) =>
      requireSuccess(
        runNodeCli(
          nodeExecutable,
          npxCli,
          ['--yes', '--registry', registry, `volund-cli@${version}`, ...args],
          { env: npxEnvironment },
        ),
        `npx volund-cli ${args.join(' ')}`,
      )
    const versionRun = npx(['--version'])
    if (!versionRun.stdout.includes(version))
      throw new Error(`npx --version did not report ${version}: ${versionRun.stdout}`)
    const helpRun = npx(['--help'])
    if (!/usage|volund/i.test(helpRun.stdout))
      throw new Error(`npx --help returned unexpected output: ${helpRun.stdout}`)
    let doctorRun = null
    if (runDoctor) {
      doctorRun = npx(['doctor', '--json'])
      JSON.parse(doctorRun.stdout)
    }

    const omitted = join(temporaryRoot, 'omit-optional')
    await mkdir(omitted)
    requireSuccess(
      runNodeCli(
        nodeExecutable,
        npmCli,
        [
          'install',
          '--ignore-scripts',
          '--omit=optional',
          '--registry',
          registry,
          `volund-cli@${version}`,
        ],
        {
          cwd: omitted,
          env: {
            PATH: minimalExecutablePath(nodeExecutable),
            HOME: omitted,
            LANG: 'C',
            LC_ALL: 'C',
          },
        },
      ),
      'npm install --omit=optional',
    )
    const missingOptional = runNodeCli(
      nodeExecutable,
      join(omitted, 'node_modules/volund-cli/bin/volund.cjs'),
      ['--version'],
      { cwd: omitted },
    )
    if (missingOptional.status === 0 || !/--omit=optional/.test(missingOptional.stderr))
      throw new Error('omit-optional execution did not fail with the expected actionable message')
    return {
      registry,
      version,
      packageCount: result.states.length,
      versionOutput: versionRun.stdout,
      helpOutput: helpRun.stdout,
      doctorOutput: doctorRun?.stdout,
      anonymousPublishRejected: true,
    }
  } catch (error) {
    if (error instanceof Error && verdaccio?.child.exitCode !== null)
      error.message += `\nVerdaccio output:\n${verdaccio.readOutput()}`
    throw error
  } finally {
    if (verdaccio) await terminateChild(verdaccio.child)
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

export function parseTemporaryRegistryCli(argv) {
  const supported = new Set([
    '--candidate',
    '--archives',
    '--source-root',
    '--dist-tag',
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
    distTag: values.get('--dist-tag'),
    candidateLayout: values.get('--layout'),
    runDoctor: true,
  }
}

async function main() {
  const result = await runTemporaryRegistryNpxE2E(parseTemporaryRegistryCli(process.argv.slice(2)))
  console.log(`temporary registry npx E2E passed for ${result.packageCount} packages`)
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) await main()
