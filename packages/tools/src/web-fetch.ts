import { lookup } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'

import type { Tool, ToolContext, ToolResult } from '@volund/tool-kit'

export interface WebFetchInput {
  url: string
}

export interface WebFetchOptions {
  resolver?: (hostname: string, signal: AbortSignal) => Promise<string[]>
  transport?: (request: WebTransportRequest) => Promise<WebTransportResponse>
  now?: () => number
  timeoutMs?: number
  maxBytes?: number
  maxCharacters?: number
  maxRedirects?: number
  requestsPerMinute?: number
}

export interface WebTransportRequest {
  url: URL
  address: string
  signal: AbortSignal
}

export interface WebTransportResponse {
  status: number
  headers: Record<string, string | undefined>
  body: AsyncIterable<Uint8Array>
}

const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['url'],
  properties: { url: { type: 'string', minLength: 1 } },
} as never

const METADATA_HOSTS = new Set([
  'metadata',
  'metadata.google.internal',
  'instance-data',
  'instance-data.ec2.internal',
])

function parseUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('WebFetch requires a valid absolute URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new Error('WebFetch only permits http: and https: URLs')
  if (url.username || url.password) throw new Error('WebFetch forbids URL credentials')
  url.hash = ''
  return url
}

export function canonicalWebOrigin(value: string): string {
  const url = parseUrl(value)
  return url.origin
}

function ipv4Number(value: string): number | undefined {
  if (isIP(value) !== 4) return
  return value.split('.').reduce((out, octet) => out * 256 + Number(octet), 0) >>> 0
}

function inV4Range(value: number, base: string, bits: number): boolean {
  const start = ipv4Number(base)!
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  return (value & mask) === (start & mask)
}

function normalizedIpv6(value: string): string {
  return value.toLowerCase().split('%')[0]!
}

/** Reject every non-public address before a socket is created. */
export function isForbiddenAddress(address: string): boolean {
  const version = isIP(address)
  if (version === 4) {
    const value = ipv4Number(address)!
    return [
      ['0.0.0.0', 8],
      ['10.0.0.0', 8],
      ['100.64.0.0', 10],
      ['127.0.0.0', 8],
      ['169.254.0.0', 16],
      ['172.16.0.0', 12],
      ['192.0.0.0', 24],
      ['192.0.2.0', 24],
      ['192.168.0.0', 16],
      ['198.18.0.0', 15],
      ['198.51.100.0', 24],
      ['203.0.113.0', 24],
      ['224.0.0.0', 4],
      ['240.0.0.0', 4],
    ].some(([base, bits]) => inV4Range(value, base as string, bits as number))
  }
  if (version !== 6) return true
  const value = normalizedIpv6(address)
  if (value.startsWith('::ffff:')) {
    const mapped = value.slice(7)
    return isIP(mapped) === 4 ? isForbiddenAddress(mapped) : true
  }
  return (
    value === '::' ||
    value === '::1' ||
    value.startsWith('fc') ||
    value.startsWith('fd') ||
    /^fe[89ab]/.test(value) ||
    value.startsWith('ff') ||
    value.startsWith('2001:db8:')
  )
}

async function defaultResolver(hostname: string): Promise<string[]> {
  if (isIP(hostname)) return [hostname]
  return (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address)
}

function defaultTransport(input: WebTransportRequest): Promise<WebTransportResponse> {
  return new Promise((resolve, reject) => {
    const run = input.url.protocol === 'https:' ? httpsRequest : httpRequest
    const request = run(
      input.url,
      {
        method: 'GET',
        signal: input.signal,
        headers: { accept: 'text/*, application/json, application/xml, application/xhtml+xml' },
        lookup: (_hostname, _options, callback) =>
          callback(null, input.address, isIP(input.address) as 4 | 6),
      },
      (response) => {
        const headers: Record<string, string | undefined> = {}
        for (const [key, value] of Object.entries(response.headers))
          headers[key] = Array.isArray(value) ? value.join(', ') : value
        resolve({ status: response.statusCode ?? 0, headers, body: response })
      },
    )
    request.once('error', reject)
    request.end()
  })
}

function safeAuditUrl(url: URL): string {
  return `${url.protocol}//${url.host}${url.pathname}`
}

function safeAuditValue(value: string): string {
  try {
    return safeAuditUrl(parseUrl(value))
  } catch {
    return '[invalid-url]'
  }
}

function allowedContentType(value: string | undefined): boolean {
  if (!value) return false
  const type = value.split(';', 1)[0]!.trim().toLowerCase()
  return (
    type.startsWith('text/') ||
    type === 'application/json' ||
    type.endsWith('+json') ||
    type === 'application/xml' ||
    type.endsWith('+xml') ||
    type === 'application/xhtml+xml'
  )
}

async function discardBody(body: AsyncIterable<Uint8Array>): Promise<void> {
  const iterator = body[Symbol.asyncIterator]()
  await iterator.return?.()
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason)
    signal.addEventListener('abort', aborted, { once: true })
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted))
  })
}

function failure(error: unknown, started: number): ToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
    meta: { durationMs: Date.now() - started },
  }
}

