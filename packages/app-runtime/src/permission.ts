/**
 * PermissionController 域（§22.7.1 / Web 计划 P1-05）：工具权限决策链的 UI-neutral 组装。
 *
 * 从 apps/cli/src/runtime.ts 迁入，行为等价，唯一差异是终端接缝不再回退到模块级
 * readline/TTY 默认——全部经显式参数注入；缺 seam 的 line 模式 fail closed（deny）。
 * PermissionManager 仍是唯一决策源；本模块只负责快照策略、SafeDisplay 消毒与交互路由。
 * Web adapter 以 PermissionPromptController（./contracts）队列替代 line/TUI 弹窗。
 */
import type { EventBus, SessionState } from '@volund/core'
import { PermissionManager } from '@volund/permission'
import type {
  PermissionDecision,
  PermissionRequest,
  PermissionSessionMode,
  PermissionSpec,
} from '@volund/permission'
import {
  detectSecret,
  isCredentialKeyForSecretDetection,
  normalizeForSecretDetection,
  sanitize,
} from '@volund/shared'
import type { JsonValue, Logger } from '@volund/shared'
import type { ToolContext } from '@volund/tool-kit'
import { ToolExecutor } from '@volund/tools'
import type { ToolHookDispatcher } from '@volund/tools'
import { v7 as uuidv7 } from 'uuid'

import type {
  InteractivePermissionDecision,
  InteractivePermissionRequest,
  PermissionInteractionMode,
} from './contracts'
import {
  formatPermissionTextForDisplay,
  formatPermissionValueForDisplay,
} from './permission-display'

/** 持久化权限规则源（§4.4 决策链 1/2/4/5）；确定型测试可以给假实现。 */
export type PermissionRuleScope = 'project' | 'global'
export interface PermissionRuleSource {
  isDenied(scope: PermissionRuleScope, request: PermissionRequest): boolean
  isAllowed(scope: PermissionRuleScope, request: PermissionRequest): boolean
  persist(scope: PermissionRuleScope, request: PermissionRequest, allow: boolean): Promise<void>
}

export interface ProductionPermissionSessionSnapshot {
  readonly dangerouslySkip: boolean
  readonly interactionMode: PermissionInteractionMode
  /** §4.4 三档会话模式；缺省按 ask 处理（确定型测试可省略）。 */
  readonly mode?: PermissionSessionMode
}

export class PermissionSessionInvariantError extends Error {
  readonly code = 'permission_parent_snapshot_missing'

  constructor(parentSessionId: string) {
    super(
      `Permission policy invariant failed: parent session snapshot not found (${parentSessionId})`,
    )
    this.name = 'PermissionSessionInvariantError'
  }
}

/** Freezes security and interaction policy once, at the Runner/session creation boundary. */
export class ProductionPermissionSessionPolicy {
  #nextDangerouslySkip = false
  #nextInteractionMode: PermissionInteractionMode = 'none'
  #nextMode: PermissionSessionMode = 'ask'
  readonly #snapshots = new Map<string, ProductionPermissionSessionSnapshot>()

  configureSecurity(input: { skipPermissions: boolean }): void {
    this.#nextDangerouslySkip = input.skipPermissions
  }

  configureInteraction(input: { mode: PermissionInteractionMode }): void {
    this.#nextInteractionMode = input.mode
  }

  /** §4.4 三档模式：新会话的冻结快照取这里；/mode 热切换另走活动会话控制。 */
  configureMode(input: { mode: PermissionSessionMode }): void {
    this.#nextMode = input.mode
  }

  currentMode(): PermissionSessionMode {
    return this.#nextMode
  }

  snapshotFor(state: Pick<SessionState, 'id' | 'lineage'>): ProductionPermissionSessionSnapshot {
    const existing = this.#snapshots.get(state.id)
    if (existing) return existing
    if (state.lineage.depth === 0) {
      const snapshot = Object.freeze({
        dangerouslySkip: this.#nextDangerouslySkip,
        interactionMode: this.#nextInteractionMode,
        mode: this.#nextMode,
      })
      this.#snapshots.set(state.id, snapshot)
      return snapshot
    }
    const parentSessionId = state.lineage.parentSessionId
    const snapshot = parentSessionId ? this.#snapshots.get(parentSessionId) : undefined
    if (!snapshot) throw new PermissionSessionInvariantError(parentSessionId ?? '<missing>')
    this.#snapshots.set(state.id, snapshot)
    return snapshot
  }

