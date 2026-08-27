import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { EncryptedCredentialStore } from './encrypted-store'
const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true })
  dirs.length = 0
})
describe('EncryptedCredentialStore', () => {
  it('round trips using Argon2id and AES-GCM without plaintext on disk', async () => {
    const dir = await mkdtemp(resolve(tmpdir(), 'volund-auth-'))
    dirs.push(dir)
    const path = resolve(dir, 'credentials.enc'),
      store = new EncryptedCredentialStore(path, async () => 'pass')
    await store.set('anthropic', 'sk-secret')
    expect(await new EncryptedCredentialStore(path, async () => 'pass').get('anthropic')).toBe(
      'sk-secret',
    )
    expect(await readFile(path, 'utf8')).not.toContain('sk-secret')
  })
})
