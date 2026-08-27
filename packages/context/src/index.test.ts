import type { EmbeddingProvider, Message, ProviderCapabilities } from '@volund/provider-kit'
import { describe, expect, it } from 'vitest'

import {
  SEMANTIC_INDEX_SCHEMA_VERSION,
  SemanticPolicy,
  SlidingWindowPolicy,
  SummaryPolicy,
  pruneSemanticIndexDocument,
  validateSemanticIndexDocument,
} from './index'
const msg = (id: string, role: Message['role'], text: string): Message => ({
  id,
  role,
  content: [{ type: 'text', text }],
  createdAt: 0,
})

describe('SummaryPolicy', () => {
  const messages = Array.from({ length: 110 }, (_, index) =>
    msg(`m${index}`, index % 2 ? 'assistant' : 'user', `turn ${index} ${'x'.repeat(30)}`),
  )
  const context = { session: { messages }, capabilities: caps, turnId: 'turn-110', model: 'main' }
  it('summarizes a 100+ message session and re-wraps the result as untrusted', async () => {
    const events: string[] = []
    const policy = new SummaryPolicy(
      { keepRecent: 10, reservedOutputTokens: 1, targetRatio: 0.5 },
      {
        provider: {
          name: 'cheap',
          capabilities: caps,
          stream: async function* () {},
          dispose: async () => {},
          complete: async () => ({
            message: msg('summary', 'assistant', 'decisions and unresolved work'),
            usage: { input: 10, output: 5 },
          }),
        },
        telemetry: (event) => {
          events.push(event.name)
        },
        now: () => new Date('2026-08-02T00:00:00Z'),
      },
    )
    const snapshot = await policy.compact(context)
    expect(snapshot.strategy).toBe('summary')
    expect(snapshot.compactedMessageIds.length).toBeGreaterThan(90)
    expect(snapshot.messages[0]?.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('<untrusted source="summary">'),
    })
    expect(events).toEqual(['context.summary_requested'])
  })
  it.each([
    new Error('network'),
    Object.assign(new Error('rate limited'), { status: 429 }),
    'arbitrary',
  ])('falls back to sliding for %s', async (failure) => {
    const events: string[] = []
    const policy = new SummaryPolicy(
      { keepRecent: 10, reservedOutputTokens: 1 },
      {
        provider: {
          name: 'cheap',
          capabilities: caps,
          stream: async function* () {},
          dispose: async () => {},
          complete: async () => {
            throw failure
          },
        },
        telemetry: (event) => {
          events.push(event.name)
        },
      },
    )
    const snapshot = await policy.compact(context)
    expect(snapshot.strategy).toBe('sliding')
    expect(events).toEqual(['context.summary_requested', 'context.summary_failed'])
  })
})
const caps = { maxContextTokens: 100, maxOutputTokens: 10 } as ProviderCapabilities
describe('SlidingWindowPolicy', () => {
  it('includes model in token cache key and reserves budget', () => {
    let calls = 0
    const p = new SlidingWindowPolicy(
      { reservedOutputTokens: 10 },
      {
        countTokens: (_t, m) => {
          calls++
          return m === 'a' ? 1 : 2
        },
      },
    )
    expect(p.estimateTokens('x', 'a')).toBe(1)
    expect(p.estimateTokens('x', 'b')).toBe(2)
    expect(calls).toBe(2)
  })
  it('keeps tool pairs and turn boundaries', async () => {
    const messages: Message[] = [
      msg('u0', 'user', 'x'.repeat(200)),
      {
        id: 'a0',
        role: 'assistant',
        createdAt: 0,
        content: [{ type: 'tool_use', id: 't', name: 'Read', input: {} }],
      },
      {
        id: 'r0',
        role: 'user',
        createdAt: 0,
        content: [{ type: 'tool_result', toolUseId: 't', content: [{ type: 'text', text: 'ok' }] }],
      },
      msg('a1', 'assistant', 'done'),
    ]
    const p = new SlidingWindowPolicy({ keepRecent: 1, reservedOutputTokens: 1, targetRatio: 0.5 })
    const snap = await p.compact({
      session: { messages },
      capabilities: caps,
      turnId: 't',
      model: 'm',
    })
    const ids = new Set(snap.messages.map((m) => m.id))
    expect(ids.has('a0')).toBe(ids.has('r0'))
  })
  it('respects preCompact veto', async () => {
    const messages = [msg('u', 'user', 'x'.repeat(1000))]
    const p = new SlidingWindowPolicy({}, undefined, { preCompact: () => false })
    expect(
      (await p.compact({ session: { messages }, capabilities: caps, turnId: 't', model: 'm' }))
        .hookIntercepted,
    ).toBe(true)
  })
  it('always preserves messages pinned to context', async () => {
    const pinned = { ...msg('pinned', 'user', 'x'.repeat(1000)), meta: { pinnedToContext: true } }
    const p = new SlidingWindowPolicy({ keepRecent: 1, reservedOutputTokens: 1 })
    const snapshot = await p.compact({
      session: { messages: [pinned, msg('latest', 'user', 'now')] },
      capabilities: caps,
      turnId: 't',
      model: 'm',
    })
    expect(snapshot.messages.map((message) => message.id)).toContain('pinned')
  })
})

