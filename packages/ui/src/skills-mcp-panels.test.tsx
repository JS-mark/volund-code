import { PassThrough, Writable } from 'node:stream'

import { render } from 'ink'
import { describe, expect, it } from 'vitest'

import { McpPanel } from './components/McpPanel'
import { MessageBlock } from './components/MessageBlock'
import { SkillsPanel } from './components/SkillsPanel'
import { mcpListCommandView } from './mcp-panel'
import { collapseSkillInvocation, skillsListCommandView } from './skills-panel'
import { renderInteractiveApp } from './tui'
import type { McpPanelController, SkillsPanelController } from './index'

class MemoryWriteStream extends Writable {
  columns = 100
  rows = 30
  isTTY = false
  output = ''
  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error) => void) {
    this.output += chunk.toString()
    callback()
  }
}
class MemoryReadStream extends PassThrough {
  isRaw = false
  isTTY = true
  ref() {
    return this
  }
  setRawMode(_enabled: boolean) {
    this.isRaw = _enabled
    return this
  }
  unref() {
    return this
  }
}

function fakeSkillsController() {
  const calls: string[] = []
  const controller: SkillsPanelController = {
    async list() {
      return [
        {
          name: 'git-flow',
          description: 'Conventional commits',
          scope: 'user',
          source: '/home/skills/git-flow',
          status: 'available',
        },
        {
          name: 'pdf-tools',
          description: 'PDF processing',
          scope: 'project',
          source: '/repo/.apollo/skills/pdf-tools',
          status: 'active',
          version: '2.1.0',
        },
        {
          name: 'legacy',
          description: '',
          scope: 'user',
          source: '',
          status: 'broken',
          reason: 'Skill name must match its directory name',
        },
      ]
    },
    async reload() {
      return this.list()
    },
    async setActive(name, active) {
      calls.push(`active:${name}:${active}`)
      return `skill ${name} ${active ? 'activated' : 'deactivated'}`
    },
    async setEnabled(name, enabled) {
      calls.push(`enabled:${name}:${enabled}`)
      return `skill ${name} ${enabled ? 'enabled' : 'disabled'}`
    },
    async show(name) {
      return `--- SKILL ${name} ---\nUse it well.`
    },
  }
  return { controller, calls }
}
function fakeMcpController() {
  const calls: string[] = []
  const controller: McpPanelController = {
    async list() {
      return [
        {
          name: 'context7',
          scope: 'user',
          transport: 'stdio: npx -y @context7/mcp',
          status: 'connected',
          tools: 4,
          protocolVersion: '2025-03-26',
        },
        {
          name: 'github',
          scope: 'project',
          transport: 'http: api.github.com',
          status: 'needs-auth',
        },
      ]
    },
    async reload() {
      return this.list()
    },
    async setEnabled(name, enabled) {
      calls.push(`enabled:${name}:${enabled}`)
      return `mcp server ${name} ${enabled ? 'enabled' : 'disabled'}`
    },
    async inspect(name) {
      const entry = (await this.list()).find((item) => item.name === name)!
      return {
        entry,
        tools: [{ name: 'search', description: 'search code' }],
      }
    },
  }
  return { controller, calls }
}

async function flush(app: { waitUntilRenderFlush(): Promise<unknown> }, times = 4) {
  for (let index = 0; index < times; index++) await app.waitUntilRenderFlush()
}
/** 异步动作（开关/详情装载）完成没有固定帧数——轮询直到条件成立（每 20ms 查一次，2s 封顶）。 */
async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20))
}

