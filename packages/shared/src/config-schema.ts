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
  'router.chain': 'forbidden',
  'router.cooldown_seconds': 'forbidden',
  'router.allow_cross_provider_tool_use': 'allowed',
  'models.aliases.*': 'allowed',
  'runner.maxToolLoopsPerTurn': 'allowed',
  'runner.top_level_budget': 'allowed',
  'subagent.max_depth': 'allowed',
  'subagent.max_concurrent': 'allowed',
  'subagent.default_budget': 'allowed',
  // SAG §2.7bis（schema 收录先行；消费随 SAG-23/32/34 落地）
  'subagent.queue_timeout_ms': 'allowed',
  'subagent.session_budget': 'allowed',
  'subagent.auto_isolation': 'allowed',
  'tools.windows_shell': 'allowed',
  'tools.pass_through_env': 'allowed',
  'tools.ignore_dirs': 'allowed',
  // §4.3.1 沙箱面：Bash 沙箱 fs 根（cwd 之外的项目外读写通道）与命令墙钟超时
  'tools.fs_read_roots': 'allowed',
  'tools.fs_write_roots': 'allowed',
  'tools.command_timeout_ms': 'allowed',
  // [env] 段：启动时写入 process.env 的键值对；`*_api_key` 结尾的名字被
  // §8.3.1 通用模式自动拦截（项目级 forbidden）
  'env.*': 'allowed',
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
  'ui.locale': 'allowed',
  'telemetry.sink': 'forbidden',
  'telemetry.otel.endpoint': 'forbidden',
  // [evolution] legacy compatibility switch（见 §15）：严格 boolean，缺省 off
  'evolution.enabled': 'allowed',
  // [skills] / [mcp]（SKILLS-MCPS-r1 §S3.4）：面板持久开关面；server 定义本体在
  // mcp.toml / .mcp.json（开放键空间，不经 ConfigSchema）。项目级可覆盖禁用名单
  // （如企业统一禁用某 server），无数据流向风险。
  'skills.disabled': 'allowed',
  'skills.index_budget': 'allowed',
  'mcp.disabled': 'allowed',
  'mcp.enable_all_project_servers': 'forbidden',
  // skills/mcp 市场目录索引（WEB-EXT-MANAGE-MARKET-r1 §S3.6）：与 plugins.market
  // 同门——信任配置，禁止项目级覆盖（项目 config 不得把安装源指向第三方）
  'skills.market': 'forbidden',
  'mcp.market': 'forbidden',
  // [plugins] 市场源（PLUGIN-MANAGER-r1）：信任配置，禁止项目级覆盖
  // （项目 config 不得把市场指向第三方源）
  'plugins.market': 'forbidden',
  // builtin_disabled（F1 插件一等公民）：禁用的第一方工具域 id（volund.exec 等）
  'plugins.builtin_disabled': 'allowed',
  // [web_search]（volund-plugin-web-search）：WebSearch 工具的搜索后端与凭据。
  // api key 是凭据 → 项目级 forbidden（§8.3.1 通用模式同族）；custom_url 决定
  // 搜索流量（query + key）流向，与 provider.*.baseUrl 同门 → 项目级 forbidden。
  'web_search.backend': 'allowed',
  'web_search.max_results': 'allowed',
  'web_search.tavily_api_key': 'forbidden',
  'web_search.brave_api_key': 'forbidden',
  'web_search.custom_url': 'forbidden',
  'web_search.custom_api_key': 'forbidden',
  // [web] §22 W-01：TUI 进入时 Web 控制台的静默自启开关与固定端口（默认开、随机端口）
  'web.enabled': 'allowed',
  'web.port': 'allowed',
  // [web.terminal] 工作台终端：shell 覆盖 / 字号 / 滚动缓冲（本地用户自身面，无流向风险）
  'web.terminal.shell': 'allowed',
  'web.terminal.font_size': 'allowed',
  'web.terminal.scrollback': 'allowed',
  // [remote] 远程控制（REM-r1）：本机经公网网关反向拨出的链路配置。
  // client_secret 是凭据 → 项目级 forbidden（与 auth.* 同门）。
  'remote.enabled': 'allowed',
  'remote.gateway_url': 'allowed',
  'remote.client_id': 'allowed',
  'remote.client_secret': 'forbidden',
  // [tasks] 定时任务调度（W-17 / Web 计划 F1）：整段是机器所有者面——项目级
  // config 不得启停调度器或改写资源参数（clone 来的仓库不得给自己排任务），
  // 全部项目级 forbidden；enabled 默认 false（W-17 硬门：默认关闭，独立发布门）。
  // 任务定义本体在 ~/.volund/tasks.json（TaskStore，不经 ConfigSchema）。
  'tasks.enabled': 'forbidden',
  'tasks.max_concurrent': 'forbidden',
  'tasks.journal_retention': 'forbidden',
  'tasks.webhook_url': 'forbidden',
  // [cache] §3.2 provider prompt cache：strategy=off 关闭断点注入（auto=按 provider
  // 能力自动注入 ephemeral 断点；OpenAI/DeepSeek 类自动缓存 provider 不受此控）。
  // ttl_seconds 只在 provider 支持 TTL 档时生效（Anthropic 5m/1h）。
  'cache.strategy': 'allowed',
  'cache.ttl_seconds': 'allowed',
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
  // [auth] 段（§8.3.1）：skipAuth / <provider>_api_key 为显式登记的已知 key（类型错 → fail），
  // 其余 key 走开放段通配；整段一律禁止项目级覆盖（凭据只能来自用户级 config）
  'auth.skipAuth': 'forbidden',
  'auth.anthropic_api_key': 'forbidden',
  'auth.*': 'forbidden',
  // 实现内建段：apps/cli 状态面板本地偏好（附录 C 已补录 outputStyle / language 两行，
  // 整段开放 JSON 值，registry 以 preferences.* 通配登记）
  'preferences.*': 'allowed',
  // §4.4 权限模式只能用户级决定：项目级 config 不得提升（auto/full 属提权面）
  'permissions.mode': 'forbidden',
  // 无人决策审批/提问卡的超时兜底：项目级 forbidden（过短超时 = 变相拒绝一切权限请求）
  'permissions.request_timeout_ms': 'forbidden',
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
      // §3.8.2：fallback 链（provider/model/priority，priority 高者优先）与
      // 失败 provider 冷却秒数；均属数据流向门，项目级 forbidden。
      chain: z
        .array(
          z.strictObject({
            provider: z.string().min(1),
            model: z.string().min(1),
            priority: z.number(),
          }),
        )
        .optional(),
      cooldown_seconds: z.number().optional(),
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
      // SAG §2.7bis：schema 收录先行，消费随排队（SAG-23）/会话预算（SAG-34）/worktree 自动隔离（SAG-32）落地
      queue_timeout_ms: z.number().int().optional(),
      session_budget: z
        .strictObject({
          costUSDMax: z.number().optional(),
          tokenMax: z.number().optional(),
        })
        .optional(),
      auto_isolation: z.boolean().optional(),
    })
    .optional(),
  tools: z
    .strictObject({
      windows_shell: z.string().optional(),
      pass_through_env: z.array(z.string()).optional(),
      ignore_dirs: z.array(z.string()).optional(),
      // §4.3.1 沙箱面：Bash 沙箱额外 fs 根（~ 展开、须绝对、可带尾部 /**）
      // 与命令墙钟超时；消费在 apps/cli createSandboxNativeBridge
      fs_read_roots: z.array(z.string()).optional(),
      fs_write_roots: z.array(z.string()).optional(),
      command_timeout_ms: z.number().positive().optional(),
    })
    .optional(),
  // [env] 段：启动时写入 process.env 的显式环境变量（值必须是字符串）。
  // 主进程与之后 spawn 的子进程（MCP stdio / 插件宿主 / native worker）随之继承；
  // 沙箱内 Bash 走 env_clear 白名单模型（r13-I11），仅 [tools] pass_through_env
  // 列出的名字进入沙箱，值可来自本段。注意 `*_api_key` 结尾的名字按 §8.3.1
  // 通用模式自动禁止项目级覆盖。
  env: z.record(z.string(), z.string()).optional(),
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
      // 界面语言（i18n-r1）：驱动会话默认标题等服务端用户可见文案的 locale；
      // web/mobile 控制台自身语言走浏览器 localStorage（ui.locale 缺省时不受影响）。
      locale: z.enum(['zh', 'en']).optional(),
    })
    .optional(),
  telemetry: z
    .strictObject({
      sink: z.enum(['local', 'otel']).optional(),
      otel: z.strictObject({ endpoint: z.string().optional() }).optional(),
    })
    .optional(),
  evolution: z.strictObject({ enabled: z.boolean().optional() }).optional(),
  // [skills]（SKILLS-MCPS-r1 §S3.4）：/skills 面板与 discovery 的持久开关面；
  // market（WEB-EXT-MANAGE-MARKET-r1 §S3.6）= 市场目录索引 URL（项目级覆盖禁止）。
  skills: z
    .strictObject({
      disabled: z.array(z.string()).optional(),
      index_budget: z.number().int().optional(),
      market: z.string().optional(),
    })
    .optional(),
  // [mcp]（SKILLS-MCPS-r1 §S3.4）：/mcp 面板持久开关面；server 定义本体在
  // mcp.toml / .mcp.json（开放键空间，不走 ConfigSchema 校验）；
  // market = MCP 目录索引 URL（仅预填表单，不静默安装；项目级覆盖禁止）。
  mcp: z
    .strictObject({
      disabled: z.array(z.string()).optional(),
      enable_all_project_servers: z.boolean().optional(),
      market: z.string().optional(),
    })
    .optional(),
  // [plugins] 市场源（PLUGIN-MANAGER-r1）：HTTPS（或回环 http）索引 URL；
  // 信任语义校验（同源 / digest）在 apps/cli 的 plugin-market.ts，schema 只管形状
  plugins: z
    .strictObject({
      market: z.string().optional(),
      builtin_disabled: z.array(z.string()).optional(),
    })
    .optional(),
  // [web_search]（volund-plugin-web-search）：WebSearch 工具的搜索后端。
  // backend 未设置时宿主默认注入 tavily（缺对应 key 仍报配置指引错误）；
  // api key 一律项目级 forbidden（凭据只允许用户级 config）；custom_url 是
  // 搜索流量的去向（query + key 都会发过去），项目级不得改指第三方。
  web_search: z
    .strictObject({
      backend: z.enum(['tavily', 'brave', 'custom']).optional(),
      max_results: z.number().int().min(1).max(10).optional(),
      tavily_api_key: z.string().optional(),
      brave_api_key: z.string().optional(),
      custom_url: z
        .string()
        .refine((value) => /^https?:\/\//.test(value), 'custom_url must be an http(s) URL')
        .optional(),
      custom_api_key: z.string().optional(),
    })
    .optional(),
  // [web]（§22 W-01）：TUI 进入时静默自启 Web 控制台；port=0 随机空闲端口
  web: z
    .strictObject({
      enabled: z.boolean().optional(),
      port: z.number().int().min(0).max(65535).optional(),
      // 工作台终端：shell 覆盖（默认 $SHELL→/bin/sh，win32 cmd.exe）/ 字号 / 滚动缓冲行数
      terminal: z
        .strictObject({
          shell: z.string().min(1).optional(),
          font_size: z.number().int().min(9).max(32).optional(),
          scrollback: z.number().int().min(100).max(100000).optional(),
        })
        .optional(),
    })
    .optional(),
  // [remote] 远程控制（REM-r1）：本机向公网网关反向拨出（/uplink）的链路配置；
  // 凭据只允许用户级（client_secret 项目级 forbidden）。
  remote: z
    .strictObject({
      enabled: z.boolean().optional(),
      gateway_url: z.string().min(1).optional(),
      client_id: z.string().min(1).optional(),
      client_secret: z.string().min(16).optional(),
    })
    .optional(),
  // [tasks] 定时任务调度（W-17）：daemon 宿主的资源面；enabled 默认 false
  // （W-17 硬门）。任务定义/运行 journal 在 TaskStore，不走本 schema。
  tasks: z
    .strictObject({
      enabled: z.boolean().optional(),
      max_concurrent: z.number().int().min(1).max(8).optional(),
      journal_retention: z.number().int().min(10).max(10_000).optional(),
      // 运行终态（completed/failed）的 webhook 通知地址；daemon 投递，空缺 = 不通知。
      webhook_url: z.url().optional(),
    })
    .optional(),
  // [cache]（§3.2 provider prompt cache）：strategy=off 关闭请求级断点注入；
  // auto（默认）按 provider 能力注入（Anthropic 显式 cache_control，OpenAI/
  // DeepSeek 自动缓存型 provider 能力为 none 不注入）。ttl_seconds 仅对支持
  // TTL 档的 provider 生效（Anthropic：300→5m、3600→1h，缺省 5m）。
  cache: z
    .strictObject({
      strategy: z.enum(['auto', 'off']).optional(),
      ttl_seconds: z.union([z.literal(300), z.literal(3600)]).optional(),
    })
    .optional(),
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
  // [auth] 开放段，但 skipAuth / <provider>_api_key 是显式已知 key（§8.4）：
  // 类型错按 C.1 启动 fail；其余 key 仍走 catchall 开放段
  auth: z
    .strictObject({
      skipAuth: z.boolean().optional(),
      anthropic_api_key: z.string().optional(),
    })
    .catchall(z.json())
    .optional(),
  // [permissions] 段（§4.4 三档会话模式）：用户级默认档；mode 项目级禁止
  // （clone 来的仓库不得给自己提权），未知 key 按 C.1 fail。
  // request_timeout_ms = 无人决策的审批/提问卡自动 deny 兜底（默认 120s，0 = 不兜底）；
  // 项目级 forbidden——过短超时等于 clone 来的仓库变相拒绝一切权限请求。
  permissions: z
    .strictObject({
      mode: z.enum(['ask', 'auto', 'full']).optional(),
      request_timeout_ms: z.number().int().min(0).optional(),
    })
    .optional(),
  preferences: openSection.optional(),
})
