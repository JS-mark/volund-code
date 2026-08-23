import { z } from 'zod'

/**
 * config.toml 全量 schema（spec 08-session-config.md §8.3 / 附录 C，r13-I4）。
 *
 * 唯一真相源是附录 C.2 表：本文件导出的 `configKeyRegistry` 与该表由
 * `scripts/verify-config-docs.mjs`（`pnpm verify:config-docs`，挂根 test 链）
 * 做 diff 校验——新增 key 必须同时改 zod schema、registry 与附录 C 表。
 *
 * 未知 key 策略（§8.3 / C.1）：strict object 收集 `unrecognized_keys` →
 * warn + 忽略（向前兼容）；已知 key 类型错 → 启动 fail（文件 + key + 期望类型）。
 * `provider.<name>` / `models.aliases.<alias>` 等动态名走 catchall / record，
 * 其余"见 §5.5 / §8b.13"的开放段（sandbox / context 扩展 / auth /
 * preferences）接受任意 JSON 值，registry 以 `段.*` 通配登记；evolution
 * 是严格段，仅接受显式 boolean `enabled`，避免字符串或未知字段伪开启。
 */
export type ProjectOverride = 'allowed' | 'forbidden'

const providerEntrySchema = z.strictObject({
  model: z.string().optional(),
  baseUrl: z.string().optional(),
  endpoint: z.string().optional(),
})

const modelAliasSchema = z.strictObject({ provider: z.string(), model: z.string() })

/** §8.3.1 数据流向门：key → projectOverride 标注（与附录 C.2 表逐行对齐）。 */
export const configKeyRegistry = {
  'provider.default': 'allowed',
  'provider.*.model': 'allowed',
  'provider.*.baseUrl': 'forbidden',
  'provider.*.endpoint': 'forbidden',
  'router.type': 'forbidden',
  'router.allow_cross_provider_tool_use': 'allowed',
  'models.aliases.*': 'allowed',
  'runner.maxToolLoopsPerTurn': 'allowed',
  'runner.top_level_budget': 'allowed',
  'subagent.max_depth': 'allowed',
  'subagent.max_concurrent': 'allowed',
  'subagent.default_budget': 'allowed',
  'tools.windows_shell': 'allowed',
  'tools.pass_through_env': 'allowed',
  'tools.ignore_dirs': 'allowed',
  'context.policy': 'allowed',
  'context.max_tokens': 'allowed',
  // keep / unkeep 等 §8b.13 pinned 参数：开放段通配
  'context.*': 'allowed',
  'memory.enabled': 'allowed',
  'memory.max_body_lines': 'allowed',
  'memory.paths.global': 'allowed',
  'memory.paths.project': 'allowed',
  // [sandbox] 降级策略 / tier 相关（见 §5.5）：开放段
  'sandbox.*': 'allowed',
  // [prompt] @include 参数（max_depth 32 / max_expansions 64，见 §6.5.6）
  'prompt.@include': 'allowed',
  'native.ipc_max_line_bytes': 'allowed',
  'ui.theme': 'allowed',
  'ui.color': 'allowed',
  'telemetry.sink': 'forbidden',
  'telemetry.otel.endpoint': 'forbidden',
  // [evolution] legacy compatibility switch（见 §15）：严格 boolean，缺省 off
  'evolution.enabled': 'allowed',
  // [reflection] §21 动态反思（proposed / 行为未接线，先登记解析契约）
  'reflection.enabled': 'allowed',
  'reflection.triggers.on_error': 'allowed',
  'reflection.triggers.on_compact': 'allowed',
  'reflection.triggers.every_n_turns': 'allowed',
  'reflection.cooldown_seconds': 'allowed',
  'reflection.model_role': 'allowed',
  'reflection.run_budget': 'allowed',
  'reflection.session_token_budget': 'allowed',
  'reflection.persist': 'allowed',
  'reflection.inject_max_lessons': 'allowed',
  'reflection.inject_max_bytes': 'allowed',
  // [auth] 段全部（§8.3.1）
  'auth.*': 'forbidden',
  // 实现内建段：apps/cli 状态面板本地偏好（附录 C 已补录 outputStyle / language 两行，
  // 整段开放 JSON 值，registry 以 preferences.* 通配登记）
  'preferences.*': 'allowed',
} as const satisfies Record<string, ProjectOverride>

export type ConfigKeyId = keyof typeof configKeyRegistry

const escapeRegex = (value: string) => value.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')

