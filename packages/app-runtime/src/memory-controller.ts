import { sanitize } from '@volund/shared'
import type {
  MemoryRecallService,
  MemoryRecord,
  MemoryRecordScope,
  MemoryService,
} from '@volund/storage'

import type { MemoryPanelController, MemoryPanelPage, MemoryPanelRecord } from './memory-panel'

const ansiEscape = String.fromCharCode(27)
const terminalBell = String.fromCharCode(7)
const ansiPattern = new RegExp(
  `${ansiEscape}(?:\\[[0-?]*[ -/]*[@-~]|\\][^${terminalBell}]*(?:${terminalBell}|${ansiEscape}\\\\))`,
  'g',
)

/** Production composition adapter; no persistence, ACL, or search behavior is duplicated in UI. */
export function createMemoryPanelController(
  memory: MemoryService,
  recall: MemoryRecallService | undefined,
  scope: MemoryRecordScope,
): MemoryPanelController {
  return {
    scopeLabel: scope.kind,
    searchAvailable: Boolean(recall),
    async list(input): Promise<MemoryPanelPage> {
      throwIfAborted(input.signal)
      const page = await memory.listPage(scope, {
        limit: input.limit,
        ...(input.cursor ? { cursor: input.cursor } : {}),
      })
      throwIfAborted(input.signal)
      return {
        items: page.items.map(toPanelRecord),
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      }
    },
    async search(input): Promise<readonly MemoryPanelRecord[]> {
      throwIfAborted(input.signal)
      if (!recall)
        throw Object.assign(new Error('Memory search is unavailable.'), {
          code: 'memory_index_unavailable',
        })
      const hits = await recall.recall(scope, input.query, { limit: input.limit })
      throwIfAborted(input.signal)
      return hits.map((hit) => toPanelRecord(hit.record))
    },
    async get(id, signal): Promise<MemoryPanelRecord | undefined> {
      throwIfAborted(signal)
      const record = await memory.get(scope, id)
      throwIfAborted(signal)
      return record && !record.deletedAt ? toPanelRecord(record) : undefined
    },
    async update(id, patch, expectedUpdatedAt): Promise<MemoryPanelRecord> {
      return toPanelRecord(await memory.update(scope, id, patch, { expectedUpdatedAt }))
    },
    async delete(id, expectedUpdatedAt): Promise<void> {
      await memory.delete(scope, id, { expectedUpdatedAt })
    },
    async pin(id, expectedUpdatedAt): Promise<MemoryPanelRecord> {
      return toPanelRecord(await memory.pin(scope, id, { expectedUpdatedAt }))
    },
    async unpin(id, expectedUpdatedAt): Promise<MemoryPanelRecord> {
      return toPanelRecord(await memory.unpin(scope, id, { expectedUpdatedAt }))
    },
  }
}

function toPanelRecord(record: MemoryRecord): MemoryPanelRecord {
  const actor = record.provenance.actorId ? safeText(record.provenance.actorId) : undefined
  return {
    id: record.id,
    content: safeText(record.content),
    tags: record.tags.map(safeText),
    pinned: record.pinned,
    scope: record.scope.kind,
    source: record.provenance.source,
    ...(actor ? { actor } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

function safeText(value: string): string {
  return sanitize(value).replace(ansiPattern, '')
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted)
    throw Object.assign(new Error('Memory request was cancelled.'), { name: 'AbortError' })
}
