/**
 * Test-only authority for exercising the quarantined v1 runtime.
 *
 * This module is deliberately not exported by the package root. Production code must never
 * import it; the only supported consumer is `../test-only/legacy-harness.ts` in package tests.
 */
export const legacyPluginTestAuthority: unique symbol = Symbol('legacy-plugin-test-authority')