  snapshotForSession(sessionId: string): ProductionPermissionSessionSnapshot | undefined {
    return this.#snapshots.get(sessionId)
  }

  releaseLineage(sessionId: string): void {
    const snapshot = this.#snapshots.get(sessionId)
    if (!snapshot) return
    for (const [candidate, value] of this.#snapshots)
      if (value === snapshot) this.#snapshots.delete(candidate)
  }
}
async function permissionPrompt(
  request: InteractivePermissionRequest,
  terminalIsInteractive?: () => boolean,
  linePrompt?: (question: string) => Promise<string | undefined>,
): Promise<PermissionDecision> {
  // 无终端接缝 = 无法安全问询，fail closed（P1-05：模块级 TTY 默认已移除）。
  if (!terminalIsInteractive?.() || !linePrompt) return { kind: 'deny' }
  const answer = (
    (await linePrompt(
      request.display.approvable
        ? `Permission required: ${request.display.toolName} ${request.display.spec}\nin-repo file paths are remembered as <repo>/**; bash/net stay exact\n[a]llow once, allow [s]ession, [g]rant full access, [d]eny · more: allow [p]roject, for [e]ver, deny forever [x]: `
        : `Permission required: ${request.display.toolName} ${request.display.spec}\n[d]eny: `,
    )) ?? ''
  )
    .trim()
    .toLowerCase()
  if (!request.display.approvable) return { kind: 'deny' }
  const byAnswer: Record<string, PermissionDecision['kind']> = {
    a: 'allow-once',
    s: 'allow-session',
    g: 'allow-all-session',
    p: 'allow-project',
    e: 'allow-forever',
    d: 'deny',
    x: 'deny-forever',
  }
  return { kind: byAnswer[answer] ?? 'deny' }
}
const MAX_PERMISSION_APPROVAL_DEPTH = 32
const MAX_PERMISSION_APPROVAL_NODES = 4_096
const MAX_PERMISSION_APPROVAL_BYTES = 64 * 1024
const permissionDetailsUnavailable = '[permission details unavailable - deny only]'
const sensitivePermissionDetailsHidden = '[sensitive permission details hidden - deny only]'

interface PermissionApprovalBudget {
  bytes: number
  nodes: number
  redacted: boolean
  readonly seen: Set<object>
}

interface PermissionApprovalValue {
  readonly complete: boolean
  readonly redacted: boolean
  readonly value: JsonValue
}

interface PermissionApprovalText extends Omit<PermissionApprovalValue, 'value'> {
  readonly value: string
}

function consumePermissionApprovalText(budget: PermissionApprovalBudget, value: string): void {
  budget.bytes -= Buffer.byteLength(value, 'utf8')
  if (budget.bytes < 0) throw new RangeError('permission approval exceeds its byte budget')
}

function hasOnlyStringKeys(keys: PropertyKey[]): keys is string[] {
  return keys.every((key) => typeof key === 'string')
}

function containsPermissionApprovalSecret(value: string): boolean {
  const normalized = normalizeForSecretDetection(value)
  return Boolean(detectSecret(value)) || sanitize(normalized) !== normalized
}

function isPermissionApprovalCredentialKey(value: string): boolean {
  const normalized = normalizeForSecretDetection(value)
  const probeValue = 'permission-approval-key-probe'
  const sanitizedProbe = sanitize({ [normalized]: probeValue })
  return isCredentialKeyForSecretDetection(value) || sanitizedProbe[normalized] !== probeValue
}

function clonePermissionApprovalValue(
  input: unknown,
  budget: PermissionApprovalBudget,
  depth = 0,
): JsonValue {
  budget.nodes -= 1
  if (budget.nodes < 0) throw new RangeError('permission approval exceeds its node budget')
  if (depth > MAX_PERMISSION_APPROVAL_DEPTH)
    throw new RangeError('permission approval exceeds its depth limit')
  if (input === null) return null
  if (typeof input === 'string') {
    consumePermissionApprovalText(budget, input)
    if (containsPermissionApprovalSecret(input)) {
      budget.redacted = true
      return '[REDACTED]'
    }
    return input
  }
  if (typeof input === 'boolean') return input
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || Object.is(input, -0))
      throw new TypeError('permission approval number cannot be represented exactly')
    return input
  }
  if (typeof input !== 'object') throw new TypeError('permission approval value is not JSON-safe')
  if (budget.seen.has(input)) throw new TypeError('permission approval value is cyclic')
  budget.seen.add(input)
  try {
    if (Array.isArray(input)) {
      if (input.length > budget.nodes)
        throw new RangeError('permission approval array exceeds its node budget')
      const keys = Reflect.ownKeys(input)
      if (!hasOnlyStringKeys(keys)) throw new TypeError('permission approval array has symbol keys')
      if (keys.length !== input.length + 1)
        throw new TypeError('permission approval array is sparse or has extra properties')
      const output: JsonValue[] = []
      for (let index = 0; index < input.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(input, String(index))
        if (!descriptor?.enumerable || !('value' in descriptor))
          throw new TypeError('permission approval array has hidden or accessor elements')
        output.push(clonePermissionApprovalValue(descriptor.value, budget, depth + 1))
      }
      return output
    }

    const prototype = Object.getPrototypeOf(input)
    if (prototype !== Object.prototype && prototype !== null)
      throw new TypeError('permission approval value is not a plain object')
    const keys = Reflect.ownKeys(input)
    if (keys.length > budget.nodes)
      throw new RangeError('permission approval object exceeds its node budget')
    if (!hasOnlyStringKeys(keys)) throw new TypeError('permission approval value has symbol keys')
    const output: Record<string, JsonValue> = {}
    for (const [index, key] of keys.entries()) {
      consumePermissionApprovalText(budget, key)
      const descriptor = Object.getOwnPropertyDescriptor(input, key)
      if (!descriptor?.enumerable || !('value' in descriptor))
        throw new TypeError('permission approval value has hidden or accessor properties')
      const safeKey = containsPermissionApprovalSecret(key) ? `[REDACTED_KEY_${index}]` : key
      if (safeKey !== key) budget.redacted = true
      if (Object.hasOwn(output, safeKey))
        throw new TypeError('permission approval redaction produced a duplicate key')
      const redactValue = isPermissionApprovalCredentialKey(key)
      if (redactValue) budget.redacted = true
      Object.defineProperty(output, safeKey, {
        configurable: true,
        enumerable: true,
        value: redactValue
          ? '[REDACTED]'
          : clonePermissionApprovalValue(descriptor.value, budget, depth + 1),
        writable: true,
      })
    }
    return output
  } finally {
    budget.seen.delete(input)
  }
}

