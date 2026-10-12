import type { MemoryRecordScope, MemoryService } from '@volund/storage'

/**
 * 会话结束时的自动记忆沉淀（Mark 2026-10-10 拍板，对齐 Claude Code auto-memory /
 * Codex Memories）：把会话里值得长期保留的用户偏好与项目事实提炼成记忆落盘。
 * 条件不满足、模型输出不合法、单条被 preWrite 守卫否决都静默跳过——沉淀是后台
 * 行为，失败绝不打扰退出。
 */

export const MEMORY_CONSOLIDATION_SYSTEM_PROMPT = `You distill durable memories from an AI coding agent session. From the transcript, extract at most 3 items worth keeping long-term: user preferences about collaboration, project conventions or facts, and recurring pitfalls. Ignore one-off task details, code, commands, secrets, and anything already visible in the repository. A list of existing memories is provided — do not duplicate them; skip anything they already cover. Respond with ONLY a JSON array (no prose, no code fence): [{"scope": "workspace" | "project", "content": "<= 2 sentences", "tags": ["up to 4 short tags"]}]. Return [] when nothing qualifies. Scope rule: workspace = true of the user across every project (taste, tone, collaboration habits); project = true of this repository only.`

/** Runtime-side adapter over the provider's `complete` — keeps this module free of provider-kit types. */
export interface MemoryConsolidationModel {
  complete(input: {
    system: string
    prompt: string
    maxTokens: number
    signal: AbortSignal
  }): Promise<string>
}

export interface ConsolidationTranscriptItem {
  readonly role: string
  readonly text: string
}

export interface ConsolidateSessionMemoryOptions {
  readonly memory: MemoryService
  readonly workspaceScope: MemoryRecordScope
  readonly projectScope: MemoryRecordScope
  readonly model: MemoryConsolidationModel
  readonly transcript: readonly ConsolidationTranscriptItem[]
  /** Existing memory first lines, so the model can avoid duplicates. */
  readonly existingSummaries?: readonly string[]
  /** VOLUND_MEMORY_AUTO_CONSOLIDATE value; '0'/'false' disables the pass. */
  readonly env?: string
  readonly minMessages?: number
  readonly maxItems?: number
  readonly maxTokens?: number
  readonly timeoutMs?: number
}

interface ConsolidationCandidate {
  scope: 'workspace' | 'project'
  content: string
  tags: string[]
}

const MIN_TRANSCRIPT_CHARS = 200
const MAX_TRANSCRIPT_ITEMS = 40
const MAX_ITEM_CHARS = 500
const MAX_INPUT_CHARS = 12_000
const MAX_CONTENT_CHARS = 2_000

export async function consolidateSessionMemory(
  options: ConsolidateSessionMemoryOptions,
): Promise<number> {
  if (options.env === '0' || options.env === 'false') return 0
  const turns = options.transcript.filter(
    (item) => (item.role === 'user' || item.role === 'assistant') && item.text.trim().length > 0,
  )
  if (turns.length < (options.minMessages ?? 2)) return 0
  if (turns.reduce((total, item) => total + item.text.length, 0) < MIN_TRANSCRIPT_CHARS) return 0

  const clipped = turns
    .slice(-MAX_TRANSCRIPT_ITEMS)
    .map((item) => `[${item.role}] ${item.text.slice(0, MAX_ITEM_CHARS)}`)
  let input = clipped.join('\n')
  if (input.length > MAX_INPUT_CHARS) input = input.slice(-MAX_INPUT_CHARS)
  const existing = options.existingSummaries?.slice(0, 60) ?? []
  const prompt = [
    existing.length > 0
      ? `Existing memories (do not duplicate):\n${existing.map((line) => `- ${line}`).join('\n')}`
      : undefined,
    `Session transcript:\n${input}`,
  ]
    .filter(Boolean)
    .join('\n\n')

  let raw: string
  try {
    raw = await options.model.complete({
      system: MEMORY_CONSOLIDATION_SYSTEM_PROMPT,
      prompt,
      maxTokens: options.maxTokens ?? 1_024,
      signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
    })
  } catch {
    return 0
  }

  let written = 0
  for (const candidate of parseCandidates(raw, options.maxItems ?? 3)) {
    try {
      await options.memory.create({
        scope: candidate.scope === 'workspace' ? options.workspaceScope : options.projectScope,
        content: candidate.content,
        provenance: { source: 'agent', actorId: 'memory-consolidation' },
        ...(candidate.tags.length > 0 ? { tags: candidate.tags } : {}),
      })
      written++
    } catch {
      // preWrite guard veto (secret/size) or validation — skip this item, keep the rest.
    }
  }
  return written
}

function parseCandidates(raw: string, maxItems: number): ConsolidationCandidate[] {
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  if (start === -1 || end <= start) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const candidates: ConsolidationCandidate[] = []
  for (const entry of parsed) {
    if (candidates.length >= maxItems) break
    if (!entry || typeof entry !== 'object') continue
    const item = entry as Record<string, unknown>
    if (item.scope !== 'workspace' && item.scope !== 'project') continue
    if (typeof item.content !== 'string' || item.content.trim().length === 0) continue
    const tags = Array.isArray(item.tags)
      ? item.tags
          .filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0)
          .slice(0, 4)
      : []
    candidates.push({
      scope: item.scope,
      content: item.content.trim().slice(0, MAX_CONTENT_CHARS),
      tags,
    })
  }
  return candidates
}
