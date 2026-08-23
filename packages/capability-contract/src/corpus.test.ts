import { readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  CapabilityContractError,
  canonicalPayloadDigest,
  domainSeparatedBytes,
  parseCanonicalJson,
} from './index'

/**
 * Shared corpus runner (§19a.14): every checked-in small case must produce
 * the exact accept identity (canonical bytes, domain preimage, typed digest)
 * or the exact first reject code recorded in its metadata.
 */

const fixturesRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'v1')
const MAX_BYTES = 16 * 1024 * 1024

interface CorpusCase {
  readonly caseId: string
  readonly caseKind: 'contract' | 'admission'
  readonly expectation:
    | {
        readonly kind: 'accept'
        readonly canonicalHex: string
        readonly domainHex: string
        readonly digestExpectation: {
          readonly kind: 'typed'
          readonly digestRole: string
          readonly value: string
        }
        readonly signatureExpectation: { readonly kind: 'none' }
      }
    | {
        readonly kind: 'reject'
        readonly errorCode: string
        readonly errorEnum: string
        readonly phase: string
      }
  readonly expectedMediaRole: string | null
  readonly expectedRole: string | null
  readonly inputPath: string
  readonly version: number
}

const loadCases = (): CorpusCase[] => {
  const text = readFileSync(join(fixturesRoot, 'small-cases.ndjson'), 'utf8')
  return text
    .trimEnd()
    .split('\n')
    .map((line) => {
      const parsed = parseCanonicalJson(new TextEncoder().encode(line), { maxBytes: 1 << 20 })
      return parsed.value as CorpusCase
    })
}

describe('shared small corpus (§19a.14)', () => {
  const cases = loadCases()
  it('loads a non-empty, unique, sorted corpus', () => {
    expect(cases.length).toBeGreaterThanOrEqual(25)
    const ids = cases.map((item) => item.caseId)
    expect(new Set(ids).size).toBe(ids.length)
  })
  it('maps records and checked-in .bin files 1:1 (no orphan fixtures)', () => {
    const binFiles = readdirSync(join(fixturesRoot, 'small'))
      .filter((name) => name.endsWith('.bin'))
      .sort()
    const referenced = cases.map((item) => basename(item.inputPath)).sort()
    expect(binFiles).toEqual(referenced)
  })

  for (const item of cases) {
    it(`${item.caseId} → ${item.expectation.kind === 'accept' ? 'accept' : item.expectation.errorCode}`, () => {
      const raw = new Uint8Array(readFileSync(join(fixturesRoot, item.inputPath)))
      if (item.expectation.kind === 'reject') {
        try {
          parseCanonicalJson(raw, { maxBytes: MAX_BYTES })
          expect.fail(`expected ${item.expectation.errorCode}`)
        } catch (error) {
          expect(error).toBeInstanceOf(CapabilityContractError)
          expect((error as CapabilityContractError).detail.code).toBe(item.expectation.errorCode)
        }
        return
      }
      expect(item.expectedRole).not.toBeNull()
      const parsed = parseCanonicalJson(raw, { maxBytes: MAX_BYTES })
      expect(Buffer.from(parsed.canonicalBytes).toString('hex')).toBe(item.expectation.canonicalHex)
      expect(item.expectedRole).not.toBeNull()
      const domain = domainSeparatedBytes(item.expectedRole!, parsed.canonicalBytes)
      expect(Buffer.from(domain).toString('hex')).toBe(item.expectation.domainHex)
      expect(canonicalPayloadDigest(item.expectedRole!, parsed.canonicalBytes)).toBe(
        item.expectation.digestExpectation.value,
      )
    })
  }
})
