import { describe, expect, expectTypeOf, it, vi } from 'vitest'

import type { Tool, ToolContext, ToolResult } from './index'
import { ToolRegistry } from './index'

const tool = (name: string): Tool => ({
  name,
  description: `${name} description`,
  inputSchema: { type: 'object' },
  permissionSpec: () => ({}),
  invoke: vi.fn(
    async (): Promise<ToolResult> => ({
      content: [{ type: 'text', text: 'ok' }],
    }),
  ),
})

describe('tool contract', () => {
  it('requires schema, permission, abort-aware context, and normalized result', () => {
    expectTypeOf<Tool>().toHaveProperty('inputSchema')
    expectTypeOf<Tool>().toHaveProperty('permissionSpec')
    expectTypeOf<Tool>().toHaveProperty('invoke')
    expectTypeOf<ToolContext>().toHaveProperty('abortSignal').toEqualTypeOf<AbortSignal>()
    expectTypeOf<ToolResult>().toHaveProperty('content')
    expectTypeOf<ToolResult>().toHaveProperty('isError').toEqualTypeOf<boolean | undefined>()
  })

  it('registers builtins under fixed names and disposes them', () => {
    const registry = new ToolRegistry()
    const read = tool('Read')
    const dispose = registry.register(read)
    expect(registry.get('Read')).toBe(read)
    expect(registry.forProvider()).toEqual([
      { name: 'Read', description: 'Read description', inputSchema: { type: 'object' } },
    ])
    dispose()
    expect(registry.get('Read')).toBeUndefined()
  })

  it('enforces MCP and plugin namespaces', () => {
    const registry = new ToolRegistry()
    expect(() => registry.register(tool('search'), { kind: 'mcp', server: 'docs' })).toThrow(
      'mcp__<server>',
    )
    expect(() => registry.register(tool('search'), { kind: 'plugin', plugin: 'demo' })).toThrow(
      'plugin:<name>',
    )
    expect(() =>
      registry.register(tool('mcp__docs__search'), { kind: 'mcp', server: 'docs' }),
    ).not.toThrow()
    expect(() =>
      registry.register(tool('plugin:demo:search'), { kind: 'plugin', plugin: 'demo' }),
    ).not.toThrow()
  })

  it('rejects duplicate names regardless of source', () => {
    const registry = new ToolRegistry()
    registry.register(tool('Read'))
    expect(() => registry.register(tool('Read'))).toThrow('Tool already registered')
  })
})
