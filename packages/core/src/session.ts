import type { Message, Usage } from '@volund/provider-kit'
import { produce } from 'immer'

export interface Turn {
  id: string
  startMessageId: string
  endMessageId?: string
  status:
    | 'streaming'
    | 'compacting'
    | 'awaiting_tool'
    | 'awaiting_user'
    | 'done'
    | 'aborted'
    | 'error'
  parentTurnId?: string
  parentDepth: number
  agentType?: string
  stickyProvider?: string
}
export interface SessionState {
  id: string
  cwd: string
  createdAt: number
  version: number
  messages: readonly Message[]
  turns: readonly Turn[]
  activeTurn: string | null
  cumulativeUsage: Usage & { costUSD: number }
  contextBudget: { maxTokens: number; currentTokens: number; lastCompactedAt?: string }
  toolRegistrySnapshot: string
  pendingInterrupt: boolean
  systemPromptSnapshot?: string
  /**
   * /model 钉住的会话级模型（provider/model 显式 id，随 session.model_changed 事件
   * 落盘；resume 时由 replay 还原）。undefined = 未选择，turn 跟随全局配置解析。
   */
  model?: string
  /**
   * Immutable lineage metadata. Child sessions never share parent messages or caches.
   *
   * SAG-06 (spec §2.7bis.3 U1): `rootSessionId` is the lineage ROOT session id —
   * the session whose backup manifest archives every file mutation in this tree
   * (top-level session = its own id; a subagent inherits its parent's root, so
   * nested grandchildren converge on the same root). `depth` is display-only and
   * never participates in backup routing.
   */
  lineage: {
    depth: number
    parentSessionId?: string
    parentTurnId?: string
    agentType?: string
    rootSessionId?: string
  }
  resourceBudget?: {
    tokenMax?: number
    costUSDMax?: number
    timeMsMax?: number
    toolCallMax?: number
  }
}
export function createSession(
  input: Pick<SessionState, 'cwd' | 'id' | 'toolRegistrySnapshot'> & {
    maxTokens: number
    lineage?: SessionState['lineage']
    resourceBudget?: SessionState['resourceBudget']
  },
): SessionState {
  return {
    id: input.id,
    cwd: input.cwd,
    createdAt: Date.now(),
    version: 0,
    messages: [],
    turns: [],
    activeTurn: null,
    cumulativeUsage: { input: 0, output: 0, costUSD: 0 },
    contextBudget: { maxTokens: input.maxTokens, currentTokens: 0 },
    toolRegistrySnapshot: input.toolRegistrySnapshot,
    pendingInterrupt: false,
    // SAG-06 (U1): normalize rootSessionId at creation — a session without an
    // explicit root is its own root (top-level); the subagent dispatcher passes
    // the parent's root down so the whole tree shares one backup manifest.
    lineage: input.lineage
      ? { ...input.lineage, rootSessionId: input.lineage.rootSessionId ?? input.id }
      : { depth: 0, rootSessionId: input.id },
    ...(input.resourceBudget ? { resourceBudget: input.resourceBudget } : {}),
  }
}
/**
 * SAG-06 (spec §2.7bis.3 U1): the session id whose backup manifest archives this
 * session's file mutations — the lineage root. Hand-built states without the
 * field (legacy fixtures, replayed sessions) fall back to self.
 */
export function lineageRootSessionId(state: Pick<SessionState, 'id' | 'lineage'>): string {
  return state.lineage?.rootSessionId ?? state.id
}
export function updateSession(
  state: SessionState,
  recipe: (draft: SessionState) => void,
): SessionState {
  return produce(state, (draft) => {
    recipe(draft)
    draft.version += 1
  })
}
