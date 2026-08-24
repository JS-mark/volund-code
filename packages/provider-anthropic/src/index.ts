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
} from '@apollo-code/provider-kit'

export interface CredentialPort {
  /** undefined = 调用方显式跳过认证（`[auth] skipAuth`，§8.4）：请求不带 x-api-key。 */
  getCredential(providerId: 'anthropic'): Promise<string | undefined>
}
export interface HttpRequest {
  url: string
  method: 'GET' | 'POST'
  headers: Record<string, string>
  body: unknown
  signal: AbortSignal
}
export interface HttpResponse {
  status: number
  headers?: Record<string, string>
  body: AsyncIterable<Uint8Array>
}
export interface HttpPort {
  request(request: HttpRequest): Promise<HttpResponse>
}
export interface AttachmentPort {
  read(source: AttachmentRef): Promise<Uint8Array>
}
export interface AnthropicClientOptions {
  credentials: CredentialPort
  http: HttpPort
  attachments?: AttachmentPort
  baseUrl?: string
}

async function readJson(body: AsyncIterable<Uint8Array>): Promise<unknown> {
  const chunks: Uint8Array[] = []
  for await (const chunk of body) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

// 非 2xx 错误体提取：网关（企业代理 / api.anthropic.com）通常在 body 里给出真实原因
// （如 "模型路径格式不正确"），丢弃它用户只能看到 'Anthropic request failed (400)'。
// 上限 64KiB 兜底，非 JSON / 无 error 字段返回 undefined 走通用消息。
async function readErrorBody(
  body: AsyncIterable<Uint8Array>,
): Promise<{ error?: { type?: string; message?: string } } | undefined> {
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of body) {
    total += chunk.byteLength
    if (total > 65_536) return undefined
    chunks.push(chunk)
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (typeof value !== 'object' || value === null) return undefined
    const error: unknown = Reflect.get(value, 'error')
    if (typeof error !== 'object' || error === null) return undefined
    const type: unknown = Reflect.get(error, 'type')
    const message: unknown = Reflect.get(error, 'message')
    return {
      error: {
        ...(typeof type === 'string' ? { type } : {}),
        ...(typeof message === 'string' ? { message } : {}),
      },
    }
  } catch {
    return undefined
  }
}

export async function verifyAnthropicCredential(
  http: HttpPort,
  credential: string,
  signal = AbortSignal.timeout(10_000),
  baseUrl = 'https://api.anthropic.com',
): Promise<boolean> {
  const response = await http.request({
    url: `${baseUrl}/v1/models?limit=1`,
    method: 'GET',
    headers: { 'x-api-key': credential, 'anthropic-version': '2023-06-01' },
    body: undefined,
    signal,
  })
  if (response.status < 200 || response.status >= 300) return false
  const value = await readJson(response.body)
  return (
    typeof value === 'object' &&
    value !== null &&
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    Array.isArray((value as Record<string, unknown>).data)
  )
}

