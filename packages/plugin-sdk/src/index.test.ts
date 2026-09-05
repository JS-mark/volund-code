import { describe, expect, it } from 'vitest'

import { definePlugin, defineTool } from './index'
describe('plugin sdk', () => {
  it('is runtime-free identity helpers', () => {
    const plugin = { activate() {} }
    const tool = { name: 'x', description: 'd', handler: async () => undefined }
    expect(definePlugin(plugin)).toBe(plugin)
    expect(defineTool(tool)).toBe(tool)
  })
  it('types the dsh-style authoring shape (inputSchema optional)', () => {
    // dsh 对齐工效层：裸名 + 可省 inputSchema；前缀由宿主收敛。
    const tool = defineTool({
      name: 'word-count',
      description: 'Count words',
      handler: async () => ({ words: 0 }),
    })
    expect(tool.name).toBe('word-count')
  })
})
