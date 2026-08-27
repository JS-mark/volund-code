import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const cli = new URL('../apps/cli/dist/volund.js', import.meta.url)

async function run(args, home) {
  try {
    const result = await execute(process.execPath, [cli.pathname, ...args], {
      cwd: path.dirname(cli.pathname),
      env: {
        PATH: process.env.PATH,
        VOLUND_HOME: home,
        NO_COLOR: '1',
      },
    })
    return { code: 0, ...result }
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr }
  }
}

void test('built CLI exposes honest no-secret JSON and no-TUI roots', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'volund-l1-e2e-'))
  try {
    const status = await run(['status', '--json'], home)
    assert.equal(status.code, 0)
    assert.equal(status.stderr, '')
    const snapshot = JSON.parse(status.stdout)
    assert.ok(Array.isArray(snapshot.status))
    assert.ok(
      snapshot.status.some(
        (row) => row.label === 'Auth method' && row.value === 'credential store (value hidden)',
      ),
    )

    const missingPrompt = await run(['chat', '--json', '--no-tui'], home)
    assert.equal(missingPrompt.code, 2)
    const records = missingPrompt.stdout.trim().split('\n').map(JSON.parse)
    assert.deepEqual(
      records.map(({ type, data }) => ({ type, data })),
      [
        {
          type: 'error',
          data: {
            code: 'prompt_required',
            category: 'usage',
            retryable: false,
            exitCode: 2,
            message: 'JSON chat requires a prompt.',
          },
        },
        { type: 'final', data: { status: 'error', exitCode: 2 } },
      ],
    )
    assert.equal(missingPrompt.stderr, '')

    const persisted = await readFile(path.join(home, 'telemetry', 'events.jsonl'), 'utf8').catch(
      () => '',
    )
    assert.doesNotMatch(`${status.stdout}${persisted}`, /api[_-]?key|bearer\s|secret/i)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
