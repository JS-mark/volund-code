/**
 * volund-plugin-status-demo — PLUGIN-STATUS-UI-r1 契约的活样例。
 *
 * 纯 ESM 单文件、零依赖（插件沙箱里没有 node_modules）。activate 里注册两个
 * /status 页签；render 由 K0 在面板打开 / 按 r 时经桥回调，数据实时取。
 * 注意：桥上一切 volund.* 调用都是异步 RPC，必须 await。
 *
 * 开发装载（不经 Catalog）：VOLUND_DEV_PLUGINS=<本目录> volund
 */
export async function activate(volund) {
  let renders = 0
  const startedAt = Date.now()

  await volund.ui.status.registerTab({
    id: 'plugin-demo',
    label: 'Plug',
    render: async () => {
      renders += 1
      const usage = await volund.session.getUsage()
      // 注：沙箱桥暂不提供 volund.plugin 元数据（属性访问不会触发 RPC），
      // 插件身份由插件自身硬编码。
      return {
        kind: 'rows',
        sections: [
          {
            title: 'Plugin tab (sandboxed)',
            rows: [
              ['Plugin', 'volund-plugin-status-demo@0.1.0'],
              ['Renders', renders],
              ['Alive for', `${Math.round((Date.now() - startedAt) / 1000)}s`],
              [
                'Session tokens',
                usage ? `${usage.inputTokens} in / ${usage.outputTokens} out` : 'n/a',
              ],
              [
                'Session cost',
                usage && typeof usage.cost === 'number' ? `$${usage.cost.toFixed(4)}` : 'n/a',
              ],
            ],
          },
        ],
      }
    },
  })

  await volund.ui.status.registerTab({
    id: 'plugin-demo-pulse',
    label: 'Pulse',
    render: () => {
      // 演示 heatmap 体例：近 14 天的伪活跃序列（真实插件应自行持久化统计）。
      const days = []
      const now = new Date()
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 13)
      for (let i = 0; i < 14; i += 1) days.push((i * 7 + renders * 3) % 10)
      const pad = (n) => String(n).padStart(2, '0')
      return {
        kind: 'heatmap',
        heatmap: {
          start: `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`,
          days,
        },
        legend: 'plugin demo',
      }
    },
  })

  await volund.log.info('status-demo activated')
}