function freezePermissionApprovalValue<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor && 'value' in descriptor) freezePermissionApprovalValue(descriptor.value)
  }
  return Object.freeze(value)
}

function preparePermissionApprovalValue(
  input: unknown,
  fallback: JsonValue,
): PermissionApprovalValue {
  try {
    const budget: PermissionApprovalBudget = {
      bytes: MAX_PERMISSION_APPROVAL_BYTES,
      nodes: MAX_PERMISSION_APPROVAL_NODES,
      redacted: false,
      seen: new Set(),
    }
    const detectedSafeValue = clonePermissionApprovalValue(input, budget)
    const sanitizedValue = sanitize(detectedSafeValue)
    const sanitizerRedacted = JSON.stringify(sanitizedValue) !== JSON.stringify(detectedSafeValue)
    return freezePermissionApprovalValue({
      complete: true,
      redacted: budget.redacted || sanitizerRedacted,
      value: sanitizedValue,
    })
  } catch {
    return freezePermissionApprovalValue({ complete: false, redacted: false, value: fallback })
  }
}

function preparePermissionApprovalSpec(input: PermissionSpec): PermissionApprovalValue {
  const prepared = preparePermissionApprovalValue(input, {
    custom: { permissionApproval: permissionDetailsUnavailable },
  })
  if (prepared.value && typeof prepared.value === 'object' && !Array.isArray(prepared.value))
    return prepared
  return freezePermissionApprovalValue({
    complete: false,
    redacted: false,
    value: { custom: { permissionApproval: permissionDetailsUnavailable } },
  })
}

