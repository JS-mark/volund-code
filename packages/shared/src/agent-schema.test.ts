import { describe, expect, it } from 'vitest'

import { agentDefinitionSchema, parseAgentDefinition } from './agent-schema'

const valid = {
  name: 'code-explainer',
  description: '读代码并解释结构',
  model: { provider: 'openai', model: 'gpt-5-mini' },
  tools: ['Read', 'Grep', 'Glob'],
  maxTurns: 10,
}

describe('agent definition schema (§2.7.1)', () => {
  it('accepts a complete definition and all optionals can be omitted', () => {
    expect(agentDefinitionSchema.parse(valid)).toMatchObject({ name: 'code-explainer' })
    expect(agentDefinitionSchema.parse({ name: 'minimal', description: 'd' })).toMatchObject({
      name: 'minimal',
    })
  })

  it('rejects a missing or non-scalar description', () => {
    expect(() => agentDefinitionSchema.parse({ name: 'x' })).toThrow()
    expect(() => agentDefinitionSchema.parse({ name: 'x', description: '' })).toThrow()
  })

  it('rejects names outside [a-z0-9-]', () => {
    expect(() => agentDefinitionSchema.parse({ ...valid, name: 'Code_Explainer' })).toThrow()
    expect(() => agentDefinitionSchema.parse({ ...valid, name: '' })).toThrow()
  })

  it('rejects unknown keys, empty tool entries and non-integer maxTurns', () => {
    expect(() => agentDefinitionSchema.parse({ ...valid, extra: true })).toThrow()
    expect(() => agentDefinitionSchema.parse({ ...valid, tools: [''] })).toThrow()
    expect(() => agentDefinitionSchema.parse({ ...valid, maxTurns: 1.5 })).toThrow()
    expect(() => agentDefinitionSchema.parse({ ...valid, maxTurns: 0 })).toThrow()
  })

  it('parseAgentDefinition rejects tool whitelists exceeding the parent registry', () => {
    expect(parseAgentDefinition(valid, { allowedTools: ['Read', 'Grep', 'Glob', 'Edit'] })).toMatchObject(
      { name: 'code-explainer' },
    )
    expect(() => parseAgentDefinition(valid, { allowedTools: ['Read'] })).toThrow(
      /tools exceed parent registry: Grep, Glob/,
    )
  })
})
