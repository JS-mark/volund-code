import type {
  ContentPart,
  Message,
  ProviderCapabilities,
  ProviderChunk,
  ProviderClient,
  ProviderError,
  ProviderRequest,
  ProviderResponse,
  StopReason,
  ToolSchema,
  Usage,
} from '@volund/provider-kit'
import type { JsonValue } from '@volund/shared'

/**
 * A declarative chunk script served by {@link MockProvider}.
 *
 * Build one with {@link scriptChunks}; hand it to the constructor or
 * {@link MockProvider.enqueue}. A single script may be reused across providers.
 */
export interface MockScript {
  readonly chunks: readonly ProviderChunk[]
}

/** Wrap a chunk list as a reusable {@link MockScript} (defensively copied). */
export function scriptChunks(chunks: readonly ProviderChunk[]): MockScript {
  return { chunks: [...chunks] }
}

/** What `stream()` serves once every queued script has been consumed. */
export type ExhaustedBehavior = 'repeat-last' | 'empty' | 'throw'

export interface MockProviderOptions {
  /** Partial overrides merged over the permissive test-default capabilities. */
  readonly capabilities?: Partial<ProviderCapabilities>
  /** Queue behavior once all scripts are consumed (default `repeat-last`). */
  readonly exhausted?: ExhaustedBehavior
}

export interface InterruptOptions {
  readonly reason: string
  readonly partial?: { text?: string; toolUseIds?: string[] }
}

/** Invalid JSON distributed across a tool's `argsFragment` chunks. */
const BROKEN_TOOL_JSON = '{"broken":'

const defaultCapabilities: ProviderCapabilities = {
  maxContextTokens: 200_000,
  maxOutputTokens: 8_192,
  toolUse: 'parallel',
  toolResultSchema: 'anthropic',
  vision: false,
  files: false,
  thinking: false,
  streaming: true,
  streamingReasoning: false,
  cache: 'none',
  jsonMode: false,
  structuredOutput: false,
  systemPromptLocation: 'system-field',
  toolChoiceRequired: false,
  interleavedThinking: false,
}

interface ChunkInjection {
  /** Fires after this many script chunks have been emitted (1-based ordinal). */
  readonly afterChunkCount: number
  readonly chunk: ProviderChunk
  readonly order: number
}

/**
 * Programmable `ProviderClient` fake (spec 06d-testkit §6.13.2).
 *
 * Serves declarative chunk scripts and supports the fault-injection knobs the
 * spec's forced-point tests need:
 *
 * - `interruptAt(n, { reason })` emits `message.interrupted` after the n-th
 *   script chunk and ends the stream.
 * - `errorAfter(n, error)` emits an `error` chunk after the n-th script chunk
 *   and ends the stream.
 * - `duplicateUsage()` emits every `usage` chunk twice (aggregation rule).
 * - `brokenToolJson(id)` rewrites that tool's `argsFragment` chunks so their
 *   concatenation is invalid JSON (I1 aggregation fail-path).
 * - `truncateUtf8At(char)` splits an astral-plane character across two
 *   `text.delta` chunks at the surrogate boundary (decoder boundary case).
 *
 * Injection ordinals count script chunks only — injected chunks do not advance
 * the counter. Injected `message.interrupted`/`error` chunks terminate the
 * stream, and each injection fires at most once across all streams.
 */
export class MockProvider implements ProviderClient {
  readonly name: string
  readonly capabilities: ProviderCapabilities
  /** Every request handed to `stream()`/`complete()`, in call order. */
  readonly requests: ProviderRequest[] = []

  readonly #scripts: MockScript[] = []
  #lastServed: MockScript | undefined
  readonly #exhausted: ExhaustedBehavior
  readonly #injections: ChunkInjection[] = []
  #injectionOrder = 0
  #duplicateUsage = false
  readonly #brokenToolIds = new Set<string>()
  #utf8SplitChar: string | undefined
  #disposed = false
  #streamCount = 0
  #completions = 0

