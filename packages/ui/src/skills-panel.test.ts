import { describe, expect, it } from 'vitest'

import { collapseSkillInvocation } from './skills-panel'

describe('collapseSkillInvocation (stacked frames)', () => {
  it('collapses a single invocation exactly as before', () => {
    const text = '<skill name="git-flow" directory="/s/g">\nCommit flow\n</skill>\n\nfix the bug'
    expect(collapseSkillInvocation(text)).toEqual({
      name: 'git-flow',
      task: 'fix the bug',
      lines: 3,
    })
  })
  it('collapses a stacked invocation into first name + stack suffix and shared task', () => {
    const text = [
      '<skill name="a" directory="/s/a">',
      'A body',
      '</skill>',
      '<skill name="b" directory="/s/b">',
      'B1',
      'B2',
      '</skill>',
      '',
      'shared task',
    ].join('\n')
    expect(collapseSkillInvocation(text)).toEqual({
      name: 'a',
      stack: ['b'],
      task: 'shared task',
      lines: 7,
    })
  })
  it('returns undefined for ordinary messages', () => {
    expect(collapseSkillInvocation('plain user text')).toBeUndefined()
  })
})
