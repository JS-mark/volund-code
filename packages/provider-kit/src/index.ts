import type { VolundErrorCategory, JsonValue } from '@volund/shared'

export interface Usage {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
  costUSD?: number
}
export type ProviderErrorCategory = VolundErrorCategory
export interface ProviderError extends Error {
  provider: string
  model?: string
  status?: number
  category: ProviderErrorCategory
  retryable: boolean
  retryAfterMs?: number
  cause?: unknown
}
export type AttachmentRef =
  | { kind: 'inline'; bytes: Uint8Array }
  | { kind: 'path'; absPath: string }
  | { kind: 'handle'; handle: string }
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string; signature?: string }
  | { type: 'image'; source: AttachmentRef; mime: string }
  | { type: 'file'; source: AttachmentRef; mime: string; filename: string }
  | { type: 'tool_use'; id: string; name: string; input: JsonValue }
  | { type: 'tool_result'; toolUseId: string; content: ContentPart[]; isError?: boolean }

export interface Message {
  id: string
  role: 'assistant' | 'system' | 'user'
  content: ContentPart[]
  createdAt: number
  meta?: {
    provider?: string
    model?: string
    usage?: Usage
    stopReason?: StopReason
    compacted?: boolean
    compactedMessageIds?: string[]
    turnId?: string
    pinnedToContext?: boolean
  }
}

export interface ToolSchema {
  name: string
  description: string
  inputSchema: Record<string, JsonValue>
}
export interface ProviderCapabilities {
  maxContextTokens: number
  maxOutputTokens: number
  toolUse: 'none' | 'sequential' | 'parallel'
  toolResultSchema: 'anthropic' | 'openai' | 'gemini' | 'json-string'
  vision: false | { formats: string[]; maxSizeMB: number }
  files: false | { formats: string[]; maxSizeMB: number }
  thinking: false | { budgetTokens: boolean }
  streaming: boolean
  /** Omitted and false both mean that a stream must be restarted from the request boundary. */
  streamResume?: false | { mode: 'opaque-cursor'; idempotency: 'provider-guaranteed' }
  streamingReasoning: boolean
  cache: 'none' | 'ephemeral' | 'persistent'
  jsonMode: boolean
  structuredOutput: boolean
  systemPromptLocation: 'system-field' | 'first-user-message'
  toolChoiceRequired: boolean
  interleavedThinking: boolean
}
export interface ProviderRequest {
  model: string
  messages: readonly Message[]
  system?: string
  tools?: ToolSchema[]
  toolChoice?: 'auto' | 'none' | 'required' | { name: string }
  maxTokens?: number
  temperature?: number
  topP?: number
  stopSequences?: string[]
  responseFormat?: 'text' | 'json'
  reasoning?: { enabled: boolean; budgetTokens?: number }
  cache?: { strategy: 'ephemeral' | 'persistent' | 'off'; ttlSeconds?: number }
  streamResume?: StreamResumeRequest
  rawMeta?: RawMeta
}
export interface StreamResumeRequest {
  mode: 'opaque-cursor'
  cursor: string
  idempotencyKey: string
}

/** Fail closed before an adapter can mistake byte/token offsets for a supported resume cursor. */
export function assertStreamResumeSupported(
  capabilities: ProviderCapabilities,
  request: unknown,
): asserts request is StreamResumeRequest {
  if (!capabilities.streamResume) throw new Error('stream_resume_unsupported')
  if (
    typeof request !== 'object' ||
    request === null ||
    (request as { mode?: unknown }).mode !== 'opaque-cursor' ||
    typeof (request as { cursor?: unknown }).cursor !== 'string' ||
    !(request as { cursor: string }).cursor ||
    typeof (request as { idempotencyKey?: unknown }).idempotencyKey !== 'string' ||
    !(request as { idempotencyKey: string }).idempotencyKey
  )
    throw new Error('stream_resume_invalid')
}
export interface RawMeta {
  anthropic?: {
    cacheControl?: { type: 'ephemeral' }[]
    metadata?: { user_id?: string }
    computerUse?: { displayWidth: number; displayHeight: number }
  }
  openai?: {
    logprobs?: boolean
    seed?: number
    reasoningEffort?: 'low' | 'medium' | 'high'
    modalities?: ('text' | 'audio')[]
  }
  gemini?: {
    safetySettings?: Array<{ category: string; threshold: string }>
    candidateCount?: number
  }
  ollama?: { keepAlive?: string; numCtx?: number }
}
export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'error'
export type ProviderChunk =
  | { kind: 'message.start'; messageId: string }
  | { kind: 'text.delta'; text: string }
  | { kind: 'thinking.delta'; text: string; signature?: string }
  | { kind: 'tool_use.start'; id: string; name: string }
  | { kind: 'tool_use.delta'; id: string; argsFragment: string }
  | { kind: 'tool_use.end'; id: string }
  | { kind: 'usage'; usage: Usage }
  | { kind: 'message.stop'; stopReason: StopReason }
  | {
      kind: 'message.interrupted'
      reason: string
      partial?: { text?: string; toolUseIds?: string[] }
    }
  | { kind: 'error'; error: ProviderError }
