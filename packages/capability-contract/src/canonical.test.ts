import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  CapabilityContractError,
  canonicalPayloadDigest,
  domainSeparatedBytes,
  encodeCanonical,
  parseCanonicalJson,
} from './index'

const MAX_BYTES = 16 * 1024 * 1024
const parse = (bytes: Uint8Array) => parseCanonicalJson(bytes, { maxBytes: MAX_BYTES })
const utf8 = (text: string) => new TextEncoder().encode(text)
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex')

describe('canonical encoder', () => {
  it('sorts object keys by unsigned UTF-8 byte order', () => {
    expect(utf8('{"a":1,"b":2}')).toEqual(encodeCanonical({ b: 2, a: 1 }))
    // U+FF41 sorts AFTER every ASCII key (byte order, not code-unit tricks).
    const encoded = encodeCanonical({ ａ: 1, z: 2 })
    expect(Buffer.from(encoded).toString('utf8')).toBe('{"z":2,"ａ":1}')
  })
  it('escapes only quote and backslash and keeps non-ASCII raw', () => {
    expect(Buffer.from(encodeCanonical({ 'k"\\é': 1 })).toString('utf8')).toBe('{"k\\"\\\\é":1}')
  })
  it('emits lowercase literals and shortest decimals', () => {
    expect(
      Buffer.from(encodeCanonical([true, false, null, 0, -1, 9007199254740991])).toString('utf8'),
    ).toBe('[true,false,null,0,-1,9007199254740991]')
  })
  it('rejects non-JSON and unsafe values programmatically', () => {
    expect(() => encodeCanonical({ x: 1.5 })).toThrow(TypeError)
    expect(() => encodeCanonical({ x: Number.NaN })).toThrow(TypeError)
    expect(() => encodeCanonical({ x: 9007199254740992 })).toThrow(TypeError)
    expect(() => encodeCanonical(undefined as unknown as number)).toThrow(TypeError)
  })
})

describe('§19a.3.3 golden vector', () => {
  const canonicalBytes = Buffer.from('7b2265666665637473223a5b5d2c2276657273696f6e223a317d', 'hex')
  const expectedPreimage = Buffer.concat([
    Buffer.from('706c7567696e2d6b65726e656c2d636f6e747261637400763100', 'hex'),
    Buffer.from('7065726d697373696f6e2d74656d706c6174652e763100', 'hex'),
    Buffer.from('000000000000001a', 'hex'),
    canonicalBytes,
  ])
  it('reproduces the domain-separated preimage byte for byte', () => {
    expect(hex(domainSeparatedBytes('permission-template.v1', canonicalBytes))).toBe(
      hex(expectedPreimage),
    )
  })
  it('reproduces the typed digest', () => {
    expect(canonicalPayloadDigest('permission-template.v1', canonicalBytes)).toBe(
      'fa6cf97e20476ac1e940fbf3b703054e86b92a9cd4ca149086f15ed9448adbf3',
    )
  })
  it('accepts the canonical bytes through full admission', () => {
    expect(hex(parse(canonicalBytes).canonicalBytes)).toBe(hex(canonicalBytes))
  })
})

describe('parse admission phases', () => {
  const expectError = (bytes: Uint8Array, code: string) => {
    try {
      parse(bytes)
      expect.fail(`expected ${code}`)
    } catch (error) {
      expect(error).toBeInstanceOf(CapabilityContractError)
      expect((error as CapabilityContractError).detail.code).toBe(code)
    }
  }
  it('enforces the phase vector order (§19a.2.4)', () => {
    expectError(new Uint8Array(MAX_BYTES + 1), 'contract.input-too-large')
    expectError(Buffer.from([0x22, 0xc0, 0xaf, 0x22]), 'contract.utf8-invalid')
    expectError(
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8('{}')]),
      'contract.bom-forbidden',
    )
    expectError(utf8('{"a":1'), 'contract.json-syntax')
    expectError(utf8('{"a":1,"a":2}'), 'contract.duplicate-key')
    expectError(utf8('{"n":1.5}'), 'contract.value-domain')
    expectError(utf8('{"a": 1}'), 'contract.noncanonical-bytes')
    expectError(utf8('[1]'), 'contract.schema-invalid')
  })
  it('whole-document syntax beats an earlier duplicate key', () => {
    // Duplicate at offset ~7, syntax break later: json-syntax must win.
    expectError(utf8('{"a":1,"a":2 junk'), 'contract.json-syntax')
  })
  it('decoded-scalar duplicate detection (raw vs escaped key)', () => {
    expectError(utf8('{"a":1,"\\u0061":2}'), 'contract.duplicate-key')
  })
  it('accepts valid documents and reports the original bytes as canonical', () => {
    const bytes = utf8('{"effects":[],"version":1}')
    expect(hex(parse(bytes).canonicalBytes)).toBe(hex(bytes))
  })
})

describe('first-error tie-breaking', () => {
  it('prefers the smallest byte offset within one phase', async () => {
    const { firstDetail } = await import('./errors')
    expect(firstDetail([{ code: 'contract.value-domain', byteOffset: 9 }])).toMatchObject({
      byteOffset: 9,
    })
    expect(
      firstDetail([
        { code: 'contract.value-domain', byteOffset: 20 },
        { code: 'contract.value-domain', byteOffset: 5 },
      ]),
    ).toMatchObject({ byteOffset: 5 })
  })
})

describe('fixture corpus shape (§19a.14)', () => {
  const fixturesRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'v1')
  const metadataText = readFileSync(join(fixturesRoot, 'small-cases.ndjson'), 'utf8')
  it('is canonical JSON lines, strictly sorted, exactly one final LF', () => {
    expect(metadataText.endsWith('\n')).toBe(true)
    expect(metadataText.endsWith('\n\n')).toBe(false)
    expect(metadataText.includes('\r')).toBe(false)
    const lines = metadataText.trimEnd().split('\n')
    const caseIds = lines.map((line) => {
      const parsed = parse(utf8(line))
      const value = parsed.value as { caseId: string }
      return value.caseId
    })
    const sorted = [...caseIds].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
    expect(caseIds).toEqual(sorted)
    expect(new Set(caseIds).size).toBe(caseIds.length)
  })
})
