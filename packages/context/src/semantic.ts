import { createHash } from 'node:crypto'

import type {
  ContextConfig,
  ContextCtx,
  ContextMessages,
  ContextPolicy,
  ContextSnapshot,
  EmbeddingAuthorizationStatus,
  EmbeddingProvider,
  Message,
} from '@volund/provider-kit'

export const SEMANTIC_INDEX_SCHEMA_VERSION = 'volund.semantic-index.v1'

export interface SemanticIndexEmbeddingMeta {
  readonly provider: string
  readonly model: string
  readonly dimensions: number
  readonly scope: 'cloud' | 'local'
}
export interface SemanticIndexRecord {
  readonly messageId: string
  readonly role: Message['role']
  readonly turnId?: string
  readonly textHash: string
  readonly embedding: readonly number[]
  readonly createdAt: number
}
export interface SemanticIndexDocument {
  readonly schemaVersion: typeof SEMANTIC_INDEX_SCHEMA_VERSION
  readonly embedding: SemanticIndexEmbeddingMeta
  readonly records: readonly SemanticIndexRecord[]
}
export interface SemanticPolicyConfig extends ContextConfig {
  readonly topK?: number
  readonly keepRecent?: number
  readonly minScore?: number
}
export interface SemanticPolicyOptions {
  readonly embedding?: EmbeddingProvider
  readonly index?: SemanticIndexDocument
  readonly fallback?: ContextPolicy
  readonly allowCloudEmbeddings?: boolean
  readonly cloudAuthorization?: EmbeddingAuthorizationStatus
}
export interface SemanticRecallHit {
  readonly message: Message
  readonly score: number
}

class NonSemanticFallbackPolicy implements ContextPolicy {
  readonly name = 'semantic-fallback'
  constructor(readonly config: SemanticPolicyConfig) {}
  estimateTokens(text: string, _model: string): number {
    return Math.ceil(text.length / 3.5)
  }
  shouldCompact(): boolean {
    return false
  }
  buildPrompt(ctx: ContextCtx): ContextMessages {
    const keepRecent = this.config.keepRecent ?? 20,
      messages = ctx.session.messages.slice(-keepRecent),
      ids = new Set(messages.map((message) => message.id))
    return {
      messages,
      removedMessageIds: ctx.session.messages
        .filter((message) => !ids.has(message.id))
        .map((message) => message.id),
      estimatedTokens:
        messages.reduce(
          (sum, message) => sum + this.estimateTokens(textOf(message), ctx.model),
          0,
        ) +
        (ctx.systemTokens ?? 0) +
        (ctx.toolSchemaTokens ?? 0),
      hasSummary: messages.some((message) => Boolean(message.meta?.compacted)),
    }
  }
  async compact(ctx: ContextCtx): Promise<ContextSnapshot> {
    const prompt = this.buildPrompt(ctx)
    return {
      messages: prompt.messages,
      compactedMessageIds: prompt.removedMessageIds,
      beforeTokens: this.total(ctx.session.messages, ctx.model),
      afterTokens: this.total(prompt.messages, ctx.model),
      strategy: this.name,
      hookIntercepted: false,
    }
  }
  private total(messages: readonly Message[], model: string): number {
    return messages.reduce(
      (sum, message) => sum + this.estimateTokens(textOf(message), model) + 4,
      0,
    )
  }
}

const textOf = (message: Message): string =>
  message.content
    .map((part): string =>
      part.type === 'text' || part.type === 'thinking'
        ? part.text
        : part.type === 'tool_use'
          ? JSON.stringify(part.input)
          : part.type === 'tool_result'
            ? part.content
                .map((content) =>
                  content.type === 'text' || content.type === 'thinking' ? content.text : '',
                )
                .join('')
            : '',
    )
    .join('\n')

const sha256 = (text: string): string => createHash('sha256').update(text).digest('base64url')
const dot = (a: readonly number[], b: readonly number[]): number =>
  a.reduce((sum, value, index) => sum + value * (b[index] ?? 0), 0)
const magnitude = (vector: readonly number[]): number =>
  Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))
const cosine = (a: readonly number[], b: readonly number[]): number => {
  const divisor = magnitude(a) * magnitude(b)
  return divisor === 0 ? 0 : dot(a, b) / divisor
}

