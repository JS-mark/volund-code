import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import type { MemoryRecordScope } from '@volund/storage'

export const LOCAL_MEMORY_WORKSPACE_ID = 'local'

const MAX_PROJECT_ROOT_LEVELS = 8
const projectRootCache = new Map<string, string>()

/**
 * 项目根解析（ADR-0014）：从 cwd 向上找最近的 `.git`（目录或 worktree 指针
 * 文件），monorepo 子包与仓库根共享同一项目身份；非 git 目录退回 cwd 自身。
 * 不跨用户 home 边界、最多 8 级，与 AGENT.md 的向上发现规则一致。结果按
 * cwd 缓存（同进程内向上扫描只做一次）。
 */
export function memoryProjectRoot(cwd: string): string {
  const start = resolve(cwd)
  const cached = projectRootCache.get(start)
  if (cached) return cached
  const home = homedir()
  let current = start
  let root = start
  for (let level = 0; level < MAX_PROJECT_ROOT_LEVELS; level++) {
    if (existsSync(join(current, '.git'))) {
      root = current
      break
    }
    if (current === home || dirname(current) === current) break
    current = dirname(current)
  }
  projectRootCache.set(start, root)
  return root
}

/** 项目身份 = 解析后的项目根（git root 或 cwd）的哈希，非 cwd 原串。 */
export function memoryProjectId(cwd: string): string {
  return createHash('sha256').update(memoryProjectRoot(cwd)).digest('hex').slice(0, 32)
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
