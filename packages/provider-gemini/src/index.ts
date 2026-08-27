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
  ToolSchema,
} from '@volund/provider-kit'

export interface CredentialPort {
  getCredential(providerId: 'gemini'): Promise<string>
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
  json?: GeminiErrorBody
}
export interface HttpPort {
  request(request: HttpRequest): Promise<HttpResponse>
}
export interface AttachmentPort {
  read(source: AttachmentRef): Promise<Uint8Array>
}
export interface GeminiClientOptions {
  credentials: CredentialPort
  http: HttpPort
  model: string
  attachments?: AttachmentPort
  baseUrl?: string
}
export interface GeminiErrorBody {
  error?: { code?: number; status?: string; message?: string }
}

export const geminiCapabilities: ProviderCapabilities = {
  maxContextTokens: 1_048_576,
  maxOutputTokens: 65_536,
  toolUse: 'parallel',
  toolResultSchema: 'gemini',
  vision: {
    formats: ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'],
    maxSizeMB: 20,
  },
  files: false,
  thinking: false,
  streaming: true,
  streamResume: false,
  streamingReasoning: false,
  cache: 'persistent',
  jsonMode: true,
  structuredOutput: false,
  systemPromptLocation: 'first-user-message',
  toolChoiceRequired: true,
  interleavedThinking: false,
}

async function readBytes(source: AttachmentRef, port?: AttachmentPort): Promise<Uint8Array> {
  if (source.kind === 'inline') return source.bytes
  if (!port) throw new TypeError('Non-inline attachments require an AttachmentPort')
  return port.read(source)
}

async function geminiPart(
  part: ContentPart,
  toolNames: Map<string, string>,
  attachments?: AttachmentPort,
): Promise<Record<string, unknown> | undefined> {
  if (part.type === 'text') return { text: part.text }
  if (part.type === 'thinking') return undefined
  if (part.type === 'file') throw new TypeError('Gemini adapter does not support file parts')
  if (part.type === 'image') {
    const vision = geminiCapabilities.vision
    if (vision === false || !vision.formats.includes(part.mime))
      throw new TypeError(`Unsupported Gemini image MIME: ${part.mime}`)
    const data = await readBytes(part.source, attachments)
    if (data.byteLength > vision.maxSizeMB * 1024 * 1024)
      throw new RangeError(`Gemini image exceeds ${vision.maxSizeMB}MB limit`)
    return { inlineData: { mimeType: part.mime, data: Buffer.from(data).toString('base64') } }
  }
  if (part.type === 'tool_use') {
    toolNames.set(part.id, part.name)
    return { functionCall: { name: part.name, args: part.input } }
  }
  const name = toolNames.get(part.toolUseId)
  if (!name) throw new TypeError(`Gemini tool result has no matching tool use: ${part.toolUseId}`)
  const output = part.content
    .filter((item): item is Extract<ContentPart, { type: 'text' }> => item.type === 'text')
    .map((item) => item.text)
    .join('')
  return {
    functionResponse: {
      name,
      response: part.isError ? { error: output } : { output },
    },
  }
}

export async function toGeminiContents(
  messages: readonly Message[],
  attachments?: AttachmentPort,
  system?: string,
): Promise<Array<Record<string, unknown>>> {
  const contents: Array<Record<string, unknown>> = []
  const toolNames = new Map<string, string>()
  if (system) contents.push({ role: 'user', parts: [{ text: system }] })
  for (const message of messages) {
    const parts = (
      await Promise.all(message.content.map((part) => geminiPart(part, toolNames, attachments)))
    ).filter((part) => part !== undefined)
    if (parts.length === 0) continue
    const hasFunctionResponse = parts.some((part) => 'functionResponse' in part)
    contents.push({
      role: hasFunctionResponse ? 'function' : message.role === 'assistant' ? 'model' : 'user',
      parts,
    })
  }
  return contents
}

