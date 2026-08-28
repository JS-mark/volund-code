const legacyCommandNames = Object.freeze(['volund'] as const)

/** Apollo-era machine identifiers the runtime must keep reading during the staged migration. */
const compatibility = Object.freeze({
  commandNames: legacyCommandNames,
  envPrefix: 'VOLUND',
  homeDirectoryName: '.volund',
  packageName: 'volund-cli',
  packageScope: '@volund',
})

/**
 * Canonical user-visible identity plus the machine identifiers that must remain
 * readable during the staged legacy-brand -> Volund migration.
 */
export const productIdentity = Object.freeze({
  category: 'CLI',
  commandName: 'volund',
  compatibility,
  description: 'Open, model-agnostic AI coding CLI',
  displayName: 'Volund CLI',
  packageName: 'volund-cli',
  packageScope: '@volund',
  shortName: 'Volund',
  tagline: 'FORGED FOR CODERS.',
  terminalGlyph: '>_',
  terminalWordmark: 'VOLUND CLI',
  visualMark: 'pixel-hammer',
})

export type ProductIdentity = typeof productIdentity
