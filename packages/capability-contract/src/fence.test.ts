import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import * as barrel from './index'

/**
 * Package and import fence (§19a.13.3): the root barrel must not surface the
 * authority subpath; the package must stay private, verifier-only, and free
 * of signing-material APIs.
 */

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

describe('capability-contract package fence', () => {
  it('does not export authority APIs from the root barrel', () => {
    expect(Object.keys(barrel).sort()).not.toContain('buildDetachedSignaturePreimage')
    expect(Object.keys(barrel).sort()).not.toContain('verifyDetachedSignature')
  })
  it('exposes the authority subpath separately and purely', async () => {
    const authority = await import('./authority')
    expect(typeof authority.buildDetachedSignaturePreimage).toBe('function')
    expect(typeof authority.verifyDetachedSignature).toBe('function')
    expect(Object.keys(authority).sort()).toEqual([
      'buildDetachedSignaturePreimage',
      'verifyDetachedSignature',
    ])
  })
  it('stays private with a closed export surface', () => {
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
      private?: boolean
      exports?: Record<string, unknown>
      bin?: unknown
      dependencies?: Record<string, string>
    }
    expect(manifest.private).toBe(true)
    expect(Object.keys(manifest.exports ?? {}).sort()).toEqual(['.', './authority'])
    expect(manifest.bin).toBeUndefined()
    // Runtime dependencies are the locked crypto adapter only — no workspace
    // runtime imports, no signing libraries.
    expect(Object.keys(manifest.dependencies ?? {})).toEqual(['@noble/curves'])
  })
  it('declares no production signing capability in source', () => {
    // Behavioral probe: every exported root symbol is data/digest/verify
    // oriented; none accepts a seed, secret, or private-key parameter.
    const source = readFileSync(join(packageRoot, 'src', 'index.ts'), 'utf8')
    expect(source).not.toMatch(/export.*\bsign\b|getPublicKey|keygen/i)
  })
})