  constructor(
    name: string,
    script: MockScript | readonly ProviderChunk[] = [],
    options: MockProviderOptions = {},
  ) {
    this.name = name
    this.capabilities = { ...defaultCapabilities, ...options.capabilities }
    this.#exhausted = options.exhausted ?? 'repeat-last'
    this.enqueue(script)
  }

  /** Number of `stream()` invocations so far. */
  get streamCount(): number {
    return this.#streamCount
  }

  get disposed(): boolean {
    return this.#disposed
  }

  /** Queue another script to serve on the next `stream()` call. */
  enqueue(script: MockScript | readonly ProviderChunk[]): this {
    const normalized: MockScript =
      'chunks' in script ? { chunks: [...script.chunks] } : { chunks: [...script] }
    if (normalized.chunks.length === 0) return this
    this.#lastServed = normalized
    this.#scripts.push(normalized)
    return this
  }

  /** After the n-th script chunk, emit `message.interrupted` and end the stream. */
  interruptAt(afterChunkCount: number, options: InterruptOptions): this {
    const chunk: ProviderChunk = {
      kind: 'message.interrupted',
      reason: options.reason,
      ...(options.partial ? { partial: options.partial } : {}),
    }
    this.#inject(afterChunkCount, chunk)
    return this
  }

  /** After the n-th script chunk, emit an `error` chunk and end the stream. */
  errorAfter(afterChunkCount: number, error: ProviderError): this {
    this.#inject(afterChunkCount, { kind: 'error', error })
    return this
  }

  /** Emit every `usage` chunk twice (usage aggregation rule cases). */
  duplicateUsage(): this {
    this.#duplicateUsage = true
    return this
  }

  /** Rewrite the tool's `argsFragment` chunks so the concatenation is invalid JSON. */
  brokenToolJson(toolUseId: string): this {
    this.#brokenToolIds.add(toolUseId)
    return this
  }

  /**
   * Split `char` across two `text.delta` chunks at the surrogate boundary.
   *
   * `char` must be a single astral-plane character (a surrogate pair, e.g.
   * '😀'); each `text.delta` containing it is split so the first fragment ends
   * with the lone high surrogate and the next starts with the low surrogate.
   * Only the first occurrence in each delta is split.
   */
  truncateUtf8At(char: string): this {
    const high = char.charCodeAt(0)
    const low = char.charCodeAt(1)
    const isSurrogatePair =
      char.length === 2 && high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff
    if (!isSurrogatePair) {
      throw new Error('testkit_truncate_utf8_requires_surrogate_pair')
    }
    this.#utf8SplitChar = char
    return this
  }

