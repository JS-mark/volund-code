import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'

import { relativeSpecifierError, outDirError } from './verify-typescript-config.mjs'

void test('accepts an extensionless specifier when it maps to TypeScript source', () => {
  const source = resolve('repo', 'src', 'cli.ts')
  const target = resolve(dirname(source), 'ports.ts')
  assert.equal(
    relativeSpecifierError(source, './ports', (path) => path === target),
    undefined,
  )
})

void test('rejects explicit source and emitted extensions plus missing targets', () => {
  assert.match(relativeSpecifierError('/repo/src/cli.ts', './ports.js'), /must omit/)
  assert.match(relativeSpecifierError('/repo/src/cli.ts', './ports.ts'), /must omit/)
  assert.match(
    relativeSpecifierError('/repo/src/cli.ts', './missing', () => false),
    /does not map/,
  )
})

void test('allows explicit extensions for Vite assets and Vue components', () => {
  assert.equal(relativeSpecifierError('/repo/src/theme.ts', './custom.css'), undefined)
  assert.equal(relativeSpecifierError('/repo/src/theme.ts', './Home.vue'), undefined)
  assert.equal(relativeSpecifierError('/repo/src/theme.ts', './logo.svg'), undefined)
})

void test('requires each workspace to own its dist directory', () => {
  assert.equal(outDirError('dist'), undefined)
  assert.match(outDirError('../../dist'), /own dist directory/)
})