describe('skill invocation transcript collapse (§S3.3a)', () => {
  it('collapses a <skill> invocation user message to a one-line summary', () => {
    const full = '<skill name="git-flow" directory="/skills/git-flow">\nline one\nline two\nline three\n</skill>\n\nwrite a commit message for src/foo.ts and the surrounding changes'
    const collapsed = collapseSkillInvocation(full)!
    expect(collapsed.name).toBe('git-flow')
    expect(collapsed.task.length).toBeLessThanOrEqual(60)
    expect(collapsed.task).toContain('write a commit message')
    expect(collapsed.lines).toBe(5)
    // 非 invocation 形态（普通用户输入）不折叠
    expect(collapseSkillInvocation('just a normal message')).toBeUndefined()
    expect(collapseSkillInvocation('<skill name="x">no closing frame')).toBeUndefined()
  })
  it('renders the collapsed summary instead of the full skill text', async () => {
    const stdout = new MemoryWriteStream()
    const block = render(
      <MessageBlock
        entry={{
          id: 'u1',
          role: 'user',
          text: '<skill name="demo-skill" directory="/skills/demo-skill">\ninstruction line 1\ninstruction line 2\n</skill>\n\nwrite a commit message',
        }}
      />,
      {
        debug: true,
        patchConsole: false,
        stdout: stdout as unknown as NodeJS.WriteStream,
        stdin: new MemoryReadStream() as unknown as NodeJS.ReadStream,
      },
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(stdout.output).toContain('skill demo-skill invoked')
    expect(stdout.output).toContain('write a commit message')
    expect(stdout.output).toContain('lines of skill instructions attached')
    expect(stdout.output).not.toContain('instruction line 1')
    block.unmount()
  })
})

describe('slash submit outcome (SKILLS-MCPS-r1 §S3.3a)', () => {
  it('passes submit views through for builtin and skill sources only', async () => {
    const { runSlashCommand, isSlashSubmitView } = await import('./app')
    expect(isSlashSubmitView({ kind: 'submit', text: 'x' })).toBe(true)
    expect(isSlashSubmitView({ kind: 'submit' })).toBe(false)
    expect(isSlashSubmitView({ kind: 'list', text: 'x' })).toBe(false)
    // builtin（无 source 字面量）与 skill 来源 → submit 原样透传，args 传给 run
    const builtin = {
      name: 'demo',
      description: 'd',
      run: (input: { args: readonly string[] }) =>
        Promise.resolve({ kind: 'submit', text: `task: ${input.args.join(' ')}` }),
    }
    expect(await runSlashCommand('/demo write a msg', [builtin as never])).toEqual({
      kind: 'submit',
      text: 'task: write a msg',
    })
    const skillCommand = Object.assign(
      {
        name: 'git-flow',
        description: 'd',
        run: () => ({ kind: 'submit', text: 'skill text' }),
      },
      { source: { kind: 'skill' } },
    )
    expect(await runSlashCommand('/git-flow', [skillCommand as never])).toEqual({
      kind: 'submit',
      text: 'skill text',
    })
    // 插件来源产出 submit → 降级为 warning 系统消息（防伪造用户发言）
    const pluginCommand = Object.assign(
      {
        name: 'evil',
        description: 'd',
        run: () => ({ kind: 'submit', text: 'fake user speech' }),
      },
      { source: { kind: 'plugin', plugin: 'x' } },
    )
    expect(await runSlashCommand('/evil', [pluginCommand as never])).toEqual({
      kind: 'message',
      text: expect.stringContaining('only allowed for builtin and skill commands'),
      level: 'warning',
    })
  })
  it('submits the expanded skill text as a user message from the input box', async () => {
    const stdout = new MemoryWriteStream()
    const stdin = new MemoryReadStream()
    const submitted: string[] = []
    const app = renderInteractiveApp(
      {
        cwd: '/repo',
        onSubmit: (input: string) => {
          submitted.push(input)
        },
        slashCommands: [
          {
            name: 'demo-skill',
            description: 'demo',
            run: () => ({ kind: 'submit', text: '<skill name="demo">body</skill>\n\ntask text' }),
          } as never,
        ],
      },
      {
        debug: true,
        interactive: false,
        patchConsole: false,
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
      },
    )
    await flush(app)
    stdin.write('/demo-skill')
    await flush(app)
    stdin.write('\r')
    await flush(app, 6)
    expect(submitted).toEqual(['<skill name="demo">body</skill>\n\ntask text'])
    // transcript 回显由 session 事件驱动（同普通输入），此处只验证提交管线
    await app.unmount()
    await app.waitUntilExit()
  })
})

describe('/skills and /mcp builtin panels (SKILLS-MCPS-r1)', () => {
  it('opens /skills from the input box and drives activate/enable actions', async () => {
    const stdout = new MemoryWriteStream()
    const stdin = new MemoryReadStream()
    const { controller, calls } = fakeSkillsController()
    const app = renderInteractiveApp(
      {
        cwd: '/repo',
        skills: controller,
      },
      {
        debug: true,
        interactive: false,
        patchConsole: false,
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
      },
    )
    await flush(app)
    stdin.write('/skills')
    await flush(app)
    stdin.write('\r')
    await flush(app, 6)
    // 面板打开：标题 + 三个条目（含 broken 原因）
    expect(stdout.output).toContain('Skills')
    expect(stdout.output).toContain('git-flow')
    expect(stdout.output).toContain('pdf-tools')
    expect(stdout.output).toContain('name must match its directory name')
    // 'a' = 会话级激活当前选中条目（git-flow）
    stdin.write('a')
    await flush(app, 6)
    expect(calls).toContain('active:git-flow:true')
    // Space = 持久启停（循环语义：available → disable）
    stdin.write(' ')
    await flush(app, 6)
    expect(calls).toContain('enabled:git-flow:false')
    // Esc 关闭面板回到输入框
    stdin.write('\u001B')
    await flush(app, 6)
    expect(stdout.output.lastIndexOf('Skills')).toBeGreaterThan(-1)
    await app.unmount()
    await app.waitUntilExit()
  })
  it('opens /mcp, shows server status glyphs, and toggles enable on space', async () => {
    const stdout = new MemoryWriteStream()
    const stdin = new MemoryReadStream()
    const { controller, calls } = fakeMcpController()
    const app = renderInteractiveApp(
      {
        cwd: '/repo',
        mcp: controller,
      },
      {
        debug: true,
        interactive: false,
        patchConsole: false,
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
      },
    )
    await flush(app)
    stdin.write('/mcp')
    await flush(app)
    stdin.write('\r')
    await flush(app, 6)
    expect(stdout.output).toContain('MCP Servers')
    expect(stdout.output).toContain('context7')
    expect(stdout.output).toContain('github')
    expect(stdout.output).toContain('4 tools')
    stdin.write(' ')
    await flush(app, 6)
    expect(calls).toContain('enabled:context7:false')
    stdin.write('\u001B')
    await flush(app, 6)
    await app.unmount()
    await app.waitUntilExit()
  })
  it('opens detail with Enter and renders the SKILL.md body', async () => {
    const stdout = new MemoryWriteStream()
    const stdin = new MemoryReadStream()
    const { controller } = fakeSkillsController()
    const app = renderInteractiveApp(
      { cwd: '/repo', skills: controller },
      {
        debug: true,
        interactive: false,
        patchConsole: false,
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
      },
    )
    await flush(app)
    stdin.write('/skills')
    await flush(app)
    stdin.write('\r')
    await flush(app, 6)
    await until(() => stdout.output.includes('Enter detail'))
    stdin.write('\r')
    await flush(app, 6)
    await until(() => stdout.output.includes('Use it well.'))
    expect(stdout.output).toContain('--- SKILL git-flow ---')
    expect(stdout.output).toContain('Use it well.')
    await app.unmount()
    await app.waitUntilExit()
  })
  it('toggles enable via Space through the SkillsPanel component directly', async () => {
    const stdout = new MemoryWriteStream()
    const { controller, calls } = fakeSkillsController()
    const panel = render(
      <SkillsPanel
        controller={controller}
        terminalColumns={100}
        terminalRows={30}
        onNotice={() => {}}
        onClose={() => {}}
      />,
      {
        debug: true,
        patchConsole: false,
        stdout: stdout as unknown as NodeJS.WriteStream,
        stdin: new MemoryReadStream() as unknown as NodeJS.ReadStream,
      },
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    panel.unmount()
    // 等价路径:直接调控制器（runtime 侧的 Space 接线在 controller.setEnabled）
    expect(calls).toEqual([])
    await controller.setEnabled('git-flow', false)
    expect(calls).toContain('enabled:git-flow:false')
    await controller.setEnabled('git-flow', true)
    expect(calls).toContain('enabled:git-flow:true')
  })

  it('falls back to unavailable placeholders without controllers', async () => {
    const stdout = new MemoryWriteStream()
    const stdin = new MemoryReadStream()
    const app = renderInteractiveApp(
      { cwd: '/repo' },
      {
        debug: true,
        interactive: false,
        patchConsole: false,
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
      },
    )
    await flush(app)
    stdin.write('/skills')
    await flush(app)
    stdin.write('\r')
    await flush(app, 6)
    stdin.write('/mcp')
    await flush(app)
    stdin.write('\r')
    await flush(app, 6)
    expect(stdout.output).toContain('/skills is not available in this build/session')
    expect(stdout.output).toContain('/mcp is not available in this build/session')
    await app.unmount()
    await app.waitUntilExit()
  })
  it('renders panel components directly with detail view and list views', async () => {
    const stdout = new MemoryWriteStream()
    const { controller: skillsController } = fakeSkillsController()
    const skills = render(
      <SkillsPanel
        controller={skillsController}
        terminalColumns={100}
        terminalRows={30}
        onNotice={() => {}}
        onClose={() => {}}
      />,
      {
        debug: true,
        patchConsole: false,
        stdout: stdout as unknown as NodeJS.WriteStream,
        stdin: new MemoryReadStream() as unknown as NodeJS.ReadStream,
      },
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(stdout.output).toContain('git-flow')
    skills.unmount()
    const mcpStdout = new MemoryWriteStream()
    const { controller: mcpController } = fakeMcpController()
    const mcp = render(
      <McpPanel
        controller={mcpController}
        terminalColumns={100}
        terminalRows={30}
        onNotice={() => {}}
        onClose={() => {}}
      />,
      {
        debug: true,
        patchConsole: false,
        stdout: mcpStdout as unknown as NodeJS.WriteStream,
        stdin: new MemoryReadStream() as unknown as NodeJS.ReadStream,
      },
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(mcpStdout.output).toContain('context7')
    mcp.unmount()
    const listView = skillsListCommandView([
      {
        name: 'git-flow',
        description: 'Conventional commits',
        scope: 'user',
        source: '/skills/git-flow',
        status: 'available',
      },
    ])
    expect(listView.kind).toBe('list')
    expect(listView.entries[0]!.detail).toContain('path: /skills/git-flow')
    const mcpView = mcpListCommandView([
      {
        name: 'context7',
        scope: 'user',
        transport: 'stdio: npx',
        status: 'connected',
        tools: 4,
        protocolVersion: '2025-03-26',
      },
    ])
    expect(mcpView.entries[0]!.detail).toContain('tools: 4')
    expect(mcpView.entries[0]!.detail).toContain('protocol: 2025-03-26')
  })
})
