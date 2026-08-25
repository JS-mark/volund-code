import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * createSandboxNativeBridge（runtime.ts）的契约测试：Bash 工具算好的最小 env
 * 必须原样透传进 apollo-sandbox（r13-I11 之前生产桥把 env 参数整个丢弃），
 * 且 permissions.env.read 白名单与注入的 key 一一对应——Rust 侧 env_clear 后
 * 只注入白名单内的名字（crates/apollo-sandbox profile.rs ExecRequest::validate）。
 */
const { execSandbox } = vi.hoisted(() => ({ execSandbox: vi.fn() }))

vi.mock('@apollo-code/native-bridge', () => ({ execSandbox }))

const { createSandboxNativeBridge } = await import('./runtime')

const settled = (overrides: Record<string, unknown> = {}) => ({
  stdout: 'ok',
  stderr: '',
  exit_code: 0,
  duration_ms: 1,
  sandbox_tier: 'full',
  sandbox_violations: [],
  ...overrides,
})

describe('createSandboxNativeBridge (§4.3.1 / r13-I11)', () => {
  beforeEach(() => execSandbox.mockClear())

  it('forwards the tool-computed env into the sandbox with a matching read whitelist', async () => {
    execSandbox.mockResolvedValue(settled())
    const onViolation = vi.fn(async () => undefined)
    const bridge = createSandboxNativeBridge({ cwd: () => '/work/dir', onViolation })
    const env = { PATH: '/usr/bin', NO_PROXY: 'localhost' }

    const out = await bridge.execute(
      '/bin/bash',
      ['-c', "'echo hi'"],
      new AbortController().signal,
      env,
    )

    expect(out).toBe('ok')
    expect(execSandbox).toHaveBeenCalledOnce()
    const [request, signal] = execSandbox.mock.calls[0]!
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(request).toMatchObject({
      command: "/bin/bash -c 'echo hi'",
      cwd: '/work/dir',
      env,
      permissions: {
        fs: { read: ['/work/dir'], write: ['/work/dir'] },
        net: false,
        env: { read: ['PATH', 'NO_PROXY'] },
      },
    })
    expect(onViolation).not.toHaveBeenCalled()
  })

  it('sends an empty read whitelist and no env field when the tool provides none', async () => {
    execSandbox.mockResolvedValue(settled())
    const bridge = createSandboxNativeBridge({ cwd: () => '/work', onViolation: vi.fn() })

    await bridge.execute('/bin/bash', ['-c', "'true'"], new AbortController().signal)

    const [request] = execSandbox.mock.calls[0]!
    expect(request.permissions.env).toEqual({ read: [] })
    // 契约是「不与宿主环境合并」：没有工具 env 时连字段都不出现
    expect('env' in request).toBe(false)
  })

  it('reports every sandbox violation with the settled tier', async () => {
    execSandbox.mockResolvedValue(
      settled({ sandbox_tier: 'partial', sandbox_violations: ['net blocked', 'fs escape'] }),
    )
    const seen: Array<{ tier: string; reason: string }> = []
    const bridge = createSandboxNativeBridge({
      cwd: () => '/work',
      onViolation: async (violation) => {
        seen.push(violation)
      },
    })

    const out = await bridge.execute('/bin/bash', ['-c', "'curl x'"], new AbortController().signal)

    expect(out).toBe('ok')
    expect(seen).toEqual([
      { tier: 'partial', reason: 'net blocked' },
      { tier: 'partial', reason: 'fs escape' },
    ])
  })
})
