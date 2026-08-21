import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { types as nodeTypes } from 'node:util'

import type { PluginSandboxProfile } from '@apollo-code/native-bridge'
import type {
  ApolloBridge,
  Disposable,
  HookEvent,
  HookHandler,
  HookResult,
  PluginMemoryHookPayload,
  PluginMemoryScope,
  PluginManifest,
  PluginRegistryMetadata,
  PluginRegistrySignedPayload,
  PluginUiContribution,
} from '@apollo-code/plugin-sdk'
import type {
  Disposable as ProviderDisposable,
  ProviderCapabilities,
  ProviderChunk,
  ProviderClient,
  ProviderRegistry,
  ProviderRequest,
} from '@apollo-code/provider-kit'

export const LEGACY_PLUGIN_UNAVAILABLE = Object.freeze({
  available: false as const,
  code: 'plugin_legacy_activation_unavailable' as const,
  detail:
    'Legacy plugin install and activation are temporarily unavailable until Catalog v2 and the verified capability ABI reopen them.',
  reopenCondition: 'CAT-01/02 + ABI-R1 production verification and explicit security review',
})

const legacyPluginUnavailable = (operation: string) =>
  new PluginError(
    LEGACY_PLUGIN_UNAVAILABLE.code,
    `${operation} is temporarily unavailable; ${LEGACY_PLUGIN_UNAVAILABLE.reopenCondition} required`,
  )