function preparePermissionApprovalText(input: string): PermissionApprovalText {
  const prepared = preparePermissionApprovalValue(input, '[permission label unavailable]')
  if (typeof prepared.value === 'string')
    return freezePermissionApprovalValue({
      complete: prepared.complete,
      redacted: prepared.redacted,
      value: prepared.value,
    })
  return freezePermissionApprovalValue({
    complete: false,
    redacted: false,
    value: '[permission label unavailable]',
  })
}

function buildPermissionDisplay(
  spec: PermissionApprovalValue,
  toolName: PermissionApprovalText,
  input: PermissionApprovalValue,
  toolUseId: PermissionApprovalText,
): InteractivePermissionRequest['display'] {
  const sanitizedSpec = formatPermissionValueForDisplay(spec.value)
  const sanitizedToolName = formatPermissionTextForDisplay(toolName.value)
  if (
    !spec.complete ||
    !toolName.complete ||
    !input.complete ||
    !toolUseId.complete ||
    !sanitizedSpec.approvable ||
    !sanitizedToolName.approvable
  )
    return {
      approvable: false,
      spec: permissionDetailsUnavailable,
      toolName: sanitizedToolName.text,
    }
  if (spec.redacted || toolName.redacted || input.redacted || toolUseId.redacted)
    return {
      approvable: false,
      spec: sensitivePermissionDetailsHidden,
      toolName: toolName.redacted ? '[sensitive tool name hidden]' : sanitizedToolName.text,
    }
  return { approvable: true, spec: sanitizedSpec.text, toolName: sanitizedToolName.text }
}
export async function requestPermission(input: {
  events: EventBus
  interactionMode: PermissionInteractionMode
  interactivePermissionPrompt:
    | ((request: InteractivePermissionRequest) => Promise<InteractivePermissionDecision>)
    | undefined
  request: PermissionRequest
  /** Deterministic test seam; production always uses the real terminal predicate. */
  terminalIsInteractive?: () => boolean
  /** Deterministic line-input seam; production uses promptLineMaybe. */
  linePermissionPrompt?: (question: string) => Promise<string | undefined>
  version: number
}): Promise<PermissionDecision> {
  const id = uuidv7()
  const approvalSpec = preparePermissionApprovalSpec(input.request.spec)
  const approvalToolName = preparePermissionApprovalText(input.request.toolName)
  const approvalToolUseId = preparePermissionApprovalText(input.request.toolUseId ?? id)
  const approvalInput = preparePermissionApprovalValue(
    input.request.input,
    '[permission input unavailable]',
  )
  const display = freezePermissionApprovalValue(
    buildPermissionDisplay(approvalSpec, approvalToolName, approvalInput, approvalToolUseId),
  )
  const approvalAllowed = display.approvable
  const uiRequest = freezePermissionApprovalValue<InteractivePermissionRequest>({
    display,
    id,
    attempt: input.request.attempt,
    input: approvalInput.value,
    spec: approvalSpec.value,
    toolName: approvalToolName.value,
  })
  // 附录 D.2 tool.permission_asked：{toolUseId, tool, spec}——toolUseId 优先用真实
  // tool_use id（ToolExecutor 透传），非模型路径回退本次弹窗请求 id。
  await input.events.emit({
    type: 'tool.permission_asked',
    version: input.version,
    sessionId: input.request.session.id,
    payload: {
      toolUseId: approvalToolUseId.value,
      tool: approvalToolName.value,
      spec: approvalSpec.value,
    },
  })
  if (input.interactionMode === 'none') return { kind: 'deny' }
  if (input.interactionMode === 'line')
    return permissionPrompt(uiRequest, input.terminalIsInteractive, input.linePermissionPrompt)
  if (!input.interactivePermissionPrompt) return { kind: 'deny' }
  const decision = await input.interactivePermissionPrompt(uiRequest)
  if (!approvalAllowed) return { kind: 'deny' }
  return { kind: decision.kind }
}

export interface ProductionPermissionConfiguration {
  readonly dangerouslySkip: boolean
  logger?: Logger
}

