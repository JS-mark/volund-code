import { existsSync, mkdirSync, renameSync } from 'node:fs'
/**
 * MemoryController 域（§22.7.1 / Web 计划 P1-04b）：Memory 四服务的组合与宿主适配。
 *
 * 从 apps/cli/src/runtime.ts 迁入，行为等价。Web `/memory` 面板与 TUI 共用同一
 * 服务栈；插件桥（createPluginMemoryHost）继续只暴露受 ACL 约束的操作面。
 */
import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import type { PromptComposer, SessionState } from '@volund/core'
import type { PluginMemoryScope } from '@volund/plugin-sdk'
import { sanitize } from '@volund/shared'
import {
  DefaultMemoryMaintenanceService,
  DefaultMemoryRecallService,
  DefaultMemoryService,
  IndexingMemoryService,
  LocalKeywordMemoryIndex,
  MemoryError,
  MemoryPromptProvider,
  MarkdownMemoryLayout,
  MarkdownMemoryRepository,
  MemoryTransferService,
} from '@volund/storage'
import type { MemoryRecallService, MemoryService } from '@volund/storage'

import {
  memoryProjectId,
  memoryProjectRoot,
  projectMemoryScope,
  sessionMemoryScope,
  workspaceMemoryScope,
} from './memory-scope'

/** Memory 服务栈：home 下四件套的单一组合点（repository/index/service/recall/transfer）。 */
export interface MemoryStack {
  readonly memory: MemoryService
  readonly memoryRecall: DefaultMemoryRecallService
  readonly memoryMaintenance: DefaultMemoryMaintenanceService
  readonly memoryTransfer: MemoryTransferService
}

export interface MemoryStackOptions {
  /**
   * 当前项目根目录：project scope 的记忆按 ADR-0012 落到 `<cwd>/.volund/memory/*.md`
   * （随仓库走，用户自行决定是否提交）；缺省时全部落在 home 的 fallback 区。
   */
  readonly cwd?: string
}

/**
 * 记忆目录里人可见的只有 md（记录 + MEMORY.md 索引）；召回索引/锁/导入日志/
 * 审计等机器文件收进 `.state/` 隐藏子目录。旧版本落在根目录的机器文件在此
 * 一次性搬进去（新路径不存在才搬，幂等）。
 */
function relocateStateFiles(memoryRoot: string): string {
  const stateRoot = join(memoryRoot, '.state')
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 })
  for (const name of [
    'index.json',
    'index.json.bak',
    '.memory.lock',
    'import-journal.json',
    'audit.jsonl',
  ]) {
    const legacyPath = join(memoryRoot, name)
    const statePath = join(stateRoot, name)
    if (!existsSync(legacyPath) || existsSync(statePath)) continue
    renameSync(legacyPath, statePath)
  }
  return stateRoot
}

export function createMemoryStack(home: string, options: MemoryStackOptions = {}): MemoryStack {
  const memoryRoot = join(home, 'memory')
  const stateRoot = relocateStateFiles(memoryRoot)
  const repository = new MarkdownMemoryRepository({
    layout: new MarkdownMemoryLayout({
      root: memoryRoot,
      ...(options.cwd
        ? {
            currentProjectId: memoryProjectId(options.cwd),
            currentProjectDir: join(memoryProjectRoot(options.cwd), '.volund', 'memory'),
          }
        : {}),
    }),
    lockPath: join(stateRoot, '.memory.lock'),
    legacySnapshotPath: join(memoryRoot, 'records.json'),
  })
  const index = new LocalKeywordMemoryIndex(join(stateRoot, 'index.json'))
  const memory = new IndexingMemoryService(new DefaultMemoryService(repository), repository, index)
  return {
    memory,
    memoryRecall: new DefaultMemoryRecallService(memory, index),
    memoryMaintenance: new DefaultMemoryMaintenanceService(repository, index),
    memoryTransfer: new MemoryTransferService(memory, {
      journalPath: join(stateRoot, 'import-journal.json'),
    }),
  }
}