export class PluginError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`)
  }
}

export interface PluginRegistryVerifier {
  verify(
    payload: PluginRegistrySignedPayload,
    signature: Readonly<PluginRegistryMetadata['signature']>,
  ): boolean | Promise<boolean>
}

export interface PluginRegistryClientOptions {
  /** Pinned registry origin. Production network access is intentionally outside this client. */
  source: string
  fetchMetadata(name: string, version: string): Promise<unknown>
  verifier: PluginRegistryVerifier
}

const REGISTRY_METADATA_KEYS = [
  'schemaVersion',
  'name',
  'version',
  'source',
  'bundle',
  'signature',
  'revoked',
] as const
const exactKeys = (value: object, expected: readonly string[]) => {
  const keys = Object.keys(value)
  return keys.length === expected.length && keys.every((key) => expected.includes(key))
}
const plainRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) &&
  typeof value === 'object' &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value))
const pinnedRegistryUrl = (value: string) => {
  try {
    const url = new URL(value)
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === '/' &&
      url.toString() === value
    )
  } catch {
    return false
  }
}

export async function verifyPluginRegistryMetadata(
  value: unknown,
  expected: Readonly<{ name: string; version: string; source: string; digest: string }>,
  verifier: PluginRegistryVerifier,
): Promise<PluginRegistryMetadata> {
  if (!plainRecord(value) || !exactKeys(value, REGISTRY_METADATA_KEYS))
    throw new PluginError('plugin_registry_metadata_invalid', 'metadata shape is not trusted')
  const bundle = value.bundle
  const signature = value.signature
  if (
    value.schemaVersion !== 1 ||
    value.name !== expected.name ||
    value.version !== expected.version ||
    value.source !== expected.source ||
    typeof value.source !== 'string' ||
    !pinnedRegistryUrl(value.source) ||
    typeof value.revoked !== 'boolean' ||
    !plainRecord(bundle) ||
    !exactKeys(bundle, ['url', 'digest']) ||
    typeof bundle.url !== 'string' ||
    typeof bundle.digest !== 'string' ||
    !bundle.digest.match(/^sha256-[a-f0-9]{64}$/) ||
    !plainRecord(signature) ||
    !exactKeys(signature, ['keyId', 'value']) ||
    typeof signature.keyId !== 'string' ||
    signature.keyId.length === 0 ||
    typeof signature.value !== 'string' ||
    signature.value.length === 0
  )
    throw new PluginError('plugin_registry_metadata_invalid', 'metadata fields are not trusted')
  if (value.revoked)
    throw new PluginError('plugin_registry_revoked', `${expected.name}@${expected.version}`)
  if (bundle.digest !== expected.digest)
    throw new PluginError('plugin_registry_digest_mismatch', `${expected.name}@${expected.version}`)
  const bundleUrl = new URL(bundle.url)
  if (
    bundleUrl.protocol !== 'https:' ||
    bundleUrl.origin !== new URL(expected.source).origin ||
    bundleUrl.username ||
    bundleUrl.password ||
    bundleUrl.search ||
    bundleUrl.hash
  )
    throw new PluginError(
      'plugin_registry_source_pollution',
      'bundle URL escaped the pinned source',
    )
  const metadata = value as unknown as PluginRegistryMetadata
  const payload: PluginRegistrySignedPayload = {
    schemaVersion: metadata.schemaVersion,
    name: metadata.name,
    version: metadata.version,
    source: metadata.source,
    bundle: metadata.bundle,
    revoked: metadata.revoked,
  }
  if (!(await verifier.verify(payload, metadata.signature)))
    throw new PluginError(
      'plugin_registry_signature_invalid',
      `${expected.name}@${expected.version}`,
    )
  return structuredClone(metadata)
}

/** Dependency-injected registry fixture: it performs no network or account access itself. */
export class PluginRegistryClient {
  constructor(private readonly options: PluginRegistryClientOptions) {
    if (!pinnedRegistryUrl(options.source))
      throw new PluginError(
        'plugin_registry_source_invalid',
        'registry source must be a pinned HTTPS origin',
      )
  }

  async resolve(name: string, version: string, digest: string) {
    const metadata = await this.options.fetchMetadata(name, version)
    return verifyPluginRegistryMetadata(
      metadata,
      { name, version, source: this.options.source, digest },
      this.options.verifier,
    )
  }
}
export interface PluginApproval {
  version: string
  permissionHash: string
  enabled: boolean
  failures?: number
}
export interface PluginState {
  approvals: Record<string, PluginApproval>
}
const PLUGIN_NAME = /^apollo-plugin-[a-z0-9][a-z0-9._-]{0,127}$/
const PLUGIN_STATE_MAX_BYTES = 1024 * 1024
const PLUGIN_STATE_MAX_APPROVALS = 1024
const PLUGIN_STATE_MAX_VERSION_LENGTH = 128
const PLUGIN_STATE_MAX_PERMISSION_HASH_LENGTH = 512
const PLUGIN_STATE_MAX_FAILURES = 1_000_000
const PLUGIN_STATE_VERSION =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function isPluginState(value: unknown): value is PluginState {
  if (!isRecord(value) || !isRecord(value.approvals)) return false
  const approvals = Object.entries(value.approvals)
  if (approvals.length > PLUGIN_STATE_MAX_APPROVALS) return false
  return approvals.every(
    ([name, approval]) =>
      PLUGIN_NAME.test(name) &&
      isRecord(approval) &&
      typeof approval.version === 'string' &&
      approval.version.length <= PLUGIN_STATE_MAX_VERSION_LENGTH &&
      PLUGIN_STATE_VERSION.test(approval.version) &&
      typeof approval.permissionHash === 'string' &&
      approval.permissionHash.length <= PLUGIN_STATE_MAX_PERMISSION_HASH_LENGTH &&
      typeof approval.enabled === 'boolean' &&
      (approval.failures === undefined ||
        (typeof approval.failures === 'number' &&
          Number.isSafeInteger(approval.failures) &&
          approval.failures >= 0 &&
          approval.failures <= PLUGIN_STATE_MAX_FAILURES)),
  )
}
function fileErrorCode(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}
function assertPluginName(name: string): void {
  if (!PLUGIN_NAME.test(name)) throw new PluginError('plugin_path_escape', name)
}
function nullPrototypeApprovals(
  entries: Iterable<readonly [string, PluginApproval]> = [],
): Record<string, PluginApproval> {
  const approvals: Record<string, PluginApproval> = {}
  Object.setPrototypeOf(approvals, null)
  for (const [name, approval] of entries) approvals[name] = approval
  return approvals
}
function ownApproval(
  approvals: Record<string, PluginApproval>,
  name: string,
): PluginApproval | undefined {
  assertPluginName(name)
  return Object.hasOwn(approvals, name) ? approvals[name] : undefined
}
async function readBoundedRegularFile(path: string, maxBytes: number): Promise<string> {
  const handle = await open(
    path,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
  )
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > maxBytes)
      throw new PluginError('plugin_legacy_activation_unavailable', 'legacy plugin state rejected')
    const buffer = Buffer.alloc(maxBytes + 1)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    if (offset > maxBytes)
      throw new PluginError('plugin_legacy_activation_unavailable', 'legacy plugin state rejected')
    return buffer.toString('utf8', 0, offset)
  } finally {
    await handle.close()
  }
}
const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/
const RANGE = /^(\^|~)?(\d+)\.(\d+)\.(\d+)$/
export function satisfies(version: string, range: string): boolean {
  const v = VERSION.exec(version),
    r = RANGE.exec(range)
  if (!v || !r) return false
  const [major, minor, patch] = v.slice(1, 4).map(Number),
    [rMajor, rMinor, rPatch] = r.slice(2, 5).map(Number)
  if (major !== rMajor) return false
  if (!r[1]) return minor === rMinor && patch === rPatch
  if (r[1] === '~') return minor === rMinor && patch! >= rPatch!
  return major === 0
    ? minor === rMinor && patch! >= rPatch!
    : minor! > rMinor! || (minor === rMinor && patch! >= rPatch!)
}
const safeRelative = (value: string) => !isAbsolute(value) && !value.split(/[\\/]/).includes('..')
const UI_SURFACES = new Set(['status-bar'])
const UI_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/
const hasControlCharacter = (value: string) =>
  [...value].some((character) => {
    const code = character.codePointAt(0)!
    return code < 32 || code === 127
  })
function validateUiContributions(manifest: Partial<PluginManifest>) {
  const contributions = manifest.contributes?.ui
  if (contributions === undefined) return
  if (!Array.isArray(contributions))
    throw new PluginError('plugin_ui_invalid', 'contributes.ui must be an array')
  if (!manifest.permissions?.apollo.includes('ui.contribute'))
    throw new PluginError('plugin_ui_permission_required', 'ui.contribute')
  const ids = new Set<string>()
  for (const item of contributions as readonly PluginUiContribution[]) {
    const keys = item && typeof item === 'object' ? Object.keys(item) : []
    if (
      !item ||
      typeof item !== 'object' ||
      keys.some((key) => !['id', 'surface', 'text', 'priority'].includes(key)) ||
      !UI_ID.test(item.id) ||
      !UI_SURFACES.has(item.surface) ||
      typeof item.text !== 'string' ||
      item.text.length === 0 ||
      item.text.length > 160 ||
      hasControlCharacter(item.text) ||
      (item.priority !== undefined &&
        (!Number.isSafeInteger(item.priority) || item.priority < -100 || item.priority > 100)) ||
      ids.has(item.id)
    )
      throw new PluginError(
        'plugin_ui_invalid',
        `invalid UI contribution: ${item?.id ?? '(unknown)'}`,
      )
    ids.add(item.id)
  }
}
export function validateManifest(value: unknown, apolloVersion: string): PluginManifest {
  if (!value || typeof value !== 'object')
    throw new PluginError('plugin_manifest_invalid', 'manifest must be an object')
  const m = value as Partial<PluginManifest>
  if (
    !m.name?.startsWith('apollo-plugin-') ||
    !VERSION.test(m.version ?? '') ||
    m.type !== 'module' ||
    !m.main ||
    !safeRelative(m.main)
  )
    throw new PluginError('plugin_manifest_invalid', 'invalid name, version, type, or main path')
  if (!m.engines?.apollo || !satisfies(apolloVersion, m.engines.apollo))
    throw new PluginError(
      'plugin_engine_incompatible',
      `Apollo ${apolloVersion} does not satisfy ${m.engines?.apollo ?? '(missing)'}`,
    )
  if (!m.permissions || !Array.isArray(m.permissions.apollo))
    throw new PluginError('plugin_manifest_invalid', 'permissions.apollo is required')
  const memory = m.permissions.memory
  if (
    memory &&
    ((memory.read !== undefined &&
      (!Array.isArray(memory.read) ||
        memory.read.some((scope) => !['workspace', 'project', 'session'].includes(scope)))) ||
      (memory.write !== undefined && typeof memory.write !== 'boolean') ||
      (memory.search !== undefined && typeof memory.search !== 'boolean') ||
      (memory.export !== undefined && typeof memory.export !== 'boolean'))
  )
    throw new PluginError('plugin_manifest_invalid', 'permissions.memory is invalid')
  validateUiContributions(m)
  if (m.kind === 'provider') {
    const provider = m.provider
    if (
      !provider?.name ||
      !provider.displayName ||
      !provider.auth?.credentialScope ||
      !['header-template', 'signing'].includes(provider.auth.mode)
    )
      throw new PluginError('plugin_provider_invalid', 'invalid provider authentication')
    if (
      provider.auth.mode === 'header-template' &&
      !provider.auth.headerTemplate?.includes('{{key}}')
    )
      throw new PluginError('plugin_provider_invalid', 'invalid header-template provider')
    if (provider.auth.mode === 'signing') {
      const signing = provider.auth.signing
      if (
        !['aws-sigv4', 'acs3', 'custom'].includes(signing?.algorithm) ||
        !Array.isArray(signing?.envKeys) ||
        signing.envKeys.length === 0 ||
        new Set(signing.envKeys).size !== signing.envKeys.length ||
        signing.envKeys.some((key) => !/^[A-Z_][A-Z0-9_]*$/.test(key))
      )
        throw new PluginError('plugin_provider_invalid', 'invalid signing provider')
    }
    if (!m.permissions.net || m.permissions.net.allowlist.length === 0)
      throw new PluginError('plugin_provider_net_required', 'provider requires a net allowlist')
    const authPermission =
      provider.auth.mode === 'signing' ? 'auth.getSigningEnvKeys' : 'auth.getAuthHeaders'
    for (const permission of ['provider.register', authPermission])
      if (!m.permissions.apollo.includes(permission))
        throw new PluginError('plugin_provider_permission_required', permission)
  } else if (m.provider) {
    throw new PluginError('plugin_provider_invalid', 'provider section requires kind: provider')
  }
  return m as PluginManifest
}
export const permissionHash = (manifest: PluginManifest) =>
  createHash('sha256')
    .update(
      JSON.stringify({ permissions: manifest.permissions, ui: manifest.contributes?.ui ?? [] }),
    )
    .digest('hex')
export function sandboxProfile(
  manifest: PluginManifest,
  pluginDir: string,
  dataDir: string,
): PluginSandboxProfile {
  const fs = manifest.permissions.fs
  const runtimeRoots = [dirname(process.execPath)]
  const homebrew = /^(.+)\/Cellar\/node\//.exec(process.execPath)?.[1]
  if (process.platform === 'darwin' && homebrew)
    runtimeRoots.push(join(homebrew, 'Cellar'), join(homebrew, 'etc', 'openssl@3'))
  return {
    fs: {
      read: [
        pluginDir,
        ...runtimeRoots,
        ...(fs?.read ?? []).map((path) => resolve(pluginDir, path)),
      ],
      write: [dataDir, ...(fs?.write ?? []).map((path) => resolve(dataDir, path))],
    },
    net: manifest.permissions.net ? { allowlist: [...manifest.permissions.net.allowlist] } : false,
    env: { read: ['PATH', 'HOME', 'LANG'] },
    limits: { cpu_seconds: 30, rss_mb: 256, processes: 1, open_files: 64 },
  }
}
export async function verifyBundle(
  pluginDir: string,
  manifest: PluginManifest,
  integrity?: Record<string, string>,
) {
  const root = await realpath(pluginDir)
  for (const entry of [manifest.main, ...Object.keys(integrity ?? {})]) {
    if (!safeRelative(entry))
      throw new PluginError('plugin_path_escape', `unsafe bundle path: ${entry}`)
    const path = resolve(root, entry)
    if ((await lstat(path)).isSymbolicLink())
      throw new PluginError('plugin_symlink_rejected', `symlink rejected: ${entry}`)
    const resolved = await realpath(path)
    if (resolved !== root && !resolved.startsWith(`${root}${sep}`))
      throw new PluginError('plugin_path_escape', `bundle path escapes plugin: ${entry}`)
    const expected = integrity?.[entry]
    if (expected) {
      const actual = createHash('sha256')
        .update(await readFile(path))
        .digest('hex')
      if (actual !== expected.replace(/^sha256-/, ''))
        throw new PluginError('plugin_integrity_failed', `integrity mismatch: ${entry}`)
    }
  }
}
export class PluginManager {
  private state: PluginState = { approvals: nullPrototypeApprovals() }
  constructor(
    readonly root: string,
    readonly apolloVersion: string,
    readonly confirm: (manifest: PluginManifest, expanded: boolean) => Promise<boolean>,
  ) {}
  async init() {
    await mkdir(this.root, { recursive: true })
    this.state = { approvals: nullPrototypeApprovals() }
    let serialized: string
    try {
      serialized = await readBoundedRegularFile(
        join(this.root, 'plugins.json'),
        PLUGIN_STATE_MAX_BYTES,
      )
    } catch (error) {
      if (fileErrorCode(error) === 'ENOENT') return
      throw legacyPluginUnavailable('legacy plugin state read')
    }
    let state: unknown
    try {
      state = JSON.parse(serialized)
    } catch {
      throw legacyPluginUnavailable('legacy plugin state migration')
    }
    if (!isPluginState(state)) throw legacyPluginUnavailable('legacy plugin state migration')
    this.state = {
      ...state,
      approvals: nullPrototypeApprovals(Object.entries(state.approvals)),
    }
    for (const approval of Object.values(this.state.approvals)) approval.enabled = false
  }
  private async save() {
    const temp = join(this.root, `.plugins-${process.pid}.tmp`)
    await writeFile(temp, JSON.stringify(this.state, null, 2))
    await rename(temp, join(this.root, 'plugins.json'))
  }
  async inspect(dir: string) {
    const manifest = validateManifest(
      JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')),
      this.apolloVersion,
    )
    await verifyBundle(dir, manifest)
    return manifest
  }
  async install(_source: string): Promise<never> {
    throw legacyPluginUnavailable('plugin install')
  }
  async setEnabled(name: string, enabled: boolean) {
    const record = ownApproval(this.state.approvals, name)
    if (enabled) throw legacyPluginUnavailable('plugin enable')
    if (!record) throw new PluginError('plugin_not_installed', name)
    record.enabled = enabled
    record.failures = 0
    await this.save()
  }
  async recordFailure(name: string, threshold = 3) {
    const record = ownApproval(this.state.approvals, name)
    if (!Number.isSafeInteger(threshold) || threshold <= 0 || threshold > PLUGIN_STATE_MAX_FAILURES)
      throw legacyPluginUnavailable('plugin failure threshold')
    if (!record) return false
    record.failures = Math.min((record.failures ?? 0) + 1, PLUGIN_STATE_MAX_FAILURES)
    if (record.failures >= threshold) record.enabled = false
    await this.save()
    return !record.enabled
  }
  async uninstall(name: string) {
    assertPluginName(name)
    await rm(join(this.root, name), { recursive: true, force: true })
    if (Object.hasOwn(this.state.approvals, name)) delete this.state.approvals[name]
    await this.save()
  }
  list() {
    return nullPrototypeApprovals(
      Object.entries(this.state.approvals).map(
        ([name, approval]) => [name, structuredClone(approval)] as const,
      ),
    )
  }
}

export type BridgeCapabilityStatus = 'supported' | 'unsupported'
export interface BridgeCapability {
  readonly method: string
  readonly status: BridgeCapabilityStatus
  readonly test: string
  readonly reason?: string
}

/**
 * Auditable contract for every leaf on ApolloBridge. Keep this data-only so CI and
 * documentation can compare the public SDK with the production host without mocks.
 */
export const APOLLO_BRIDGE_CAPABILITIES: readonly BridgeCapability[] = Object.freeze([
  ...[
    'tools.register',
    'tools.unregister',
    'hooks.on',
    'hooks.off',
    'hooks.kv.get',
    'hooks.kv.set',
    'hooks.kv.delete',
    'hooks.kv.clear',
    'commands.register',
    'prompt.contribute',
    'prompt.revoke',
    'session.getMessages',
    'session.getUsage',
    'session.on',
    'fs.readFile',
    'fs.writeFile',
    'fs.exists',
    'fs.glob',
    'fs.stat',
    'exec',
    'http.fetch',
    'ui.confirm',
    'ui.prompt',
    'ui.pick',
    'ui.notify',
    'storage.get',
    'storage.set',
    'storage.delete',
    'memory.get',
    'memory.list',
    'memory.search',
    'memory.create',
    'memory.update',
    'memory.delete',
    'memory.export',
    'config.get',
    'log.debug',
    'log.info',
    'log.warn',
    'log.error',
  ].map((method) => ({
    method,
    status: 'supported' as const,
    test: 'packages/plugin-runtime/src/index.test.ts#ApolloBridge capability matrix',
  })),
  {
    method: 'call',
    status: 'unsupported' as const,
    reason: 'Low-level calls are transport-only; there is no direct in-process handler.',
    test: 'packages/plugin-runtime/src/index.test.ts#ApolloBridge capability matrix',
  },
  ...['provider.register', 'auth.getAuthHeaders', 'auth.getSigningEnvKeys'].map((method) => ({
    method,
    status: 'unsupported' as const,
    reason: 'Declared by the provider-plugin design but not exposed by ApolloBridge yet.',
    test: 'packages/plugin-runtime/src/provider.test.ts#provider plugin policy',
  })),
])

export interface PluginRuntimeOptions {
  dataRoot: string
  activationTimeoutMs?: number
  heartbeatTimeoutMs?: number
}
export class PluginRuntime {
  constructor(
    readonly manager: PluginManager,
    readonly bridge: BridgeRuntime,
    readonly options: PluginRuntimeOptions,
  ) {}
  async loadEnabled(): Promise<Array<{ name: string; error: Error }>> {
    return []
  }
  async load(_name: string, _signal?: AbortSignal): Promise<never> {
    throw legacyPluginUnavailable('plugin activation')
  }
  async deactivate(name: string) {
    await this.bridge.deactivate(name)
  }
  async setEnabled(name: string, enabled: boolean) {
    if (!enabled) await this.deactivate(name)
    await this.manager.setEnabled(name, enabled)
  }
  async uninstall(name: string) {
    await this.deactivate(name)
    await this.manager.uninstall(name)
  }
  async dispose() {}
  active() {
    return []
  }
}
export function createRpcGuard(manifest: PluginManifest, maxCallsPerTurn = 500) {
  const allowed = new Set(manifest.permissions.apollo),
    calls = new Map<string, number>()
  return (turnId: string, method: string) => {
    if (!allowed.has(method)) throw new PluginError('plugin_rpc_method_denied', method)
    const count = (calls.get(turnId) ?? 0) + 1
    calls.set(turnId, count)
    if (count > maxCallsPerTurn) throw new PluginError('plugin_rpc_quota_exceeded', method)
  }
}

export type CredentialReader = (scope: string) => Promise<string | undefined>
export type SigningCredentialReader = (
  scope: string,
  envKeys: readonly string[],
) => Promise<Readonly<Record<string, string>>>

export interface SigningEnvironmentScope {
  dispose(): void | Promise<void>
}

export interface SigningEnvironment {
  open(environment: Readonly<Record<string, string>>): Promise<SigningEnvironmentScope>
}

export function redactSigningValues(
  value: unknown,
  environment: Readonly<Record<string, string>>,
): unknown {
  const secrets = Object.values(environment).filter(Boolean)
  const redactString = (text: string) =>
    secrets.reduce((result, secret) => result.replaceAll(secret, '[REDACTED]'), text)
  const visit = (item: unknown): unknown => {
    if (typeof item === 'string') return redactString(item)
    if (Array.isArray(item)) return item.map(visit)
    if (item && typeof item === 'object')
      return Object.fromEntries(
        Object.entries(item).map(([key, nested]) => [
          key,
          Object.hasOwn(environment, key) ? '[REDACTED]' : visit(nested),
        ]),
      )
    return item
  }
  return visit(value)
}

export function renderAuthHeaders(template: string, key: string): Record<string, string> {
  const separator = template.indexOf(':')
  if (separator < 1)
    throw new PluginError('plugin_auth_template_invalid', 'missing header separator')
  const name = template.slice(0, separator).trim()
  const value = template
    .slice(separator + 1)
    .trim()
    .replaceAll('{{key}}', key)
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\r\n]/.test(value))
    throw new PluginError('plugin_auth_template_invalid', 'invalid header name or value')
  return { [name]: value }
}

export interface ProviderStreamTransport {
  stream(
    providerName: string,
    request: ProviderRequest & { authHeaders: Record<string, string> },
    signal: AbortSignal,
  ): AsyncIterable<ProviderChunk>
  dispose(): Promise<void>
}

export function registerProviderPlugin(options: {
  manifest: PluginManifest
  capabilities: ProviderCapabilities
  registry: ProviderRegistry
  credentials: CredentialReader
  signing?: {
    approve(manifest: PluginManifest): Promise<boolean>
    credentials: SigningCredentialReader
    environment: SigningEnvironment
  }
  transport: ProviderStreamTransport
}): ProviderDisposable {
  const { manifest, capabilities, registry, credentials, signing, transport } = options
  if (manifest.kind !== 'provider' || !manifest.provider)
    throw new PluginError('plugin_provider_invalid', 'not a provider plugin')
  const provider = manifest.provider
  const client: ProviderClient = {
    name: provider.name,
    capabilities: Object.freeze(structuredClone(capabilities)),
    async *stream(request, signal) {
      if (provider.auth.mode === 'header-template') {
        const key = await credentials(provider.auth.credentialScope)
        const authHeaders = key ? renderAuthHeaders(provider.auth.headerTemplate, key) : {}
        yield* transport.stream(provider.name, { ...request, authHeaders }, signal)
        return
      }
      if (!signing || !(await signing.approve(manifest)))
        throw new PluginError('plugin_signing_approval_required', provider.name)
      const declaredKeys = provider.auth.signing.envKeys
      const values = await signing.credentials(provider.auth.credentialScope, declaredKeys)
      const environment = Object.fromEntries(
        declaredKeys.filter((key) => values[key] !== undefined).map((key) => [key, values[key]!]),
      )
      if (Object.keys(environment).length !== declaredKeys.length)
        throw new PluginError('plugin_signing_credentials_missing', provider.name)
      const scope = await signing.environment.open(environment)
      try {
        yield* transport.stream(provider.name, { ...request, authHeaders: {} }, signal)
      } finally {
        await scope.dispose()
      }
    },
    dispose: () => transport.dispose(),
  }
  const meta = {
    capabilities: client.capabilities,
    displayName: provider.displayName,
    ...(provider.models ? { models: provider.models } : {}),
  }
  return registry.register(client, { kind: 'plugin', plugin: manifest.name }, meta)
}

export class BufferedProviderStream {
  private bytes = 0
  constructor(private readonly maxBytes = 4 * 1024 * 1024) {}
  accept(chunk: ProviderChunk) {
    this.bytes += Buffer.byteLength(JSON.stringify(chunk))
    if (this.bytes > this.maxBytes)
      throw new PluginError('stream_truncated', 'provider stream buffer exceeded')
    return chunk
  }
  consume(chunk: ProviderChunk) {
    this.bytes = Math.max(0, this.bytes - Buffer.byteLength(JSON.stringify(chunk)))
  }
}

const BRIDGE_PERMISSIONS: Readonly<Record<string, string>> = Object.freeze({
  'tools.register': 'tools.register',
  'tools.unregister': 'tools.register',
  'hooks.on': 'hooks.on',
  'hooks.off': 'hooks.on',
  'hooks.kv.get': 'hooks.on',
  'hooks.kv.set': 'hooks.on',
  'hooks.kv.delete': 'hooks.on',
  'hooks.kv.clear': 'hooks.on',
  'commands.register': 'commands.register',
  'prompt.contribute': 'prompt.contribute',
  'prompt.revoke': 'prompt.contribute',
  'session.read': 'session.read',
  'session.on': 'session.read',
  'fs.readFile': 'fs.read',
  'fs.exists': 'fs.read',
  'fs.glob': 'fs.read',
  'fs.stat': 'fs.read',
  'fs.writeFile': 'fs.write',
  exec: 'exec',
  'http.fetch': 'http.fetch',
  'ui.confirm': 'ui.confirm',
  'ui.prompt': 'ui.prompt',
  'ui.pick': 'ui.pick',
  'ui.notify': 'ui.notify',
  'storage.get': 'storage.read',
  'storage.set': 'storage.write',
  'storage.delete': 'storage.write',
  'memory.get': 'memory.read',
  'memory.list': 'memory.read',
  'memory.search': 'memory.search',
  'memory.create': 'memory.write',
  'memory.update': 'memory.write',
  'memory.delete': 'memory.write',
  'memory.export': 'memory.export',
  'config.get': 'config.read',
  'log.write': 'log.write',
})

export interface BridgeSessionSnapshot {
  readonly id: string
  readonly cwd: string
  readonly messages: readonly unknown[]
  readonly usage: Readonly<{ inputTokens: number; outputTokens: number; cost?: number }>
}
export interface BridgeHost {
  readonly session: BridgeSessionSnapshot
  register(kind: 'tool' | 'command' | 'prompt' | 'ui', value: unknown, plugin: string): Disposable
  fs: {
    readFile(path: string, encoding?: string): Promise<string | Uint8Array>
    writeFile(path: string, data: string | Uint8Array): Promise<void>
    exists(path: string): Promise<boolean>
    glob(pattern: string, cwd: string): Promise<string[]>
    stat(path: string): Promise<unknown>
  }
  exec(command: string, options: unknown, signal: AbortSignal): Promise<unknown>
  fetch(url: string, init: unknown, signal: AbortSignal): Promise<unknown>
  ui(method: 'confirm' | 'prompt' | 'pick' | 'notify', params: unknown): unknown
  storage(
    plugin: string,
    operation: 'get' | 'set' | 'delete',
    key: string,
    value?: unknown,
  ): Promise<unknown>
  memory?(
    plugin: string,
    operation: 'get' | 'list' | 'search' | 'create' | 'update' | 'delete' | 'export',
    params: unknown,
  ): Promise<unknown>
  config(plugin: string, key: string): unknown
  log(level: string, message: string, meta?: unknown): void
}

/**
 * Hook source domain (spec 02-agent-loop.md §2.6, r13-I10). `builtin` marks hooks
 * registered by the Apollo runtime itself (e.g. the memory redaction guard); they run
 * first and fail closed on timeout or error. Plugins register through the bridge and
 * are always `plugin`. `project` / `user` are host-controlled registration domains for
 * `<cwd>/.apollo/hooks` and `~/.apollo/hooks`.
 */
export type HostHookDomain = 'builtin' | 'project' | 'user'
export type HookDomain = HostHookDomain | 'plugin'

/** Per-handler timeout for intercepting hooks (spec §2.6 执行语义: 超时 5 秒). */
export const HOOK_HANDLER_TIMEOUT_MS = 5_000
/** Hard byte limit for builtin (security) hook payloads before dispatch. */
export const BUILTIN_HOOK_PAYLOAD_LIMIT_BYTES = 1024 * 1024

const HOST_DOMAIN_PRIORITY_BANDS = {
  builtin: { min: 900, max: 1000, priority: 1000 },
  project: { min: 500, max: 899, priority: 600 },
  user: { min: -1000, max: -1, priority: -1000 },
} as const

// Domain rank wins over numeric priority so no plugin/user hook can ever preempt a
// builtin security hook, regardless of the priority dialect in use (see PR notes for
// the 900–1000 vs -100..100 spec tension).
const HOOK_DOMAIN_ORDER: Record<HookDomain, number> = {
  builtin: 0,
  project: 1,
  plugin: 2,
  user: 3,
}

/**
 * Telemetry / error signals surfaced by {@link BridgeRuntime.runDomainHooks}. The
 * composition layer maps builtin fail-closed signals to `error.raised` events and
 * logs/records the fail-open signals.
 */
export type HookPipelineSignal =
  | {
      kind: 'builtin_hook_timeout'
      code: 'builtin_hook_timeout'
      domain: 'builtin'
      hook: string
      event: HookEvent
      timeoutMs: number
    }
  | {
      kind: 'builtin_hook_error'
      code: 'builtin_hook_error'
      domain: 'builtin'
      hook: string
      event: HookEvent
      message: string
    }
  | {
      kind: 'hook_skipped'
      code: 'hook_skipped'
      domain: HookDomain
      hook: string
      event: HookEvent
      cause: 'timeout' | 'error'
      message: string
    }
  | {
      kind: 'builtin_hook_payload_too_large'
      code: 'builtin_hook_payload_too_large'
      domain: 'builtin'
      hook: string
      event: HookEvent
      limitBytes: number
      rawBytes: number
      rawDigest: `sha256:${string}`
      scanStatus: 'not_started'
      scannedBytes: 0
      scannedDigest: null
      decision: 'veto'
    }

export interface RunDomainHooksOptions {
  signal?: AbortSignal
  toolUseId?: string
  /** Per-handler timeout; defaults to {@link HOOK_HANDLER_TIMEOUT_MS}. */
  timeoutMs?: number
  /** Observability channel for fail-closed / fail-open signals. */
  report?: (signal: HookPipelineSignal) => void
}

type HookRecord = {
  plugin: string
  domain: HookDomain
  event: HookEvent
  handler: HookHandler
  priority: number
  order: number
  memoryScopes: readonly PluginMemoryScope[]
}
const clone = <T>(value: T): T => structuredClone(value)
const isWithin = (root: string, candidate: string) => {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}
const matchesHost = (host: string, rule: string) =>
  host === rule || (rule.startsWith('*.') && host.endsWith(rule.slice(1)))
const matchesCommand = (command: string, rule: string) =>
  rule.endsWith(' *')
    ? command === rule.slice(0, -2) || command.startsWith(rule.slice(0, -1))
    : command === rule
const redact = (value: unknown): unknown => {
  if (typeof value === 'string')
    return value.replace(/(?:bearer\s+|sk-|api[_-]?key[=:]\s*)[^\s,;]+/giu, '[REDACTED]')
  if (Array.isArray(value)) return value.map(redact)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /token|secret|password|authorization|api.?key/i.test(key) ? '[REDACTED]' : redact(item),
      ]),
    )
  return value
}

type HookPayloadMeasurement = {
  rawBytes: number
  rawDigest: `sha256:${string}`
}

const HOOK_JSON_V1_MAX_DEPTH = 512
const HOOK_JSON_V1_MAX_NODES = 200_000
const HOOK_JSON_V1_MAX_WORK_BYTES = 16 * 1024 * 1024
const HOOK_JSON_V1_BYTES_TAG = '$apollo.bytes.v1'
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype) as object
const typedArraySlotGetter = <T>(key: 'buffer' | 'byteOffset' | 'byteLength') => {
  const getter = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, key)?.get
  if (!getter) throw new TypeError(`missing intrinsic TypedArray ${key} getter`)
  return (value: Uint8Array): T => Reflect.apply(getter, value, []) as T
}
const getTypedArrayBuffer = typedArraySlotGetter<ArrayBufferLike>('buffer')
const getTypedArrayByteOffset = typedArraySlotGetter<number>('byteOffset')
const getTypedArrayByteLength = typedArraySlotGetter<number>('byteLength')
const isUnsupportedHookExotic = (value: object) =>
  nodeTypes.isProxy(value) ||
  nodeTypes.isAnyArrayBuffer(value) ||
  nodeTypes.isArrayBufferView(value) ||
  nodeTypes.isMap(value) ||
  nodeTypes.isSet(value) ||
  nodeTypes.isWeakMap(value) ||
  nodeTypes.isWeakSet(value) ||
  nodeTypes.isDate(value) ||
  nodeTypes.isRegExp(value) ||
  nodeTypes.isNativeError(value) ||
  nodeTypes.isPromise(value)

/**
 * Canonical JSON-v1 for the builtin hook size boundary. Keys are sorted by UTF-16 code
 * unit order, Uint8Array attachment bytes use a reserved base64 tag, and only strict
 * JSON data is accepted. Encoding is fed incrementally into SHA-256 so an oversized
 * string does not create a second full-payload copy. Unsupported/resource-exhausting
 * values fail closed instead of being silently dropped/coerced by JSON.stringify.
 */
const measureHookPayloadJsonV1 = (value: unknown): HookPayloadMeasurement => {
  const hash = createHash('sha256')
  let rawBytes = 0
  let nodes = 0
  const active = new WeakSet<object>()
  const write = (chunk: string) => {
    const bytes = Buffer.byteLength(chunk, 'utf8')
    const nextBytes = rawBytes + bytes
    if (!Number.isSafeInteger(nextBytes) || nextBytes > HOOK_JSON_V1_MAX_WORK_BYTES)
      throw new TypeError('hook JSON-v1 canonical work limit exceeded')
    rawBytes = nextBytes
    hash.update(chunk, 'utf8')
  }
  const writeString = (text: string) => {
    write('"')
    for (let offset = 0; offset < text.length;) {
      let end = Math.min(text.length, offset + 8_192)
      const last = text.charCodeAt(end - 1)
      const next = text.charCodeAt(end)
      if (end < text.length && last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff)
        end++
      const encoded = JSON.stringify(text.slice(offset, end))
      write(encoded.slice(1, -1))
      offset = end
    }
    write('"')
  }
  const encode = (node: unknown, depth: number): void => {
    nodes++
    if (nodes > HOOK_JSON_V1_MAX_NODES) throw new TypeError('hook JSON-v1 node limit exceeded')
    if (depth > HOOK_JSON_V1_MAX_DEPTH) throw new TypeError('hook JSON-v1 depth limit exceeded')
    if (node === null) {
      write('null')
      return
    }
    if (typeof node === 'string') {
      writeString(node)
      return
    }
    if (typeof node === 'boolean') {
      write(node ? 'true' : 'false')
      return
    }
    if (typeof node === 'number') {
      if (!Number.isFinite(node) || Object.is(node, -0))
        throw new TypeError('hook JSON-v1 contains an unsupported number')
      write(JSON.stringify(node))
      return
    }
    if (typeof node !== 'object')
      throw new TypeError(`hook JSON-v1 contains unsupported ${typeof node} data`)
    const isUint8Array = nodeTypes.isUint8Array(node)
    if (!isUint8Array && isUnsupportedHookExotic(node))
      throw new TypeError('hook JSON-v1 contains an unsupported exotic object')
    if (active.has(node)) throw new TypeError('hook JSON-v1 contains a cycle')
    active.add(node)
    try {
      if (isUint8Array) {
        // Read the view's internal slots through the realm intrinsic. A Uint8Array
        // subclass can override the public properties, but the canonical preimage
        // and strict clone must remain bound to its real backing bytes.
        const bytes = node as Uint8Array
        const buffer = getTypedArrayBuffer(bytes)
        const byteOffset = getTypedArrayByteOffset(bytes)
        const byteLength = getTypedArrayByteLength(bytes)
        if (nodeTypes.isSharedArrayBuffer(buffer))
          throw new TypeError('hook JSON-v1 contains shared mutable bytes')
        write(`{"${HOOK_JSON_V1_BYTES_TAG}":"`)
        const bytesPerChunk = 12_288
        for (let offset = 0; offset < byteLength; offset += bytesPerChunk) {
          const length = Math.min(bytesPerChunk, byteLength - offset)
          write(Buffer.from(buffer, byteOffset + offset, length).toString('base64'))
        }
        write('"}')
        return
      }
      if (Array.isArray(node)) {
        if (nodes + node.length > HOOK_JSON_V1_MAX_NODES)
          throw new TypeError('hook JSON-v1 node limit exceeded')
        const keys = Reflect.ownKeys(node)
        if (nodes + keys.length - 1 > HOOK_JSON_V1_MAX_NODES)
          throw new TypeError('hook JSON-v1 node limit exceeded')
        if (keys.length !== node.length + 1)
          throw new TypeError('hook JSON-v1 contains a sparse or extended array')
        if (
          keys.some((key) => {
            if (key === 'length') return false
            if (typeof key !== 'string') return true
            const index = Number(key)
            return (
              !Number.isInteger(index) || index < 0 || index >= node.length || String(index) !== key
            )
          })
        )
          throw new TypeError('hook JSON-v1 contains a sparse or extended array')
        write('[')
        for (let index = 0; index < node.length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(node, index)
          if (!descriptor?.enumerable || !('value' in descriptor))
            throw new TypeError('hook JSON-v1 contains a sparse or extended array')
          if (index > 0) write(',')
          encode(descriptor.value, depth + 1)
        }
        write(']')
        return
      }
      const prototype = Object.getPrototypeOf(node)
      if (prototype !== Object.prototype && prototype !== null)
        throw new TypeError('hook JSON-v1 contains a non-plain object')
      const ownKeys = Reflect.ownKeys(node)
      if (nodes + ownKeys.length > HOOK_JSON_V1_MAX_NODES)
        throw new TypeError('hook JSON-v1 node limit exceeded')
      const stringKeys: string[] = []
      let unsortedKeyBytes = 0
      for (const key of ownKeys) {
        if (typeof key !== 'string') throw new TypeError('hook JSON-v1 contains a symbol key')
        unsortedKeyBytes += Buffer.byteLength(key, 'utf8')
        if (
          !Number.isSafeInteger(unsortedKeyBytes) ||
          unsortedKeyBytes > HOOK_JSON_V1_MAX_WORK_BYTES
        )
          throw new TypeError('hook JSON-v1 canonical work limit exceeded')
        stringKeys.push(key)
      }
      const keys = stringKeys.toSorted()
      if (keys.includes(HOOK_JSON_V1_BYTES_TAG))
        throw new TypeError('hook JSON-v1 contains a reserved field')
      write('{')
      for (const [index, key] of keys.entries()) {
        const descriptor = Object.getOwnPropertyDescriptor(node, key)
        if (!descriptor?.enumerable || !('value' in descriptor))
          throw new TypeError('hook JSON-v1 contains a hidden or accessor field')
        if (index > 0) write(',')
        writeString(key)
        write(':')
        encode(descriptor.value, depth + 1)
      }
      write('}')
    } finally {
      active.delete(node)
    }
  }
  encode(value, 0)
  return {
    rawBytes,
    rawDigest: `sha256:${hash.digest('hex')}`,
  }
}

