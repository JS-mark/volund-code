import { describe, expect, it } from 'vitest'

import {
  ConfigSchema,
  configKeyRegistry,
  isProjectOverrideForbidden,
  projectOverrideFor,
} from './config-schema'

/**
 * registry ↔ zod schema 一致性（黑盒探测，不依赖 zod 内部结构）：
 * 把 registry id 的 `*` 段替换为探针名、叶子放哨兵值 `false`，safeParse 后
 * 断言没有 unrecognized_keys 认领探针段——认领即说明 schema 不认识该 key，
 * registry 与 schema 已经漂移（附录 C 对齐由 scripts/verify-config-docs.mjs 管）。
 */
const PROBE = '__registry_probe__'

function probeObject(path: string[]): Record<string, unknown> {
  const root: Record<string, unknown> = {}
  let cursor = root
  for (const [index, segment] of path.entries()) {
    if (index === path.length - 1) cursor[segment] = false
    else cursor = cursor[segment] = {} as Record<string, unknown>
  }
  return root
}

function probeStatus(id: string): 'recognized' | 'unrecognized' {
  const path = id.split('.').map((segment) => (segment === '*' ? PROBE : segment))
  const result = ConfigSchema.safeParse(probeObject(path))
  for (const issue of result.error?.issues ?? []) {
    if (issue.code !== 'unrecognized_keys') continue
    if (
      issue.keys.map(String).includes(String(path[issue.path.length])) &&
      path.slice(0, issue.path.length).join('.') === issue.path.map(String).join('.')
    )
      return 'unrecognized'
  }
  return 'recognized'
}

describe('configKeyRegistry ↔ ConfigSchema consistency', () => {
  it('every registry key is represented by the zod schema', () => {
    for (const id of Object.keys(configKeyRegistry))
      expect(probeStatus(id), `registry key '${id}' missing from ConfigSchema`).toBe('recognized')
  })

  it('every top-level schema section is covered by the registry', () => {
    const sections = new Set(Object.keys(configKeyRegistry).map((id) => id.split('.')[0]!))
    for (const section of Object.keys(ConfigSchema.shape))
      expect(sections.has(section), `schema section '${section}' has no registry entry`).toBe(true)
    for (const section of sections)
      expect(
        section in ConfigSchema.shape,
        `registry section '${section}' has no schema entry`,
      ).toBe(true)
  })

  it('the probe actually catches drift (negative controls)', () => {
    expect(probeStatus('tools.bogus_key')).toBe('unrecognized')
    expect(probeStatus('bogus_section.key')).toBe('unrecognized')
  })

  it('dynamic-name sections accept probe entries (provider.<name>, models.aliases.<alias>)', () => {
    expect(
      ConfigSchema.safeParse({ provider: { anthropic: { model: 'claude-sonnet-4-5' } } }).success,
    ).toBe(true)
    expect(
      ConfigSchema.safeParse({
        models: { aliases: { sonnet: { provider: 'anthropic', model: 'x' } } },
      }).success,
    ).toBe(true)
    // open sections (sandbox / auth / preferences / context extras)
    expect(ConfigSchema.safeParse({ sandbox: { tier: 'restricted' } }).success).toBe(true)
    expect(ConfigSchema.safeParse({ evolution: { enabled: false } }).success).toBe(true)
    expect(ConfigSchema.safeParse({ context: { keep_recent: 20 } }).success).toBe(true)
  })

  it('keeps evolution strict and accepts only an optional boolean enabled switch', () => {
    expect(ConfigSchema.safeParse({ evolution: {} }).success).toBe(true)
    expect(ConfigSchema.safeParse({ evolution: { enabled: true } }).success).toBe(true)
    expect(ConfigSchema.safeParse({ evolution: { enabled: 'true' } }).success).toBe(false)
    expect(ConfigSchema.safeParse({ evolution: { mode: 'apply' } }).success).toBe(false)
  })

  it('recognizes the explicit auth keys and fails on wrong types (§8.4)', () => {
    expect(ConfigSchema.safeParse({ auth: { skipAuth: true } }).success).toBe(true)
    expect(ConfigSchema.safeParse({ auth: { anthropic_api_key: 'sk' } }).success).toBe(true)
    expect(ConfigSchema.safeParse({ auth: { skipAuth: 'yes' } }).success).toBe(false)
    expect(ConfigSchema.safeParse({ auth: { anthropic_api_key: 42 } }).success).toBe(false)
    // 开放段语义不变：其余 auth.* key 仍接受任意 JSON 值
    expect(ConfigSchema.safeParse({ auth: { future_key: { nested: true } } }).success).toBe(true)
  })

  it('accepts [env] as a string record and fails on non-string values (C.1)', () => {
    expect(ConfigSchema.safeParse({ env: { NO_PROXY: 'localhost', EMPTY_OK: '' } }).success).toBe(
      true,
    )
    // 环境变量只能是字符串：数字 / 布尔 / 嵌套对象都是类型错 → 启动 fail
    expect(ConfigSchema.safeParse({ env: { PORT: 8080 } }).success).toBe(false)
    expect(ConfigSchema.safeParse({ env: { FLAG: true } }).success).toBe(false)
    expect(ConfigSchema.safeParse({ env: { NESTED: { a: 'b' } } }).success).toBe(false)
  })
})

