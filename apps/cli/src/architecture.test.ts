import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const sourceRoot = dirname(fileURLToPath(import.meta.url))

function importedBindings(clause: string) {
  if (/^\s*(?:type\s+)?\*/.test(clause)) return ['*']
  const open = clause.indexOf('{')
  if (open < 0) return ['default']
  const values = clause
    .slice(open + 1, clause.lastIndexOf('}'))
    .split(',')
    .map(
      (value) =>
        value
          .trim()
          .replace(/^type\s+/, '')
          .split(/\s+as\s+/)[0],
    )
    .filter(Boolean)
  if (
    clause
      .slice(0, open)
      .replace(/^\s*type\s+/, '')
      .replace(/,/g, '')
      .trim()
  )
    values.push('default')
  return values
}

function legacyPluginBypasses(source: string, file = 'fixture.ts'): string[] {
  const failures: string[] = []
  const report = (index: number, reason: string) => {
    const line = source.slice(0, index).split('\n').length
    failures.push(`${file}:${line}: ${reason}`)
  }
  const importPattern = /\bimport\s+([\s\S]*?)\s+from\s+(['"])([^'"]+)\2/g
  for (const match of source.matchAll(importPattern)) {
    const clause = match[1] ?? ''
    const specifier = match[3] ?? ''
    const index = match.index ?? 0
    if (specifier.includes('/test-only/') || specifier.includes('/internal/legacy-test-'))
      report(index, 'production cannot import the legacy test harness or its authority')
    if (specifier === '@volund/plugin-runtime')
      for (const binding of importedBindings(clause))
        if (binding === 'PluginRuntime' || binding === '*' || binding === 'default')
          report(index, `forbidden plugin-runtime import: ${binding}`)
    if (specifier === '@volund/native-bridge')
      for (const binding of importedBindings(clause))
        if (binding === 'startPluginHost' || binding === '*' || binding === 'default')
          report(index, `forbidden plugin host import: ${binding}`)
  }

  const rules: Array<[RegExp, string]> = [
    [
      /\b(?:import|require)\s*\(\s*['"](?:@volund\/(?:plugin-runtime|native-bridge)|[^'"]*\/test-only\/)[^'"]*['"]\s*\)/g,
      'dynamic legacy plugin dependency is forbidden',
    ],
    [/\bPluginRuntime\b/g, 'PluginRuntime is forbidden in production CLI sources'],
    [/\.\s*(?:loadEnabled|startPluginHost)\s*\(/g, 'legacy activation member is forbidden'],
    [
      /\b(?:pluginRuntime|memoryPolicyRuntime)\s*\.\s*load\s*\(/g,
      'legacy runtime load is forbidden',
    ],
    [
      /\b(?:pluginHostStart|pluginApproval|enableLegacyPlugins|legacyPluginActivation)\b/g,
      'production reopen option is forbidden',
    ],
    [
      /volund_.*(?:LEGACY_PLUGIN|PLUGIN_(?:ACTIVATION|ENABLE|REOPEN))/gi,
      'environment/config reopen key is forbidden',
    ],
    [
      /['"][^'"]*(?:\/test-only\/|\/internal\/legacy-test-)[^'"]*['"]/g,
      'legacy test-only path is forbidden',
    ],
  ]
  for (const [pattern, reason] of rules)
    for (const match of source.matchAll(pattern)) report(match.index ?? 0, reason)
  return [...new Set(failures)]
}
async function productionSources(directory: string): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await productionSources(path)))
    else if (/\.[cm]?tsx?$/.test(entry.name) && !/\.(?:test|spec)\.[cm]?tsx?$/.test(entry.name))
      files.push(path)
  }
  return files
}

describe('CLI dependency boundaries', () => {
  it('keeps domain commands independent from other command domains and runtime', async () => {
    const commandFiles = [
      'commands/doctor/index.ts',
      'commands/memory/index.ts',
      'commands/status/index.ts',
      'commands/telemetry/index.ts',
      'commands/trust/index.ts',
      'commands/memory/index.ts',
    ]

    for (const file of commandFiles) {
      const source = await readFile(resolve(sourceRoot, file), 'utf8')
      expect(source, relative(sourceRoot, resolve(sourceRoot, file))).not.toMatch(
        /from ['"](?:\.\.\/)+runtime(?:['"]|\/)/,
      )
      expect(source, relative(sourceRoot, resolve(sourceRoot, file))).not.toMatch(
        /from ['"](?:\.\.\/)+commands\//,
      )
    }
  })

  it('keeps the quarantined legacy plugin runtime out of production composition', async () => {
    const failures: string[] = []
    for (const file of await productionSources(sourceRoot))
      failures.push(
        ...legacyPluginBypasses(await readFile(file, 'utf8'), relative(sourceRoot, file)),
      )
    expect(failures).toEqual([])
  })

  it('detects aliases, namespace access, dynamic imports, and hidden reopen controls', () => {
    const fixtures = [
      `import { PluginRuntime as PR } from '@volund/plugin-runtime'; new PR()`,
      `import * as plugins from '@volund/plugin-runtime'; new plugins.PluginRuntime()`,
      `const plugins = await import('@volund/plugin-runtime')`,
      `import { startPluginHost as start } from '@volund/native-bridge'; start({})`,
      `interface ProductionOptions { pluginHostStart?: unknown }`,
      `const key = 'VOLUND_LEGACY_PLUGIN_REOPEN'`,
      `async function createChildRunner() { return injected.loadEnabled() }`,
    ]
    for (const fixture of fixtures) expect(legacyPluginBypasses(fixture)).not.toEqual([])
  })
})