/**
 * Clone only the strict data model accepted by {@link measureHookPayloadJsonV1}.
 * In particular, byte views become tight copies: structuredClone preserves the
 * entire backing ArrayBuffer and could otherwise copy or expose unmeasured bytes.
 * The caller must measure/validate the input immediately before calling this.
 */
const cloneHookPayloadJsonV1 = (value: unknown): unknown => {
  const cloneNode = (node: unknown): unknown => {
    if (node === null || ['string', 'boolean', 'number'].includes(typeof node)) return node
    if (typeof node !== 'object') throw new TypeError('hook JSON-v1 clone received invalid data')
    if (nodeTypes.isUint8Array(node)) {
      const bytes = node as Uint8Array
      const buffer = getTypedArrayBuffer(bytes)
      const byteOffset = getTypedArrayByteOffset(bytes)
      const byteLength = getTypedArrayByteLength(bytes)
      if (nodeTypes.isSharedArrayBuffer(buffer))
        throw new TypeError('hook JSON-v1 clone received shared mutable bytes')
      const tight = new Uint8Array(byteLength)
      tight.set(new Uint8Array(buffer, byteOffset, byteLength))
      return tight
    }
    if (Array.isArray(node)) {
      const copy: unknown[] = []
      copy.length = node.length
      for (let index = 0; index < node.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(node, index)
        if (!descriptor || !('value' in descriptor))
          throw new TypeError('hook JSON-v1 clone received invalid array data')
        copy[index] = cloneNode(descriptor.value)
      }
      return copy
    }
    const copy: Record<string, unknown> = {}
    const stringKeys: string[] = []
    for (const key of Reflect.ownKeys(node)) {
      if (typeof key !== 'string')
        throw new TypeError('hook JSON-v1 clone received invalid object data')
      stringKeys.push(key)
    }
    for (const key of stringKeys.toSorted()) {
      const descriptor = Object.getOwnPropertyDescriptor(node, key)
      if (!descriptor || !('value' in descriptor))
        throw new TypeError('hook JSON-v1 clone received invalid object data')
      Object.defineProperty(copy, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: cloneNode(descriptor.value),
      })
    }
    return copy
  }
  return cloneNode(value)
}

