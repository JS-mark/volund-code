import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { parseTomlFile, validateConfig } from '@volund/config'
import type { JsonValue } from '@volund/shared'
import { VolundError } from '@volund/shared'

import { serializeToml } from './toml'

/** config.toml 里 [skills]/[mcp] 的 disabled 名单读取（缺文件/缺段 → 空表）。 */
export function disabledNamesFrom(section: JsonValue | undefined): string[] {
  if (!section || typeof section !== 'object' || Array.isArray(section)) return []
  const list = (section as Record<string, JsonValue>).disabled
  return Array.isArray(list) ? list.filter((name): name is string => typeof name === 'string') : []
}

/** [plugins] builtin_disabled 名单读取（F1 第一方工具域可见可禁用）。 */
export function builtinDisabledFrom(section: JsonValue | undefined): string[] {
  if (!section || typeof section !== 'object' || Array.isArray(section)) return []
  const list = (section as Record<string, JsonValue>).builtin_disabled
  return Array.isArray(list) ? list.filter((name): name is string => typeof name === 'string') : []
}

/**
 * F1：[plugins] builtin_disabled 名单的读改写（原子替换）——第一方工具域的
 * 禁用/启用落盘，不触及其余段。
 */
export async function updateConfigBuiltinDisabled(input: {
  home: string
  domain: string
  disable: boolean
}): Promise<void> {
  const path = join(input.home, 'config.toml')
  const config = await readConfigFileOrEmpty(path)
  const current = builtinDisabledFrom(config.plugins)
  const next = input.disable
    ? [...new Set([...current, input.domain])]
    : current.filter((item) => item !== input.domain)
  const sectionObject =
    config.plugins && typeof config.plugins === 'object' && !Array.isArray(config.plugins)
      ? (config.plugins as Record<string, JsonValue>)
      : {}
  sectionObject.builtin_disabled = next
  config.plugins = sectionObject
  await writeConfigFile(path, config)
}

/**
 * 原型污染护栏（与 packages/config 的 assign 同一约定）：魔术 key segment 会让
 * 游标落到 Object.prototype，一律拒绝而不是静默跳过。
 */
const forbiddenKeySegments: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])

function assertSafeKey(key: string): void {
  if (!/^[\w@.-]+$/.test(key) || key.split('.').some((part) => part === ''))
    throw new VolundError('config_unknown_key', `Malformed config key: '${key}'`)
  if (key.split('.').some((part) => forbiddenKeySegments.has(part)))
    throw new VolundError('config_invalid', `forbidden config key segment in '${key}'`)
}

/** dot-path 写入（如 `provider.anthropic.model`），中间层按需建表。 */
export function assignConfigValue(
  target: Record<string, JsonValue>,
  key: string,
  value: JsonValue,
): void {
  assertSafeKey(key)
  const parts = key.split('.')
  let cursor = target
  for (const part of parts.slice(0, -1)) {
    const next = cursor[part]
    cursor =
      next && typeof next === 'object' && !Array.isArray(next)
        ? (next as Record<string, JsonValue>)
        : (cursor[part] = {})
  }
  cursor[parts.at(-1)!] = value
}

/** dot-path 读取；不存在（含中间层缺失）返回 undefined。 */
export function getConfigValue(
  source: Record<string, JsonValue>,
  key: string,
): JsonValue | undefined {
  let cursor: JsonValue | undefined = source
  for (const part of key.split('.')) {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) return undefined
    cursor = (cursor as Record<string, JsonValue>)[part]
  }
  return cursor
}

/** dot-path 删除并剪掉变空的父表；返回是否真的删掉了值。 */
export function deleteConfigValue(target: Record<string, JsonValue>, key: string): boolean {
  assertSafeKey(key)
  const parts = key.split('.')
  const chain: Array<Record<string, JsonValue>> = [target]
  for (const part of parts.slice(0, -1)) {
    const next = chain.at(-1)![part]
    if (!next || typeof next !== 'object' || Array.isArray(next)) return false
    chain.push(next as Record<string, JsonValue>)
  }
  const leaf = chain.at(-1)!
  if (!Object.hasOwn(leaf, parts.at(-1)!)) return false
  delete leaf[parts.at(-1)!]
  for (let index = chain.length - 1; index > 0; index--) {
    if (Object.keys(chain[index]!).length > 0) break
    delete chain[index - 1]![parts[index - 1]!]
  }
  return true
}

/** §8.3 / 附录 C.1：未知 key → config_unknown_key；已知 key 类型错 → config_invalid。 */
export function assertConfigKeyValue(key: string, value: JsonValue): void {
  const probe: Record<string, JsonValue> = {}
  assignConfigValue(probe, key, value)
  const { warnings } = validateConfig(probe, { file: 'command line' })
  if (warnings.length > 0)
    throw new VolundError(
      'config_unknown_key',
      `Unknown config key: '${key}'. See the config schema reference for known keys.`,
    )
}

export async function readConfigFileOrEmpty(path: string): Promise<Record<string, JsonValue>> {
  try {
    return await parseTomlFile(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return {}
  }
}

export async function writeConfigFile(
  path: string,
  config: Record<string, JsonValue>,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, serializeToml(config), { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, path)
}

/**
 * SKILLS-MCPS-r1 §S3.4：`[skills]/[mcp] disabled` 名单的读改写（原子替换）。
 * 面板 Space 与 CLI enable/disable 共用；不触及其余段。
 */
export async function updateConfigDisabledList(input: {
  home: string
  section: 'skills' | 'mcp'
  name: string
  add: boolean
}): Promise<void> {
  const path = join(input.home, 'config.toml')
  const config = await readConfigFileOrEmpty(path)
  const current = disabledNamesFrom(config[input.section])
  const next = input.add
    ? [...new Set([...current, input.name])]
    : current.filter((item) => item !== input.name)
  const sectionObject =
    config[input.section] &&
    typeof config[input.section] === 'object' &&
    !Array.isArray(config[input.section])
      ? (config[input.section] as Record<string, JsonValue>)
      : {}
  sectionObject.disabled = next
  config[input.section] = sectionObject
  await writeConfigFile(path, config)
}
