/**
 * volund-plugin-env — 内置插件：/env 斜杠命令，查看 [env] 配置段的生效状态。
 *
 * 数据源是宿主侧 volund.env.getEffective()（每次调用重读用户级 config.toml 并与
 * process.env 对比）——插件沙箱里读不到主进程环境（env_clear 白名单模型），
 * 所以配置值必须由宿主服务给出，插件只负责格式化。
 *
 * 输出走 CommandListView 纯数据描述符（`{ kind: 'list', ... }`），UI 渲染成
 * resume 风格的可搜索面板：行内只放 变量名 / 截断值 / 状态徽标，选中一条后
 * detail（全文 + 状态）进 transcript。
 *
 * 与 dev 插件同一条装载链路（volund-sandbox --run-plugin + fd3 桥），
 * 区别仅在目录来源：产物自带的 apps/cli/plugins/<name>/。
 */
export async function activate(volund) {
  // G 插件一等公民：工具贡献——把 [env] 生效快照以结构化工具暴露给模型
  // （名字必须带 plugin:<manifest.name>: 前缀；invoke 经桥回到沙箱执行）。
  await volund.tools.register({
    name: 'plugin:volund-plugin-env:effective-env',
    description: 'Return the effective [env] config snapshot (name, configured value, status)',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      const entries = await volund.env.getEffective()
      return {
        count: entries.length,
        variables: entries.map((entry) => ({
          name: entry.key,
          configured: entry.configured,
          status: entry.status,
          sandboxPassthrough: entry.sandboxPassthrough,
        })),
      }
    },
  })
  await volund.commands.register({
    name: 'env',
    order: 55,
    description: 'Browse [env] config variables and their live status',
    handler: async () => {
      let entries
      try {
        entries = await volund.env.getEffective()
      } catch (error) {
        return `/env is unavailable: ${error instanceof Error ? error.message : String(error)}`
      }
      if (!entries || entries.length === 0)
        return [
          'No [env] variables configured.',
          'Add an [env] section to ~/.volund/config.toml, for example:',
          '',
          '  [env]',
          '  NO_PROXY = "localhost,127.0.0.1"',
          '',
          'Configured values are written to process.env at session start.',
          'Only names listed in [tools] pass_through_env also enter the Bash sandbox.',
        ].join('\n')
      const statusText = (entry) =>
        entry.status === 'effective'
          ? 'effective'
          : entry.status === 'pending'
            ? 'pending'
            : 'overridden'
      return {
        kind: 'list',
        title: 'Environment — [env] from ~/.volund/config.toml',
        placeholder: 'Search by name, value, or status',
        entries: entries.map((entry) => ({
          id: entry.key,
          label: entry.key,
          value: entry.configured,
          status: `${statusText(entry)} · sandbox: ${entry.sandboxPassthrough ? 'passed through' : 'withheld'}`,
          detail: [
            `${entry.key} = ${JSON.stringify(entry.configured)}`,
            `status: ${
              entry.status === 'overridden'
                ? `overridden — process.env currently has ${JSON.stringify(entry.actual)}`
                : entry.status === 'pending'
                  ? 'pending — not present in process.env (applies when a session starts)'
                  : 'effective'
            }`,
            `sandbox: ${
              entry.sandboxPassthrough
                ? 'passed through (minimal set or [tools] pass_through_env)'
                : 'withheld — add the name to [tools] pass_through_env to pass it into the Bash sandbox'
            }`,
          ].join('\n'),
        })),
      }
    },
  })
  await volund.log.info('volund-plugin-env activated')
}
