import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = dirname(dirname(fileURLToPath(import.meta.url)))

void test('plugin-runtime package publishes only the deny-only production entrypoint', async () => {
  await execFileAsync('pnpm', ['run', 'build'], {
    cwd: join(root, 'packages/plugin-runtime'),
  })
  const { stdout } = await execFileAsync('pnpm', ['pack', '--dry-run', '--json'], {
    cwd: join(root, 'packages/plugin-runtime'),
  })
  const parsed = JSON.parse(stdout)
  const report = Array.isArray(parsed) ? parsed[0] : parsed
  const paths = report.files.map((file) => file.path).toSorted()

  assert.deepEqual(paths, [
    'LICENSE',
    'dist/index.d.ts',
    'dist/index.d.ts.map',
    'dist/index.js',
    'dist/index.js.map',
    'package.json',
  ])
  assert.equal(
    paths.some(
      (path) =>
        /(?:^|\/)(?:internal|test-only)(?:\/|$)/.test(path) ||
        /(?:^|\.)test\.[^.]+$/.test(path) ||
        path.includes('authority'),
    ),
    false,
  )
})
