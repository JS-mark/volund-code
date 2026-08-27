import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { DefaultPromptComposer } from '@volund/core'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SkillsRuntime, defaultSkillSources } from './index'

const dirs: string[] = []
afterEach(async () =>
  Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))),
)
async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), 'volund-skills-'))
  dirs.push(root)
  const skill = resolve(root, 'skills', 'testing')
  await mkdir(resolve(skill, 'references'), { recursive: true })
  await writeFile(
    resolve(skill, 'SKILL.md'),
    `---\nname: testing\ndescription: Test projects safely\nvolundVersion: ^1.0.0\nversion: 1.2.0\nactivation:\n  manual: true\nresources:\n  - references/details.md\n---\n# Testing\nRun focused tests.`,
  )
  await writeFile(resolve(skill, 'references/details.md'), 'Never skip failures.')
  return { root, skill }
}
async function writeSkill(dir: string, name: string, frontmatter: string, body = 'Body') {
  await mkdir(resolve(dir, name), { recursive: true })
  await writeFile(resolve(dir, name, 'SKILL.md'), `---\n${frontmatter}\n---\n${body}`)
}

describe('SkillsRuntime', () => {
  it('installs only a skill manifest and its declared resources', async () => {
    const { root, skill } = await fixture()
    const installRoot = resolve(root, 'installed')
    const runtime = new SkillsRuntime({
      skillsDir: installRoot,
      volundVersion: '1.0.0',
      composer: new DefaultPromptComposer(),
    })
    expect((await runtime.installFromDirectory(skill)).name).toBe('testing')
    expect(await runtime.discover()).toHaveLength(1)
    await expect(runtime.installFromDirectory(skill)).rejects.toThrow('already installed')
  })
  it('discovers only metadata, then progressively loads declared resources on activation', async () => {
    const { root } = await fixture()
    const composer = new DefaultPromptComposer()
    const runtime = new SkillsRuntime({
      skillsDir: resolve(root, 'skills'),
      volundVersion: '1.0.0',
      composer,
    })
    expect(await runtime.discover()).toEqual([
      expect.objectContaining({ name: 'testing', description: 'Test projects safely' }),
    ])
    await runtime.registerIndex()
    let prompt = await composer.compose({ cwd: root, model: 'm', provider: 'p' })
    expect(prompt).toContain('testing: Test projects safely')
    expect(prompt).not.toContain('Run focused tests')
    expect(await runtime.activate('testing')).toBe(true)
    expect(await runtime.activate('testing')).toBe(false)
    prompt = await composer.compose({ cwd: root, model: 'm', provider: 'p' })
    expect(prompt).toContain('Run focused tests')
    expect(prompt).toContain('Never skip failures')
    expect(runtime.deactivate('testing')).toBe(true)
    expect(await composer.compose({ cwd: root, model: 'm', provider: 'p' })).not.toContain(
      'Run focused tests',
    )
  })

  it('warns on incompatible versions and rejects undeclared or escaping resources', async () => {
    const { root, skill } = await fixture()
    await writeFile(resolve(root, 'secret.md'), 'secret')
    await writeFile(
      resolve(skill, 'SKILL.md'),
      `---\nname: testing\ndescription: Test projects safely\nvolundVersion: ^2.0.0\nresources:\n  - ../../secret.md\n---\nBody`,
    )
    const warning = vi.fn()
    const runtime = new SkillsRuntime({
      skillsDir: resolve(root, 'skills'),
      volundVersion: '1.0.0',
      composer: new DefaultPromptComposer(),
      onWarning: warning,
    })
    await runtime.discover()
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('requires volund'))
    await expect(runtime.activate('testing')).rejects.toThrow('escapes skill directory')
  })

  it('discovers standard agent skills without volundVersion (SKILLS-MCPS-r1)', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'volund-skills-'))
    dirs.push(root)
    // anthropics/skills 风格：仅标准字段，无 volundVersion。
    await writeSkill(
      resolve(root, 'skills'),
      'pdf-processing',
      'name: pdf-processing\ndescription: Extract text from PDF files',
      'Use the pdf script.',
    )
    const composer = new DefaultPromptComposer()
    const runtime = new SkillsRuntime({
      skillsDir: resolve(root, 'skills'),
      volundVersion: '1.0.0',
      composer,
    })
    const discovered = await runtime.discover()
    expect(discovered).toHaveLength(1)
    expect(discovered[0]!.name).toBe('pdf-processing')
    expect(discovered[0]).not.toHaveProperty('volundVersion')
    expect(await runtime.activate('pdf-processing')).toBe(true)
  })

  it('shadows same-name skills across scopes instead of failing (SKILLS-MCPS-r1)', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'volund-skills-'))
    dirs.push(root)
    await writeSkill(
      resolve(root, 'project', '.volund', 'skills'),
      'git-flow',
      'name: git-flow\ndescription: Project git flow',
      'Project body.',
    )
    await writeSkill(
      resolve(root, 'home', 'skills'),
      'git-flow',
      'name: git-flow\ndescription: User git flow',
      'User body.',
    )
    const composer = new DefaultPromptComposer()
    const runtime = new SkillsRuntime({
      sources: [
        { dir: resolve(root, 'project', '.volund', 'skills'), scope: 'project' },
        { dir: resolve(root, 'home', 'skills'), scope: 'user' },
      ],
      volundVersion: '1.0.0',
      composer,
    })
    const discovered = await runtime.discover()
    expect(discovered).toHaveLength(1)
    expect(discovered[0]!.description).toBe('Project git flow')
    const entries = runtime.entries()
    expect(entries.filter((entry) => entry.status === 'shadowed')).toEqual([
      expect.objectContaining({
        name: 'git-flow',
        scope: 'user',
        reason: expect.stringContaining('shadowed by project'),
      }),
    ])
    await runtime.activate('git-flow')
    const prompt = await composer.compose({ cwd: root, model: 'm', provider: 'p' })
    expect(prompt).toContain('Project body.')
    expect(prompt).not.toContain('User body.')
  })

  it('marks skills with invalid standard fields as broken, not fatal (SKILLS-MCPS-r1)', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'volund-skills-'))
    dirs.push(root)
    await writeSkill(resolve(root, 'skills'), 'mismatch', 'name: other-name\ndescription: x')
    await writeSkill(resolve(root, 'skills'), 'no-description', 'name: no-description')
    await writeSkill(resolve(root, 'skills'), 'Bad_Name', 'name: Bad_Name\ndescription: x')
    await writeSkill(resolve(root, 'skills'), 'fine', 'name: fine\ndescription: works')
    const composer = new DefaultPromptComposer()
    const runtime = new SkillsRuntime({
      skillsDir: resolve(root, 'skills'),
      volundVersion: '1.0.0',
      composer,
    })
    expect((await runtime.discover()).map((skill) => skill.name)).toEqual(['fine'])
    const broken = runtime.entries().filter((entry) => entry.status === 'broken')
    expect(broken.map((entry) => entry.name).toSorted()).toEqual([
      'Bad_Name',
      'mismatch',
      'no-description',
    ])
    await expect(runtime.activate('mismatch')).rejects.toThrow('broken')
    await expect(runtime.activate('no-description')).rejects.toThrow('broken')
  })

  it('hides disabled and disable-model-invocation skills from the model (SKILLS-MCPS-r1)', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'volund-skills-'))
    dirs.push(root)
    await writeSkill(resolve(root, 'skills'), 'hidden', 'name: hidden\ndescription: h')
    await writeSkill(resolve(root, 'skills'), 'off', 'name: off\ndescription: o')
    await writeFile(
      resolve(root, 'skills', 'off', 'SKILL.md'),
      `---\nname: off\ndescription: o\ndisable-model-invocation: true\n---\nOff body.`,
    )
    const composer = new DefaultPromptComposer()
    const runtime = new SkillsRuntime({
      skillsDir: resolve(root, 'skills'),
      volundVersion: '1.0.0',
      composer,
      disabled: new Set(['hidden']),
    })
    await runtime.discover()
    await runtime.registerIndex()
    const prompt = await composer.compose({ cwd: root, model: 'm', provider: 'p' })
    expect(prompt).not.toContain('hidden')
    expect(prompt).not.toContain('off:')
    await expect(runtime.activate('hidden')).rejects.toThrow('disabled')
    // 显式激活是用户路径，disable-model-invocation 不拦（拦的是模型自动路径）。
    expect(await runtime.activate('off')).toBe(true)
    expect(runtime.entries().find((entry) => entry.name === 'hidden')?.status).toBe('disabled')
  })

  it('drops descriptions from the tail when the index budget is exceeded (SKILLS-MCPS-r1)', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'volund-skills-'))
    dirs.push(root)
    for (let index = 0; index < 4; index++)
      await writeSkill(
        resolve(root, 'skills'),
        `skill-${index}`,
        `name: skill-${index}\ndescription: ${'d'.repeat(100)} number ${index}`,
      )
    const composer = new DefaultPromptComposer()
    const runtime = new SkillsRuntime({
      skillsDir: resolve(root, 'skills'),
      volundVersion: '1.0.0',
      composer,
      indexBudgetChars: 260,
    })
    await runtime.discover()
    await runtime.registerIndex()
    const prompt = await composer.compose({ cwd: root, model: 'm', provider: 'p' })
    expect(prompt.length).toBeLessThan(400)
    expect(prompt).toContain('skill-0')
    expect(prompt).toContain('skill-3')
    expect(prompt).not.toContain('number 3')
  })

  it('readInvocation returns the body without frontmatter and no prompt fragment (§S3.3a)', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'volund-skills-'))
    dirs.push(root)
    await writeSkill(
      resolve(root, 'skills'),
      'demo',
      'name: demo\ndescription: d\nresources:\n  - notes.md',
      'One-shot body.',
    )
    await writeFile(resolve(root, 'skills', 'demo', 'notes.md'), 'resource text')
    const composer = new DefaultPromptComposer()
    const runtime = new SkillsRuntime({
      skillsDir: resolve(root, 'skills'),
      volundVersion: '1.0.0',
      composer,
    })
    await runtime.discover()
    const invocation = await runtime.readInvocation('demo')
    expect(invocation.body).toBe('One-shot body.')
    expect(invocation.directory).toBe(await realpath(resolve(root, 'skills', 'demo')))
    // invocation 不改 prompt：body 不进 compose 结果，active 列表为空
    expect(await composer.compose({ cwd: root, model: 'm', provider: 'p' })).not.toContain(
      'One-shot body.',
    )
    expect(runtime.active()).toEqual([])
    await expect(runtime.readInvocation('missing')).rejects.toThrow('Unknown skill')
  })

  it('orders default skill sources project-first with interop paths last (SKILLS-MCPS-r1)', () => {
    const sources = defaultSkillSources({
      volundHome: '/home/mark/.volund',
      userHome: '/home/mark',
      cwd: '/work/repo',
    })
    expect(sources.map((source) => source.dir)).toEqual([
      '/work/repo/.volund/skills',
      '/work/repo/.agents/skills',
      '/home/mark/.volund/skills',
      '/home/mark/.agents/skills',
    ])
    expect(sources[0]!.scope).toBe('project')
    expect(sources[1]).toEqual(expect.objectContaining({ scope: 'project', interop: true }))
    expect(sources[2]!.scope).toBe('user')
    expect(sources[3]).toEqual(expect.objectContaining({ scope: 'user', interop: true }))
  })
})

it('installs into the requested scope (SKILLS-MCPS-r1 §S3.2)', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'volund-skills-'))
  dirs.push(root)
  await writeSkill(resolve(root, 'src'), 'deploy', 'name: deploy\ndescription: deploys')
  const project = resolve(root, 'ws', '.volund', 'skills')
  const runtime = new SkillsRuntime({
    sources: [
      { dir: project, scope: 'project' },
      { dir: resolve(root, 'home'), scope: 'user' },
    ],
    volundVersion: '1.0.0',
    composer: new DefaultPromptComposer(),
  })
  const installed = await runtime.installFromDirectory(resolve(root, 'src', 'deploy'), {
    scope: 'project',
  })
  expect(installed.scope).toBe('project')
  expect(await readFile(resolve(project, 'deploy', 'SKILL.md'), 'utf8')).toContain('deploys')
  // 默认仍装 user
  await writeSkill(resolve(root, 'src2'), 'audit', 'name: audit\ndescription: audits')
  const userInstalled = await runtime.installFromDirectory(resolve(root, 'src2', 'audit'))
  expect(userInstalled.scope).toBe('user')
})
