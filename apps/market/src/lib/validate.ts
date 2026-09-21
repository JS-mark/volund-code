/**
 * 发布/录入校验：规则镜像 volund 客户端解析器（plugin-market.ts 的
 * PLUGIN_NAME/SAFE_FILE_PATH/上限，skill-market.ts 的 SKILL_NAME，
 * mcp-market.ts 的 SERVER_NAME），保证服务端收下的条目客户端一定能解析。
 * 客户端规则是权威，这里只在入口提前拦截；宿主安装期仍有 manifest/verifyBundle 二次校验。
 */
import { createHash } from 'node:crypto'

import type { MarketFileSpec, McpIndexEntry, PluginVersionRecord, SkillIndexEntry } from './types'

const PLUGIN_NAME = /^volund-plugin-[a-z0-9][a-z0-9._-]{0,127}$/
const SAFE_FILE_PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/
/** 与 plugin-runtime validateManifest 的 VERSION 同形。 */
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/
/** 与 plugin-runtime satisfies 的 RANGE 同形：服务端只收它认的范围写法。 */
const ENGINE_RANGE = /^(\^|~)?(\d+)\.(\d+)\.(\d+)$/
const SKILL_NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/
const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** 客户端硬上限：索引 ≤256 条、单插件 ≤64 文件、单文件 ≤8MiB。 */
export const MAX_PLUGINS = 256
export const MAX_CATALOG_ENTRIES = 256
export const MAX_FILES_PER_PLUGIN = 64
export const MAX_FILE_BYTES = 8 * 1024 * 1024
const MAX_TEXT_BYTES = 64 * 1024

export class ValidationError extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const safeRelative = (value: string) =>
  !value.startsWith('/') && !value.split(/[\\/]/).includes('..')

const optionalText = (value: unknown, field: string, max = 2000): string | undefined => {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value.trim())
    throw new ValidationError(`${field} must be a non-empty string`)
  if (Buffer.byteLength(value, 'utf8') > max)
    throw new ValidationError(`${field} larger than ${max} bytes`)
  return value
}

const stringTable = (value: unknown, field: string): Record<string, string> | undefined => {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new ValidationError(`${field} must be a table`)
  const out: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') throw new ValidationError(`${field}.${key} must be a string`)
    out[key] = item
  }
  return out
}

export interface PluginPublishInput {
  readonly files: readonly { readonly path: string; readonly content: Buffer }[]
  readonly manifest: Record<string, unknown>
  readonly version: PluginVersionRecord
  readonly publisher?: string
}

/**
 * 插件发布：files 是唯一事实来源，manifest 从 files['manifest.json'] 解出并校验，
 * 逐文件算 sha256 生成 MarketFileSpec。规则与 parseMarketIndex + validateManifest 对齐。
 */
export function validatePluginPublish(body: unknown): PluginPublishInput {
  if (!isRecord(body)) throw new ValidationError('body must be a JSON object')
  const rawFiles = body.files
  if (!Array.isArray(rawFiles) || rawFiles.length === 0)
    throw new ValidationError('files must be a non-empty array of { path, contentBase64 }')
  if (rawFiles.length > MAX_FILES_PER_PLUGIN)
    throw new ValidationError(`too many files (>${MAX_FILES_PER_PLUGIN})`)

  const files: { path: string; content: Buffer }[] = []
  const paths = new Set<string>()
  for (const raw of rawFiles) {
    if (!isRecord(raw)) throw new ValidationError('file entry shape')
    const path = raw.path
    if (typeof path !== 'string' || !SAFE_FILE_PATH.test(path) || !safeRelative(path))
      throw new ValidationError(`unsafe file path: ${String(path)}`)
    if (paths.has(path)) throw new ValidationError(`duplicate file path: ${path}`)
    if (typeof raw.contentBase64 !== 'string')
      throw new ValidationError(`file ${path} requires contentBase64`)
    const content = Buffer.from(raw.contentBase64, 'base64')
    if (content.byteLength === 0) throw new ValidationError(`file ${path} is empty`)
    if (content.byteLength > MAX_FILE_BYTES)
      throw new ValidationError(`file ${path} larger than ${MAX_FILE_BYTES} bytes`)
    paths.add(path)
    files.push({ path, content })
  }
  const manifestFile = files.find((file) => file.path === 'manifest.json')
  if (!manifestFile) throw new ValidationError('manifest.json is required in files')

  let manifest: Record<string, unknown>
  try {
    manifest = JSON.parse(manifestFile.content.toString('utf8')) as Record<string, unknown>
  } catch {
    throw new ValidationError('manifest.json is not valid JSON')
  }
  const name = manifest.name
  if (typeof name !== 'string' || !PLUGIN_NAME.test(name))
    throw new ValidationError(`manifest.name must match ${PLUGIN_NAME.source}`)
  const version = manifest.version
  if (typeof version !== 'string' || !SEMVER.test(version))
    throw new ValidationError(`manifest.version must be semver: ${String(version)}`)
  if (manifest.type !== 'module') throw new ValidationError('manifest.type must be "module"')
  const main = manifest.main
  if (typeof main !== 'string' || !safeRelative(main) || !paths.has(main))
    throw new ValidationError(`manifest.main must be a file in files: ${String(main)}`)
  const engines = manifest.engines
  if (
    !isRecord(engines) ||
    typeof engines.volund !== 'string' ||
    !ENGINE_RANGE.test(engines.volund)
  )
    throw new ValidationError('manifest.engines.volund must be a range like ^0.1.0')
  const permissions = manifest.permissions
  if (!isRecord(permissions) || !Array.isArray(permissions.volund))
    throw new ValidationError('manifest.permissions.volund is required')

  const specs: MarketFileSpec[] = files.map((file) => ({
    path: file.path,
    digest: `sha256-${createHash('sha256').update(file.content).digest('hex')}`,
  }))
  const readme = optionalText(body.readme, 'readme', MAX_TEXT_BYTES)
  const publisher = optionalText(body.publisher, 'publisher', 200)

  return {
    files,
    manifest,
    version: {
      version,
      publishedAt: new Date().toISOString(),
      manifest,
      files: specs,
      ...(readme ? { readme } : {}),
    },
    ...(publisher ? { publisher } : {}),
  }
}

