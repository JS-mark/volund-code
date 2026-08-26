import { isAbsolute, relative, resolve } from 'node:path'

import type { Logger } from '@apollo-code/shared'

import { normalizeOrigin } from './net-origin'

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
  kind: 'allow-once' | 'allow-session' | 'allow-project' | 'allow-forever' | 'deny' | 'deny-forever'
}
export interface PermissionRules {
  projectDeny?: (request: PermissionRequest) => boolean
  globalDeny?: (request: PermissionRequest) => boolean
  projectAllow?: (request: PermissionRequest) => boolean
  globalAllow?: (request: PermissionRequest) => boolean
}
export type PromptHandler = (request: PermissionRequest) => Promise<PermissionDecision>

function inCwd(path: string, cwd: string): boolean {
  const full = isAbsolute(path) ? resolve(path) : resolve(cwd, path)
  const rel = relative(resolve(cwd), full)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}
function keyOf(request: PermissionRequest): string {
  if (request.spec.net) {
    // net 粒度 = origin（r13-D1）：scheme://host[:port] 归一，同域不同路径共享 allow-session
    const origin = normalizeOrigin(request.spec.net.url)
    return JSON.stringify([request.toolName, { net: { ...request.spec.net, url: origin } }])
  }
  return JSON.stringify([request.toolName, request.spec])
}

export class PermissionManager {
  readonly #cache = new Set<string>()
  #queue = Promise.resolve()
  #prompt?: PromptHandler
  constructor(
    readonly rules: PermissionRules = {},
    readonly options: {
      dangerouslySkip?: boolean
      logger?: Logger
      persist?: (
        scope: 'project' | 'global',
        request: PermissionRequest,
        allow: boolean,
      ) => Promise<void>
    } = {},
  ) {}
  setPromptHandler(handler: PromptHandler): void {
    this.#prompt = handler
  }
  clearSession(): void {
    this.#cache.clear()
  }
  async request(request: PermissionRequest): Promise<PermissionDecision> {
    if (this.rules.projectDeny?.(request)) return { kind: 'deny' }
    if (this.rules.globalDeny?.(request)) return { kind: 'deny' }
    if (this.#cache.has(keyOf(request))) return { kind: 'allow-session' }
    if (this.rules.projectAllow?.(request)) return { kind: 'allow-project' }
    if (this.rules.globalAllow?.(request)) return { kind: 'allow-forever' }
    const automatic = this.autoAllow(request)
    if (automatic) {
      if (automatic.kind === 'allow-session') this.#cache.add(keyOf(request))
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
  }
  private async record(
    request: PermissionRequest,
    decision: PermissionDecision,
  ): Promise<PermissionDecision> {
    if (decision.kind === 'allow-session') this.#cache.add(keyOf(request))
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
