import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import {
  initialChatState,
  type ChatState,
  type SubagentActivity,
  type ToolCard,
} from '../../lib/chat'
import type { StagedAttachment } from '../../lib/gateway'
import { I18nProvider } from '../../lib/i18n'
import { ChatView, ToolGroupRow, ToolRow } from '../ChatView'

const staged: StagedAttachment = { kind: 'image', mime: 'image/png', size: 1, handle: 'h-1' }

const state = (overrides: Partial<ChatState> = {}): ChatState => ({
  ...initialChatState,
  ...overrides,
})

const props = (overrides: { loading?: boolean; noSession?: boolean } = {}) => ({
  state: initialChatState,
  connected: true,
  loading: overrides.loading ?? false,
  activeSessionId: overrides.noSession ? undefined : 'sess-1',
  gateway: undefined,
  onEcho: () => {},
  onSubmit: () => {},
  onStage: () => Promise.resolve(staged),
  onInterrupt: () => {},
  onDecide: () => {},
  onAnswerAsk: () => {},
  resolveAttachment: () => Promise.resolve('blob:x'),
  onGoSessions: () => {},
  onStall: () => {},
  onQueuePush: () => {},
  onQueueRemove: () => {},
  onQueueReorder: () => {},
  onNotice: () => {},
})

/** 静态渲染包 I18nProvider：useI18n 默认上下文 t 直返 key，无 Provider 会丢中文断言。 */
const render = (ui: React.ReactElement): string =>
  renderToStaticMarkup(<I18nProvider>{ui}</I18nProvider>)

describe('ChatView 会话流空态（有会话无消息）', () => {
  it('空流：渲染俏皮空态（气泡场景 + 引导文案）', () => {
    const html = render(<ChatView {...props()} />)
    expect(html).toContain('chat-blank-stream')
    expect(html).toContain('chat-blank-bubble')
    expect(html).toContain('这里静悄悄的')
    expect(html).toContain('唤醒你的助手')
  })

  it('有消息：不渲染空态', () => {
    const html = render(
      <ChatView
        {...props()}
        state={state({
          messages: [{ id: 'm-1', role: 'user', text: '你好', seq: 1 }],
        })}
      />,
    )
    expect(html).not.toContain('chat-blank-stream')
  })

  it('transcript 水合中：俏皮加载动画优先于空态', () => {
    const html = render(<ChatView {...props({ loading: true })} />)
    expect(html).not.toContain('chat-blank-stream')
    expect(html).toContain('aria-busy')
    expect(html).toContain('chat-hydrate-typing')
    expect(html).toContain('对话加载中')
  })

  it('无活动会话：走整页空态引导（不是会话流空态）', () => {
    const html = render(<ChatView {...props({ noSession: true })} />)
    expect(html).not.toContain('chat-blank-stream')
    expect(html).toContain('没有进行中的会话')
  })

  it('工具卡默认折叠：渲染折叠行（图标+中文标签+目标+箭头），展开卡隐藏', () => {
    const tool: ToolCard = {
      toolUseId: 'tu-1',
      tool: 'Bash',
      status: 'done',
      target: 'pnpm build',
      body: 'pnpm build 2>&1\n| tail -15',
    }
    const html = render(<ToolRow tool={tool} subagents={{}} />)
    // 折叠行：中文标签 + 单行目标 + 可展开箭头；展开卡常驻 DOM 但处于收起态。
    expect(html).toContain('tool-row')
    expect(html).toContain('终端')
    expect(html).toContain('pnpm build')
    expect(html).toContain('tool-chevron')
    expect(html).not.toContain('tool-card-wrap open')
    expect(html).toContain('aria-hidden="true"')
  })
})

describe('ToolRow Task 卡（子代理折叠行 + 工具轨迹）', () => {
  const taskTool: ToolCard = {
    toolUseId: 'task-1',
    tool: 'Task',
    status: 'running',
    turnId: 't1',
    task: { agentType: 'explore', prompt: '检查各包健康状况' },
    body: '请检查 packages/ 目录下各包的健康状况',
  }
  const activity: SubagentActivity = {
    toolCalls: 2,
    running: 1,
    lastTool: 'Grep',
    runs: [
      { toolUseId: 'r1', tool: 'Read', status: 'done', target: '/repo/a.ts' },
      { toolUseId: 'r2', tool: 'Grep', status: 'running', target: 'TODO' },
    ],
  }

  it('折叠行：🤖 agentType · 当前工具 + prompt 首行预览，轨迹收起', () => {
    const html = render(<ToolRow tool={taskTool} subagents={{ t1: activity }} />)
    expect(html).toContain('🤖 explore')
    expect(html).toContain('Grep')
    expect(html).toContain('检查各包健康状况')
    expect(html).not.toContain('tool-card-wrap open')
  })

  it('展开面常驻 DOM：prompt 详情卡 + 工具轨迹逐行（名称/目标/状态）', () => {
    const html = render(<ToolRow tool={taskTool} subagents={{ t1: activity }} />)
    expect(html).toContain('tool-card-stack')
    expect(html).toContain('task-trail')
    expect(html).toContain('工具轨迹 · 2')
    expect(html).toContain('/repo/a.ts')
    expect(html).toContain('task-trail-row is-running')
  })

  it('无 body 有轨迹仍可展开；无 body 无轨迹不可展开', () => {
    // exactOptionalPropertyTypes：剥掉 body 键而非显式 undefined。
    const { body: _body, ...promptLess } = taskTool
    const noBody = render(<ToolRow tool={promptLess} subagents={{ t1: activity }} />)
    expect(noBody).toContain('tool-chevron')
    const bare = render(<ToolRow tool={promptLess} subagents={{}} />)
    expect(bare).not.toContain('tool-chevron')
  })
})

describe('ToolGroupRow 连续工具行分组', () => {
  const tool = (id: string, status: ToolCard['status']): ToolCard => ({
    toolUseId: id,
    tool: 'Read',
    status,
    target: 'a.ts',
  })

  it('默认折叠：只显示「N 次工具调用」头，行卡与详情卡都收起', () => {
    const html = renderToStaticMarkup(
      <ToolGroupRow
        tools={[tool('t1', 'done'), { ...tool('t2', 'error'), body: 'x' }]}
        subagents={{}}
      />,
    )
    expect(html).toContain('2 次工具调用')
    expect(html).toContain('1 个失败')
    expect(html).toContain('tool-group-wrap')
    expect(html).not.toContain('tool-group-wrap open')
    // 逐行卡仍在 DOM（展开即现），标签走各自行卡的中文映射。
    expect(html).toContain('读取')
  })

  it('分组头聚合进度：全部运行中 / 部分完成 / 全部收口三态', () => {
    const allRunning = renderToStaticMarkup(
      <ToolGroupRow
        tools={[tool('t1', 'running'), tool('t2', 'running'), tool('t3', 'running')]}
        subagents={{}}
      />,
    )
    expect(allRunning).toContain('3 次工具调用')
    expect(allRunning).toContain('3 个运行中')

    const partial = renderToStaticMarkup(
      <ToolGroupRow
        tools={[tool('t1', 'done'), tool('t2', 'done'), tool('t3', 'running')]}
        subagents={{}}
      />,
    )
    expect(partial).toContain('2 个完成 · 1 个运行中')

    const settled = renderToStaticMarkup(
      <ToolGroupRow
        tools={[tool('t1', 'done'), tool('t2', 'done'), tool('t3', 'done')]}
        subagents={{}}
      />,
    )
    expect(settled).toContain('3 次工具调用')
    expect(settled).not.toContain('个完成')
    expect(settled).not.toContain('个运行中')
  })
})
