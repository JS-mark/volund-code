import { PassThrough, Writable } from 'node:stream'

import type { CoreEvent } from '@volund/core'
import { render } from 'ink'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'

import { applyInteractiveEvent, type InteractiveAppState, type TranscriptEntry } from './app'
import { MessageBlock } from './components/MessageBlock'

class MemoryWriteStream extends Writable {
  columns = 80
  rows = 24
  isTTY = false
  output = ''
  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error) => void) {
    this.output += chunk.toString()
    callback()
  }
}

const baseState: InteractiveAppState = {
  sessionId: 's1',
  status: 'ready',
  statusLevel: 'muted',
  transcript: [],
  pendingAssistantText: '',
  permissionRequests: [],
} as unknown as InteractiveAppState

function event(partial: Partial<CoreEvent> & { type: CoreEvent['type'] }): CoreEvent {
  return {
    id: 'e1',
    version: 1,
    sessionId: 's1',
    at: '2026-08-19T00:00:00.000Z',
    ...partial,
  } as CoreEvent
}

describe('B7 truncation continuation marker (r13-G5)', () => {
  it('turn.completed with max_tokens marks the last assistant transcript entry', () => {
    // 附录 D.2 真实时序（runner.ts）：stream.completed 后紧跟 message.appended，
    // 定稿 entry 由 message.appended 落 transcript。
    let state = { ...baseState, pendingAssistantText: 'half an answer' }
    state = applyInteractiveEvent(
      state,
      event({ type: 'stream.completed', turnId: 't1', payload: { messageId: 'm1' } }),
    )
    state = applyInteractiveEvent(
      state,
      event({
        type: 'message.appended',
        turnId: 't1',
        payload: {
          messageId: 'm1',
          role: 'assistant',
          content: [{ type: 'text', text: 'half an answer' }],
        },
      }),
    )
    expect(state.transcript).toHaveLength(1)
    expect(state.transcript[0]?.truncated).toBeUndefined()

    state = applyInteractiveEvent(
      state,
      event({
        type: 'turn.completed',
        turnId: 't1',
        payload: {
          turnId: 't1',
          usage: { input: 1, output: 2, costUSD: 0 },
          stopReason: 'max_tokens',
        },
      }),
    )
    expect(state.transcript[0]?.truncated).toBe(true)
  })

  it('turn.completed with end_turn leaves the transcript untouched', () => {
    let state = { ...baseState, pendingAssistantText: 'full answer' }
    state = applyInteractiveEvent(
      state,
      event({ type: 'stream.completed', turnId: 't1', payload: { messageId: 'm1' } }),
    )
    state = applyInteractiveEvent(
      state,
      event({
        type: 'message.appended',
        turnId: 't1',
        payload: {
          messageId: 'm1',
          role: 'assistant',
          content: [{ type: 'text', text: 'full answer' }],
        },
      }),
    )
    state = applyInteractiveEvent(
      state,
      event({
        type: 'turn.completed',
        turnId: 't1',
        payload: {
          turnId: 't1',
          usage: { input: 1, output: 2, costUSD: 0 },
          stopReason: 'end_turn',
        },
      }),
    )
    expect(state.transcript[0]?.truncated).toBeUndefined()
  })

  it('MessageBlock renders the marker and continue hint for truncated entries', async () => {
    const stdout = new MemoryWriteStream()
    const stdin = new PassThrough()
    const entry: TranscriptEntry = { id: 'm1', role: 'assistant', text: 'partial', truncated: true }
    const instance = render(createElement(MessageBlock, { entry }), {
      debug: true,
      interactive: false,
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    })
    await new Promise((resolve) => setTimeout(resolve, 40))
    instance.unmount()
    expect(stdout.output).toContain('[truncated: max_tokens reached]')
    expect(stdout.output).toContain('输入 continue 可继续')
  })

  it('MessageBlock renders no marker for ordinary assistant entries', async () => {
    const stdout = new MemoryWriteStream()
    const stdin = new PassThrough()
    const entry: TranscriptEntry = { id: 'm1', role: 'assistant', text: 'complete' }
    const instance = render(createElement(MessageBlock, { entry }), {
      debug: true,
      interactive: false,
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    })
    await new Promise((resolve) => setTimeout(resolve, 40))
    instance.unmount()
    expect(stdout.output).not.toContain('max_tokens')
  })
})