const localEmbeddings = (): EmbeddingProvider => ({
  name: 'fixture-local',
  scope: 'local',
  model: 'fixture-bow-v1',
  dimensions: 4,
  embed: async (request) => ({
    embeddings: request.input.map((text) => [
      /\bauth|oauth|login\b/i.test(text) ? 1 : 0,
      /\bvector|embedding|semantic|recall\b/i.test(text) ? 1 : 0,
      /\bbilling|invoice|cost\b/i.test(text) ? 1 : 0,
      1,
    ]),
  }),
})

describe('SemanticPolicy', () => {
  const semanticMessages = [
    msg('m0', 'user', 'billing invoice export keeps cost evidence'),
    msg('m1', 'assistant', 'oauth login regression notes'),
    msg('m2', 'user', 'semantic embedding vector recall fixture'),
    msg('m3', 'user', 'please recall embedding evidence'),
  ]
  const semanticContext = {
    session: { messages: semanticMessages },
    capabilities: caps,
    turnId: 'turn-semantic',
    model: 'main',
  }

  it('fails closed to non-semantic fallback when no local embedding is configured', async () => {
    const policy = new SemanticPolicy({ keepRecent: 1, topK: 3 })
    const snapshot = await policy.compact(semanticContext)
    expect(snapshot.strategy).toBe('semantic-fallback')
    expect(snapshot.messages.map((message) => message.id)).toEqual(['m3'])
    expect(policy.getIndex()).toBeUndefined()
  })

  it('writes and validates a versioned local semantic index schema', async () => {
    const policy = new SemanticPolicy({ topK: 2 }, { embedding: localEmbeddings() })
    await policy.refreshIndex(semanticContext)
    const index = policy.getIndex()
    expect(index).toMatchObject({
      schemaVersion: SEMANTIC_INDEX_SCHEMA_VERSION,
      embedding: {
        provider: 'fixture-local',
        model: 'fixture-bow-v1',
        dimensions: 4,
        scope: 'local',
      },
    })
    expect(validateSemanticIndexDocument(index).ok).toBe(true)
    expect(validateSemanticIndexDocument({ ...index, schemaVersion: 'future' }).ok).toBe(false)
    expect(pruneSemanticIndexDocument(index!, new Set(['m2', 'm3'])).records).toHaveLength(2)
  })

  it('recalls deterministic golden semantic matches without a model callout', async () => {
    const policy = new SemanticPolicy(
      { keepRecent: 1, minScore: 0.6, topK: 2 },
      { embedding: localEmbeddings() },
    )
    const hits = await policy.recall(semanticContext)
    expect(hits.map((hit) => hit.message.id)).toEqual(['m2', 'm3'])
    const snapshot = await policy.compact(semanticContext)
    expect(snapshot.strategy).toBe('semantic')
    expect(snapshot.messages.map((message) => message.id)).toEqual(['m2', 'm3'])
  })

  it.each(['denied', 'pending'] as const)(
    'denies cloud embeddings when authorization is %s',
    async (cloudAuthorization) => {
      let calls = 0
      const cloud: EmbeddingProvider = {
        ...localEmbeddings(),
        name: 'cloud-fixture',
        scope: 'cloud',
        embed: async (request, signal) => {
          calls++
          return localEmbeddings().embed(request, signal)
        },
      }
      const policy = new SemanticPolicy(
        { keepRecent: 1 },
        { allowCloudEmbeddings: true, cloudAuthorization, embedding: cloud },
      )
      const snapshot = await policy.compact(semanticContext)
      expect(snapshot.strategy).toBe('semantic-fallback')
      expect(calls).toBe(0)
    },
  )
})
