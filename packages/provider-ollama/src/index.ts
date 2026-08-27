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

export interface HttpRequest {
  url: string
  method: 'GET' | 'POST'
  headers: Record<string, string>
  body?: unknown
  signal: AbortSignal
  redirect: 'manual'
}
export interface HttpResponse {
  status: number
  headers?: Record<string, string>
  body: AsyncIterable<Uint8Array>
  /** Final URL when the HTTP implementation followed a redirect despite redirect: manual. */
  url?: string
  json?: { error?: string }
}
export interface HttpPort {
  request(request: HttpRequest): Promise<HttpResponse>
}
export interface AttachmentPort {
  read(source: AttachmentRef): Promise<Uint8Array>
}

const APPROVAL = Symbol('ollama-endpoint-approval')
export interface OllamaEndpointApproval {
  readonly endpoint: string
  readonly [APPROVAL]: true
}
export interface EndpointConfirmation {
  interactive: boolean
  confirm?: (warning: {
    endpoint: string
    plaintext: boolean
    message: string
  }) => boolean | Promise<boolean>
}

function canonicalEndpoint(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new TypeError('ollama_endpoint_invalid')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new TypeError('ollama_endpoint_protocol_not_supported')
  if (url.username || url.password) throw new TypeError('ollama_endpoint_userinfo_forbidden')
  if (url.search || url.hash) throw new TypeError('ollama_endpoint_query_or_fragment_forbidden')
  url.pathname = url.pathname.replace(/\/+$/, '') || '/'
  return url
}

function endpointString(url: URL): string {
  return `${url.origin}${url.pathname === '/' ? '' : url.pathname}`
}

export function isLoopbackOllamaEndpoint(value: string): boolean {
  const url = canonicalEndpoint(value)
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return (
    url.protocol === 'http:' &&
    (host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host))
  )
}

export function normalizeOllamaEndpoint(value: string): string {
  return endpointString(canonicalEndpoint(value))
}

export async function approveOllamaEndpoint(
  value: string,
  options: EndpointConfirmation,
): Promise<OllamaEndpointApproval | undefined> {
  const endpoint = normalizeOllamaEndpoint(value)
  if (isLoopbackOllamaEndpoint(endpoint)) return undefined
  if (!options.interactive) throw new Error('ollama_remote_endpoint_non_interactive_denied')
  const plaintext = endpoint.startsWith('http:')
  const confirmed = await options.confirm?.({
    endpoint,
    plaintext,
    message: plaintext
      ? `DANGER: send prompts in plaintext to remote Ollama endpoint ${endpoint}?`
      : `Send prompts to remote Ollama endpoint ${endpoint}?`,
  })
  if (!confirmed) throw new Error('ollama_remote_endpoint_confirmation_required')
  return Object.freeze({ endpoint, [APPROVAL]: true as const })
}

function assertEndpointApproved(endpoint: string, approval?: OllamaEndpointApproval): void {
  if (isLoopbackOllamaEndpoint(endpoint)) return
  if (approval?.[APPROVAL] !== true || approval.endpoint !== endpoint)
    throw new Error('ollama_remote_endpoint_confirmation_required')
}

export const ollamaCapabilities: ProviderCapabilities = {
  maxContextTokens: 32_768,
  maxOutputTokens: 8_192,
  toolUse: 'sequential',
  toolResultSchema: 'openai',
  vision: { formats: ['image/jpeg', 'image/png'], maxSizeMB: 20 },
  files: false,
  thinking: false,
  streaming: true,
  streamResume: false,
  streamingReasoning: false,
  cache: 'none',
  jsonMode: true,
  structuredOutput: false,
  systemPromptLocation: 'system-field',
  toolChoiceRequired: false,
  interleavedThinking: false,
}

