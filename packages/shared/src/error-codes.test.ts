import { describe, expect, it } from 'vitest'

import {
  appendixErrorCodes,
  ErrorCodes,
  isErrorCode,
  normalizedErrorCodes,
  type ErrorCode,
} from './error-codes'

const CODE_SHAPE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$|^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/

describe('error code registry', () => {
  it('exposes every entry as a referenceable constant with a code-shaped value', () => {
    const entries = Object.entries(ErrorCodes)
    expect(entries.length).toBeGreaterThanOrEqual(100)
    for (const [key, code] of entries) {
      expect(key, `${key} must be camelCase`).toMatch(/^[a-z][A-Za-z0-9]*$/)
      expect(code, `${key} -> ${code} must be snake_case or UPPER_SNAKE`).toMatch(CODE_SHAPE)
    }
  })

  it('keeps registry values globally unique', () => {
    const codes = Object.values(ErrorCodes)
    expect(new Set(codes).size).toBe(codes.length)
  })

  it('registers the full appendix B.2 contract set', () => {
    const registry = new Set(Object.values(ErrorCodes))
    for (const code of appendixErrorCodes) expect(registry.has(code)).toBe(true)
    expect(appendixErrorCodes).toHaveLength(11)
  })

  it('covers every APOLLO_<CATEGORY> produced by the normalizeError factory', () => {
    const registry = new Set(Object.values(ErrorCodes))
    expect(normalizedErrorCodes).toHaveLength(17)
    for (const code of normalizedErrorCodes) expect(registry.has(code)).toBe(true)
  })

  it('narrows unknown values via isErrorCode', () => {
    const sample: ErrorCode = ErrorCodes.toolLoopExhausted
    expect(isErrorCode(sample)).toBe(true)
    expect(isErrorCode('definitely_not_registered')).toBe(false)
    expect(isErrorCode(42)).toBe(false)
    expect(isErrorCode(undefined)).toBe(false)
  })
})
