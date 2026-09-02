import { randomUUID } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { parseTomlFile } from '@volund/config'
import { permissionKey, type PermissionRequest, type PermissionSpec } from '@volund/permission'
import type { JsonValue, Logger } from '@volund/shared'

import { serializeToml } from './mcp'

export type PermissionRuleScope = 'project' | 'global'

/** 落盘条目：tool + spec 对就是匹配单位（permissionKey 全等），不做前缀/glob 推断。 */
export interface StoredPermission {
  tool: string
  spec: PermissionSpec
}

export interface PermissionsDocument {
  allow: StoredPermission[]
  deny: StoredPermission[]
}

/**
 * createProductionToolPermissionChain 注入的最小面；确定型测试可以给假实现。
 * 语义对齐 spec §4.4 决策链 1/2（deny）与 4/5（allow）。
 */
export interface PermissionRuleSource {
  isDenied(scope: PermissionRuleScope, request: PermissionRequest): boolean
  isAllowed(scope: PermissionRuleScope, request: PermissionRequest): boolean
  persist(scope: PermissionRuleScope, request: PermissionRequest, allow: boolean): Promise<void>
}

export interface PermissionRuleStoreOptions {
  /** allow-project 落盘文件（<cwd>/.volund/permissions.toml）。 */
  project: string
  /** allow-forever / deny-forever 落盘文件（~/.volund/permissions.toml）。 */
  global: string
  logger?: Logger
}

function isStoredPermission(value: JsonValue | undefined): value is StoredPermission {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Record<string, JsonValue>
  return (
    typeof candidate.tool === 'string' &&
    candidate.spec !== undefined &&
    typeof candidate.spec === 'object' &&
    candidate.spec !== null &&
    !Array.isArray(candidate.spec)
  )
}

function entriesFrom(
  config: Record<string, JsonValue>,
  section: 'allow' | 'deny',
): {
  entries: StoredPermission[]
  invalid: number
} {
  const list = config[section]
  if (!Array.isArray(list)) return { entries: [], invalid: list === undefined ? 0 : 1 }
  const entries = list.filter(isStoredPermission)
  return { entries, invalid: list.length - entries.length }
}

/**
 * r13 §4.4 的持久化腿：allow-project → <project>/.volund/permissions.toml，
 * allow-forever / deny-forever → ~/.volund/permissions.toml。进程内只建一份、
 * 所有 session 的 PermissionManager 共享——子 session 里的 grant 父 session 立即可见。
 *
 * 单写者假设：改写以内存为准（两个 volund 进程同project 并发写时 last-writer-wins）。
 * 文件损坏时只告警不覆写，绝不静默销毁用户文件。
 */
export class PermissionRuleStore implements PermissionRuleSource {
  readonly #options: PermissionRuleStoreOptions
  readonly #entries: Record<
    PermissionRuleScope,
    { allow: Map<string, StoredPermission>; deny: Map<string, StoredPermission> }
  >
  readonly #writes: Record<PermissionRuleScope, Promise<void>>
  #load?: Promise<void>

  constructor(options: PermissionRuleStoreOptions) {
    this.#options = options
    this.#entries = {
      project: { allow: new Map(), deny: new Map() },
      global: { allow: new Map(), deny: new Map() },
    }
    this.#writes = { project: Promise.resolve(), global: Promise.resolve() }
  }

  /** 幂等装载；解析失败 → 告警并按空表对待（内存规则不受影响）。 */
  async ready(): Promise<void> {
    this.#load ??= Promise.all([this.#loadScope('project'), this.#loadScope('global')]).then(
      () => undefined,
    )
    await this.#load
  }

  isDenied(scope: PermissionRuleScope, request: PermissionRequest): boolean {
    return this.#entries[scope].deny.has(permissionKey(request.toolName, request.spec))
  }

  isAllowed(scope: PermissionRuleScope, request: PermissionRequest): boolean {
    return this.#entries[scope].allow.has(permissionKey(request.toolName, request.spec))
  }

  /** 新决策取代同 key 的旧决策（allow 翻 deny / deny 翻 allow 都成立）；写盘失败只告警，内存决策保留。 */
  async persist(
    scope: PermissionRuleScope,
    request: PermissionRequest,
    allow: boolean,
  ): Promise<void> {
    await this.ready()
    const key = permissionKey(request.toolName, request.spec)
    const entry: StoredPermission = { tool: request.toolName, spec: request.spec }
    const buckets = this.#entries[scope]
    ;(allow ? buckets.allow : buckets.deny).set(key, entry)
    ;(allow ? buckets.deny : buckets.allow).delete(key)
    this.#writes[scope] = this.#writes[scope].catch(() => undefined).then(() => this.#flush(scope))
    await this.#writes[scope]
  }

  async #loadScope(scope: PermissionRuleScope): Promise<void> {
    const file = this.#options[scope]
    let config: Record<string, JsonValue>
    try {
      config = await parseTomlFile(file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        this.#options.logger?.warn(`ignoring unreadable permissions file ${file}: ${String(error)}`)
      return
    }
    const buckets = this.#entries[scope]
    for (const section of ['allow', 'deny'] as const) {
      const { entries, invalid } = entriesFrom(config, section)
      if (invalid > 0)
        this.#options.logger?.warn(
          `ignoring ${invalid} malformed ${section} entr${invalid === 1 ? 'y' : 'ies'} in ${file}`,
        )
      for (const entry of entries)
        buckets[section].set(permissionKey(entry.tool, entry.spec), entry)
    }
  }

  async #flush(scope: PermissionRuleScope): Promise<void> {
    const file = this.#options[scope]
    try {
      // 覆写前先探一次：文件解析不了说明有人为损坏，宁可不写也不能覆盖掉原文件。
      await parseTomlFile(file).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      })
    } catch (error) {
      this.#options.logger?.warn(
        `refusing to rewrite corrupt permissions file ${file}: ${String(error)}`,
      )
      return
    }
    const buckets = this.#entries[scope]
    const document: PermissionsDocument = {
      allow: [...buckets.allow.values()],
      deny: [...buckets.deny.values()],
    }
    try {
      await mkdir(dirname(file), { recursive: true })
      const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
      await writeFile(temporary, serializeToml({ ...document }), { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, file)
    } catch (error) {
      this.#options.logger?.warn(`failed to persist permissions to ${file}: ${String(error)}`)
    }
  }
}
