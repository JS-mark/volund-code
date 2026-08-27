import { createHash } from 'node:crypto'

import { sanitize } from '@volund/shared'
import type { Tool, ToolContext, ToolResult } from '@volund/tool-kit'

export interface WebSearchInput {
  query: string
  maxResults?: number
}

export interface WebSearchProviderResult {
  title: string
  url: string
  snippet: string
  publishedAt?: string
}

export interface WebSearchProvider {
  readonly id: string
  search(
    request: { query: string; limit: number },
    context: { signal: AbortSignal },
  ): Promise<readonly WebSearchProviderResult[]>
}

export class WebSearchProviderError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'WebSearchProviderError'
  }
}

export type MockWebSearchResponse =
  | readonly WebSearchProviderResult[]
  | { error: Error; retryable?: boolean }

/** Deterministic offline provider for contract tests; it performs no I/O. */
export class MockWebSearchProvider implements WebSearchProvider {
  readonly calls: Array<{ query: string; limit: number }> = []
  #responses: MockWebSearchResponse[]
  constructor(
    readonly id: string,
    responses: MockWebSearchResponse[],
  ) {
    this.#responses = [...responses]
  }
  async search(request: { query: string; limit: number }, context: { signal: AbortSignal }) {
    context.signal.throwIfAborted()
    this.calls.push(request)
    const response = this.#responses.shift()
    if (!response) throw new WebSearchProviderError('Mock response queue exhausted')
    if ('error' in response)
      throw new WebSearchProviderError(response.error.message, response.retryable, {
        cause: response.error,
      })
    return response
  }
}

const SECRET = /\b((?:api[_-]?key|token|secret|password|oauth[_-]?code)\s*[=:]\s*)[^\s&,;]+/gi
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi

export function redactSearchQuery(query: string): string {
  return sanitize(query).replace(SECRET, '$1[REDACTED]').replace(EMAIL, '[EMAIL]')
}

function queryFingerprint(query: string): string {
  return createHash('sha256').update(query).digest('hex').slice(0, 12)
}

function escapeUntrusted(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function fail(error: unknown, started: number): ToolResult {
  const message = error instanceof Error ? error.message : String(error)
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
    meta: { durationMs: Date.now() - started },
  }
}

export interface WebSearchOptions {
  maxResults?: number
  maxQueryCharacters?: number
  maxSnippetCharacters?: number
  maxTotalCharacters?: number
  maxRetries?: number
}

export class WebSearchTool implements Tool<WebSearchInput> {
  readonly name = 'WebSearch'
  readonly description = 'Search through a configured provider; returned content is untrusted'
  readonly readonly = true
  readonly parallelSafe = true
  readonly timeoutMs = 30_000
  readonly inputSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      query: { type: 'string', minLength: 1, maxLength: 2_000 },
      maxResults: { type: 'integer', minimum: 1, maximum: 10 },
    },
    required: ['query'],
  } as never
  readonly #limits: Required<WebSearchOptions>
  constructor(
    readonly provider?: WebSearchProvider,
    options: WebSearchOptions = {},
  ) {
    this.#limits = {
      maxResults: options.maxResults ?? 5,
      maxQueryCharacters: options.maxQueryCharacters ?? 2_000,
      maxSnippetCharacters: options.maxSnippetCharacters ?? 2_000,
      maxTotalCharacters: options.maxTotalCharacters ?? 10_000,
      maxRetries: options.maxRetries ?? 1,
    }
  }
  permissionSpec(input: WebSearchInput) {
    return {
      custom: {
        webSearch: {
          provider: this.provider?.id ?? 'unconfigured',
          query: redactSearchQuery(input.query),
          queryFingerprint: queryFingerprint(input.query),
        },
      },
    }
  }
  async invoke(input: WebSearchInput, context: ToolContext): Promise<ToolResult> {
    const started = Date.now()
    try {
      context.abortSignal.throwIfAborted()
      if (!this.provider) throw new Error('WebSearch is unavailable: no provider configured')
      if (!input.query.trim()) throw new Error('WebSearch query must not be empty')
      if (input.query.length > this.#limits.maxQueryCharacters)
        throw new Error(`WebSearch query exceeds ${this.#limits.maxQueryCharacters} characters`)
      const limit = Math.max(
        1,
        Math.min(
          Math.floor(input.maxResults ?? this.#limits.maxResults),
          this.#limits.maxResults,
          10,
        ),
      )
      let results: readonly WebSearchProviderResult[] | undefined
      for (let attempt = 0; attempt <= this.#limits.maxRetries; attempt++) {
        try {
          results = await this.provider.search(
            { query: input.query, limit },
            { signal: context.abortSignal },
          )
          break
        } catch (error) {
          context.abortSignal.throwIfAborted()
          if (
            !(error instanceof WebSearchProviderError) ||
            !error.retryable ||
            attempt === this.#limits.maxRetries
          )
            throw new Error('WebSearch provider failed', { cause: error })
        }
      }
      const normalized = (results ?? []).slice(0, limit).map((item) => {
        const normalizedItem: WebSearchProviderResult = {
          title: item.title.slice(0, 500),
          url: item.url,
          snippet: item.snippet.slice(0, this.#limits.maxSnippetCharacters),
        }
        if (item.publishedAt) normalizedItem.publishedAt = item.publishedAt
        return normalizedItem
      })
      const body = JSON.stringify(normalized).slice(0, this.#limits.maxTotalCharacters)
      context.logger.info('web search completed', {
        provider: this.provider.id,
        queryFingerprint: queryFingerprint(input.query),
        resultCount: normalized.length,
      })
      return {
        content: [
          {
            type: 'text',
            text: `<untrusted source="web-search:${escapeUntrusted(this.provider.id)}">\n${escapeUntrusted(body)}\n</untrusted>`,
          },
        ],
        meta: { durationMs: Date.now() - started, bytesRead: Buffer.byteLength(body) },
      }
    } catch (error) {
      context.logger.warn('web search failed', {
        provider: this.provider?.id ?? 'unconfigured',
        errorType: error instanceof Error ? error.name : 'unknown',
      })
      return fail(error, started)
    }
  }
}