describe('projectOverrideFor / isProjectOverrideForbidden (§8.3.1)', () => {
  it('resolves exact keys first, then wildcard registry patterns', () => {
    expect(projectOverrideFor('ui.theme')).toBe('allowed')
    expect(projectOverrideFor('provider.anthropic.baseUrl')).toBe('forbidden')
    expect(projectOverrideFor('provider.anthropic.model')).toBe('allowed')
    expect(projectOverrideFor('telemetry.sink')).toBe('forbidden')
    expect(projectOverrideFor('telemetry.otel.endpoint')).toBe('forbidden')
    expect(projectOverrideFor('auth.enabled')).toBe('forbidden')
    expect(projectOverrideFor('auth.skipAuth')).toBe('forbidden')
    expect(projectOverrideFor('auth.anthropic_api_key')).toBe('forbidden')
    expect(projectOverrideFor('evolution.enabled')).toBe('allowed')
    expect(projectOverrideFor('evolution.mode')).toBeUndefined()
    expect(projectOverrideFor('context.keep_recent')).toBe('allowed')
    expect(projectOverrideFor('totally.unknown')).toBeUndefined()
  })

  it('aligns router filtering with appendix C.2 (type forbidden, allow_cross_provider_tool_use allowed)', () => {
    expect(isProjectOverrideForbidden('router.type')).toBe(true)
    expect(isProjectOverrideForbidden('router.allow_cross_provider_tool_use')).toBe(false)
  })

  it('keeps §8.3.1 generic data-flow patterns beyond the registry', () => {
    expect(isProjectOverrideForbidden('plugin.custom.baseUrl')).toBe(true)
    expect(isProjectOverrideForbidden('memory.paths.endpoint')).toBe(true)
    expect(isProjectOverrideForbidden('provider.anthropic.my_api_key')).toBe(true)
    expect(isProjectOverrideForbidden('auth.skipAuth')).toBe(true)
    expect(isProjectOverrideForbidden('auth.anthropic_api_key')).toBe(true)
    expect(isProjectOverrideForbidden('tools.ignore_dirs')).toBe(false)
  })

  it('allows project-level [env] but keeps credential-shaped names forbidden', () => {
    expect(projectOverrideFor('env.NO_PROXY')).toBe('allowed')
    expect(isProjectOverrideForbidden('env.NO_PROXY')).toBe(false)
    // §8.3.1 通用模式：*_api_key 结尾的名字只能来自用户级 config
    expect(isProjectOverrideForbidden('env.MY_SERVICE_API_KEY')).toBe(true)
  })
})