export interface ProviderResponse {
  message: Message
  usage: Usage
}
export interface ProviderClient {
  readonly name: string
  readonly capabilities: ProviderCapabilities
  stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderChunk>
  complete?(request: ProviderRequest, signal: AbortSignal): Promise<ProviderResponse>
  countTokens?(messages: Message[], tools?: ToolSchema[]): Promise<number>
  dispose(): Promise<void>
}

export type EmbeddingProviderScope = 'cloud' | 'local'
export type EmbeddingAuthorizationStatus = 'denied' | 'granted' | 'pending'
export interface EmbeddingRequest {
  readonly model: string
  readonly input: readonly string[]
  readonly purpose: 'semantic-recall'
}
export interface EmbeddingResponse {
  readonly embeddings: readonly (readonly number[])[]
}
export interface EmbeddingProvider {
  readonly name: string
  readonly scope: EmbeddingProviderScope
  readonly model: string
  readonly dimensions: number
  embed(request: EmbeddingRequest, signal: AbortSignal): Promise<EmbeddingResponse>
}

export interface Disposable {
  dispose(): void | Promise<void>
}
export type ProviderSource = { kind: 'core' } | { kind: 'plugin'; plugin: string }
export interface ModelDescriptor {
  id: string
  maxContext?: number
}
export interface ProviderMeta {
  capabilities: Readonly<ProviderCapabilities>
  displayName: string
  models?: readonly ModelDescriptor[]
}
export interface RegisteredProvider {
  name: string
  source: ProviderSource
  meta: Readonly<ProviderMeta>
  client: ProviderClient
}
export interface ProviderRegistry {
  register(client: ProviderClient, source: ProviderSource, meta: ProviderMeta): Disposable
  get(name: string): ProviderClient | undefined
  list(): readonly RegisteredProvider[]
  describe(name: string): RegisteredProvider | undefined
}

const freezeMeta = (meta: ProviderMeta): Readonly<ProviderMeta> => {
  const frozen: ProviderMeta = {
    displayName: meta.displayName,
    capabilities: Object.freeze(structuredClone(meta.capabilities)),
  }
  if (meta.models)
    frozen.models = Object.freeze(meta.models.map((model) => Object.freeze({ ...model })))
  return Object.freeze(frozen)
}

export class InMemoryProviderRegistry implements ProviderRegistry {
  private readonly providers = new Map<string, RegisteredProvider>()

  register(client: ProviderClient, source: ProviderSource, meta: ProviderMeta): Disposable {
    if (this.providers.has(client.name)) throw new Error(`provider_name_conflict: ${client.name}`)
    if (
      client.capabilities !== meta.capabilities &&
      JSON.stringify(client.capabilities) !== JSON.stringify(meta.capabilities)
    )
      throw new Error(`provider_capabilities_mismatch: ${client.name}`)
    const registered = Object.freeze({
      name: client.name,
      source: Object.freeze({ ...source }),
      meta: freezeMeta(meta),
      client,
    })
    this.providers.set(client.name, registered)
    let disposed = false
    return {
      dispose: async () => {
        if (disposed) return
        disposed = true
        if (this.providers.get(client.name) === registered) this.providers.delete(client.name)
        await client.dispose()
      },
    }
  }
  get(name: string) {
    return this.providers.get(name)?.client
  }
  describe(name: string) {
    return this.providers.get(name)
  }
  list() {
    return Object.freeze([...this.providers.values()])
  }
}

export interface ContextConfig {
  compactionThreshold?: number
  targetRatio?: number
  reservedOutputTokens?: number
  keepRecent?: number
  maxTokens?: number
}
export interface ContextSessionSnapshot {
  messages: readonly Message[]
  activeTurn?: string | null
  turns?: readonly { id: string; status: string; startMessageId?: string; endMessageId?: string }[]
}
export interface ContextCtx {
  readonly session: ContextSessionSnapshot
  readonly capabilities: ProviderCapabilities
  readonly turnId: string
  readonly model: string
  readonly systemTokens?: number
  readonly toolSchemaTokens?: number
}
export interface ContextMessages {
  messages: readonly Message[]
  removedMessageIds: string[]
  estimatedTokens: number
  hasSummary: boolean
}
export interface ContextSnapshot {
  messages: readonly Message[]
  compactedMessageIds: string[]
  beforeTokens: number
  afterTokens: number
  strategy: string
  hookIntercepted: boolean
}
export interface ContextPolicy {
  readonly name: string
  shouldCompact(context: ContextCtx): boolean
  buildPrompt(context: ContextCtx): ContextMessages
  compact(context: ContextCtx): Promise<ContextSnapshot>
  estimateTokens(text: string, model: string): number
  init?(config: ContextConfig): Promise<void>
  dispose?(): Promise<void>
}
export interface ContextPolicySpec {
  readonly name: string
  readonly policy: ContextPolicy
  readonly priority: number
  readonly when?: (context: ContextCtx) => boolean
}
export interface ContextPolicyRegistration {
  dispose(): void
}
export interface ContextPolicyContributor {
  contributePolicy(spec: ContextPolicySpec): ContextPolicyRegistration
}