export class WebFetchTool implements Tool<WebFetchInput> {
  readonly name = 'WebFetch'
  readonly description = 'Fetch public HTTP(S) text after domain permission and SSRF checks'
  readonly readonly = true
  readonly parallelSafe = true
  readonly timeoutMs: number
  readonly inputSchema = schema
  readonly #resolver: NonNullable<WebFetchOptions['resolver']>
  readonly #transport: NonNullable<WebFetchOptions['transport']>
  readonly #now: () => number
  readonly #maxBytes: number
  readonly #maxCharacters: number
  readonly #maxRedirects: number
  readonly #requestsPerMinute: number
  readonly #requests = new Map<string, number[]>()

  constructor(options: WebFetchOptions = {}) {
    this.#resolver = options.resolver ?? defaultResolver
    this.#transport = options.transport ?? defaultTransport
    this.#now = options.now ?? Date.now
    this.timeoutMs = options.timeoutMs ?? 15_000
    this.#maxBytes = options.maxBytes ?? 1_048_576
    this.#maxCharacters = options.maxCharacters ?? 87_500
    this.#maxRedirects = options.maxRedirects ?? 5
    this.#requestsPerMinute = options.requestsPerMinute ?? 10
  }

  permissionSpec(input: WebFetchInput) {
    return { net: { url: canonicalWebOrigin(input.url), method: 'GET' as const } }
  }

  async invoke(input: WebFetchInput, context: ToolContext): Promise<ToolResult> {
    const started = Date.now()
    const timeout = AbortSignal.timeout(this.timeoutMs)
    const signal = AbortSignal.any([context.abortSignal, timeout])
    try {
      let url = parseUrl(input.url)
      const permittedOrigin = url.origin
      this.#rateLimit(url.hostname)
      for (let redirect = 0; ; redirect++) {
        signal.throwIfAborted()
        this.#validateHostname(url.hostname)
        const addresses = await abortable(this.#resolver(url.hostname, signal), signal)
        signal.throwIfAborted()
        if (addresses.length === 0 || addresses.some(isForbiddenAddress))
          throw new Error('WebFetch blocked a private, reserved, or unresolved address')
        const response = await abortable(
          this.#transport({ url, address: addresses[0]!, signal }),
          signal,
        )
        context.logger.info('webfetch.response', {
          url: safeAuditUrl(url),
          status: response.status,
        })
        if (response.status >= 300 && response.status < 400) {
          await discardBody(response.body)
          const location = response.headers.location
          if (!location) throw new Error('WebFetch redirect omitted Location')
          if (redirect >= this.#maxRedirects) throw new Error('WebFetch redirect limit exceeded')
          url = parseUrl(new URL(location, url).href)
          if (url.origin !== permittedOrigin)
            throw new Error('WebFetch blocked a redirect outside the permitted origin')
          this.#rateLimit(url.hostname)
          continue
        }
        if (response.status < 200 || response.status >= 300)
          throw new Error(`WebFetch received HTTP ${response.status}`)
        if (!allowedContentType(response.headers['content-type']))
          throw new Error('WebFetch rejected a non-text content type')
        const encoding = response.headers['content-encoding']?.toLowerCase()
        if (encoding && encoding !== 'identity')
          throw new Error('WebFetch rejected an encoded response')
        const declared = Number(response.headers['content-length'])
        if (Number.isFinite(declared) && declared > this.#maxBytes)
          throw new Error('WebFetch response exceeds the byte limit')
        const chunks: Uint8Array[] = []
        let bytes = 0
        const iterator = response.body[Symbol.asyncIterator]()
        let completed = false
        try {
          for (;;) {
            const next = await abortable(iterator.next(), signal)
            if (next.done) {
              completed = true
              break
            }
            const chunk = next.value
            signal.throwIfAborted()
            bytes += chunk.byteLength
            if (bytes > this.#maxBytes) throw new Error('WebFetch response exceeds the byte limit')
            chunks.push(chunk)
          }
        } finally {
          if (!completed) await iterator.return?.()
        }
        let text = Buffer.concat(chunks).toString('utf8')
        let truncated = false
        if (text.length > this.#maxCharacters) {
          text = `${text.slice(0, this.#maxCharacters)}\n[... WebFetch output truncated ...]`
          truncated = true
        }
        return {
          content: [{ type: 'text', text }],
          meta: { durationMs: Date.now() - started, bytesRead: bytes, costImpact: 'moderate' },
          ...(truncated ? { isError: false } : {}),
        }
      }
    } catch (error) {
      const reason = signal.aborted ? 'WebFetch cancelled or timed out' : error
      context.logger.warn('webfetch.failed', { url: safeAuditValue(input.url) })
      return failure(reason, started)
    }
  }

  #validateHostname(hostname: string): void {
    const normalized = hostname.toLowerCase().replace(/\.$/, '')
    if (
      normalized === 'localhost' ||
      normalized.endsWith('.localhost') ||
      normalized.endsWith('.local') ||
      METADATA_HOSTS.has(normalized)
    )
      throw new Error('WebFetch blocked a local or metadata hostname')
  }

  #rateLimit(hostname: string): void {
    const now = this.#now()
    const recent = (this.#requests.get(hostname) ?? []).filter((value) => now - value < 60_000)
    if (recent.length >= this.#requestsPerMinute) throw new Error('WebFetch rate limit exceeded')
    recent.push(now)
    this.#requests.set(hostname, recent)
  }
}
