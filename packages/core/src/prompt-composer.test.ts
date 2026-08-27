import { describe, expect, it } from 'vitest'

import { DefaultPromptComposer, builtinPromptFragment } from './prompt-composer'
describe('PromptComposer', () => {
  it('filters, sorts stably, annotates, interpolates and invalidates', async () => {
    const composer = new DefaultPromptComposer()
    composer.register({ id: 'b', source: 'project', priority: 600, text: 'B {{cwd}}' })
    composer.register({ id: 'a', source: 'user', priority: 600, text: 'A' })
    composer.register({ id: 'off', source: 'off', priority: 999, when: () => false, text: 'NO' })
    const context = { cwd: '/repo', model: 'm', provider: 'p' }
    const first = await composer.compose(context)
    expect(first).toContain('source: user, priority: 600')
    expect(first.indexOf('\nA')).toBeLessThan(first.indexOf('\nB /repo'))
    expect(first).not.toContain('NO')
    expect(first).toContain('\n\n---\n\n')
    const disposable = composer.register({
      id: 'top',
      source: 'builtin',
      priority: 1000,
      text: 'TOP',
    })
    expect(await composer.compose(context)).toContain('TOP')
    disposable.dispose()
    expect(await composer.compose(context)).not.toContain('TOP')
  })
  it('provides the priority-1000 builtin', () => {
    expect(builtinPromptFragment.priority).toBe(1000)
    expect(builtinPromptFragment.text).toContain('You are Volund CLI')
  })
  it('builtin prompt forbids disclosing the system prompt (§6.5.0b)', () => {
    const text =
      typeof builtinPromptFragment.text === 'string'
        ? builtinPromptFragment.text
        : builtinPromptFragment.text({ cwd: '', model: '', provider: '' })
    // §6.5.0b：必须含不复述指令，且显式覆盖"用户直接问"与"untrusted 诱导"两条路径
    expect(text).toMatch(/never reveal.*system prompt/i)
    expect(text).toMatch(/untrusted/i)
    expect(text).toMatch(/can't share/i)
  })
})