export const validateSemanticIndexDocument = (
  document: unknown,
): { ok: true; value: SemanticIndexDocument } | { ok: false; errors: string[] } => {
  const errors: string[] = []
  if (!document || typeof document !== 'object') return { ok: false, errors: ['document_object'] }
  const value = document as SemanticIndexDocument
  if (value.schemaVersion !== SEMANTIC_INDEX_SCHEMA_VERSION) errors.push('schemaVersion')
  if (!value.embedding || typeof value.embedding !== 'object') errors.push('embedding')
  if (!Array.isArray(value.records)) errors.push('records')
  const dimensions = value.embedding?.dimensions
  if (!Number.isInteger(dimensions) || dimensions <= 0) errors.push('embedding.dimensions')
  if (value.embedding?.scope !== 'local' && value.embedding?.scope !== 'cloud')
    errors.push('embedding.scope')
  for (const [index, record] of (value.records ?? []).entries()) {
    if (!record.messageId) errors.push(`records.${index}.messageId`)
    if (!['assistant', 'system', 'user'].includes(record.role)) errors.push(`records.${index}.role`)
    if (!record.textHash) errors.push(`records.${index}.textHash`)
    if (!Array.isArray(record.embedding) || record.embedding.length !== dimensions)
      errors.push(`records.${index}.embedding`)
  }
  return errors.length ? { ok: false, errors } : { ok: true, value }
}

export const pruneSemanticIndexDocument = (
  document: SemanticIndexDocument,
  messageIds: ReadonlySet<string>,
): SemanticIndexDocument => ({
  ...document,
  records: document.records.filter((record) => messageIds.has(record.messageId)),
})

export class SemanticPolicy implements ContextPolicy {
  readonly name = 'semantic'
  readonly #config: Required<Pick<SemanticPolicyConfig, 'keepRecent' | 'minScore' | 'topK'>> &
    ContextConfig
  readonly #options: SemanticPolicyOptions
  #index?: SemanticIndexDocument

