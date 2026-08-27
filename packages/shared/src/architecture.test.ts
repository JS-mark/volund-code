import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

describe('shared contract ownership', () => {
  it('prevents provider-kit from redefining the canonical error taxonomy', () => {
    const providerKit = readFileSync(resolve(process.cwd(), '../provider-kit/src/index.ts'), 'utf8')
    expect(providerKit).toContain('ProviderErrorCategory = VolundErrorCategory')
    expect(providerKit).not.toMatch(/ProviderErrorCategory\s*=\s*\n\s*\|/)
  })
})
