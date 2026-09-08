import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { runtimeStatusData } from './status'

let dir: string | undefined
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = undefined
})

async function freshHome(): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), 'volund-status-test-'))
  return dir
}

describe('runtimeStatusData Web 行（§22 W-01）', () => {
  it('webConsoleUrl 有值时展示 Web 行，缺省/undefined 时不展示', async () => {
    const home = await freshHome()
    const withUrl = await runtimeStatusData(
      home,
      {
        identity: { version: '0.0.0-test' },
        webConsoleUrl: () => 'http://127.0.0.1:17893/',
      },
      { cwd: '/tmp' },
    )
    expect(withUrl.status).toContainEqual({
      label: 'Web',
      value: 'http://127.0.0.1:17893/',
    })

    const without = await runtimeStatusData(
      home,
      { identity: { version: '0.0.0-test' }, webConsoleUrl: () => undefined },
      { cwd: '/tmp' },
    )
    expect(without.status.find((row) => row.label === 'Web')).toBeUndefined()

    const unwired = await runtimeStatusData(
      home,
      { identity: { version: '0.0.0-test' } },
      { cwd: '/tmp' },
    )
    expect(unwired.status.find((row) => row.label === 'Web')).toBeUndefined()
  })
})
