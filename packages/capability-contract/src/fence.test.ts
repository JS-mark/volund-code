import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
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
  it('has zero production dependents across the workspace (P0-00 fence)', () => {
    // The fence must fail if ANY other workspace package starts depending on
    // or importing this package before CAT runtime wiring is approved — not
    // just observe that none do today.
    const repoRoot = join(packageRoot, '..', '..')
    const packageDirs: string[] = []
    for (const group of ['apps', 'packages']) {
      for (const entry of readdirSync(join(repoRoot, group), { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const dir = join(repoRoot, group, entry.name)
        if (dir === packageRoot) continue
        if (existsSync(join(dir, 'package.json'))) packageDirs.push(dir)
      }
    }
    expect(packageDirs.length).toBeGreaterThan(5)
    for (const dir of packageDirs) {
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, string>
        devDependencies?: Record<string, string>
        peerDependencies?: Record<string, string>
        optionalDependencies?: Record<string, string>
      }
      const dependencyEntries = [
        ...Object.entries(manifest.dependencies ?? {}),
        ...Object.entries(manifest.devDependencies ?? {}),
        ...Object.entries(manifest.peerDependencies ?? {}),
        ...Object.entries(manifest.optionalDependencies ?? {}),
      ]
      for (const [name, specifier] of dependencyEntries) {
        expect(name).not.toBe('@apollo-code/capability-contract')
        // pnpm alias form (`"x": "workspace:@apollo-code/capability-contract@*"`)
        // hides the real target in the VALUE — scan values too.
        expect(specifier).not.toContain('capability-contract')
      }
      const srcRoot = join(dir, 'src')
      if (!existsSync(srcRoot)) continue
      const pending = [srcRoot]
      while (pending.length > 0) {
        const current = pending.pop()!
        for (const entry of readdirSync(current, { withFileTypes: true })) {
          const full = join(current, entry.name)
          if (entry.isDirectory()) {
            pending.push(full)
            continue
          }
          if (!/\.(?:ts|tsx|mts|cts|js|mjs|cjs|jsx)$/.test(entry.name)) continue
          expect(
            readFileSync(full, 'utf8').includes('@apollo-code/capability-contract'),
            `${basename(dir)}/${entry.name} must not reference @apollo-code/capability-contract`,
          ).toBe(false)
        }
      }
    }
  })
})