const GITHUB_TREE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/tree\/[^/]+\//
const GIT_URL = /^(https:\/\/.+\.git|git@[\w.-]+:.+)$/
const OWNER_REPO = /^\w[\w.-]*\/\w[\w.-]*$/

/** SkillPort.install 认的形态：git URL / github tree URL / github: 简写 / owner/repo / 本地路径。 */
export function isInstallableSkillSource(source: string): boolean {
  return (
    source.startsWith('https://') ||
    source.startsWith('git@') ||
    source.startsWith('github:') ||
    source.startsWith('file://') ||
    OWNER_REPO.test(source) ||
    GITHUB_TREE.test(source) ||
    GIT_URL.test(source)
  )
}

/** Skill 录入：name 须可作 skill 目录名；source 须是 SkillPort.install 认的 git 形态。 */
export function validateSkillInput(body: unknown): SkillIndexEntry {
  if (!isRecord(body)) throw new ValidationError('body must be a JSON object')
  const name = body.name
  if (typeof name !== 'string' || !SKILL_NAME.test(name) || name.length > 64)
    throw new ValidationError(`invalid skill name: ${String(name)}`)
  const source = body.source
  if (typeof source !== 'string' || !isInstallableSkillSource(source))
    throw new ValidationError(
      `source must be a git URL / github tree URL / owner/repo: ${String(source)}`,
    )
  const homepage = optionalText(body.homepage, 'homepage', 500)
  if (homepage && !homepage.startsWith('https://'))
    throw new ValidationError('homepage must be an HTTPS URL')
  const version = optionalText(body.version, 'version', 64)
  if (version && !SEMVER.test(version))
    throw new ValidationError(`version must be semver (x.y.z): ${version}`)
  return {
    name,
    source,
    ...(optionalText(body.description, 'description')
      ? { description: body.description as string }
      : {}),
    ...(version ? { version } : {}),
    ...(homepage ? { homepage } : {}),
  }
}

/** MCP 录入：stdio 必须有 command；http 必须有 url（与 parseMcpMarketIndex 同规则）。 */
export function validateMcpInput(body: unknown): McpIndexEntry {
  if (!isRecord(body)) throw new ValidationError('body must be a JSON object')
  const name = body.name
  if (typeof name !== 'string' || !SERVER_NAME.test(name))
    throw new ValidationError(`invalid mcp server name: ${String(name)}`)
  const transport = body.transport
  if (transport !== 'stdio' && transport !== 'http')
    throw new ValidationError("transport must be 'stdio' or 'http'")
  const url = optionalText(body.url, 'url', 500)
  const command = optionalText(body.command, 'command', 200)
  if (transport === 'stdio' && !command)
    throw new ValidationError(`mcp entry '${name}' (stdio) requires command`)
  if (transport === 'http' && !url)
    throw new ValidationError(`mcp entry '${name}' (http) requires url`)
  if (url && !/^https?:\/\//.test(url)) throw new ValidationError('url must be an HTTP(S) URL')
  const headers = stringTable(body.headers, 'headers')
  const env = stringTable(body.env, 'env')
  let args: string[] | undefined
  if (body.args !== undefined) {
    if (
      !Array.isArray(body.args) ||
      !body.args.every((item): item is string => typeof item === 'string')
    )
      throw new ValidationError('args must be an array of strings')
    args = body.args
  }
  const homepage = optionalText(body.homepage, 'homepage', 500)
  if (homepage && !homepage.startsWith('https://'))
    throw new ValidationError('homepage must be an HTTPS URL')
  const version = optionalText(body.version, 'version', 64)
  if (version && !SEMVER.test(version))
    throw new ValidationError(`version must be semver (x.y.z): ${version}`)
  return {
    name,
    transport,
    ...(optionalText(body.description, 'description')
      ? { description: body.description as string }
      : {}),
    ...(version ? { version } : {}),
    ...(url ? { url } : {}),
    ...(headers ? { headers } : {}),
    ...(command ? { command } : {}),
    ...(args ? { args } : {}),
    ...(env ? { env } : {}),
    ...(homepage ? { homepage } : {}),
  }
}
