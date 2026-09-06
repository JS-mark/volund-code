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
  LocalMemoryRepository,
  MemoryError,
  MemoryPromptProvider,
  MemoryTransferService,
} from '@volund/storage'
import type { MemoryRecallService, MemoryService } from '@volund/storage'

import { projectMemoryScope, sessionMemoryScope, workspaceMemoryScope } from './memory-scope'

/** Memory 服务栈：home 下四件套的单一组合点（repository/index/service/recall/transfer）。 */
export interface MemoryStack {
  readonly memory: MemoryService
  readonly memoryRecall: DefaultMemoryRecallService
  readonly memoryMaintenance: DefaultMemoryMaintenanceService
  readonly memoryTransfer: MemoryTransferService
}

export function createMemoryStack(home: string): MemoryStack {
  const repository = new LocalMemoryRepository(join(home, 'memory', 'records.json'))
  const index = new LocalKeywordMemoryIndex(join(home, 'memory', 'index.json'))
  const memory = new IndexingMemoryService(new DefaultMemoryService(repository), repository, index)
  return {
    memory,
    memoryRecall: new DefaultMemoryRecallService(memory, index),
    memoryMaintenance: new DefaultMemoryMaintenanceService(repository, index),
    memoryTransfer: new MemoryTransferService(memory, {
      journalPath: join(home, 'memory', 'import-journal.json'),
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
  readonly sessionId?: string
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
    const scope =
      params.scope === 'workspace'
        ? workspaceMemoryScope()
        : params.scope === 'project'
          ? projectMemoryScope(options.cwd)
          : options.sessionId
            ? sessionMemoryScope(options.cwd, options.sessionId)
            : (() => {
                throw new MemoryError(
                  'memory_scope_denied',
                  'Session memory requires an active session',
                )
              })()
    const auditPath = join(options.home, 'memory', 'audit.jsonl')
    const writeOperation = ['create', 'update', 'delete'].includes(operation)
    if (writeOperation) {
      await mkdir(join(options.home, 'memory'), { recursive: true, mode: 0o700 })
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
    await mkdir(join(options.home, 'memory'), { recursive: true, mode: 0o700 })
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