export function mapGeminiError(
  status: number,
  body?: GeminiErrorBody,
  retryAfterMs?: number,
): ProviderError {
  const code = body?.error?.status ?? ''
  const message = body?.error?.message ?? ''
  const searchable = `${code} ${message}`.toLowerCase()
  let category: ProviderErrorCategory = 'unknown'
  if (status === 401 || status === 403) category = 'auth'
  else if (status === 429) category = searchable.includes('quota') ? 'quota' : 'rate_limit'
  else if (status === 404) category = 'model_not_found'
  else if (status >= 500) category = 'server'
  else if (searchable.includes('safety') || searchable.includes('blocked'))
    category = 'content_filter'
  else if (searchable.includes('token') && searchable.includes('limit')) category = 'context_length'
  else if (status === 400 || status === 422) category = 'invalid_request'
  return Object.assign(new Error(message || `Gemini request failed (${status})`), {
    provider: 'gemini',
    status,
    category,
    retryable: category === 'rate_limit' || category === 'server',
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  })
}

function mapNetworkError(cause: unknown): ProviderError {
  return Object.assign(new Error(cause instanceof Error ? cause.message : 'Gemini network error'), {
    provider: 'gemini',
    category: 'network' as const,
    retryable: true,
    cause,
  })
}

function stopReason(reason?: string) {
  if (reason === 'MAX_TOKENS') return 'max_tokens' as const
  if (reason === 'SAFETY' || reason === 'RECITATION' || reason === 'PROHIBITED_CONTENT')
    return 'error' as const
  return 'end_turn' as const
}

export async function* parseGeminiSse(
  bytes: AsyncIterable<Uint8Array>,
  signal?: AbortSignal,
): AsyncIterable<ProviderChunk> {
  const decoder = new TextDecoder()
  let buffer = ''
  let partialText = ''
  let started = false
  let stopped = false
  let toolIndex = 0
  const activeToolIds: string[] = []
  try {
    for await (const chunk of bytes) {
      if (signal?.aborted) {
        yield {
          kind: 'message.interrupted',
          reason: 'aborted',
          partial: { text: partialText, toolUseIds: activeToolIds },
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
        const value = JSON.parse(data)
        if (value.error) {
          yield { kind: 'error', error: mapGeminiError(value.error.code ?? 500, value) }
          stopped = true
          continue
        }
        if (!started) {
          yield {
            kind: 'message.start',
            messageId: value.responseId ?? `gemini-${Date.now().toString(36)}`,
          }
          started = true
        }
        const candidate = value.candidates?.[0]
        for (const part of candidate?.content?.parts ?? []) {
          if (typeof part.text === 'string' && part.text) {
            partialText += part.text
            yield { kind: 'text.delta', text: part.text }
          }
          if (part.functionCall) {
            const id = part.functionCall.id ?? `gemini-call-${toolIndex++}`
            activeToolIds.push(id)
            yield { kind: 'tool_use.start', id, name: part.functionCall.name ?? '' }
            yield {
              kind: 'tool_use.delta',
              id,
              argsFragment: JSON.stringify(part.functionCall.args ?? {}),
            }
            yield { kind: 'tool_use.end', id }
          }
        }
        if (value.usageMetadata)
          yield {
            kind: 'usage',
            usage: {
              input: value.usageMetadata.promptTokenCount ?? 0,
              output: value.usageMetadata.candidatesTokenCount ?? 0,
              ...(value.usageMetadata.cachedContentTokenCount === undefined
                ? {}
                : { cacheRead: value.usageMetadata.cachedContentTokenCount }),
            },
          }
        if (candidate?.finishReason) {
          yield { kind: 'message.stop', stopReason: stopReason(candidate.finishReason) }
          stopped = true
        }
      }
    }
    buffer += decoder.decode()
    if (!stopped)
      yield {
        kind: 'message.interrupted',
        reason: buffer.trim() ? 'incomplete_sse_frame' : 'stream_ended',
        partial: { text: partialText, toolUseIds: activeToolIds },
      }
  } catch (cause) {
    if (!stopped)
      yield {
        kind: 'message.interrupted',
        reason: cause instanceof Error ? cause.message : 'stream_error',
        partial: { text: partialText, toolUseIds: activeToolIds },
      }
  }
}

function functionDeclarations(tools?: ToolSchema[]) {
  if (!tools) return undefined
  return [
    {
      functionDeclarations: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      })),
    },
  ]
}