function registryPattern(id: string): RegExp {
  const segments = id.split('.')
  const last = segments.length - 1
  const pattern = segments
    .map((segment, index) =>
      segment === '*' ? (index === last ? '.+' : '[^.]+') : escapeRegex(segment),
    )
    .join('\\.')
  return new RegExp(`^${pattern}$`)
}

/** 按 registry（精确优先，含 `*` 通配）查 key 的 projectOverride 标注。 */
export function projectOverrideFor(key: string): ProjectOverride | undefined {
  if (Object.hasOwn(configKeyRegistry, key)) return configKeyRegistry[key as ConfigKeyId]
  for (const [id, override] of Object.entries(configKeyRegistry)) {
    if (id.includes('*') && registryPattern(id).test(key)) return override as ProjectOverride
  }
  return undefined
}

/**
 * §8.3.1 数据流向 key 禁止项目级覆盖：附录 C.2 标注 forbidden 的 key，
 * 加上 §8.3.1 第 2 层的通用模式（任何 `*.baseUrl` / `*.endpoint` / `*_api_key`）。
 */
export function isProjectOverrideForbidden(key: string): boolean {
  if (projectOverrideFor(key) === 'forbidden') return true
  return /(?:^|\.)(?:baseurl|endpoint)$/i.test(key) || /_api_key$/i.test(key)
}

const openSection = z.record(z.string(), z.json())

export const ConfigSchema = z.strictObject({
  provider: z
    .strictObject({ default: z.string().optional() })
    .catchall(providerEntrySchema)
    .optional(),
  router: z
    .strictObject({
      type: z.enum(['single', 'fallback', 'role']).optional(),
      allow_cross_provider_tool_use: z.boolean().optional(),
    })
    .optional(),
  models: z.strictObject({ aliases: z.record(z.string(), modelAliasSchema).optional() }).optional(),
  runner: z
    .strictObject({
      maxToolLoopsPerTurn: z.number().int().optional(),
      top_level_budget: z.boolean().optional(),
    })
    .optional(),
  subagent: z
    .strictObject({
      max_depth: z.number().int().optional(),
      max_concurrent: z.number().int().optional(),
      default_budget: z
        .strictObject({
          costUSDMax: z.number().optional(),
          tokenMax: z.number().optional(),
          timeMsMax: z.number().optional(),
        })
        .optional(),
    })
    .optional(),
  tools: z
    .strictObject({
      windows_shell: z.string().optional(),
      pass_through_env: z.array(z.string()).optional(),
      ignore_dirs: z.array(z.string()).optional(),
    })
    .optional(),
  // keep / unkeep 等 §8b.13 pinned 参数走 catchall（开放段，registry 以 context.* 登记）
  context: z
    .strictObject({
      policy: z.enum(['sliding', 'summary', 'semantic']).optional(),
      max_tokens: z.number().int().optional(),
    })
    .catchall(z.json())
    .optional(),
  memory: z
    .strictObject({
      enabled: z.boolean().optional(),
      max_body_lines: z.number().int().optional(),
      paths: z
        .strictObject({ global: z.string().optional(), project: z.string().optional() })
        .optional(),
    })
    .optional(),
  sandbox: openSection.optional(),
  prompt: openSection.optional(),
  native: z.strictObject({ ipc_max_line_bytes: z.number().int().optional() }).optional(),
  ui: z
    .strictObject({
      theme: z.string().optional(),
      color: z.boolean().optional(),
    })
    .optional(),
  telemetry: z
    .strictObject({
      sink: z.enum(['local', 'otel']).optional(),
      otel: z.strictObject({ endpoint: z.string().optional() }).optional(),
    })
    .optional(),
  evolution: z.strictObject({ enabled: z.boolean().optional() }).optional(),
  // §21 动态反思（proposed / not wired）：严格解析契约先行，行为随 §6.4.1a 落地
  reflection: z
    .strictObject({
      enabled: z.boolean().optional(),
      triggers: z
        .strictObject({
          on_error: z.boolean().optional(),
          on_compact: z.boolean().optional(),
          every_n_turns: z.number().int().optional(),
        })
        .optional(),
      cooldown_seconds: z.number().int().optional(),
      model_role: z.string().optional(),
      run_budget: z
        .strictObject({
          costUSDMax: z.number().optional(),
          tokenMax: z.number().optional(),
          timeMsMax: z.number().optional(),
        })
        .optional(),
      session_token_budget: z.number().int().optional(),
      persist: z.enum(['manual', 'auto', 'off']).optional(),
      inject_max_lessons: z.number().int().optional(),
      inject_max_bytes: z.number().int().optional(),
    })
    .optional(),
  auth: openSection.optional(),
  preferences: openSection.optional(),
})
