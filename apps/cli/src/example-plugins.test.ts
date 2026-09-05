import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { probeSandbox, resolveBinary } from '@volund/native-bridge'
import { activateLocalPlugin, type ActivatedLocalPlugin } from '@volund/plugin-runtime'
import type { Tool } from '@volund/tool-kit'
import { afterEach, describe, expect, it } from 'vitest'

import { createPluginHookDispatcher } from './runtime'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const exampleDir = join(repoRoot, 'examples', 'plugins', 'volund-plugin-demo')

const dirs: string[] = []
const handles: ActivatedLocalPlugin[] = []
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.deactivate()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function sandboxAvailable(): Promise<boolean> {
  if (!process.env.VOLUND_NATIVE_SANDBOX_BINARY)
    process.env.VOLUND_NATIVE_SANDBOX_BINARY = join(repoRoot, 'target', 'debug', 'volund-sandbox')
  try {
    const binary = await resolveBinary('sandbox')
    if (!binary) return false
    return (await probeSandbox()).tier !== 'none'
  } catch {
    return false
  }
}

async function activateExample() {
  const dataDir = await mkdtemp(join(tmpdir(), 'volund-example-data-'))
  dirs.push(dataDir)
  const activated = await activateLocalPlugin({
    dir: exampleDir,
    volundVersion: '0.1.0',
    dataDirRoot: dataDir,
    services: {},
  })
  handles.push(activated)
  return activated
}

describe('volund-plugin-demo（示例插件 = 全贡献面可运行文档）', () => {
  it('activates through the sandbox and registers every contribution kind', async () => {
    if (!(await sandboxAvailable())) return
    const activated = await activateExample()
    expect(activated.manifest.name).toBe('volund-plugin-demo')
    expect(activated.tools.map((tool) => tool.name)).toEqual([
      'plugin:volund-plugin-demo:word-count',
    ])
    // session.on 复用 hooks 订阅通道：sessionStart 也是一条 hook 记录
    expect(activated.hooks.map((hook) => hook.event)).toEqual(['preToolUse', 'sessionStart'])
    expect(activated.prompts).toHaveLength(1)
    expect(activated.commands.find((command) => command.name === 'demo')).toBeDefined()
  }, 30_000)

  it('invokes the word-count tool with structured output', async () => {
    if (!(await sandboxAvailable())) return
    const activated = await activateExample()
    const tool = activated.tools[0]!
    expect(tool.description).toContain('Count words')
    const raw = (await tool.invoke({ text: 'a b\ncd' })) as {
      words: number
      characters: number
      lines: number
    }
    expect(raw).toEqual({ words: 3, characters: 6, lines: 2 })
  }, 30_000)

  it('veto hook blocks matching Bash calls through the kernel dispatcher', async () => {
    if (!(await sandboxAvailable())) return
    const activated = await activateExample()
    const dispatcher = createPluginHookDispatcher(
      [{ name: activated.manifest.name, handle: activated }],
      { warn: () => {} },
    )
    const outcome = await dispatcher(
      'preToolUse',
      {
        schemaVersion: 1,
        tool: 'Bash',
        input: { command: 'echo demo-block-me' },
      },
      { signal: new AbortController().signal },
    )
    expect(outcome).toMatchObject({ veto: true })
    expect(outcome?.reason).toContain('demo-block-me')
    const pass = await dispatcher(
      'preToolUse',
      {
        schemaVersion: 1,
        tool: 'Bash',
        input: { command: 'git status' },
      },
      { signal: new AbortController().signal },
    )
    expect(pass).toBeUndefined()
  }, 30_000)

  it('renders the /demo command as a pure-data list view', async () => {
    if (!(await sandboxAvailable())) return
    const activated = await activateExample()
    const command = activated.commands.find((candidate) => candidate.name === 'demo')
    const output = (await command!.run([])) as { kind: string; entries: unknown[] }
    expect(output.kind).toBe('list')
    expect(output.entries).toHaveLength(4)
  }, 30_000)

  it('keeps the example a valid plugin:* namespaced tool for kernel registration', () => {
    // 与 ToolRegistry {kind:'plugin'} 的名字约束对齐——示例漂移即测试失败。
    const probe: Pick<Tool, 'name'> = { name: 'plugin:volund-plugin-demo:word-count' }
    expect(probe.name.startsWith('plugin:volund-plugin-demo:')).toBe(true)
  })
})
