import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

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
  it('emits §S3.8 sampling events for scope shadowing and schema rejection', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'volund-skills-'))
    dirs.push(root)
    await writeSkill(resolve(root, 'skills'), 'dup', 'name: dup\ndescription: winner')
    await writeSkill(resolve(root, 'interops'), 'dup', 'name: dup\ndescription: loser')
    await writeSkill(resolve(root, 'skills'), 'badname', 'name: BAD_NAME\ndescription: x')
    const events: Array<{ event: string; payload: Record<string, unknown> }> = []
    const runtime = new SkillsRuntime({
      sources: [
        { dir: resolve(root, 'skills'), scope: 'user' },
        { dir: resolve(root, 'interops'), scope: 'project', interop: true },
      ],
      volundVersion: '1.0.0',
      composer: new DefaultPromptComposer(),
      onEvent: (event, payload) => events.push({ event, payload }),
    })

    await runtime.discover()

    const shadowed = events.find((item) => item.event === 'skill.scope_shadowed')
    expect(shadowed?.payload).toEqual({
      name: 'dup',
      winner_scope: 'user',
      loser_scope: 'project',
    })
    const rejected = events.find((item) => item.event === 'skill.standard_schema_rejected')
    expect(rejected?.payload).toMatchObject({ name: 'badname' })
    expect(String(rejected?.payload.reason)).toContain('Invalid skill name')
  })
  it('modelInvocableNames filters disabled and disable-model-invocation, keeps user-invocable:false', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'volund-skills-'))
    dirs.push(root)
    await writeSkill(resolve(root, 'skills'), 'plain', 'name: plain\ndescription: x')
    await writeSkill(
      resolve(root, 'skills'),
      'manual-only',
      'name: manual-only\ndescription: x\ndisable-model-invocation: true',
    )
    await writeSkill(
      resolve(root, 'skills'),
      'model-only',
      'name: model-only\ndescription: x\nuser-invocable: false',
    )
    const options = {
      sources: [{ dir: resolve(root, 'skills'), scope: 'user' as const }],
      volundVersion: '1.0.0',
      composer: new DefaultPromptComposer(),
    }
    const runtime = new SkillsRuntime(options)
    await runtime.discover()
    // user-invocable: false 只挡 slash 注册，模型仍可调用
    expect(runtime.modelInvocableNames()).toEqual(['model-only', 'plain'])
    const gated = new SkillsRuntime({ ...options, disabled: new Set(['plain']) })
    await gated.discover()
    expect(gated.modelInvocableNames()).toEqual(['model-only'])
  })
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
  it('discovers only metadata, then on activation injects body plus resource paths (no inlining)', async () => {
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
    // 渐进披露第 3 层：resource 只列路径让模型按需 Read，不内联内容
    expect(prompt).toContain('references/details.md')
    expect(prompt).not.toContain('Never skip failures')
    expect(runtime.deactivate('testing')).toBe(true)
    expect(await composer.compose({ cwd: root, model: 'm', provider: 'p' })).not.toContain(
      'Run focused tests',
    )
  })

  it('parses allowed-tools frontmatter (string and array forms) into metadata', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'volund-skills-'))
    dirs.push(root)
    await writeSkill(
      resolve(root, 'skills'),
      'stringed',
      'name: stringed\ndescription: x\nallowed-tools: "Bash(git:*) Read"',
    )
    await writeSkill(
      resolve(root, 'skills'),
      'listed',
      'name: listed\ndescription: x\nallowed-tools:\n  - Grep\n  - Glob',
    )
    const runtime = new SkillsRuntime({
      sources: [{ dir: resolve(root, 'skills'), scope: 'user' }],
      volundVersion: '1.0.0',
      composer: new DefaultPromptComposer(),
    })
    const skills = await runtime.discover()
    expect(skills.find((skill) => skill.name === 'stringed')?.allowedTools).toEqual([
      'Bash(git:*)',
      'Read',
    ])
    expect(skills.find((skill) => skill.name === 'listed')?.allowedTools).toEqual(['Grep', 'Glob'])
    const invocation = await runtime.readInvocation('stringed')
    expect(invocation.allowedTools).toEqual(['Bash(git:*)', 'Read'])
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
    // 路径两侧同用 join 构造：Windows 上 join 会产出反斜杠，字面量断言会漂移。
    const repo = join('/', 'work', 'repo')
    const volundHome = join('/', 'home', 'mark', '.volund')
    const userHome = join('/', 'home', 'mark')
    const sources = defaultSkillSources({ volundHome, userHome, cwd: repo })
    expect(sources.map((source) => source.dir)).toEqual([
      join(repo, '.volund', 'skills'),
      join(repo, '.claude', 'skills'),
      join(repo, '.agents', 'skills'),
      join(volundHome, 'skills'),
      join(userHome, '.claude', 'skills'),
      join(userHome, '.agents', 'skills'),
    ])
    expect(sources[0]!.scope).toBe('project')
    expect(sources[1]).toEqual(expect.objectContaining({ scope: 'project', interop: true }))
    expect(sources[3]!.scope).toBe('user')
    expect(sources[4]).toEqual(expect.objectContaining({ scope: 'user', interop: true }))
  })

  it('places plugin skill dirs between project and user scopes (SM-08b)', () => {
    const repo = join('/', 'work', 'repo')
    const home = join('/', 'home', 'mark')
    const one = join('/', 'plugins', 'one', 'skills')
    const two = join('/', 'plugins', 'two', 'skills')
    const sources = defaultSkillSources({
      volundHome: join(home, '.volund'),
      userHome: home,
      cwd: repo,
      pluginDirs: [one, two],
    })
    expect(sources.map((source) => `${source.scope}:${source.dir}`)).toEqual([
      `project:${join(repo, '.volund', 'skills')}`,
      `project:${join(repo, '.claude', 'skills')}`,
      `project:${join(repo, '.agents', 'skills')}`,
      `plugin:${one}`,
      `plugin:${two}`,
      `user:${join(home, '.volund', 'skills')}`,
      `user:${join(home, '.claude', 'skills')}`,
      `user:${join(home, '.agents', 'skills')}`,
    ])
  })

  it('re-evaluates function sources on every discover (SM-08b plugin lifecycle)', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'volund-skills-'))
    dirs.push(root)
    let pluginSkillsDir = resolve(root, 'plugins', 'one', 'skills')
    const runtime = new SkillsRuntime({
      sources: async () => [{ dir: pluginSkillsDir, scope: 'plugin' }],
      volundVersion: '1.0.0',
      composer: new DefaultPromptComposer(),
    })
    expect(await runtime.discover()).toEqual([])

    // 插件后装：目录出现后，无需重建 runtime 即可发现。
    await writeSkill(
      resolve(root, 'plugins', 'one', 'skills'),
      'bundled',
      'name: bundled\ndescription: b',
    )
    const discovered = await runtime.discover()
    expect(discovered.map((entry) => `${entry.scope}:${entry.name}`)).toEqual(['plugin:bundled'])

    // 插件被禁用移除：下一次 discover 反映最新目录集。
    pluginSkillsDir = resolve(root, 'plugins', 'gone', 'skills')
    expect(await runtime.discover()).toEqual([])
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
