import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { SubagentRunRow } from '../../lib/gateway'
import { I18nProvider } from '../../lib/i18n'
import { SubagentsRow } from '../SubagentsRow'

const run = (
  overrides: Partial<Omit<SubagentRunRow, 'agentType'>> &
    Partial<Pick<SubagentRunRow, 'agentType'>> = {},
): SubagentRunRow => ({
  sessionId: 'sub-1',
  depth: 1,
  status: 'running',
  startedAt: Date.now() - 65_000,
  promptPreview: 'scan the repo',
  prompt: 'scan the repo',
  ...overrides,
})

/** 静态渲染包 I18nProvider：useI18n 默认上下文 t 直返 key，无 Provider 会丢中文断言。 */
const render = (ui: React.ReactElement): string =>
  renderToStaticMarkup(<I18nProvider>{ui}</I18nProvider>)

describe('SubagentsRow（移动端只读运行行）', () => {
  it('无运行：不渲染任何行', () => {
    const html = render(<SubagentsRow gateway={undefined} tick={0} initialRuns={[]} />)
    expect(html).toBe('')
  })

  it('全部结算（0 运行中）：整条隐藏——注册表历史不占会话页', () => {
    const html = render(
      <SubagentsRow
        gateway={undefined}
        tick={0}
        initialRuns={[
          run({ status: 'completed', endedAt: Date.now() - 10_000 }),
          run({ sessionId: 'sub-2', status: 'failed', endedAt: Date.now() - 5_000 }),
        ]}
      />,
    )
    expect(html).toBe('')
  })

  it('有运行：窄条头 + 展开列表（状态/agent/预览/时长/取消）', () => {
    const html = render(
      <SubagentsRow
        gateway={undefined}
        tick={0}
        initialOpen
        initialRuns={[
          run({ agentType: 'explore' }),
          run({
            sessionId: 'sub-2',
            status: 'completed',
            endedAt: Date.now() - 10_000,
          }),
        ]}
      />,
    )
    expect(html).toContain('subagents-row')
    expect(html).toContain('1 个子代理运行中')
    expect(html).toContain('explore')
    expect(html).toContain('task-agent')
    expect(html).toContain('scan the repo')
    expect(html).toContain('运行中')
    expect(html).toContain('已完成')
    expect(html).toContain('取消')
  })

  it('展开列表里非运行行不出现取消按钮（取消按钮数 = 运行行数）', () => {
    const html = render(
      <SubagentsRow
        gateway={undefined}
        tick={0}
        initialOpen
        initialRuns={[
          run({ agentType: 'explore' }),
          run({ sessionId: 'sub-2', status: 'failed', endedAt: Date.now() }),
        ]}
      />,
    )
    expect(html).toContain('失败')
    expect(html.match(/subagents-row-cancel/g)).toHaveLength(1)
  })
})
