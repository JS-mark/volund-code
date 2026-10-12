import type {
  MemoryListOptions,
  MemoryRecordScope,
  MemoryRecallService,
  MemoryService,
  NewMemoryRecord,
} from '@volund/storage'
import type { Tool, ToolContext, ToolResult } from '@volund/tool-kit'

import { projectMemoryScope, sessionMemoryScope, workspaceMemoryScope } from './memory-scope'

type ScopeKind = MemoryRecordScope['kind']

const scopeSchema = { type: 'string', enum: ['workspace', 'project', 'session'] }
const baseProperties = { scope: scopeSchema }

const SNIPPET_MAX_LINES = 20
const SNIPPET_MAX_CHARS = 1_000

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

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/** Short preview of a hit's content; Memory.get remains the full-text channel. */
function snippetOf(content: string): string {
  const lines = content.split('\n', SNIPPET_MAX_LINES + 1)
  const clipped =
    lines.length > SNIPPET_MAX_LINES
      ? `${lines.slice(0, SNIPPET_MAX_LINES).join('\n')}\n…`
      : lines.join('\n')
  return clipped.length > SNIPPET_MAX_CHARS ? `${clipped.slice(0, SNIPPET_MAX_CHARS)}…` : clipped
}

function tool(definition: Omit<Tool, 'permissionSpec'> & { readonly readonly?: boolean }): Tool {
  return { ...definition, permissionSpec: () => ({}) }
}

/** Model-facing adapters. All authorization and mutation semantics remain in MemoryService. */
export function createMemoryTools(
  memory: MemoryService,
  memoryRecall: MemoryRecallService,
): Tool[] {
  return [
    tool({
      name: 'Memory.create',
      description:
        'Create a durable memory. Pick the scope by who the knowledge belongs to: workspace = user-level preferences that hold across every project (taste, tone, collaboration habits); project = facts about this repository only (conventions, commands, pitfalls); session = context for this task alone. Reply-format or mandatory-phrasing rules the user wants enforced belong in AGENT.md (project or ~/.volund), not in memory.',
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
    tool({
      name: 'Memory.recall',
      description:
        'Search memories by keywords (local index). Searches all scopes (session, project, workspace) by default; narrow with scope. Returns short snippets; read the full text of a hit with Memory.get.',
      readonly: true,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['query'],
        properties: {
          scope: {
            type: 'string',
            enum: ['workspace', 'project', 'session', 'all'],
            description: 'Defaults to all: session, project, and workspace merged by relevance.',
          },
          query: { type: 'string', minLength: 1, maxLength: 512 },
          tags: { type: 'array', items: { type: 'string', maxLength: 64 }, maxItems: 64 },
          limit: { type: 'integer', minimum: 1, maximum: 50 },
        },
      },
      async invoke(value: unknown, context) {
        const input = value as {
          scope?: ScopeKind | 'all'
          query: string
          tags?: string[]
          limit?: number
        }
        const scopeKind = input.scope ?? 'all'
        const recallOptions = {
          ...(input.limit === undefined ? {} : { limit: input.limit }),
          ...(input.tags === undefined ? {} : { tags: input.tags }),
        }
        const scopes: ScopeKind[] =
          scopeKind === 'all' ? ['session', 'project', 'workspace'] : [scopeKind]
        // Scores come from one shared index, so they are comparable across scopes.
        const hits = (
          await Promise.all(
            scopes.map((kind) =>
              memoryRecall.recall(scopeFor(kind, context), input.query, recallOptions),
            ),
          )
        )
          .flat()
          .toSorted((left, right) => right.score - left.score)
          .slice(0, input.limit ?? 10)
        if (hits.length === 0) return text({ query: input.query, scope: scopeKind, hits: [] })
        const body = hits
          .map((hit) =>
            [
              `<memory id="${escapeXml(hit.record.id)}" scope="${hit.record.scope.kind}" pinned="${hit.record.pinned}" updated="${escapeXml(hit.record.updatedAt)}">`,
              escapeXml(snippetOf(hit.record.content)),
              '</memory>',
            ].join('\n'),
          )
          .join('\n')
        return {
          content: [
            {
              type: 'text',
              text:
                `<untrusted source="memory:recall" query="${escapeXml(input.query)}">\n${body}\n</untrusted>\n` +
                'Snippets only — read the full text of a hit with Memory.get <id>.',
            },
          ],
          meta: { durationMs: 0, costImpact: 'safe' },
        }
      },
    }),
    tool({
      name: 'Memory.move',
      description:
        'Move a memory to another scope (workspace <-> project), keeping id and content. Use this when a memory was filed under the wrong scope; e.g. a user-level preference saved as project, or a repository fact saved as workspace.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['scope', 'id', 'to'],
        properties: {
          ...baseProperties,
          id: { type: 'string' },
          to: { type: 'string', enum: ['workspace', 'project'] },
          expectedUpdatedAt: { type: 'string' },
        },
      },
      async invoke(value: unknown, context) {
        const input = value as {
          scope: ScopeKind
          id: string
          to: 'workspace' | 'project'
          expectedUpdatedAt?: string
        }
        const options = input.expectedUpdatedAt
          ? { expectedUpdatedAt: input.expectedUpdatedAt }
          : undefined
        return text(
          await memory.move(
            scopeFor(input.scope, context),
            input.id,
            scopeFor(input.to, context),
            options,
          ),
        )
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
