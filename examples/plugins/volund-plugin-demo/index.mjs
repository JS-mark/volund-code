/**
 * volund-plugin-demo — 示例插件：演示插件一等公民的全部贡献面。
 *
 * 一个插件 = 一个目录（manifest.json + 单文件 ESM 入口），activate(volund)
 * 里通过桥对象注册贡献。本示例覆盖五种：
 *
 *   1. tools.register        模型可调用的工具（名字必须 plugin:<manifest.name>: 前缀）
 *   2. hooks.on              生命周期订阅（preToolUse 可 veto / 改写工具调用）
 *   3. prompt.contribute     静态 prompt fragment（进每会话 system prompt）
 *   4. session.on            会话生命周期事件（sessionStart / sessionEnd）
 *   5. commands.register     斜杠命令（返回字符串或纯数据面板视图）
 *
 * 运行方式（开发插件，自动批准 + 启用）：
 *   ln -s "$PWD/examples/plugins/volund-plugin-demo" ~/.volund/plugins-dev/
 *   # 或 VOLUND_PLUGINS_DEV=examples/plugins volund
 * 代码全程跑在 volund-sandbox 子进程里；主进程只见经权限 guard 的桥调用。
 */
export async function activate(volund) {
  // ── 1) 工具：模型自主调用 ────────────────────────────────────────────
  // 名字强制 plugin:<manifest.name>: 前缀（与内置 / MCP 工具不撞名）；
  // 宿主会把它包进统一权限决策链（permissionSpec 收敛为 {custom:{pluginTool}}），
  // 输出按不可信内容包裹后返回给模型。
  await volund.tools.register({
    name: 'plugin:volund-plugin-demo:word-count',
    description: 'Count words, characters and lines of the given text',
    inputSchema: {
      type: 'object',
      required: ['text'],
      properties: {
        text: { type: 'string', description: 'Text to measure' },
      },
    },
    handler: async (input) => {
      const text = typeof input?.text === 'string' ? input.text : ''
      return {
        words: text.split(/\s+/).filter(Boolean).length,
        characters: [...text].length,
        lines: text ? text.split('\n').length : 0,
      }
    },
  })

  // ── 2) Hook：preToolUse veto ────────────────────────────────────────
  // 返回 { veto: true, reason } 在权限决策之前拦下工具调用；返回 undefined
  // 表示不干预（fail-open）。preToolUse 还可返回 { value } 改写工具入参；
  // postToolUse 的 { value } 可改写工具结果。
  await volund.hooks.on('preToolUse', (payload) => {
    if (
      payload?.tool === 'Bash' &&
      typeof payload?.input?.command === 'string' &&
      payload.input.command.includes('demo-block-me')
    ) {
      return { veto: true, reason: 'demo plugin: command contains the demo-block-me marker' }
    }
    return undefined
  })

  // ── 3) Prompt fragment ──────────────────────────────────────────────
  // 静态文本进每会话 system prompt（id 自动加 plugin:<名>: 命名空间，
  // priority 缺省 600——低于 skills 800 / builtin 1000）。
  await volund.prompt.contribute({
    id: 'demo-usage',
    priority: 600,
    content:
      'The word-count tool (plugin:volund-plugin-demo:word-count) measures any text the user asks about.',
  })

  // ── 4) 会话生命周期 ─────────────────────────────────────────────────
  await volund.session.on('sessionStart', () =>
    volund.log.info('volund-plugin-demo: session started'),
  )

  // ── 5) 斜杠命令 ─────────────────────────────────────────────────────
  await volund.commands.register({
    name: 'demo',
    order: 90,
    description: 'Show what the demo plugin contributed',
    handler: async () => ({
      kind: 'list',
      title: 'volund-plugin-demo — contributions',
      placeholder: 'Filter contributions',
      entries: [
        {
          id: 'tool',
          label: 'tool: word-count',
          value: 'plugin:volund-plugin-demo:word-count',
          status: 'model-invocable · permission-gated',
          detail: 'Ask the model to measure any text; the tool runs inside this sandbox.',
        },
        {
          id: 'hook',
          label: 'hook: preToolUse guard',
          value: 'veto marker',
          status: 'fail-open',
          detail: 'Any Bash command containing "demo-block-me" is vetoed before execution.',
        },
        {
          id: 'prompt',
          label: 'prompt: demo-usage',
          value: 'priority 600',
          status: 'in every session system prompt',
          detail: 'Tells the model the word-count tool exists and what it does.',
        },
        {
          id: 'session',
          label: 'session: sessionStart',
          value: 'log.info',
          status: 'fires on every session start',
          detail: 'Writes an info line through the bridge logger.',
        },
      ],
    }),
  })

  await volund.log.info('volund-plugin-demo activated')
}
