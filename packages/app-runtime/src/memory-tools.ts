import type {
  MemoryListOptions,
  MemoryRecordScope,
  MemoryService,
  NewMemoryRecord,
} from '@volund/storage'
import type { Tool, ToolContext, ToolResult } from '@volund/tool-kit'

import { projectMemoryScope, sessionMemoryScope, workspaceMemoryScope } from './memory-scope'

type ScopeKind = MemoryRecordScope['kind']

const scopeSchema = { type: 'string', enum: ['workspace', 'project', 'session'] }
const baseProperties = { scope: scopeSchema }

function scopeFor(kind: ScopeKind, context: ToolContext): MemoryRecordScope {
  if (kind === 'workspace') return workspaceMemoryScope()
  if (kind === 'project') return projectMemoryScope(context.session.cwd)
  return sessionMemoryScope(context.session.cwd, context.session.id)
}

function text(value: unknown): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    meta: { durationMs: 0, costImpact: 'safe' },
  }
}

function tool(definition: Omit<Tool, 'permissionSpec'> & { readonly readonly?: boolean }): Tool {
  return { ...definition, permissionSpec: () => ({}) }
}

/** Model-facing adapters. All authorization and mutation semantics remain in MemoryService. */
export function createMemoryTools(memory: MemoryService): Tool[] {
  return [
    tool({
      name: 'Memory.create',
      description: 'Create a durable memory in the current workspace, project, or session scope',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['scope', 'content'],
        properties: {
          ...baseProperties,
          id: { type: 'string', maxLength: 128 },
          content: { type: 'string', minLength: 1, maxLength: 65_536 },
          tags: { type: 'array', items: { type: 'string', maxLength: 64 }, maxItems: 64 },
          pinned: { type: 'boolean' },
        },
      },
      async invoke(value: unknown, context) {
        const input = value as {
          scope: ScopeKind
          id?: string
          content: string
          tags?: string[]
          pinned?: boolean
        }
        const record: NewMemoryRecord = {
          scope: scopeFor(input.scope, context),
          content: input.content,
          provenance: { source: 'agent', actorId: 'model' },
          ...(input.id ? { id: input.id } : {}),
          ...(input.tags ? { tags: input.tags } : {}),
          ...(input.pinned === undefined ? {} : { pinned: input.pinned }),
        }
        return text(await memory.create(record))
      },
    }),
    tool({
      name: 'Memory.get',
      description: 'Get a memory visible in the current scope',
      readonly: true,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['scope', 'id'],
        properties: { ...baseProperties, id: { type: 'string' } },
      },
      async invoke(value: unknown, context) {
        const input = value as { scope: ScopeKind; id: string }
        return text((await memory.get(scopeFor(input.scope, context), input.id)) ?? null)
      },
    }),
    tool({
      name: 'Memory.list',
      description: 'List memories with stable cursor pagination',
      readonly: true,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['scope'],
        properties: {
          ...baseProperties,
          cursor: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 500 },
          pinned: { type: 'boolean' },
          tags: { type: 'array', items: { type: 'string' }, maxItems: 64 },
        },
      },
      async invoke(value: unknown, context) {
        const input = value as { scope: ScopeKind } & MemoryListOptions
        const { scope, ...options } = input
        return text(await memory.listPage(scopeFor(scope, context), options))
      },
    }),
    ...(['update', 'delete', 'pin', 'unpin'] as const).map(
      (operation): Tool =>
        tool({
          name: `Memory.${operation}`,
          description: `${operation[0]!.toUpperCase()}${operation.slice(1)} a memory in the current scope`,
          inputSchema: {
            type: 'object',
            additionalProperties: false,
            required: ['scope', 'id'],
            properties: {
              ...baseProperties,
              id: { type: 'string' },
              expectedUpdatedAt: { type: 'string' },
              ...(operation === 'update'
                ? {
                    content: { type: 'string', minLength: 1, maxLength: 65_536 },
                    tags: { type: 'array', items: { type: 'string' }, maxItems: 64 },
                    pinned: { type: 'boolean' },
                  }
                : {}),
            },
          },
          async invoke(value: unknown, context) {
            const input = value as {
              scope: ScopeKind
              id: string
              expectedUpdatedAt?: string
              content?: string
              tags?: string[]
              pinned?: boolean
            }
            const scope = scopeFor(input.scope, context)
            const options = input.expectedUpdatedAt
              ? { expectedUpdatedAt: input.expectedUpdatedAt }
              : undefined
            if (operation === 'delete') return text(await memory.delete(scope, input.id, options))
            if (operation === 'pin') return text(await memory.pin(scope, input.id, options))
            if (operation === 'unpin') return text(await memory.unpin(scope, input.id, options))
            return text(
              await memory.update(
                scope,
                input.id,
                {
                  ...(input.content === undefined ? {} : { content: input.content }),
                  ...(input.tags === undefined ? {} : { tags: input.tags }),
                  ...(input.pinned === undefined ? {} : { pinned: input.pinned }),
                },
                options,
              ),
            )
          },
        }),
    ),
  ]
}
