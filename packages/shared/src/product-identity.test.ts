import { describe, expect, it } from 'vitest'

import { productIdentity } from './product-identity'

describe('productIdentity', () => {
  it('defines one frozen Volund display identity', () => {
    expect(productIdentity).toMatchObject({
      category: 'CLI',
      commandName: 'volund',
      displayName: 'Volund CLI',
      packageName: '@volund/cli',
      packageScope: '@volund',
      shortName: 'Volund',
      tagline: 'FORGED FOR CODERS.',
      terminalGlyph: '>_',
      terminalWordmark: 'VOLUND CLI',
      visualMark: 'pixel-hammer',
    })
    expect(Object.isFrozen(productIdentity)).toBe(true)
  })
})
