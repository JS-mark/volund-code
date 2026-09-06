/**
 * Memory 面板契约（§22.7.1 / P1-04b）：TUI/Web 共用的面板 DTO 与错误映射。
 * 从 @volund/ui 迁入；终端宽度渲染（truncateTerminal/wrapTerminalLines）留在 ui。
 */

export type MemoryPanelErrorCode =
  | 'memory_conflict'
  | 'memory_corrupt'
  | 'memory_index_corrupt'
  | 'memory_index_busy'
  | 'memory_index_unavailable'
  | 'memory_io'
  | 'memory_not_found'
  | 'memory_scope_denied'
  | 'memory_validation'
  | 'memory_unknown'

export interface MemoryPanelError extends Error {
  code?: MemoryPanelErrorCode
}

export interface MemoryPanelRecord {
  id: string
  content: string
  tags: readonly string[]
  pinned: boolean
  scope: string
  source: string
  actor?: string
  createdAt: string
  updatedAt: string
}

export interface MemoryPanelPage {
  items: readonly MemoryPanelRecord[]
  nextCursor?: string
}

export interface MemoryPanelController {
  readonly scopeLabel: string
  readonly searchAvailable: boolean
  list(input: { cursor?: string; limit: number; signal?: AbortSignal }): Promise<MemoryPanelPage>
  search(input: {
    query: string
    limit: number
    signal?: AbortSignal
  }): Promise<readonly MemoryPanelRecord[]>
  get(id: string, signal?: AbortSignal): Promise<MemoryPanelRecord | undefined>
  update(
    id: string,
    patch: { content: string; tags: readonly string[] },
    expectedUpdatedAt: string,
  ): Promise<MemoryPanelRecord>
  delete(id: string, expectedUpdatedAt: string): Promise<void>
  pin(id: string, expectedUpdatedAt: string): Promise<MemoryPanelRecord>
  unpin(id: string, expectedUpdatedAt: string): Promise<MemoryPanelRecord>
}

export type MemoryPanelMode =
  | 'confirmDelete'
  | 'conflict'
  | 'detail'
  | 'discardEdit'
  | 'edit'
  | 'empty'
  | 'list'
  | 'loadError'
  | 'loading'
  | 'mutating'
  | 'noMatch'
  | 'searchError'
  | 'searching'

export function memoryPanelError(error: unknown): { code: MemoryPanelErrorCode; message: string } {
  const value = error as MemoryPanelError
  return {
    code: value?.code ?? 'memory_unknown',
    message: error instanceof Error ? error.message : String(error),
  }
}