export function registerRuntimeMemoryPrompts(
  composer: PromptComposer,
  memory: MemoryService,
  state: Pick<SessionState, 'cwd' | 'id'>,
) {
  return new MemoryPromptProvider(memory, {
    scopes: [
      sessionMemoryScope(state.cwd, state.id),
      projectMemoryScope(state.cwd),
      workspaceMemoryScope(),
    ],
  }).register(composer)
}

export interface PluginMemoryHostOptions {
  readonly home: string
  readonly cwd: string
  /** 静态会话 id 或取当前活跃会话的 getter（插件宿主长驻、会话轮换时用 getter）。 */
  readonly sessionId?: string | (() => string | undefined)
  readonly memory: MemoryService
  readonly memoryRecall: MemoryRecallService
  readonly memoryTransfer: MemoryTransferService
}

export type PluginMemoryHost = (
  plugin: string,
  operation: string,
  rawParams: unknown,
) => Promise<unknown>

/** Production plugin adapter. Memory content stays inside MemoryService and never enters audit. */
export function createPluginMemoryHost(options: PluginMemoryHostOptions): PluginMemoryHost {
  return async (plugin: string, operation: string, rawParams: unknown): Promise<unknown> => {
    const params = rawParams as {
      scope: PluginMemoryScope
      id?: string
      query?: string
      options?: { limit?: number; tags?: readonly string[]; pinned?: boolean }
      content?: string
      tags?: readonly string[]
      pinned?: boolean
      patch?: { content?: string; tags?: readonly string[]; pinned?: boolean }
    }
    const sessionId =
      typeof options.sessionId === 'function' ? options.sessionId() : options.sessionId
    const scope =
      params.scope === 'workspace'
        ? workspaceMemoryScope()
        : params.scope === 'project'
          ? projectMemoryScope(options.cwd)
          : sessionId
            ? sessionMemoryScope(options.cwd, sessionId)
            : (() => {
                throw new MemoryError(
                  'memory_scope_denied',
                  'Session memory requires an active session',
                )
              })()
    const auditPath = join(options.home, 'memory', '.state', 'audit.jsonl')
    const writeOperation = ['create', 'update', 'delete'].includes(operation)
    if (writeOperation) {
      await mkdir(join(options.home, 'memory', '.state'), { recursive: true, mode: 0o700 })
      await appendFile(
        auditPath,
        `${JSON.stringify({
          schemaVersion: 1,
          at: new Date().toISOString(),
          phase: 'attempt',
          plugin,
          operation,
          scope: params.scope,
          ...(params.id ? { id: sanitize(params.id) } : {}),
        })}\n`,
        { encoding: 'utf8', mode: 0o600 },
      )
    }
    let result: unknown
    if (operation === 'get') result = (await options.memory.get(scope, String(params.id))) ?? null
    else if (operation === 'list') result = await options.memory.list(scope, params.options)
    else if (operation === 'search')
      result = await options.memoryRecall.recall(scope, String(params.query ?? ''), params.options)
    else if (operation === 'create')
      result = await options.memory.create({
        ...(params.id ? { id: params.id } : {}),
        scope,
        content: String(params.content ?? ''),
        provenance: { source: 'agent', actorId: `plugin:${plugin}` },
        ...(params.tags ? { tags: params.tags } : {}),
        ...(params.pinned === undefined ? {} : { pinned: params.pinned }),
      })
    else if (operation === 'update')
      result = await options.memory.update(scope, String(params.id), params.patch ?? {})
    else if (operation === 'delete') result = await options.memory.delete(scope, String(params.id))
    else result = await options.memoryTransfer.export([scope])
    await mkdir(join(options.home, 'memory', '.state'), { recursive: true, mode: 0o700 })
    await appendFile(
      auditPath,
      `${JSON.stringify({
        schemaVersion: 1,
        at: new Date().toISOString(),
        phase: 'success',
        plugin,
        operation,
        scope: params.scope,
        ...(params.id ? { id: sanitize(params.id) } : {}),
      })}\n`,
      { encoding: 'utf8', mode: 0o600 },
    )
    return result
  }
}
