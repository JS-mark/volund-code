import { isAbsolute, join, relative, resolve } from 'node:path'

import type { Logger } from '@volund/shared'
import picomatch from 'picomatch'

import { normalizeOrigin } from './net-origin'
import { matchPath, toPosixSeparators } from './path-pattern'

export {
  canonicalizePath,
  canonicalizePattern,
  matchPath,
  PathPatternError,
  type PathPatternOptions,
} from './path-pattern'
export { InvalidNetUrlError, normalizeOrigin } from './net-origin'

export interface PermissionSpec {
  fs?: { read?: string[]; write?: string[] }
  bash?: { command: string; background?: boolean }
  net?: { url: string; method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' }
  env?: { read?: string[] }
  custom?: Record<string, unknown>
}
export interface PermissionRequest {
  toolName: string
  spec: PermissionSpec
  input: unknown
  session: { id: string; cwd: string }
  attempt: number
  /** 触发本次请求的 tool_use id（附录 D.2 tool.permission_asked ★toolUseId）；非模型路径可缺省。 */
  toolUseId?: string
}
export type PermissionDecision = {
  kind:
    | 'allow-once'
    | 'allow-session'
    /** 用户在弹窗里主动升级：本会话内不再询问（deny 规则仍然优先）。 */
    | 'allow-all-session'
    | 'allow-project'
    | 'allow-forever'
    | 'deny'
    | 'deny-forever'
}
export interface PermissionRules {
  projectDeny?: (request: PermissionRequest) => boolean
  globalDeny?: (request: PermissionRequest) => boolean
  projectAllow?: (request: PermissionRequest) => boolean
  globalAllow?: (request: PermissionRequest) => boolean
}
export type PromptHandler = (request: PermissionRequest) => Promise<PermissionDecision>

/**
 * 会话权限模式（§4.4 三档）：
 * - ask  变更前确认：未显式允许的操作一律弹窗；
 * - auto 自动编辑：cwd 内的纯文件写（fs-only spec，无 bash/net）自动放行；
 * - full 完全访问：本会话不再询问（deny 黑名单仍优先）。
 */
export type PermissionSessionMode = 'ask' | 'auto' | 'full'

function inCwd(path: string, cwd: string): boolean {
  const full = isAbsolute(path) ? resolve(path) : resolve(cwd, path)
  const rel = relative(resolve(cwd), full)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}
/** Grant key for a tool+spec pair: the matching unit shared by session cache and persisted rules. */
export function permissionKey(toolName: string, spec: PermissionSpec): string {
  if (spec.net) {
    // net 粒度 = origin（r13-D1）：scheme://host[:port] 归一，同域不同路径共享 allow-session
    const origin = normalizeOrigin(spec.net.url)
    return JSON.stringify([toolName, { net: { ...spec.net, url: origin } }])
  }
  return JSON.stringify([toolName, spec])
}
function keyOf(request: PermissionRequest): string {
  return permissionKey(request.toolName, request.spec)
}

/** 规则值出现这些字符即视为 glob 模式（fs 路径与 bash command 共用判断）。 */
const GLOB_CHARS = /[*?[]/

/**
 * 弹窗授权（allow-project / allow-forever）落盘前的规则泛化 —— 对齐 codex 的
 * 项目级信任与 claude-code 的 glob 规则：项目内文件路径不落成具体文件（否则写
 * 第二个文件还要再弹窗），收敛为 `<cwd>/**` 子树模式；既有 glob 与 cwd 外路径
 * 原样保留（宁可多问，不做目录越权）。bash / net 的身份就在 command / origin
 * 上，整体原样保留，规则保持手写友好的精确形态。
 */
export function generalizePermissionSpec(spec: PermissionSpec, cwd: string): PermissionSpec {
  if (spec.bash || spec.net || !spec.fs) return spec
  const generalize = (paths: string[]): string[] => [
    ...new Set(
      paths.map((path) =>
        GLOB_CHARS.test(path) || !inCwd(path, cwd)
          ? path
          : toPosixSeparators(join(resolve(cwd), '**')),
      ),
    ),
  ]
  const fs: PermissionSpec['fs'] = {}
  if (spec.fs.read) fs.read = generalize(spec.fs.read)
  if (spec.fs.write) fs.write = generalize(spec.fs.write)
  return { ...spec, fs }
}

/**
 * 持久化规则（permissions.toml 的 tool+spec 条目）对请求的匹配：
 * - fs.read/write / env.read：请求 ⊆ 规则 —— 请求的每个具体值都要被规则的某个
 *   模式覆盖（统一走 matchPath 的钉死方言，字面量即退化为其 canonicalize 相等）；
 *   请求未触及的能力面（字段为空/缺失）不参与判定；
 * - bash：规则 command 含 glob 字符时按 picomatch 全串匹配（`git *` 前缀语义），
 *   否则全等；background 需一致；
 * - net：origin 归一相等（r13-D1）且 method 相等；
 * - custom：JSON 全等（与 permissionKey 同语义）。
 * 非法存储模式（如裸名 glob）按不命中处理——弹窗总比崩溃或静默放行好。
 */
export function permissionRuleMatches(
  rule: { tool: string; spec: PermissionSpec },
  request: PermissionRequest,
): boolean {
  if (rule.tool !== request.toolName) return false
  const ruleSpec = rule.spec
  const requestSpec = request.spec
  if (ruleSpec.bash || requestSpec.bash) {
    if (!ruleSpec.bash || !requestSpec.bash) return false
    const matched = GLOB_CHARS.test(ruleSpec.bash.command)
      ? picomatch.isMatch(requestSpec.bash.command, ruleSpec.bash.command, {
          dot: true,
          nonegate: true,
        })
      : ruleSpec.bash.command === requestSpec.bash.command
    if (!matched) return false
    if ((ruleSpec.bash.background ?? false) !== (requestSpec.bash.background ?? false)) return false
  }
  if (ruleSpec.net || requestSpec.net) {
    if (!ruleSpec.net || !requestSpec.net) return false
    if (normalizeOrigin(ruleSpec.net.url) !== normalizeOrigin(requestSpec.net.url)) return false
    if (ruleSpec.net.method !== requestSpec.net.method) return false
  }
  const covered = (patterns: string[] | undefined, paths: string[] | undefined): boolean => {
    const required = paths ?? []
    if (required.length === 0) return true
    if (!patterns || patterns.length === 0) return false
    return required.every((path) =>
      patterns.some((pattern) => {
        try {
          return matchPath(pattern, path, { cwd: request.session.cwd })
        } catch {
          return false
        }
      }),
    )
  }
  if (!covered(ruleSpec.fs?.read, requestSpec.fs?.read)) return false
  if (!covered(ruleSpec.fs?.write, requestSpec.fs?.write)) return false
  if (!covered(ruleSpec.env?.read, requestSpec.env?.read)) return false
  if (ruleSpec.custom !== undefined || requestSpec.custom !== undefined) {
    if (JSON.stringify(ruleSpec.custom ?? null) !== JSON.stringify(requestSpec.custom ?? null))
      return false
  }
  return true
}

export class PermissionManager {
  /** Prompted decisions remembered for the session, keyed by tool+spec. */
  readonly #cache = new Map<
    string,
    'allow-session' | 'allow-project' | 'allow-forever' | 'deny-forever'
  >()
  /** 回合级临时放行（skill allowed-tools）：见 grantEphemeral。 */
  readonly #ephemeral: Array<{ tool: string; spec: PermissionSpec }> = []
  #queue = Promise.resolve()
  #prompt?: PromptHandler
  readonly #initialMode: PermissionSessionMode
  #mode: PermissionSessionMode
  constructor(
    readonly rules: PermissionRules = {},
    readonly options: {
      dangerouslySkip?: boolean
      mode?: PermissionSessionMode
      logger?: Logger
      persist?: (
        scope: 'project' | 'global',
        request: PermissionRequest,
        allow: boolean,
      ) => Promise<void>
    } = {},
  ) {
    this.#initialMode = options.mode ?? 'ask'
    this.#mode = this.#initialMode
  }
  get mode(): PermissionSessionMode {
    return this.#mode
  }
  /** 会话中切换三档模式（/mode 命令、弹窗 full-access 升级都走这里）。 */
  setMode(mode: PermissionSessionMode): void {
    this.#mode = mode
  }
  setPromptHandler(handler: PromptHandler): void {
    this.#prompt = handler
  }
  /**
   * skill allowed-tools 的回合级放行（业界语义：仅 skill 触发的那轮生效，调用方
   * 在回合边界 clearEphemeral()）。判定位于 deny 规则、缓存与 full 模式之后——
   * 显式 deny 与用户既定决策不被绕过；不入 #cache、不落盘。
   */
  grantEphemeral(rules: ReadonlyArray<{ tool: string; spec: PermissionSpec }>): void {
    this.#ephemeral.push(...rules)
  }
  clearEphemeral(): void {
    this.#ephemeral.splice(0)
  }
  clearSession(): void {
    this.#cache.clear()
    this.#mode = this.#initialMode
  }
  async request(request: PermissionRequest): Promise<PermissionDecision> {
    if (this.rules.projectDeny?.(request)) return { kind: 'deny' }
    if (this.rules.globalDeny?.(request)) return { kind: 'deny' }
    const cached = this.#cache.get(keyOf(request))
    if (cached) return { kind: cached }
    // 会话级完全访问：deny 规则与已缓存决策之后、scoped allow 之前短路。
    if (this.#mode === 'full') return { kind: 'allow-session' }
    // 回合级 skill 放行：direct return 不写缓存——授权只活到 clearEphemeral()。
    if (this.#ephemeral.some((rule) => permissionRuleMatches(rule, request)))
      return { kind: 'allow-session' }
    if (this.rules.projectAllow?.(request)) return { kind: 'allow-project' }
    if (this.rules.globalAllow?.(request)) return { kind: 'allow-forever' }
    const automatic = this.autoAllow(request)
    if (automatic) {
      if (automatic.kind === 'allow-session') this.#cache.set(keyOf(request), 'allow-session')
      return automatic
    }
    if (this.options.dangerouslySkip) {
      this.options.logger?.warn('permissions bypassed', { toolName: request.toolName })
      return { kind: 'allow-once' }
    }
    if (!this.#prompt) return { kind: 'deny' }
    return this.enqueue(async () => this.record(request, await this.#prompt!(request)))
  }
  async requestAndExecute<T>(request: PermissionRequest, operation: () => Promise<T>): Promise<T> {
    const decision = await this.request(request)
    if (decision.kind.startsWith('deny'))
      throw new Error(`Permission denied for ${request.toolName}`)
    return operation()
  }
  private autoAllow(request: PermissionRequest): PermissionDecision | undefined {
    const reads = request.spec.fs?.read ?? []
    if (
      ['Read', 'Grep', 'Glob'].includes(request.toolName) &&
      reads.length > 0 &&
      reads.every((path) => inCwd(path, request.session.cwd))
    )
      return { kind: 'allow-session' }
    // auto 模式：只自动放行纯文件写入（fs-only spec）；带 bash / net 的 spec
    // （Bash 自带 fs.write ['.']）绝不静默——没有基于命令字符串的白名单。
    if (this.#mode === 'auto') {
      const writes = request.spec.fs?.write ?? []
      if (
        !request.spec.bash &&
        !request.spec.net &&
        writes.length > 0 &&
        writes.every((path) => inCwd(path, request.session.cwd))
      )
        return { kind: 'allow-session' }
    }
  }
  private async record(
    request: PermissionRequest,
    decision: PermissionDecision,
  ): Promise<PermissionDecision> {
    // Session cache: prompted decisions hold for the process lifetime; project/
    // forever/deny-forever additionally persist via options.persist when wired.
    if (
      decision.kind === 'allow-session' ||
      decision.kind === 'allow-project' ||
      decision.kind === 'allow-forever' ||
      decision.kind === 'deny-forever'
    )
      this.#cache.set(keyOf(request), decision.kind)
    if (decision.kind === 'allow-all-session') this.#mode = 'full'
    if (decision.kind === 'allow-project') await this.options.persist?.('project', request, true)
    if (decision.kind === 'allow-forever') await this.options.persist?.('global', request, true)
    if (decision.kind === 'deny-forever') await this.options.persist?.('global', request, false)
    return decision
  }
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(task, task)
    this.#queue = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }
}