async function bytes(source: AttachmentRef, port?: AttachmentPort): Promise<Uint8Array> {
  if (source.kind === 'inline') return source.bytes
  if (!port) throw new TypeError('Non-inline attachments require an AttachmentPort')
  return port.read(source)
}
function text(parts: readonly ContentPart[]): string {
  return parts
    .filter((part): part is Extract<ContentPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('')
}

export async function toOllamaMessages(
  messages: readonly Message[],
  attachments?: AttachmentPort,
  system?: string,
): Promise<Array<Record<string, unknown>>> {
  const result: Array<Record<string, unknown>> = []
  if (system) result.push({ role: 'system', content: system })
  for (const message of messages) {
    const toolUses = message.content.filter(
      (part): part is Extract<ContentPart, { type: 'tool_use' }> => part.type === 'tool_use',
    )
    const toolResults = message.content.filter(
      (part): part is Extract<ContentPart, { type: 'tool_result' }> => part.type === 'tool_result',
    )
    const images = message.content.filter(
      (part): part is Extract<ContentPart, { type: 'image' }> => part.type === 'image',
    )
    for (const image of images) {
      const vision = ollamaCapabilities.vision
      if (vision === false || !vision.formats.includes(image.mime))
        throw new TypeError(`Unsupported Ollama image MIME: ${image.mime}`)
    }
    if (message.role === 'system') {
      const content = text(message.content)
      if (content) result.push({ role: 'system', content })
      continue
    }
    if (message.role === 'assistant' || text(message.content) || images.length || toolUses.length)
      result.push({
        role: message.role,
        content: text(message.content),
        ...(images.length
          ? {
              images: await Promise.all(
                images.map(async (part) =>
                  Buffer.from(await bytes(part.source, attachments)).toString('base64'),
                ),
              ),
            }
          : {}),
        ...(toolUses.length
          ? {
              tool_calls: toolUses.map((part) => ({
                function: { name: part.name, arguments: part.input },
              })),
            }
          : {}),
      })
    for (const part of toolResults)
      result.push({ role: 'tool', content: text(part.content), tool_call_id: part.toolUseId })
  }
  return result
}

export function mapOllamaError(status: number, body?: { error?: string }): ProviderError {
  const message = body?.error ?? `Ollama request failed (${status})`
  let category: ProviderErrorCategory = 'unknown'
  if (status === 401 || status === 403) category = 'auth'
  else if (status === 404 || /model.*(?:not found|missing)/i.test(message))
    category = 'model_not_found'
  else if (status === 429) category = 'rate_limit'
  else if (status >= 500) category = 'server'
  else if (/context.*(?:length|window|limit)/i.test(message)) category = 'context_length'
  else if (status === 400 || status === 422) category = 'invalid_request'
  return Object.assign(new Error(message), {
    provider: 'ollama',
    status,
    category,
    retryable: category === 'rate_limit' || category === 'server',
  })
}

function networkError(cause: unknown): ProviderError {
  return Object.assign(new Error(cause instanceof Error ? cause.message : 'Ollama network error'), {
    provider: 'ollama',
    category: 'network' as const,
    retryable: true,
    cause,
  })
}

export async function* parseOllamaNdjson(
  input: AsyncIterable<Uint8Array>,
  signal?: AbortSignal,
): AsyncIterable<ProviderChunk> {
  const decoder = new TextDecoder()
  let buffer = '',
    started = false,
    stopped = false,
    partialText = ''
  const toolIds: string[] = []
  try {
    for await (const chunk of input) {
      if (signal?.aborted) {
        yield {
          kind: 'message.interrupted',
          reason: 'aborted',
          partial: { text: partialText, toolUseIds: toolIds },
        }
        return
      }
      buffer += decoder.decode(chunk, { stream: true })
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (!line) continue
        const value = JSON.parse(line)
        if (value.error) {
          yield { kind: 'error', error: mapOllamaError(value.status ?? 500, value) }
          stopped = true
          continue
        }
        if (!started) {
          yield { kind: 'message.start', messageId: value.id ?? `ollama-${Date.now()}` }
          started = true
        }
        if (typeof value.message?.content === 'string' && value.message.content) {
          partialText += value.message.content
          yield { kind: 'text.delta', text: value.message.content }
        }
        for (const [index, call] of (value.message?.tool_calls ?? []).entries()) {
          const id = call.id ?? `tool-${index}`
          toolIds.push(id)
          yield { kind: 'tool_use.start', id, name: call.function?.name ?? '' }
          yield {
            kind: 'tool_use.delta',
            id,
            argsFragment: JSON.stringify(call.function?.arguments ?? {}),
          }
          yield { kind: 'tool_use.end', id }
        }
        if (value.done) {
          yield {
            kind: 'usage',
            usage: { input: value.prompt_eval_count ?? 0, output: value.eval_count ?? 0 },
          }
          yield {
            kind: 'message.stop',
            stopReason: toolIds.length
              ? 'tool_use'
              : value.done_reason === 'length'
                ? 'max_tokens'
                : 'end_turn',
          }
          stopped = true
        }
      }
    }
    buffer += decoder.decode()
    if (!stopped)
      yield {
        kind: 'message.interrupted',
        reason: buffer.trim() ? 'incomplete_ndjson_frame' : 'stream_ended',
        partial: { text: partialText, toolUseIds: toolIds },
      }
  } catch (cause) {
    if (!stopped)
      yield {
        kind: 'message.interrupted',
        reason: cause instanceof Error ? cause.message : 'stream_error',
        partial: { text: partialText, toolUseIds: toolIds },
      }
  }
}

