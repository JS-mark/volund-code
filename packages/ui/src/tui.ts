import { render, type RenderOptions } from 'ink'
import { createElement } from 'react'

import { InteractiveApp, type InteractiveAppOptions } from './app'
import {
  DirectoryTrustPrompt,
  type DirectoryTrustDecision,
} from './components/DirectoryTrustPrompt'
import { SessionPicker } from './components/SessionPicker'
import type { SessionCandidate } from './session-picker'

export interface InteractiveAppHandle {
  clear(): void
  unmount(): void
  waitUntilRenderFlush(): Promise<void>
  waitUntilExit(): Promise<void>
}

export function renderSessionPicker(input: {
  sessions: readonly SessionCandidate[]
  error?: string
}): Promise<SessionCandidate | undefined> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value?: SessionCandidate) => {
      if (settled) return
      settled = true
      instance.unmount()
      resolve(value)
    }
    const instance = render(
      createElement(SessionPicker, {
        ...input,
        onCancel: () => finish(),
        onSelect: finish,
      }),
      { exitOnCtrlC: false },
    )
  })
}

export function renderInteractiveApp(
  options: InteractiveAppOptions,
  renderOptions?: RenderOptions,
): InteractiveAppHandle {
  const stdout = renderOptions?.stdout ?? process.stdout
  // ink 的局部擦除按写入时宽度计行；宽度变化后终端 reflow 使计数失效，旧帧残留
  // 并被后续写入挤进 scrollback。这里抢在 ink 自己的 resize 监听之前注册
  // （EventEmitter 按注册顺序触发）：先把整屏连同 scrollback 清掉（同 ink 全屏
  // 路径的 clearTerminal 序列），ink 随后的擦除+重绘落在干净屏上。高度变化无
  // reflow，不清。useTerminalSize 里的对应逻辑只做尺寸跟踪。
  let lastColumns = stdout.columns ?? 80
  const clearOnWidthChange = () => {
    const columns = stdout.columns ?? 80
    if (columns === lastColumns) return
    lastColumns = columns
    if (stdout.isTTY) stdout.write('\x1b[2J\x1b[3J\x1b[H')
  }
  stdout.on('resize', clearOnWidthChange)
  const instance = render(createElement(InteractiveApp, options), {
    exitOnCtrlC: false,
    ...renderOptions,
  })
  return {
    clear: () => instance.clear(),
    unmount: () => {
      stdout.off('resize', clearOnWidthChange)
      instance.unmount()
    },
    waitUntilRenderFlush: async () => {
      await instance.waitUntilRenderFlush()
    },
    waitUntilExit: async () => {
      await instance.waitUntilExit()
    },
  }
}

export function renderDirectoryTrustPrompt(input: {
  canonicalPath: string
  parentPath: string
}): Promise<DirectoryTrustDecision> {
  return new Promise((resolve) => {
    let settled = false
    const instance = render(
      createElement(DirectoryTrustPrompt, {
        ...input,
        onDecision(decision: DirectoryTrustDecision) {
          if (settled) return
          settled = true
          instance.unmount()
          resolve(decision)
        },
      }),
      { exitOnCtrlC: false },
    )
  })
}
