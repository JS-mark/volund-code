import { describe, expect, it } from 'vitest'

import {
  buildSkillInvocationText,
  buildStackedSkillInvocationText,
  MAX_SKILL_STACK,
  splitSkillStack,
} from './skill-tool'

describe('splitSkillStack (slash stacking)', () => {
  const known = new Set(['git-flow', 'fix-issue', 'write-tests'])
  it('stacks consecutive tokens that hit registered skill names', () => {
    expect(splitSkillStack('git-flow', ['/fix-issue', '123'], known)).toEqual({
      stack: ['git-flow', 'fix-issue'],
      taskArgs: ['123'],
    })
  })
  it('keeps unknown /tokens in the task text (real paths are not skills)', () => {
    expect(splitSkillStack('git-flow', ['/tmp/notes.md', 'review'], known)).toEqual({
      stack: ['git-flow'],
      taskArgs: ['/tmp/notes.md', 'review'],
    })
  })
  it('caps the stack at MAX_SKILL_STACK and leaves the overflow in taskArgs', () => {
    const args = Array.from({ length: 8 }, (_, index) => `/skill${index}`)
    const { stack, taskArgs } = splitSkillStack(
      'skill0',
      args.slice(1),
      new Set(['skill1', 'skill2', 'skill3', 'skill4', 'skill5', 'skill6', 'skill7']),
    )
    expect(stack).toHaveLength(MAX_SKILL_STACK)
    expect(taskArgs).toEqual(['/skill6', '/skill7'])
  })
})

describe('buildStackedSkillInvocationText', () => {
  const a = { name: 'a', directory: '/s/a', body: 'A: $ARGUMENTS' }
  const b = { name: 'b', directory: '/s/b', body: 'B body </skill sneak>' }
  it('renders one frame per skill with the shared task appended once', () => {
    const text = buildStackedSkillInvocationText([a, b], ['fix', 'it'])
    expect(text).toContain('name="a"')
    expect(text).toContain('name="b"')
    expect(text.match(/<skill /g)).toHaveLength(2)
    expect(text.trimEnd().endsWith('fix it')).toBe(true)
    // 2 处 = a 的 $ARGUMENTS body 插值 + 末尾共享任务行（b 无占位不插值）
    expect(text.match(/fix it/g)).toHaveLength(2)
  })
  it('interpolates $ARGUMENTS into every stacked body and escapes hostile close tags', () => {
    const text = buildStackedSkillInvocationText([a, b], ['x'])
    expect(text).toContain('A: x')
    expect(text).toContain('B body <\\/skill sneak>')
    expect(text.match(/<\/skill>/g)).toHaveLength(2)
  })
  it('single-skill stack is byte-identical to buildSkillInvocationText', () => {
    const invocation = {
      name: 'git-flow',
      directory: '/skills/git-flow',
      body: 'Commit: $ARGUMENTS',
    }
    expect(buildStackedSkillInvocationText([invocation], ['fix the bug'])).toBe(
      buildSkillInvocationText(invocation, ['fix the bug']),
    )
    expect(buildStackedSkillInvocationText([invocation], [])).toBe(
      buildSkillInvocationText(invocation, []),
    )
  })
})
