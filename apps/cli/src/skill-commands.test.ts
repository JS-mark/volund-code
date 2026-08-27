import type { SkillEntry } from '@volund/skills-runtime'
import { MutableSlashCommandRegistry } from '@volund/ui'
import { describe, expect, it, vi } from 'vitest'

import { SkillSlashCommands } from './skill-commands'

function entry(name: string, overrides: Partial<SkillEntry> = {}): SkillEntry {
  return {
    name,
    description: `${name} skill description`,
    resources: [],
    path: `/skills/${name}/SKILL.md`,
    scope: 'user',
    disableModelInvocation: false,
    userInvocable: true,
    incompatible: false,
    status: 'available',
    ...overrides,
  }
}

describe('SkillSlashCommands (SKILLS-MCPS-r1 §S3.3a)', () => {
  it('registers each user-invocable skill as a same-name command that invokes it one-shot', async () => {
    const registry = new MutableSlashCommandRegistry()
    const invoke = vi.fn(async (name: string, args: readonly string[]) => ({
      kind: 'submit' as const,
      text: `<skill name="${name}">…</skill>\n\n${args.join(' ')}`,
    }))
    const commands = new SkillSlashCommands({ registry, invoke, onWarn: () => {} })
    commands.sync([entry('git-flow'), entry('pdf-tools', { description: 'a'.repeat(120) })])
    expect(commands.registered()).toEqual(['git-flow', 'pdf-tools'])
    const registered = registry.snapshot().find((command) => command.name === 'git-flow')!
    expect(registered.source).toEqual({ kind: 'skill' })
    expect(registered.description).toBe('git-flow skill description')
    // 长描述截断到一行 80
    expect(
      registry.snapshot().find((command) => command.name === 'pdf-tools')!.description.length,
    ).toBeLessThanOrEqual(80)
    // /git-flow 写一条 commit message → invoke(name, args)；run 返回 submit 视图
    const outcome = await registered.run({
      name: 'git-flow',
      args: ['write', 'a', 'commit', 'message'],
      raw: '/git-flow write a commit message',
    })
    expect(outcome).toEqual({
      kind: 'submit',
      text: expect.stringContaining('write a commit message'),
    })
    expect(invoke).toHaveBeenCalledWith('git-flow', ['write', 'a', 'commit', 'message'])
    commands.dispose()
    expect(registry.snapshot().find((command) => command.name === 'git-flow')).toBeUndefined()
  })
  it('skips broken/shadowed/disabled and user-invocable-false skills, and unregisters on removal', () => {
    const registry = new MutableSlashCommandRegistry()
    const commands = new SkillSlashCommands({
      registry,
      invoke: async () => ({ kind: 'submit', text: 'x' }),
      onWarn: () => {},
    })
    commands.sync([
      entry('ok'),
      entry('broken-skill', { status: 'broken', reason: 'invalid frontmatter' }),
      entry('shadowed-skill', { status: 'shadowed' }),
      entry('disabled-skill', { status: 'disabled' }),
      entry('hidden', { userInvocable: false }),
    ])
    expect(commands.registered()).toEqual(['ok'])
    // r 后 ok 被移除、broken 修复为 available → 注销 ok、注册 broken-skill
    commands.sync([entry('broken-skill')])
    expect(commands.registered()).toEqual(['broken-skill'])
    // disabled 转换（面板 Space）后即时消失
    commands.sync([entry('broken-skill', { status: 'disabled' })])
    expect(commands.registered()).toEqual([])
    commands.dispose()
  })
  it('warns and skips when a skill name collides with a builtin or registered command', () => {
    const registry = new MutableSlashCommandRegistry()
    const warn = vi.fn()
    const commands = new SkillSlashCommands({
      registry,
      invoke: async () => ({ kind: 'submit', text: 'x' }),
      onWarn: warn,
    })
    commands.sync([entry('status'), entry('model'), entry('unique')])
    expect(commands.registered()).toEqual(['unique'])
    expect(warn).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('/status not registered'))
    commands.dispose()
  })
})
