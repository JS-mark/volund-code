import { describe, expect, it } from 'vitest'

import { productIdentity } from './product-identity'

describe('productIdentity', () => {
  it('defines one frozen Volund display identity', () => {
    expect(productIdentity).toMatchObject({
      category: 'CLI',
      commandName: 'volund',
      displayName: 'Volund CLI',
      packageName: 'volund-cli',
      packageScope: '@volund',
      shortName: 'Volund',
      tagline: 'FORGED FOR CODERS.',
      terminalGlyph: '>_',
      terminalWordmark: 'VOLUND CLI',
      visualMark: 'pixel-hammer',
    })
    expect(Object.isFrozen(productIdentity)).toBe(true)
  })

  it('keeps apollo-era machine identifiers isolated as frozen compatibility data', () => {
    expect(productIdentity.compatibility).toEqual({
      commandNames: ['apollo'],
      envPrefix: 'APOLLO',
      homeDirectoryName: '.apollo',
      packageName: 'apollo-code',
      packageScope: '@apollo-code',
    })
    expect(Object.isFrozen(productIdentity.compatibility)).toBe(true)
    expect(Object.isFrozen(productIdentity.compatibility.commandNames)).toBe(true)
  })
})
