import { createHash } from 'node:crypto'

import type { MemoryRecordScope } from '@volund/storage'

export const LOCAL_MEMORY_WORKSPACE_ID = 'local'

export function memoryProjectId(cwd: string): string {
  return createHash('sha256').update(cwd).digest('hex').slice(0, 32)
}

export function workspaceMemoryScope(): MemoryRecordScope {
  return { kind: 'workspace', workspaceId: LOCAL_MEMORY_WORKSPACE_ID }
}

export function projectMemoryScope(cwd: string): MemoryRecordScope {
  return {
    kind: 'project',
    workspaceId: LOCAL_MEMORY_WORKSPACE_ID,
    projectId: memoryProjectId(cwd),
  }
}

export function sessionMemoryScope(cwd: string, sessionId: string): MemoryRecordScope {
  return {
    kind: 'session',
    workspaceId: LOCAL_MEMORY_WORKSPACE_ID,
    projectId: memoryProjectId(cwd),
    sessionId,
  }
}
