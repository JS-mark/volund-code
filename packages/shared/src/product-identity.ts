/** Canonical user-visible product identity for the Volund CLI. */
export const productIdentity = Object.freeze({
  category: 'CLI',
  commandName: 'volund',
  description: 'Open, model-agnostic AI coding CLI',
  displayName: 'Volund CLI',
  packageName: '@volund/cli',
  packageScope: '@volund',
  shortName: 'Volund',
  tagline: 'FORGED FOR CODERS.',
  terminalGlyph: '>_',
  terminalWordmark: 'VOLUND CLI',
  visualMark: 'pixel-hammer',
})

export type ProductIdentity = typeof productIdentity