export const anthropicCapabilities: ProviderCapabilities = {
  maxContextTokens: 200_000,
  maxOutputTokens: 64_000,
  toolUse: 'parallel',
  toolResultSchema: 'anthropic',
  vision: { formats: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'], maxSizeMB: 5 },
  files: false,
  thinking: { budgetTokens: true },
  streaming: true,
  streamResume: false,
  streamingReasoning: true,
  cache: 'ephemeral',
  jsonMode: false,
  structuredOutput: false,
  systemPromptLocation: 'system-field',
  toolChoiceRequired: false,
  interleavedThinking: true,
}

async function attachmentData(
  source: AttachmentRef,
  mime: string,
  port?: AttachmentPort,
): Promise<string> {
  const vision = anthropicCapabilities.vision
  if (vision === false || !vision.formats.includes(mime))
    throw new TypeError(`Unsupported Anthropic image MIME: ${mime}`)
  const bytes = source.kind === 'inline' ? source.bytes : await port?.read(source)
  if (!bytes) throw new TypeError('Non-inline attachments require an AttachmentPort')
  if (bytes.byteLength > vision.maxSizeMB * 1024 * 1024)
    throw new RangeError(`Anthropic image exceeds ${vision.maxSizeMB}MB limit`)
  return Buffer.from(bytes).toString('base64')
}
async function content(
  part: ContentPart,
  attachments?: AttachmentPort,
): Promise<Record<string, unknown>> {
  if (part.type === 'text') return { type: 'text', text: part.text }
  if (part.type === 'thinking')
    return {
      type: 'thinking',
      thinking: part.text,
      ...(part.signature ? { signature: part.signature } : {}),
    }
  if (part.type === 'image')
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: part.mime,
        data: await attachmentData(part.source, part.mime, attachments),
      },
    }
  if (part.type === 'file') throw new TypeError('Anthropic adapter does not support file parts')
  if (part.type === 'tool_use')
    return { type: 'tool_use', id: part.id, name: part.name, input: part.input }
  return {
    type: 'tool_result',
    tool_use_id: part.toolUseId,
    content: await Promise.all(part.content.map((item) => content(item, attachments))),
    ...(part.isError === undefined ? {} : { is_error: part.isError }),
  }
}
export async function toAnthropicMessages(
  messages: readonly Message[],
  attachments?: AttachmentPort,
): Promise<Array<Record<string, unknown>>> {
  return Promise.all(
    messages
      .filter((message) => message.role !== 'system')
      .map(async (message) => ({
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content: await Promise.all(message.content.map((part) => content(part, attachments))),
      })),
  )
}
export function mapAnthropicError(
  status: number,
  body?: { error?: { type?: string; message?: string } },
  retryAfterMs?: number,
): ProviderError {
  const type = body?.error?.type ?? ''
  let category: ProviderErrorCategory = 'unknown'
  if (status === 401 || status === 403) category = 'auth'
  else if (status === 429) category = type.includes('quota') ? 'quota' : 'rate_limit'
  else if (status === 404) category = 'model_not_found'
  else if (status >= 500) category = 'server'
  else if (type.includes('overloaded')) category = 'server'
  else if (type.includes('invalid_request'))
    category = body?.error?.message?.includes('context') ? 'context_length' : 'invalid_request'
  return Object.assign(new Error(body?.error?.message ?? `Anthropic request failed (${status})`), {
    provider: 'anthropic',
    status,
    category,
    retryable: category === 'rate_limit' || category === 'server',
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  })
}

function normalize(event: string, value: any): ProviderChunk[] {
  if (event === 'message_start')
    return [{ kind: 'message.start', messageId: value.message?.id ?? '' }]
  if (event === 'content_block_start' && value.content_block?.type === 'tool_use')
    return [{ kind: 'tool_use.start', id: value.content_block.id, name: value.content_block.name }]
  if (event === 'content_block_delta' && value.delta?.type === 'text_delta')
    return [{ kind: 'text.delta', text: value.delta.text ?? '' }]
  if (event === 'content_block_delta' && value.delta?.type === 'thinking_delta')
    return [
      {
        kind: 'thinking.delta',
        text: value.delta.thinking ?? '',
        ...(value.delta.signature ? { signature: value.delta.signature } : {}),
      },
    ]
  if (event === 'content_block_delta' && value.delta?.type === 'input_json_delta')
    return [
      {
        kind: 'tool_use.delta',
        id: String(value.index),
        argsFragment: value.delta.partial_json ?? '',
      },
    ]
  if (event === 'content_block_stop') return [{ kind: 'tool_use.end', id: String(value.index) }]
  if (event === 'message_delta' && value.usage)
    return [
      {
        kind: 'usage',
        usage: {
          input: value.usage.input_tokens ?? 0,
          output: value.usage.output_tokens ?? 0,
          ...(value.usage.cache_read_input_tokens === undefined
            ? {}
            : { cacheRead: value.usage.cache_read_input_tokens }),
          ...(value.usage.cache_creation_input_tokens === undefined
            ? {}
            : { cacheWrite: value.usage.cache_creation_input_tokens }),
        },
      },
    ]
  if (event === 'message_stop')
    return [
      {
        kind: 'message.stop',
        stopReason:
          value.stop_reason === 'tool_use'
            ? 'tool_use'
            : value.stop_reason === 'max_tokens'
              ? 'max_tokens'
              : value.stop_reason === 'stop_sequence'
                ? 'stop_sequence'
                : 'end_turn',
      },
    ]
  if (event === 'error') return [{ kind: 'error', error: mapAnthropicError(500, value) }]
  return []
}