  constructor(config: SemanticPolicyConfig = {}, options: SemanticPolicyOptions = {}) {
    this.#config = { keepRecent: 20, minScore: 0, topK: 10, ...config }
    this.#options = options
    if (options.index) {
      const result = validateSemanticIndexDocument(options.index)
      if (!result.ok) throw new Error(`semantic_index_invalid: ${result.errors.join(',')}`)
      this.#index = result.value
    }
  }
  estimateTokens(text: string, model: string): number {
    return this.fallback().estimateTokens(text, model)
  }
  shouldCompact(ctx: ContextCtx): boolean {
    return this.fallback().shouldCompact(ctx)
  }
  buildPrompt(ctx: ContextCtx): ContextMessages {
    if (!this.#index) return this.fallback().buildPrompt(ctx)
    const selected = this.selectWithIndex(ctx, this.queryEmbeddingFromIndex(ctx))
    if (!selected) return this.fallback().buildPrompt(ctx)
    return this.toContextMessages(ctx, selected)
  }
  async compact(ctx: ContextCtx): Promise<ContextSnapshot> {
    try {
      await this.refreshIndex(ctx)
      const query = await this.embedQuery(ctx)
      const selected = this.selectWithIndex(ctx, query)
      if (!selected) return this.fallback().compact(ctx)
      const ids = new Set(selected.map((message) => message.id))
      return {
        messages: selected,
        compactedMessageIds: ctx.session.messages
          .filter((message) => !ids.has(message.id))
          .map((message) => message.id),
        beforeTokens: this.totalTokens(ctx.session.messages, ctx.model),
        afterTokens: this.totalTokens(selected, ctx.model),
        strategy: this.name,
        hookIntercepted: false,
      }
    } catch {
      return this.fallback().compact(ctx)
    }
  }
  async refreshIndex(ctx: ContextCtx): Promise<void> {
    const provider = this.authorizedEmbeddingProvider()
    const texts = ctx.session.messages.map(textOf)
    const signal = new AbortController().signal
    const response = await provider.embed(
      { model: provider.model, input: texts, purpose: 'semantic-recall' },
      signal,
    )
    if (response.embeddings.length !== ctx.session.messages.length)
      throw new Error('semantic_embedding_count_mismatch')
    this.#index = {
      schemaVersion: SEMANTIC_INDEX_SCHEMA_VERSION,
      embedding: {
        provider: provider.name,
        model: provider.model,
        dimensions: provider.dimensions,
        scope: provider.scope,
      },
      records: ctx.session.messages.map((message, index) => {
        const record: SemanticIndexRecord = {
          messageId: message.id,
          role: message.role,
          textHash: sha256(texts[index] ?? ''),
          embedding: response.embeddings[index]!,
          createdAt: message.createdAt,
        }
        if (message.meta?.turnId) return { ...record, turnId: message.meta.turnId }
        return record
      }),
    }
  }
  getIndex(): SemanticIndexDocument | undefined {
    return this.#index
  }
  async recall(ctx: ContextCtx): Promise<SemanticRecallHit[]> {
    await this.refreshIndex(ctx)
    const query = await this.embedQuery(ctx)
    const records = new Map(this.#index?.records.map((record) => [record.messageId, record]))
    return ctx.session.messages
      .map((message) => ({
        message,
        score: cosine(query, records.get(message.id)?.embedding ?? []),
      }))
      .filter((hit) => hit.score >= this.#config.minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, this.#config.topK)
  }
  private async embedQuery(
    ctx: ContextCtx,
    signal = new AbortController().signal,
  ): Promise<readonly number[]> {
    const provider = this.authorizedEmbeddingProvider(),
      query = this.queryText(ctx),
      response = await provider.embed(
        { model: provider.model, input: [query], purpose: 'semantic-recall' },
        signal,
      )
    return response.embeddings[0] ?? []
  }
  private queryEmbeddingFromIndex(ctx: ContextCtx): readonly number[] {
    const latest = this.latestUser(ctx),
      record = this.#index?.records.find((candidate) => candidate.messageId === latest?.id)
    return record?.embedding ?? []
  }
  private selectWithIndex(ctx: ContextCtx, query: readonly number[]): Message[] | undefined {
    if (!this.#index || query.length === 0) return undefined
    const records = new Map(this.#index.records.map((record) => [record.messageId, record]))
    const recent = new Set(ctx.session.messages.slice(-this.#config.keepRecent).map((m) => m.id))
    const semantic = ctx.session.messages
      .map((message) => ({
        message,
        score: cosine(query, records.get(message.id)?.embedding ?? []),
      }))
      .filter((hit) => hit.score >= this.#config.minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, this.#config.topK)
    const selected = new Set([...semantic.map((hit) => hit.message.id), ...recent])
    for (const message of ctx.session.messages)
      if (message.meta?.pinnedToContext) selected.add(message.id)
    return ctx.session.messages.filter((message) => selected.has(message.id))
  }
  private toContextMessages(ctx: ContextCtx, messages: readonly Message[]): ContextMessages {
    const ids = new Set(messages.map((message) => message.id))
    return {
      messages,
      removedMessageIds: ctx.session.messages
        .filter((message) => !ids.has(message.id))
        .map((m) => m.id),
      estimatedTokens:
        this.totalTokens(messages, ctx.model) +
        (ctx.systemTokens ?? 0) +
        (ctx.toolSchemaTokens ?? 0),
      hasSummary: messages.some((message) => Boolean(message.meta?.compacted)),
    }
  }
  private latestUser(ctx: ContextCtx): Message | undefined {
    return [...ctx.session.messages].reverse().find((message) => message.role === 'user')
  }
  private queryText(ctx: ContextCtx): string {
    return this.latestUser(ctx) ? textOf(this.latestUser(ctx)!) : ''
  }
  private totalTokens(messages: readonly Message[], model: string): number {
    return messages.reduce(
      (sum, message) => sum + this.estimateTokens(textOf(message), model) + 4,
      0,
    )
  }
  private fallback(): ContextPolicy {
    return this.#options.fallback ?? new NonSemanticFallbackPolicy(this.#config)
  }
  private authorizedEmbeddingProvider(): EmbeddingProvider {
    const provider = this.#options.embedding
    if (!provider) throw new Error('semantic_embedding_unconfigured')
    if (
      provider.scope === 'cloud' &&
      (!this.#options.allowCloudEmbeddings || this.#options.cloudAuthorization !== 'granted')
    )
      throw new Error(`semantic_cloud_embedding_${this.#options.cloudAuthorization ?? 'denied'}`)
    return provider
  }
}