export interface OllamaProbeResult {
  version: string
  tools: boolean
}
export async function probeOllamaCapabilities(
  http: HttpPort,
  endpoint = 'http://127.0.0.1:11434',
  signal = AbortSignal.timeout(5_000),
  approval?: OllamaEndpointApproval,
): Promise<OllamaProbeResult> {
  const normalized = normalizeOllamaEndpoint(endpoint)
  assertEndpointApproved(normalized, approval)
  const response = await http.request({
    url: `${normalized}/api/version`,
    method: 'GET',
    headers: {},
    signal,
    redirect: 'manual',
  })
  assertSafeResponse(response, `${normalized}/api/version`, approval)
  if (response.status < 200 || response.status >= 300)
    throw mapOllamaError(response.status, response.json)
  let value = ''
  for await (const chunk of response.body) value += new TextDecoder().decode(chunk)
  const parsed: unknown = JSON.parse(value)
  const version =
    typeof parsed === 'object' &&
    parsed !== null &&
    'version' in parsed &&
    typeof parsed.version === 'string'
      ? parsed.version
      : ''
  return { version, tools: compareVersion(version, '0.3.0') >= 0 }
}
function compareVersion(a: string, b: string): number {
  const left = a.split('.').map(Number),
    right = b.split('.').map(Number)
  for (let index = 0; index < 3; index++) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0)
    if (delta) return delta
  }
  return 0
}
function assertSafeResponse(
  response: HttpResponse,
  requested: string,
  approval?: OllamaEndpointApproval,
) {
  if (response.status >= 300 && response.status < 400) throw new Error('ollama_redirect_denied')
  if (response.url && normalizeOllamaEndpoint(response.url) !== requested) {
    assertEndpointApproved(normalizeOllamaEndpoint(response.url), approval)
    throw new Error('ollama_redirect_target_changed')
  }
}

export interface OllamaClientOptions {
  http: HttpPort
  attachments?: AttachmentPort
  endpoint?: string
  approval?: OllamaEndpointApproval
}
export class OllamaClient implements ProviderClient {
  readonly name = 'ollama'
  readonly capabilities = ollamaCapabilities
  private readonly endpoint: string
  constructor(private readonly options: OllamaClientOptions) {
    this.endpoint = normalizeOllamaEndpoint(options.endpoint ?? 'http://127.0.0.1:11434')
    assertEndpointApproved(this.endpoint, options.approval)
  }
  async *stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderChunk> {
    if (signal.aborted) {
      yield { kind: 'message.interrupted', reason: 'aborted' }
      return
    }
    let response: HttpResponse
    try {
      response = await this.options.http.request({
        url: `${this.endpoint}/api/chat`,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal,
        redirect: 'manual',
        body: {
          model: request.model,
          messages: await toOllamaMessages(
            request.messages,
            this.options.attachments,
            request.system,
          ),
          stream: true,
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
          ...(request.responseFormat === 'json' ? { format: 'json' } : {}),
          options: {
            ...(request.maxTokens === undefined ? {} : { num_predict: request.maxTokens }),
            ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
            ...(request.topP === undefined ? {} : { top_p: request.topP }),
            ...(request.stopSequences === undefined ? {} : { stop: request.stopSequences }),
            ...(request.rawMeta?.ollama?.numCtx === undefined
              ? {}
              : { num_ctx: request.rawMeta.ollama.numCtx }),
          },
          ...(request.rawMeta?.ollama?.keepAlive === undefined
            ? {}
            : { keep_alive: request.rawMeta.ollama.keepAlive }),
        },
      })
    } catch (cause) {
      if (signal.aborted) {
        yield { kind: 'message.interrupted', reason: 'aborted' }
        return
      }
      throw networkError(cause)
    }
    assertSafeResponse(response, `${this.endpoint}/api/chat`, this.options.approval)
    if (response.status < 200 || response.status >= 300)
      throw mapOllamaError(response.status, response.json)
    yield* parseOllamaNdjson(response.body, signal)
  }
  async dispose(): Promise<void> {}
}