  async *stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderChunk> {
    if (this.#disposed) throw new Error('mock_provider_disposed')
    this.requests.push(request)
    this.#streamCount += 1
    const brokenPointers = new Map<string, number>()
    let emitted = 0
    for (const chunk of this.#nextScript().chunks) {
      for (const piece of this.#expand(chunk, brokenPointers)) {
        if (signal.aborted) return
        yield piece
      }
      emitted += 1
      const due = this.#drainInjections(emitted)
      for (const injection of due) {
        if (signal.aborted) return
        yield injection.chunk
      }
      if (due.length > 0) return
    }
  }

  async complete(request: ProviderRequest, signal: AbortSignal): Promise<ProviderResponse> {
    let messageId = `mock-complete-${(this.#completions += 1)}`
    let text = ''
    let thinking = ''
    let thinkingSignature: string | undefined
    let usage: Usage | undefined
    let stopReason: StopReason | undefined
    const tools = new Map<string, { id: string; name: string; args: string }>()
    for await (const chunk of this.stream(request, signal)) {
      if (chunk.kind === 'message.start') messageId = chunk.messageId
      else if (chunk.kind === 'text.delta') text += chunk.text
      else if (chunk.kind === 'thinking.delta') {
        thinking += chunk.text
        if (chunk.signature !== undefined) thinkingSignature = chunk.signature
      } else if (chunk.kind === 'tool_use.start')
        tools.set(chunk.id, { id: chunk.id, name: chunk.name, args: '' })
      else if (chunk.kind === 'tool_use.delta') {
        const tool = tools.get(chunk.id)
        if (tool) tool.args += chunk.argsFragment
      } else if (chunk.kind === 'usage') usage = chunk.usage
      else if (chunk.kind === 'message.stop') stopReason = chunk.stopReason
      else if (chunk.kind === 'message.interrupted') break
      else if (chunk.kind === 'error') throw chunk.error
    }
    const content: ContentPart[] = []
    if (thinking)
      content.push({
        type: 'thinking',
        text: thinking,
        ...(thinkingSignature !== undefined ? { signature: thinkingSignature } : {}),
      })
    if (text) content.push({ type: 'text', text })
    for (const tool of tools.values()) {
      let input: JsonValue
      try {
        input = JSON.parse(tool.args) as JsonValue
      } catch {
        input = { parseError: true, raw: tool.args }
      }
      content.push({ type: 'tool_use', id: tool.id, name: tool.name, input })
    }
    const message: Message = {
      id: messageId,
      role: 'assistant',
      content,
      createdAt: 0,
      meta: {
        provider: this.name,
        model: request.model,
        ...(usage ? { usage } : {}),
        ...(stopReason ? { stopReason } : {}),
      },
    }
    return { message, usage: usage ?? { input: 0, output: 0 } }
  }

  async countTokens(messages: readonly Message[], tools?: readonly ToolSchema[]): Promise<number> {
    let chars = 0
    for (const message of messages) {
      for (const part of message.content) {
        if (part.type === 'text' || part.type === 'thinking') chars += part.text.length
        else if (part.type === 'tool_use') chars += JSON.stringify(part.input).length
        else if (part.type === 'tool_result') chars += JSON.stringify(part.content).length
      }
    }
    if (tools) chars += JSON.stringify(tools).length
    return Math.ceil(chars / 4)
  }

  async dispose(): Promise<void> {
    this.#disposed = true
    this.#scripts.length = 0
    this.#injections.length = 0
  }

  #inject(afterChunkCount: number, chunk: ProviderChunk): void {
    if (!Number.isInteger(afterChunkCount) || afterChunkCount < 0) {
      throw new Error('testkit_injection_requires_non_negative_integer')
    }
    this.#injections.push({ afterChunkCount, chunk, order: (this.#injectionOrder += 1) })
  }

  #drainInjections(emitted: number): ChunkInjection[] {
    const due = this.#injections
      .filter((injection) => injection.afterChunkCount === emitted)
      .sort((a, b) => a.order - b.order)
    for (const injection of due) {
      const index = this.#injections.indexOf(injection)
      if (index >= 0) this.#injections.splice(index, 1)
    }
    return due
  }

  #nextScript(): MockScript {
    const queued = this.#scripts.shift()
    if (queued) {
      this.#lastServed = queued
      return queued
    }
    if (this.#exhausted === 'throw') throw new Error('mock_provider_script_exhausted')
    if (this.#exhausted === 'empty') return { chunks: [] }
    return this.#lastServed ?? { chunks: [] }
  }

  #expand(chunk: ProviderChunk, brokenPointers: Map<string, number>): ProviderChunk[] {
    if (chunk.kind === 'usage' && this.#duplicateUsage) return [chunk, chunk]
    if (chunk.kind === 'tool_use.delta' && this.#brokenToolIds.has(chunk.id)) {
      const start = brokenPointers.get(chunk.id) ?? 0
      const end = Math.min(start + chunk.argsFragment.length, BROKEN_TOOL_JSON.length)
      brokenPointers.set(chunk.id, end)
      return [{ ...chunk, argsFragment: BROKEN_TOOL_JSON.slice(start, end) }]
    }
    const char = this.#utf8SplitChar
    if (chunk.kind === 'text.delta' && char !== undefined) {
      const index = chunk.text.indexOf(char)
      if (index >= 0) {
        return [
          { ...chunk, text: `${chunk.text.slice(0, index)}${char.slice(0, 1)}` },
          { ...chunk, text: `${char.slice(1)}${chunk.text.slice(index + char.length)}` },
        ]
      }
    }
    return [chunk]
  }
}
