import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { rewriteDirectory } from './rewrite-esm-specifiers.mjs'

void test('adds runtime extensions to emitted relative ESM specifiers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'volund-esm-'))
  mkdirSync(join(directory, 'nested'))
  writeFileSync(join(directory, 'cli.js'), 'export const runCli = () => {}\n')
  writeFileSync(join(directory, 'types.d.ts'), 'export interface Options {}\n')
  writeFileSync(join(directory, 'nested', 'index.js'), 'export const nested = true\n')
  writeFileSync(
    join(directory, 'index.js'),
    "import { runCli } from './cli'\nexport * from './nested'\nimport('./cli')\n",
  )
  writeFileSync(join(directory, 'index.d.ts'), "export type { Options } from './types'\n")

  rewriteDirectory(directory)

  assert.equal(
    readFileSync(join(directory, 'index.js'), 'utf8'),
    "import { runCli } from './cli.js'\nexport * from './nested/index.js'\nimport('./cli.js')\n",
  )
  assert.equal(
    readFileSync(join(directory, 'index.d.ts'), 'utf8'),
    "export type { Options } from './types.js'\n",
  )
})
