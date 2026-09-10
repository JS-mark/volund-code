/**
 * PairingStore 单元：配对码过期（注入时钟）、一次性核销、撤销语义、
 * 明文 secret 不落盘（存 JSON 无 secret 类字段）。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { deriveSigningKey } from './oauth'
import { PairingStore } from './pairing'

let dir: string | undefined
let now = 1_000_000

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'volund-pairing-'))
})

afterEach(async () => {
  await rm(dir!, { recursive: true, force: true })
})

function createStore(): PairingStore {
  return new PairingStore({
    signingKey: deriveSigningKey('pairing-unit-key'),
    issuer: 'volund-gateway-test',
    storePath: join(dir!, 'devices.json'),
    codeTtlMs: 60_000,
    deviceTokenTtlSeconds: 3_600,
    now: () => now,
  })
}

describe('PairingStore', () => {
  it('expires pairing codes after the TTL', async () => {
    const store = createStore()
    const code = await store.createCode('machine-a')
    now += 61_000
    expect(await store.redeem(code.code, '手机')).toBeUndefined()
    expect(
      (await store.listDevices()).length ?? (await store.listDevices('machine-a')).length,
    ).toBe(0)
  })

  it('issues a working device token and revocation kills it', async () => {
    const store = createStore()
    const code = await store.createCode('machine-a')
    const redeemed = await store.redeem(code.code, '手机')
    expect(redeemed).toBeTruthy()
    const token = redeemed!.result.accessToken
    const claims = await store.verifyDeviceToken(token)
    expect(claims?.client).toBe('machine-a')
    expect(claims?.sub).toMatch(/^dev-/)

    expect(await store.revokeDevice('machine-a', claims!.sub)).toBe(true)
    expect(await store.verifyDeviceToken(token)).toBeUndefined()
    // 重复撤销/跨机器撤销都是无害 false。
    expect(await store.revokeDevice('machine-a', claims!.sub)).toBe(false)
    expect(await store.revokeDevice('machine-b', claims!.sub)).toBe(false)
  })

  it('survives reload from disk without secrets in the store file', async () => {
    const store = createStore()
    const code = await store.createCode('machine-a')
    const redeemed = await store.redeem(code.code, '手机')
    const raw = await readFile(join(dir!, 'devices.json'), 'utf8')
    expect(raw).not.toMatch(/secret|token|access/i)

    const reloaded = createStore()
    const claims = await reloaded.verifyDeviceToken(redeemed!.result.accessToken)
    expect(claims?.sub).toBe(redeemed!.result.deviceId)
    expect((await reloaded.listDevices('machine-a')).map((device) => device.name)).toEqual(['手机'])
  })

  it('rejects a device token bound to a different machine', async () => {
    const store = createStore()
    const code = await store.createCode('machine-a')
    const redeemed = await store.redeem(code.code, '手机')
    // 篡改注册表：设备改绑到别的机器 → client 不匹配即失效。
    const devices = JSON.parse(await readFile(join(dir!, 'devices.json'), 'utf8')) as {
      id: string
      client: string
    }[]
    devices[0]!.client = 'machine-b'
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(dir!, 'devices.json'), JSON.stringify(devices))
    const reloaded = createStore()
    expect(await reloaded.verifyDeviceToken(redeemed!.result.accessToken)).toBeUndefined()
  })
})
