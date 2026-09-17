import { PassThrough, Writable } from 'node:stream'

import { render } from 'ink'
import { describe, expect, it } from 'vitest'

import { PermissionPromptStack } from './components/PermissionPromptStack'
import type { InteractivePermissionRequest } from './permission'
import { PermissionPromptController } from './permission'

/** §2.7bis.5 U4：TUI 审批卡「子代理 · <agentType>」徽标——lineage 有/无两态。 */

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

function request(
  overrides: Partial<InteractivePermissionRequest> = {},
): InteractivePermissionRequest {
  return {
    id: 'perm-1',
    attempt: 1,
    display: { approvable: true, spec: 'bash', toolName: 'Bash' },
    input: {},
    spec: { bash: { command: 'ls' } },
    toolName: 'Bash',
    ...overrides,
  }
}

async function renderStack(requests: readonly InteractivePermissionRequest[]): Promise<{
  output: string
  unmount: () => void
}> {
  const stdout = new MemoryWriteStream()
  const app = render(
    <PermissionPromptStack controller={new PermissionPromptController()} requests={requests} />,
    {
      debug: true,
      patchConsole: false,
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: new MemoryReadStream() as unknown as NodeJS.ReadStream,
    },
  )
  await new Promise((resolve) => setTimeout(resolve, 50))
  return { output: stdout.output, unmount: () => app.unmount() }
}

describe('PermissionPromptStack lineage badge（§2.7bis.5 U4）', () => {
  it('renders 「子代理 · <agentType>」 badge row when lineage carries agentType', async () => {
    const { output, unmount } = await renderStack([
      request({ lineage: { sessionId: 'sub-1', agentType: 'explore', parentTurnId: 'turn-3' } }),
    ])
    expect(output).toContain('子代理 · explore')
    unmount()
  })

  it('renders bare 「子代理」 badge when lineage has no agentType', async () => {
    const { output, unmount } = await renderStack([request({ lineage: { sessionId: 'sub-2' } })])
    expect(output).toContain('子代理')
    expect(output).not.toContain('子代理 ·')
    unmount()
  })

  it('renders no badge for main-agent requests（无 lineage 回归面）', async () => {
    const { output, unmount } = await renderStack([request()])
    expect(output).toContain('权限请求')
    expect(output).not.toContain('子代理')
    unmount()
  })
})