export async function* parseAnthropicSse(
  bytes: AsyncIterable<Uint8Array>,
  signal?: AbortSignal,
): AsyncIterable<ProviderChunk> {
  const decoder = new TextDecoder()
  let buffer = ''
  let stopped = false
  const toolIds = new Map<number, string>()
  let partialText = ''
  try {
    for await (const chunk of bytes) {
      if (signal?.aborted) {
        yield {
          kind: 'message.interrupted',
          reason: 'aborted',
          partial: { text: partialText, toolUseIds: [...toolIds.values()] },
        }
        return
      }
      buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n')
      let boundary: number
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        let event = ''
        const data: string[] = []
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim()
          else if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
        }
        if (!event || data.length === 0) continue
        const value = JSON.parse(data.join('\n'))
        if (event === 'content_block_start' && value.content_block?.type === 'tool_use')
          toolIds.set(value.index, value.content_block.id)
        for (const item of normalize(event, value)) {
          let mapped = item
          if (
            (item.kind === 'tool_use.delta' || item.kind === 'tool_use.end') &&
            toolIds.has(value.index)
          )
            mapped = { ...item, id: toolIds.get(value.index)! }
          if (mapped.kind === 'text.delta') partialText += mapped.text
          if (mapped.kind === 'message.stop' || mapped.kind === 'error') stopped = true
          yield mapped
        }
      }
    }
    buffer += decoder.decode()
    if (!stopped)
      yield {
        kind: 'message.interrupted',
        reason: buffer.trim() ? 'incomplete_sse_frame' : 'stream_ended',
        partial: { text: partialText, toolUseIds: [...toolIds.values()] },
      }
  } catch (cause) {
    if (!stopped)
      yield {
        kind: 'message.interrupted',
        reason: cause instanceof Error ? cause.message : 'stream_error',
        partial: { text: partialText, toolUseIds: [...toolIds.values()] },
      }
  }
}

export class AnthropicClient implements ProviderClient {
  readonly name = 'anthropic'
  readonly capabilities = anthropicCapabilities
  constructor(private readonly options: AnthropicClientOptions) { }
  async *stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderChunk> {
    const credential = await this.options.credentials.getCredential('anthropic')
    const response = await this.options.http.request({
      url: `${this.options.baseUrl ?? 'https://api.anthropic.com'}/v1/messages`,
      method: 'POST',
      headers: {
        ...(credential === undefined ? {} : { 'x-api-key': credential }),
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: {
        model: request.model,
        messages: await toAnthropicMessages(request.messages, this.options.attachments),
        system: request.system,
        tools: request.tools?.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.inputSchema,
        })),
        max_tokens: request.maxTokens ?? this.capabilities.maxOutputTokens,
        stream: true,
      },
      signal,
    })
    if (response.status < 200 || response.status >= 300)
      throw mapAnthropicError(
        response.status,
        await readErrorBody(response.body),
        Number(response.headers?.['retry-after-ms']) || undefined,
      )
    yield* parseAnthropicSse(response.body, signal)
  }
  async dispose(): Promise<void> { }
}