export interface ProductionToolPermissionChainOptions {
  state: Pick<SessionState, 'id' | 'cwd' | 'version' | 'lineage'>
  events: EventBus
  permissionSnapshot: ProductionPermissionSessionSnapshot
  logger?: Logger
  interactivePermissionPrompt: () =>
    | ((request: InteractivePermissionRequest) => Promise<InteractivePermissionDecision>)
    | undefined
  /** Deterministic test seam; omitted by createProductionPorts. */
  terminalIsInteractive?: () => boolean
  /** Deterministic line-input seam; production uses promptLineMaybe. */
  linePermissionPrompt?: (question: string) => Promise<string | undefined>
  /** 持久化 project/global 权限规则（spec §4.4 决策链 1/2/4/5）；必须已完成装载
   * （生产路径 createRunner 先 await ready()），确定型测试可省略。 */
  rules?: PermissionRuleSource
}

export interface ProductionToolPermissionChain {
  permissionRequests: Pick<PermissionManager, 'request'>
  /** 当前生效的三档模式（活动会话的 /mode 读数走这里）。 */
  mode(): PermissionSessionMode
  /** /mode 热切换：只影响持有此 chain 的会话。 */
  setMode(mode: PermissionSessionMode): void
  /** skill allowed-tools 的回合级放行（Skill 工具与 /skill 路径共用）。 */
  grantEphemeral(rules: ReadonlyArray<{ tool: string; spec: PermissionSpec }>): void
  /** 回合终态清空 ephemeral 授权（createRunner 订阅 turn.completed/aborted）。 */
  clearEphemeral(): void
  bindExecutor(
    context: (signal: AbortSignal) => ToolContext,
    dispatchHook?: ToolHookDispatcher,
  ): Pick<ToolExecutor, 'execute'>
}

/**
 * Single production composition point for tool permission enforcement.
 *
 * PromptLoader receives only the request view, while ToolExecutor can be bound exactly once so
 * requestPermission and native execution cannot drift or expose cache/prompt mutation controls.
 */
export function createProductionToolPermissionChain(
  options: ProductionToolPermissionChainOptions,
): ProductionToolPermissionChain {
  const configuration: ProductionPermissionConfiguration = Object.freeze({
    dangerouslySkip: options.permissionSnapshot.dangerouslySkip,
    ...(options.logger ? { logger: options.logger } : {}),
  })
  const interactionMode = options.permissionSnapshot.interactionMode
  // r13 §4.4 决策链落地：持久化规则的 deny（1/2）先于 session cache（3），
  // allow（4/5）在 cache 之后、auto-allow 之前——PermissionManager 内置顺序与此一致。
  const rules = options.rules
  const permissions = new PermissionManager(
    rules
      ? {
          projectDeny: (request) => rules.isDenied('project', request),
          globalDeny: (request) => rules.isDenied('global', request),
          projectAllow: (request) => rules.isAllowed('project', request),
          globalAllow: (request) => rules.isAllowed('global', request),
        }
      : {},
    {
      ...configuration,
      ...(options.permissionSnapshot.mode ? { mode: options.permissionSnapshot.mode } : {}),
      ...(rules
        ? {
            persist: (scope: 'project' | 'global', request: PermissionRequest, allow: boolean) =>
              rules.persist(scope, request, allow),
          }
        : {}),
    },
  )
  permissions.setPromptHandler(async (request) => {
    const decision = await requestPermission({
      events: options.events,
      interactionMode,
      interactivePermissionPrompt: options.interactivePermissionPrompt(),
      request,
      ...(options.terminalIsInteractive
        ? { terminalIsInteractive: options.terminalIsInteractive }
        : {}),
      ...(options.linePermissionPrompt
        ? { linePermissionPrompt: options.linePermissionPrompt }
        : {}),
      version: options.state.version,
    })
    if (options.state.lineage.depth === 0) return decision
    return ['allow-once', 'allow-session', 'deny'].includes(decision.kind)
      ? decision
      : { kind: 'deny' }
  })
  let bound = false
  return {
    permissionRequests: Object.freeze({ request: permissions.request.bind(permissions) }),
    mode: () => permissions.mode,
    setMode: (mode) => permissions.setMode(mode),
    grantEphemeral: (rules) => permissions.grantEphemeral(rules),
    clearEphemeral: () => permissions.clearEphemeral(),
    bindExecutor(context, dispatchHook) {
      if (bound) throw new Error('Production permission executor is already bound')
      bound = true
      const executor = new ToolExecutor(permissions, context, dispatchHook)
      return Object.freeze({ execute: executor.execute.bind(executor) })
    },
  }
}
