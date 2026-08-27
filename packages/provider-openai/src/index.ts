import type {
  AttachmentRef,
  ContentPart,
  Message,
  ProviderCapabilities,
  ProviderChunk,
  ProviderClient,
  ProviderError,
  ProviderErrorCategory,
  ProviderRequest,
} from '@volund/provider-kit'

export interface CredentialPort {
  getCredential(providerId: 'openai'): Promise<string>
}
export interface HttpRequest {
  url: string
  method: 'POST'
  headers: Record<string, string>
  body: unknown
  signal: AbortSignal
}
export interface HttpResponse {
  status: number
  headers?: Record<string, string>
  body: AsyncIterable<Uint8Array>
  json?: { error?: { code?: string; type?: string; message?: string } }
}
export interface HttpPort {
  request(request: HttpRequest): Promise<HttpResponse>
}
export interface AttachmentPort {
  read(source: AttachmentRef): Promise<Uint8Array>
}
export interface OpenAIClientOptions {
  credentials: CredentialPort
  http: HttpPort
  attachments?: AttachmentPort
  baseUrl?: string
}

export const openaiCapabilities: ProviderCapabilities = {
  maxContextTokens: 128_000,
  maxOutputTokens: 16_384,
  toolUse: 'parallel',
  toolResultSchema: 'openai',
  vision: { formats: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'], maxSizeMB: 20 },
  files: false,
  thinking: { budgetTokens: false },
  streaming: true,
  streamResume: false,
  streamingReasoning: false,
  cache: 'none',
  jsonMode: true,
  structuredOutput: true,
  systemPromptLocation: 'system-field',
  toolChoiceRequired: true,
  interleavedThinking: false,
}

async function attachmentBytes(source: AttachmentRef, port?: AttachmentPort): Promise<Uint8Array> {
  if (source.kind === 'inline') return source.bytes
  if (!port) throw new TypeError('Non-inline attachments require an AttachmentPort')
  return port.read(source)
}
async function imageData(
  source: AttachmentRef,
  mime: string,
  attachments?: AttachmentPort,
): Promise<string> {
  const vision = openaiCapabilities.vision
  if (vision === false || !vision.formats.includes(mime))
    throw new TypeError(`Unsupported OpenAI image MIME: ${mime}`)
  const bytes = await attachmentBytes(source, attachments)
  if (bytes.byteLength > vision.maxSizeMB * 1024 * 1024)
    throw new RangeError(`OpenAI image exceeds ${vision.maxSizeMB}MB limit`)
  return Buffer.from(bytes).toString('base64')
}

async function userContent(part: ContentPart, attachments?: AttachmentPort): Promise<unknown> {
  if (part.type === 'text') return { type: 'text', text: part.text }
  if (part.type === 'image')
    return {
      type: 'image_url',
      image_url: {
        url: `data:${part.mime};base64,${await imageData(part.source, part.mime, attachments)}`,
      },
    }
  if (part.type === 'file')
    throw new TypeError('OpenAI Chat Completions does not support file parts')
  return undefined
}

function textContent(parts: readonly ContentPart[]): string {
  return parts
    .filter((part): part is Extract<ContentPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('')
}

export async function toOpenAIMessages(
  messages: readonly Message[],
  attachments?: AttachmentPort,
  system?: string,
): Promise<Array<Record<string, unknown>>> {
  const result: Array<Record<string, unknown>> = []
  if (system) result.push({ role: 'system', content: system })
  for (const message of messages) {
    if (message.role === 'system') {
      const content = textContent(message.content)
      if (content) result.push({ role: 'system', content })
      continue
    }
    const toolUses = message.content.filter(
      (part): part is Extract<ContentPart, { type: 'tool_use' }> => part.type === 'tool_use',
    )
    const toolResults = message.content.filter(
      (part): part is Extract<ContentPart, { type: 'tool_result' }> => part.type === 'tool_result',
    )
    const regularParts = message.content.filter(
      (part) => part.type !== 'tool_use' && part.type !== 'tool_result' && part.type !== 'thinking',
    )
    if (message.role === 'assistant') {
      result.push({
        role: 'assistant',
        content: textContent(regularParts),
        ...(toolUses.length
          ? {
              tool_calls: toolUses.map((part) => ({
                id: part.id,
                type: 'function',
                function: { name: part.name, arguments: JSON.stringify(part.input) },
              })),
            }
          : {}),
      })
    } else if (regularParts.length) {
      const content = (
        await Promise.all(regularParts.map((part) => userContent(part, attachments)))
      ).filter((part) => part !== undefined)
      result.push({ role: 'user', content })
    }
    for (const part of toolResults)
      result.push({
        role: 'tool',
        tool_call_id: part.toolUseId,
        content: textContent(part.content),
      })
  }
  return result
}

export function mapOpenAIError(
  status: number,
  body?: { error?: { code?: string; type?: string; message?: string } },
  retryAfterMs?: number,
): ProviderError {
  const code = `${body?.error?.code ?? ''} ${body?.error?.type ?? ''}`
  let category: ProviderErrorCategory = 'unknown'
  if (status === 401 || status === 403) category = 'auth'
  else if (status === 429) category = code.includes('insufficient_quota') ? 'quota' : 'rate_limit'
  else if (status === 404) category = 'model_not_found'
  else if (status >= 500) category = 'server'
  else if (code.includes('context_length')) category = 'context_length'
  else if (code.includes('content_filter')) category = 'content_filter'
  else if (status === 400 || status === 422) category = 'invalid_request'
  return Object.assign(new Error(body?.error?.message ?? `OpenAI request failed (${status})`), {
    provider: 'openai',
    status,
    category,
    retryable: category === 'rate_limit' || category === 'server',
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  })
}

function mapNetworkError(cause: unknown): ProviderError {
  return Object.assign(new Error(cause instanceof Error ? cause.message : 'OpenAI network error'), {
    provider: 'openai',
    category: 'network' as const,
    retryable: true,
    cause,
  })
}

function finishReason(value?: string | null) {
  if (value === 'tool_calls' || value === 'function_call') return 'tool_use' as const
  if (value === 'length') return 'max_tokens' as const
  if (value === 'content_filter') return 'error' as const
  return 'end_turn' as const
}

export async function* parseOpenAISse(
  bytes: AsyncIterable<Uint8Array>,
  signal?: AbortSignal,
): AsyncIterable<ProviderChunk> {
  const decoder = new TextDecoder()
  const tools = new Map<number, { id: string; name: string }>()
  let buffer = ''
  let partialText = ''
  let started = false
  let stopped = false
  let pendingStop: ProviderChunk | undefined
  try {
    for await (const chunk of bytes) {
      if (signal?.aborted) {
        yield {
          kind: 'message.interrupted',
          reason: 'aborted',
          partial: { text: partialText, toolUseIds: [...tools.values()].map((tool) => tool.id) },
        }
        return
      }
      buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n')
      let boundary: number
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n')
        if (!data) continue
        if (data === '[DONE]') {
          for (const tool of tools.values()) yield { kind: 'tool_use.end', id: tool.id }
          if (pendingStop) yield pendingStop
          stopped = true
          continue
        }
        const value = JSON.parse(data)
        if (value.error) {
          yield { kind: 'error', error: mapOpenAIError(value.status ?? 500, value) }
          stopped = true
          continue
        }
        if (!started && value.id) {
          yield { kind: 'message.start', messageId: value.id }
          started = true
        }
        const choice = value.choices?.[0]
        const delta = choice?.delta
        if (typeof delta?.content === 'string' && delta.content) {
          partialText += delta.content
          yield { kind: 'text.delta', text: delta.content }
        }
        for (const call of delta?.tool_calls ?? []) {
          const index = call.index ?? 0
          let tool = tools.get(index)
          if (!tool && call.id) {
            tool = { id: call.id, name: call.function?.name ?? '' }
            tools.set(index, tool)
            yield { kind: 'tool_use.start', id: tool.id, name: tool.name }
          }
          if (tool && call.function?.arguments)
            yield { kind: 'tool_use.delta', id: tool.id, argsFragment: call.function.arguments }
        }
        if (value.usage)
          yield {
            kind: 'usage',
            usage: {
              input: value.usage.prompt_tokens ?? 0,
              output: value.usage.completion_tokens ?? 0,
              ...(value.usage.prompt_tokens_details?.cached_tokens === undefined
                ? {}
                : { cacheRead: value.usage.prompt_tokens_details.cached_tokens }),
            },
          }
        if (choice?.finish_reason)
          pendingStop = { kind: 'message.stop', stopReason: finishReason(choice.finish_reason) }
      }
    }
    buffer += decoder.decode()
    if (!stopped)
      yield {
        kind: 'message.interrupted',
        reason: buffer.trim() ? 'incomplete_sse_frame' : 'stream_ended',
        partial: { text: partialText, toolUseIds: [...tools.values()].map((tool) => tool.id) },
      }
  } catch (cause) {
    if (!stopped)
      yield {
        kind: 'message.interrupted',
        reason: cause instanceof Error ? cause.message : 'stream_error',
        partial: { text: partialText, toolUseIds: [...tools.values()].map((tool) => tool.id) },
      }
  }
}

function toolChoice(choice: ProviderRequest['toolChoice']): unknown {
  if (choice && typeof choice === 'object')
    return { type: 'function', function: { name: choice.name } }
  return choice
}

export class OpenAIClient implements ProviderClient {
  readonly name = 'openai'
  readonly capabilities = openaiCapabilities
  constructor(private readonly options: OpenAIClientOptions) {}
  async *stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderChunk> {
    if (signal.aborted) {
      yield { kind: 'message.interrupted', reason: 'aborted' }
      return
    }
    const credential = await this.options.credentials.getCredential('openai')
    const metadata = request.rawMeta?.openai
    let response: HttpResponse
    try {
      response = await this.options.http.request({
        url: `${this.options.baseUrl ?? 'https://api.openai.com'}/v1/chat/completions`,
        method: 'POST',
        headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
        body: {
          model: request.model,
          messages: await toOpenAIMessages(
            request.messages,
            this.options.attachments,
            request.system,
          ),
          stream: true,
          stream_options: { include_usage: true },
          ...(request.tools
            ? {
                tools: request.tools.map((tool) => ({
                  type: 'function',
                  function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.inputSchema,
                  },
                })),
              }
            : {}),
          ...(request.toolChoice === undefined
            ? {}
            : { tool_choice: toolChoice(request.toolChoice) }),
          ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
          ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
          ...(request.topP === undefined ? {} : { top_p: request.topP }),
          ...(request.stopSequences === undefined ? {} : { stop: request.stopSequences }),
          ...(request.responseFormat === undefined
            ? {}
            : {
                response_format: {
                  type: request.responseFormat === 'json' ? 'json_object' : 'text',
                },
              }),
          ...(metadata?.logprobs === undefined ? {} : { logprobs: metadata.logprobs }),
          ...(metadata?.seed === undefined ? {} : { seed: metadata.seed }),
          ...(metadata?.reasoningEffort === undefined
            ? request.reasoning?.enabled
              ? { reasoning_effort: 'medium' }
              : {}
            : { reasoning_effort: metadata.reasoningEffort }),
          ...(metadata?.modalities === undefined ? {} : { modalities: metadata.modalities }),
        },
        signal,
      })
    } catch (cause) {
      if (signal.aborted) {
        yield { kind: 'message.interrupted', reason: 'aborted' }
        return
      }
      throw mapNetworkError(cause)
    }
    if (response.status < 200 || response.status >= 300)
      throw mapOpenAIError(
        response.status,
        response.json,
        Number(response.headers?.['retry-after-ms']) || undefined,
      )
    yield* parseOpenAISse(response.body, signal)
  }
  async dispose(): Promise<void> {}
}
