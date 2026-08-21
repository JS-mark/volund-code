import type { PluginManifest } from '@apollo-code/plugin-sdk'

import { PluginManager } from '../index'
import { legacyPluginTestAuthority } from '../internal/legacy-test-authority'

type TestOnlyPluginManagerConstructor = new (
  root: string,
  apolloVersion: string,
  confirm: (manifest: PluginManifest, expanded: boolean) => Promise<boolean>,
  authority: typeof legacyPluginTestAuthority,
) => PluginManager

/**
 * Explicit v1 compatibility harness for plugin-runtime package tests only.
 *
 * It is absent from `@apollo-code/plugin-runtime` exports and has no environment/config switch.
 */
export function createLegacyPluginTestManager(
  root: string,
  apolloVersion: string,
  confirm: (manifest: PluginManifest, expanded: boolean) => Promise<boolean> = async () => true,
): PluginManager {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the fourth argument is intentionally hidden from the production declaration surface
  const TestOnlyManager = PluginManager as unknown as TestOnlyPluginManagerConstructor
  return new TestOnlyManager(root, apolloVersion, confirm, legacyPluginTestAuthority)
}
