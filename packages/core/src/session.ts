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
  /** Immutable lineage metadata. Child sessions never share parent messages or caches. */
  lineage: { depth: number; parentSessionId?: string; parentTurnId?: string; agentType?: string }
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
    lineage: input.lineage ?? { depth: 0 },
    ...(input.resourceBudget ? { resourceBudget: input.resourceBudget } : {}),
  }
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