export class BridgeRuntime {
  readonly #hooks: HookRecord[] = []
  readonly #disposables = new Map<string, Set<Disposable>>()
  readonly #kv = new Map<string, Map<string, unknown>>()
  #order = 0
  constructor(
    readonly host: BridgeHost,
    readonly options: { timeoutMs?: number; maxCallsPerTurn?: number; hookKvBytes?: number } = {},
  ) {}

  registerUiContributions(manifest: PluginManifest) {
    for (const contribution of manifest.contributes?.ui ?? []) {
      const disposable = this.host.register('ui', clone(contribution), manifest.name)
      const set = this.#disposables.get(manifest.name) ?? new Set<Disposable>()
      set.add(disposable)
      this.#disposables.set(manifest.name, set)
    }
  }

  create(manifest: PluginManifest, dataDir: string, turnId = 'activation'): ApolloBridge {
    const guard = createRpcGuard(
      {
        ...manifest,
        permissions: {
          ...manifest.permissions,
          apollo: manifest.permissions.apollo.map((method) => BRIDGE_PERMISSIONS[method] ?? method),
        },
      },
      this.options.maxCallsPerTurn ?? 500,
    )
    const check = (method: string) => guard(turnId, BRIDGE_PERMISSIONS[method] ?? method)
    const track = (disposable: Disposable) => {
      const set = this.#disposables.get(manifest.name) ?? new Set<Disposable>()
      set.add(disposable)
      this.#disposables.set(manifest.name, set)
      return disposable
    }
    const register = (kind: 'tool' | 'command' | 'prompt', value: unknown, method: string) => {
      check(method)
      return track(this.host.register(kind, value, manifest.name))
    }
    const pathFor = async (input: string, mode: 'read' | 'write') => {
      const candidate = resolve(this.host.session.cwd, input)
      const canonical = await realpath(mode === 'write' ? dirname(candidate) : candidate).then(
        (p) => (mode === 'write' ? join(p, basename(candidate)) : p),
      )
      const roots = await Promise.all(
        (manifest.permissions.fs?.[mode] ?? []).map(async (path) => {
          const root = resolve(this.host.session.cwd, path.replace(/[*?].*$/, ''))
          return realpath(root).catch(() => root)
        }),
      )
      if (!roots.some((root) => isWithin(root, canonical)))
        throw new PluginError('plugin_fs_denied', input)
      return canonical
    }
    const invoke = async <T>(
      method: string,
      task: (signal: AbortSignal) => Promise<T>,
      external?: AbortSignal,
    ) => {
      check(method)
      const controller = new AbortController(),
        timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 10_000)
      const abort = () => controller.abort()
      external?.addEventListener('abort', abort, { once: true })
      try {
        return await task(controller.signal)
      } finally {
        clearTimeout(timeout)
        external?.removeEventListener('abort', abort)
      }
    }
    const bridge: ApolloBridge = {
      apiVersion: '1.0',
      plugin: Object.freeze({ name: manifest.name, version: manifest.version, dataDir }),
      tools: {
        register: (spec) => register('tool', spec, 'tools.register'),
        unregister: () => check('tools.unregister'),
      },
      hooks: {
        on: (event, handler, options) => {
          check('hooks.on')
          if (event.startsWith('memory.') && !manifest.permissions.memory?.read?.length)
            throw new PluginError('plugin_memory_hook_scope_required', event)
          const priority = options?.priority ?? 0
          if (!Number.isSafeInteger(priority) || priority < -100 || priority > 100)
            throw new PluginError('plugin_hook_priority_invalid', event)
          const record = {
            plugin: manifest.name,
            domain: 'plugin' as const,
            event,
            handler,
            priority,
            order: this.#order++,
            memoryScopes: manifest.permissions.memory?.read ?? [],
          }
          this.#hooks.push(record)
          return track({ dispose: () => this.removeHook(record) })
        },
        off: (event, handler) => {
          check('hooks.off')
          for (const item of this.#hooks.filter(
            (h) => h.plugin === manifest.name && h.event === event && h.handler === handler,
          ))
            this.removeHook(item)
        },
        kv: {
          get: <T = unknown>(key: string) => {
            check('hooks.kv.get')
            return clone(this.hookKv(manifest.name, turnId).get(key)) as T | undefined
          },
          set: (key, value) => {
            check('hooks.kv.set')
            const store = this.hookKv(manifest.name, turnId)
            const next = new Map(store).set(key, clone(value))
            if (Buffer.byteLength(JSON.stringify([...next])) > (this.options.hookKvBytes ?? 65_536))
              throw new PluginError('plugin_hook_kv_quota_exceeded', key)
            store.set(key, clone(value))
          },
          delete: (key) => {
            check('hooks.kv.delete')
            this.hookKv(manifest.name, turnId).delete(key)
          },
          clear: () => {
            check('hooks.kv.clear')
            this.hookKv(manifest.name, turnId).clear()
          },
        },
      },
      commands: { register: (spec) => register('command', spec, 'commands.register') },
      prompt: {
        contribute: (fragment) => register('prompt', fragment, 'prompt.contribute'),
        revoke: () => check('prompt.revoke'),
      },
      session: {
        id: this.host.session.id,
        cwd: this.host.session.cwd,
        getMessages: (range) => {
          check('session.read')
          return clone(
            this.host.session.messages.slice(-(range?.limit ?? this.host.session.messages.length)),
          ) as never
        },
        getUsage: () => {
          check('session.read')
          return clone(this.host.session.usage)
        },
        on: () => {
          check('session.on')
          return track({ dispose() {} })
        },
      },
      fs: {
        readFile: (path, encoding) =>
          invoke('fs.readFile', async () =>
            this.host.fs.readFile(await pathFor(path, 'read'), encoding),
          ),
        writeFile: (path, data) =>
          invoke('fs.writeFile', async () =>
            this.host.fs.writeFile(await pathFor(path, 'write'), data),
          ),
        exists: (path) =>
          invoke('fs.exists', async () => this.host.fs.exists(await pathFor(path, 'read'))),
        glob: (pattern) =>
          invoke('fs.glob', async () => {
            await pathFor(pattern.replace(/[*?].*$/, '') || '.', 'read')
            return this.host.fs.glob(pattern, this.host.session.cwd)
          }),
        stat: (path) =>
          invoke('fs.stat', async () => this.host.fs.stat(await pathFor(path, 'read'))) as never,
      },
      exec: (command, options) =>
        invoke(
          'exec',
          async (signal) => {
            if (!manifest.permissions.bash?.allowlist.some((rule) => matchesCommand(command, rule)))
              throw new PluginError('plugin_exec_denied', command)
            return this.host.exec(command, clone(options), signal) as never
          },
          options?.signal,
        ) as never,
      http: {
        fetch: (url, init) =>
          invoke('http.fetch', async (signal) => {
            const parsed = new URL(url)
            if (
              parsed.protocol !== 'https:' ||
              !manifest.permissions.net ||
              !manifest.permissions.net.allowlist.some((rule) => matchesHost(parsed.hostname, rule))
            )
              throw new PluginError('plugin_net_denied', parsed.hostname)
            return this.host.fetch(url, clone(init), signal)
          }),
      },
      ui: {
        confirm: (message) => {
          check('ui.confirm')
          return this.host.ui('confirm', { message }) as Promise<boolean>
        },
        prompt: (question, options) => {
          check('ui.prompt')
          return this.host.ui('prompt', { question, options }) as Promise<string | null>
        },
        pick: (options, settings) => {
          check('ui.pick')
          return this.host.ui('pick', {
            options: clone(options),
            labels: settings ? options.map(settings.label) : undefined,
          }) as Promise<never>
        },
        notify: (message, level) => {
          check('ui.notify')
          this.host.ui('notify', { message, level })
        },
      },
      storage: {
        get: (key) => {
          check('storage.get')
          return this.host.storage(manifest.name, 'get', key) as never
        },
        set: (key, value) => {
          check('storage.set')
          return this.host.storage(manifest.name, 'set', key, clone(value)) as Promise<void>
        },
        delete: (key) => {
          check('storage.delete')
          return this.host.storage(manifest.name, 'delete', key) as Promise<void>
        },
      },
      memory: {
        get: (scope, id) => this.#memoryCall(manifest, check, 'get', { scope, id }) as never,
        list: (scope, options) =>
          this.#memoryCall(manifest, check, 'list', { scope, options }) as never,
        search: (scope, query, options) =>
          this.#memoryCall(manifest, check, 'search', { scope, query, options }) as never,
        create: (input) => this.#memoryCall(manifest, check, 'create', input) as never,
        update: (scope, id, patch) =>
          this.#memoryCall(manifest, check, 'update', { scope, id, patch }) as never,
        delete: (scope, id) => this.#memoryCall(manifest, check, 'delete', { scope, id }) as never,
        export: (scope) => this.#memoryCall(manifest, check, 'export', { scope }) as never,
      },
      config: {
        get: (key) => {
          check('config.get')
          if (!Object.prototype.hasOwnProperty.call(manifest.config ?? {}, key))
            throw new PluginError('plugin_config_undeclared', key)
          return clone(this.host.config(manifest.name, key)) as never
        },
      },
      log: Object.fromEntries(
        ['debug', 'info', 'warn', 'error'].map((level) => [
          level,
          (message: string, ...args: unknown[]) => {
            check('log.write')
            this.host.log(level, redact(message) as string, redact(args))
          },
        ]),
      ) as ApolloBridge['log'],
      call: async (method, _params) => {
        check(method)
        throw new PluginError('plugin_rpc_transport_only', `No direct handler for ${method}`)
      },
    }
    return Object.freeze(bridge)
  }

  async #memoryCall(
    manifest: PluginManifest,
    check: (method: string) => void,
    operation: 'get' | 'list' | 'search' | 'create' | 'update' | 'delete' | 'export',
    params: unknown,
  ): Promise<unknown> {
    check(`memory.${operation}`)
    if (!this.host.memory) throw new PluginError('plugin_memory_unavailable', operation)
    const scope =
      params && typeof params === 'object' && 'scope' in params
        ? (params as { scope?: unknown }).scope
        : undefined
    if (scope !== 'workspace' && scope !== 'project' && scope !== 'session')
      throw new PluginError('plugin_memory_scope_denied', String(scope))
    const permission = manifest.permissions.memory
    const readable = permission?.read?.includes(scope)
    if ((operation === 'get' || operation === 'list') && !readable)
      throw new PluginError('plugin_memory_scope_denied', scope)
    if (operation === 'search' && (!permission?.search || !readable))
      throw new PluginError('plugin_memory_scope_denied', scope)
    if (operation === 'export' && (!permission?.export || !readable))
      throw new PluginError('plugin_memory_scope_denied', scope)
    if (
      (operation === 'create' || operation === 'update' || operation === 'delete') &&
      (!permission?.write || !readable)
    )
      throw new PluginError('plugin_memory_write_denied', operation)
    return this.host.memory(manifest.name, operation, clone(params))
  }

  async runHooks(
    event: HookEvent,
    payload: unknown,
    options: { signal?: AbortSignal; toolUseId?: string } = {},
  ): Promise<HookResult | undefined> {
    if (event.startsWith('memory.'))
      throw new PluginError('plugin_memory_hook_dispatch_required', event)
    return (await this.#runHooks(event, payload, options))?.result
  }

  async runMemoryHooks(
    event: Extract<HookEvent, `memory.${string}`>,
    payload: PluginMemoryHookPayload,
    options: { signal?: AbortSignal } = {},
  ): Promise<{ plugin: string; result: HookResult } | undefined> {
    return this.#runHooks(event, payload, options, (hook) =>
      hook.memoryScopes.includes(payload.scope),
    )
  }

  /**
   * Register a host-owned hook (builtin security hook, project hook, or user hook).
   * Priority bands follow spec 06b §6.11.1 per domain; out-of-band priorities are
   * rejected at registration time so no host hook can masquerade as another domain.
   */
  registerHostHook(
    domain: HostHookDomain,
    event: HookEvent,
    handler: HookHandler,
    options: { priority?: number; name?: string } = {},
  ): Disposable {
    const band = HOST_DOMAIN_PRIORITY_BANDS[domain]
    const priority = options.priority ?? band.priority
    if (!Number.isSafeInteger(priority) || priority < band.min || priority > band.max)
      throw new PluginError('plugin_hook_priority_invalid', `${domain}:${event}`)
    const record: HookRecord = {
      plugin: options.name ?? `apollo.${domain}`,
      domain,
      event,
      handler,
      priority,
      order: this.#order++,
      // Host hooks are trusted: they observe every memory scope.
      memoryScopes: ['workspace', 'project', 'session'],
    }
    this.#hooks.push(record)
    return { dispose: () => this.removeHook(record) }
  }

  /**
   * Domain-aware intercepting-hook dispatch (spec 02-agent-loop.md §2.6, r13-I10):
   * handlers run as a serial pipeline where each handler may rewrite the payload for
   * the next one; a veto short-circuits the chain. Per-handler timeout defaults to 5s
   * and its consequence is split by hook domain:
   * - `builtin` timeout or exception -> fail-closed: the outcome is a veto and
   *   `builtin_hook_timeout` / `builtin_hook_error` is reported for `error.raised`.
   * - `plugin` / `project` / `user` timeout or exception -> fail-open: the handler is
   *   skipped (`hook_skipped` reported) and the pipeline continues.
   * Every builtin input and non-veto rewrite passes strict JSON-v1 measurement. A
   * serialized payload over 1MiB is never truncated or scanned: it is rejected before
   * the next consumer with honest `scanStatus: not_started` evidence.
   */
  async runDomainHooks(
    event: HookEvent,
    payload: unknown,
    options: RunDomainHooksOptions = {},
  ): Promise<HookResult | undefined> {
    if (event.startsWith('memory.'))
      throw new PluginError('plugin_memory_hook_dispatch_required', event)
    const timeoutMs = options.timeoutMs ?? HOOK_HANDLER_TIMEOUT_MS
    const report = options.report
    const handlers = this.#hooks
      .filter((hook) => hook.event === event)
      .sort(
        (a, b) =>
          HOOK_DOMAIN_ORDER[a.domain] - HOOK_DOMAIN_ORDER[b.domain] ||
          b.priority - a.priority ||
          a.order - b.order,
      )
    if (handlers.length === 0) return undefined
    let current = payload
    for (const hook of handlers) {
      if (options.signal?.aborted) throw options.signal.reason
      const gateBuiltinPayload = (
        candidate: unknown,
      ): { status: 'blocked'; result: HookResult } | { status: 'ready'; value: unknown } => {
        const serializationFailure = () => {
          report?.({
            kind: 'builtin_hook_error',
            code: 'builtin_hook_error',
            domain: 'builtin',
            hook: hook.plugin,
            event,
            message: 'hook JSON-v1 serialization failed',
          })
          return {
            status: 'blocked' as const,
            result: {
              veto: true,
              reason: `builtin hook ${hook.plugin} on ${event} payload serialization failed (fail-closed)`,
            },
          }
        }
        let measurement: HookPayloadMeasurement
        try {
          measurement = measureHookPayloadJsonV1(candidate)
        } catch {
          return serializationFailure()
        }
        if (measurement.rawBytes > BUILTIN_HOOK_PAYLOAD_LIMIT_BYTES) {
          report?.({
            kind: 'builtin_hook_payload_too_large',
            code: 'builtin_hook_payload_too_large',
            domain: 'builtin',
            hook: hook.plugin,
            event,
            limitBytes: BUILTIN_HOOK_PAYLOAD_LIMIT_BYTES,
            rawBytes: measurement.rawBytes,
            rawDigest: measurement.rawDigest,
            scanStatus: 'not_started',
            scannedBytes: 0,
            scannedDigest: null,
            decision: 'veto',
          })
          return {
            status: 'blocked',
            result: {
              veto: true,
              reason: `builtin hook ${hook.plugin} on ${event} rejected an oversized payload (fail-closed)`,
            },
          }
        }
        try {
          const value = cloneHookPayloadJsonV1(candidate)
          const delivered = measureHookPayloadJsonV1(value)
          if (
            delivered.rawBytes !== measurement.rawBytes ||
            delivered.rawDigest !== measurement.rawDigest
          )
            return serializationFailure()
          return { status: 'ready', value }
        } catch {
          return serializationFailure()
        }
      }
      const handleHookFailure = (
        error: unknown,
        phase: 'invoke' | 'result',
      ): { status: 'blocked'; result: HookResult } | { status: 'skipped' } => {
        let timedOut = false
        let message = 'hook failure detail unavailable'
        try {
          timedOut =
            phase === 'invoke' &&
            error instanceof PluginError &&
            error.code === 'hook_dispatch_timeout'
          message = error instanceof Error ? error.message : String(error)
        } catch {}
        if (hook.domain === 'builtin') {
          report?.(
            timedOut
              ? {
                  kind: 'builtin_hook_timeout',
                  code: 'builtin_hook_timeout',
                  domain: 'builtin',
                  hook: hook.plugin,
                  event,
                  timeoutMs,
                }
              : {
                  kind: 'builtin_hook_error',
                  code: 'builtin_hook_error',
                  domain: 'builtin',
                  hook: hook.plugin,
                  event,
                  message,
                },
          )
          return {
            status: 'blocked',
            result: {
              veto: true,
              reason: timedOut
                ? `builtin hook ${hook.plugin} on ${event} timed out after ${timeoutMs}ms (fail-closed)`
                : phase === 'result'
                  ? `builtin hook ${hook.plugin} on ${event} returned an invalid result (fail-closed)`
                  : `builtin hook ${hook.plugin} on ${event} failed (fail-closed)`,
            },
          }
        }
        report?.({
          kind: 'hook_skipped',
          code: 'hook_skipped',
          domain: hook.domain,
          hook: hook.plugin,
          event,
          cause: timedOut ? 'timeout' : 'error',
          message,
        })
        return { status: 'skipped' }
      }
      if (hook.domain === 'builtin') {
        const gate = gateBuiltinPayload(current)
        if (gate.status === 'blocked') return gate.result
        // Continue the pipeline with the exact normalized value measured above, so
        // hidden internal slots cannot reappear after a security hook scanned its clone.
        current = gate.value
      }
      let timer: NodeJS.Timeout | undefined
      // The async wrapper converts clone/preparation failures and synchronously
      // throwing handlers into rejections routed through the same domain semantics.
      const invoke: Promise<void | HookResult> = (async () =>
        hook.handler(hook.domain === 'builtin' ? current : clone(current)))()
      // Keep a late rejection (after the race already settled) from becoming unhandled.
      void invoke.catch(() => {})
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new PluginError('hook_dispatch_timeout', `${hook.plugin}:${event}`)),
          timeoutMs,
        )
      })
      let result: HookResult | void
      try {
        result = await Promise.race([invoke, timeout])
      } catch (error) {
        const failure = handleHookFailure(error, 'invoke')
        if (failure.status === 'blocked') return failure.result
        continue
      } finally {
        if (timer) clearTimeout(timer)
      }
      try {
        if (result?.veto) {
          const reason = result.reason
          return {
            veto: true,
            ...(reason === undefined ? {} : { reason }),
          }
        }
        const rewrite = result?.value
        if (hook.domain === 'builtin') {
          // A builtin may mutate its input in place and return void. Re-gate every
          // non-veto completion, then continue from a fresh measured clone so a
          // retained handler reference cannot mutate downstream state later.
          const gate = gateBuiltinPayload(rewrite === undefined ? current : rewrite)
          if (gate.status === 'blocked') return gate.result
          current = gate.value
        } else if (rewrite !== undefined) {
          current = rewrite
        }
      } catch (error) {
        const failure = handleHookFailure(error, 'result')
        if (failure.status === 'blocked') return failure.result
        continue
      }
    }
    return { value: current }
  }

  async #runHooks(
    event: HookEvent,
    payload: unknown,
    options: { signal?: AbortSignal; toolUseId?: string },
    include: (hook: HookRecord) => boolean = () => true,
  ): Promise<{ plugin: string; result: HookResult } | undefined> {
    const handlers = this.#hooks
      .filter((hook) => hook.event === event && include(hook))
      .sort(
        (a, b) =>
          HOOK_DOMAIN_ORDER[a.domain] - HOOK_DOMAIN_ORDER[b.domain] ||
          b.priority - a.priority ||
          a.order - b.order,
      )
    for (const hook of handlers) {
      if (options.signal?.aborted) throw options.signal.reason
      const controller = new AbortController(),
        timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 10_000)
      const aborted = new Promise<never>((_, reject) =>
        controller.signal.addEventListener(
          'abort',
          () => reject(new PluginError('plugin_hook_timeout', `${hook.plugin}:${event}`)),
          { once: true },
        ),
      )
      try {
        const result = await Promise.race([Promise.resolve(hook.handler(clone(payload))), aborted])
        if (result?.veto) return { plugin: hook.plugin, result: clone(result) }
      } finally {
        clearTimeout(timeout)
      }
    }
    return undefined
  }
  async deactivate(plugin: string) {
    for (const item of [...(this.#disposables.get(plugin) ?? [])].reverse()) await item.dispose()
    this.#disposables.delete(plugin)
    for (const hook of this.#hooks.filter((item) => item.plugin === plugin)) this.removeHook(hook)
    for (const key of [...this.#kv.keys()].filter((key) => key.startsWith(`${plugin}:`)))
      this.#kv.delete(key)
  }
  private removeHook(record: HookRecord) {
    const index = this.#hooks.indexOf(record)
    if (index >= 0) this.#hooks.splice(index, 1)
  }
  private hookKv(plugin: string, toolUseId: string) {
    const key = `${plugin}:${toolUseId}`,
      existing = this.#kv.get(key)
    if (existing) return existing
    const created = new Map<string, unknown>()
    this.#kv.set(key, created)
    return created
  }
}

export interface ToolHookDispatchOptions {
  signal?: AbortSignal
}
/**
 * Structural match for the dispatcher `ToolExecutor` accepts; declared here so the
 * runtime package can adapt {@link BridgeRuntime} without depending on the tools package.
 */
export type ToolHookDispatch = (
  event: 'preToolUse' | 'postToolUse',
  payload: unknown,
  options?: ToolHookDispatchOptions,
) => Promise<HookResult | undefined>

/**
 * Adapt a {@link BridgeRuntime} (optionally resolved lazily) into a ToolExecutor hook
 * dispatcher running the r13-I10 domain semantics. Returns `undefined` while the lazy
 * runtime is not yet constructed so tool execution degrades to a hook-free path
 * instead of crashing during startup.
 */
export function createToolHookDispatcher(
  source: BridgeRuntime | (() => BridgeRuntime | undefined),
  options: { report?: (signal: HookPipelineSignal) => void } = {},
): ToolHookDispatch {
  return (event, payload, dispatchOptions) => {
    const runtime = typeof source === 'function' ? source() : source
    if (!runtime) return Promise.resolve(undefined)
    return runtime.runDomainHooks(event, payload, {
      ...(dispatchOptions?.signal === undefined ? {} : { signal: dispatchOptions.signal }),
      ...(options.report === undefined ? {} : { report: options.report }),
    })
  }
}