function functionCallingConfig(choice: ProviderRequest['toolChoice']) {
  if (choice === undefined || choice === 'auto') return undefined
  if (choice === 'none') return { functionCallingConfig: { mode: 'NONE' } }
  if (choice === 'required') return { functionCallingConfig: { mode: 'ANY' } }
  return {
    functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [choice.name] },
  }
}

async function readJson(body: AsyncIterable<Uint8Array>): Promise<Record<string, unknown>> {
  const chunks: Uint8Array[] = []
  for await (const chunk of body) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export class GeminiClient implements ProviderClient {
  readonly name = 'gemini'
  readonly capabilities = geminiCapabilities
  constructor(private readonly options: GeminiClientOptions) {}

  private endpoint(model: string, method: 'streamGenerateContent' | 'countTokens') {
    const suffix = method === 'streamGenerateContent' ? '?alt=sse' : ''
    return `${this.options.baseUrl ?? 'https://generativelanguage.googleapis.com'}/v1beta/models/${encodeURIComponent(model)}:${method}${suffix}`
  }

  private async request(input: HttpRequest): Promise<HttpResponse> {
    try {
      return await this.options.http.request(input)
    } catch (cause) {
      if (input.signal.aborted) throw cause
      throw mapNetworkError(cause)
    }
  }

  async *stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderChunk> {
    if (signal.aborted) {
      yield { kind: 'message.interrupted', reason: 'aborted' }
      return
    }
    const credential = await this.options.credentials.getCredential('gemini')
    const metadata = request.rawMeta?.gemini
    let response: HttpResponse
    try {
      response = await this.request({
        url: this.endpoint(request.model, 'streamGenerateContent'),
        method: 'POST',
        headers: { 'x-goog-api-key': credential, 'content-type': 'application/json' },
        body: {
          contents: await toGeminiContents(
            request.messages,
            this.options.attachments,
            request.system,
          ),
          ...(request.tools ? { tools: functionDeclarations(request.tools) } : {}),
          ...(request.toolChoice === undefined
            ? {}
            : { toolConfig: functionCallingConfig(request.toolChoice) }),
          ...(metadata?.safetySettings ? { safetySettings: metadata.safetySettings } : {}),
          generationConfig: {
            ...(request.maxTokens === undefined ? {} : { maxOutputTokens: request.maxTokens }),
            ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
            ...(request.topP === undefined ? {} : { topP: request.topP }),
            ...(request.stopSequences === undefined
              ? {}
              : { stopSequences: request.stopSequences }),
            ...(request.responseFormat === undefined
              ? {}
              : {
                  responseMimeType:
                    request.responseFormat === 'json' ? 'application/json' : 'text/plain',
                }),
            ...(metadata?.candidateCount === undefined
              ? {}
              : { candidateCount: metadata.candidateCount }),
          },
        },
        signal,
      })
    } catch (cause) {
      if (signal.aborted) {
        yield { kind: 'message.interrupted', reason: 'aborted' }
        return
      }
      throw cause
    }
    if (response.status < 200 || response.status >= 300)
      throw mapGeminiError(
        response.status,
        response.json,
        Number(response.headers?.['retry-after-ms']) || undefined,
      )
    yield* parseGeminiSse(response.body, signal)
  }

  async countTokens(messages: Message[], tools?: ToolSchema[]): Promise<number> {
    const signal = AbortSignal.timeout(10_000)
    const credential = await this.options.credentials.getCredential('gemini')
    const response = await this.request({
      url: this.endpoint(this.options.model, 'countTokens'),
      method: 'POST',
      headers: { 'x-goog-api-key': credential, 'content-type': 'application/json' },
      body: {
        contents: await toGeminiContents(messages, this.options.attachments),
        ...(tools ? { tools: functionDeclarations(tools) } : {}),
      },
      signal,
    })
    if (response.status < 200 || response.status >= 300)
      throw mapGeminiError(response.status, response.json)
    const value = await readJson(response.body)
    if (typeof value.totalTokens !== 'number')
      throw mapGeminiError(500, { error: { message: 'Gemini countTokens response is invalid' } })
    return value.totalTokens
  }

  async dispose(): Promise<void> {}
}
