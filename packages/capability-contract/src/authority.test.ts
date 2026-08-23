import { ed25519 } from '@noble/curves/ed25519'
import { describe, expect, it } from 'vitest'

import { buildDetachedSignaturePreimage, verifyDetachedSignature } from './authority'
import { domainSeparatedBytes, encodeBase64Url } from './digest'

/**
 * Behavioral pinning for the detached-signature authority surface
 * (§19a.3.4 / §19a.13.3): shape vs role vs crypto reasons must stay distinct,
 * and no malformed envelope may ever throw.
 *
 * The seed below is TEST-ONLY (§19a.3.3 public vector) and must never enter a
 * production trust store.
 */

const TEST_SEED = Buffer.from(
  '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
  'hex',
)
const TEST_PUBLIC_KEY = Buffer.from(ed25519.getPublicKey(TEST_SEED)).toString('hex')
const GOLDEN_SIGNATURE =
  'ckzMFq57Oq2025xUrn2BDeHkI0bnIFhzW9-UgIfsTdiBWDatELw1mZu7sAxFwn9dnIB0EBxE_rhuPTeGLRlMCQ'
const GOLDEN_CANONICAL = Buffer.from('7b2265666665637473223a5b5d2c2276657273696f6e223a317d', 'hex')
const ROLE = 'permission-template.v1'

const trustedKey = { publicKeyBase64Url: encodeBase64Url(Buffer.from(TEST_PUBLIC_KEY, 'hex')) }
const goldenEnvelope = () => ({
  algorithm: 'ed25519' as const,
  keyId: 'test-key',
  signatureBase64Url: GOLDEN_SIGNATURE,
  signedSchemaRole: ROLE,
  version: 1 as const,
})
// Negative probes intentionally pass \`unknown\` runtime shapes; the cast is
// the test harness crossing the typed boundary — the verifier must not.
const verify = (envelope: unknown, canonicalBytes: Uint8Array = GOLDEN_CANONICAL) =>
  verifyDetachedSignature({
    expectedRole: ROLE,
    canonicalBytes,
    envelope: envelope as Parameters<typeof verifyDetachedSignature>[0]['envelope'],
    trustedKey,
  })

describe('detached signature authority (§19a.3.4)', () => {
  it('accepts the golden envelope over the golden preimage', () => {
    expect(verify(goldenEnvelope())).toEqual({ ok: true })
  })
  it('preimage is caller-expected-role domain separated (§19a.3.2 two-segment)', () => {
    const preimage = buildDetachedSignaturePreimage(ROLE, GOLDEN_CANONICAL)
    expect(Buffer.from(preimage).toString('hex')).toBe(
      Buffer.from(domainSeparatedBytes(ROLE, GOLDEN_CANONICAL)).toString('hex'),
    )
    // A self-reported envelope role never selects the domain.
    expect(verify({ ...goldenEnvelope(), signedSchemaRole: 'bundle-binding-payload.v1' })).toEqual({
      ok: false,
      reason: 'role-mismatch',
    })
  })
  it('rejects shape errors before any crypto or role check', () => {
    const shapeCases: unknown[] = [
      null,
      undefined,
      'envelope',
      [],
      [{ k: 1 }],
      { ...goldenEnvelope(), extra: true },
      (() => {
        const e = goldenEnvelope() as Record<string, unknown>
        delete e.keyId
        return e
      })(),
      { ...goldenEnvelope(), version: 2 },
      { ...goldenEnvelope(), algorithm: 'Ed25519' },
      { ...goldenEnvelope(), keyId: '' },
      { ...goldenEnvelope(), keyId: 'k'.repeat(129) },
      { ...goldenEnvelope(), keyId: 'has space' },
      { ...goldenEnvelope(), keyId: 'has\ttab' },
      { ...goldenEnvelope(), keyId: 'ké' },
      { ...goldenEnvelope(), signatureBase64Url: 42 },
    ]
    for (const envelope of shapeCases)
      expect(verify(envelope)).toEqual({ ok: false, reason: 'envelope-shape' })
  })
  it('accepts a 128-char visible-ASCII keyId', () => {
    expect(verify({ ...goldenEnvelope(), keyId: 'k'.repeat(128) })).toEqual({ ok: true })
  })
  it('rejects a wrong key as signature-invalid', () => {
    const otherKey = {
      publicKeyBase64Url: encodeBase64Url(ed25519.getPublicKey(Buffer.alloc(32, 1))),
    }
    expect(
      verifyDetachedSignature({
        expectedRole: ROLE,
        canonicalBytes: GOLDEN_CANONICAL,
        envelope: goldenEnvelope(),
        trustedKey: otherKey,
      }),
    ).toEqual({ ok: false, reason: 'signature-invalid' })
  })
  it('S = 0 is a valid scalar-domain input that verifies false and never throws', () => {
    const golden = Buffer.from(GOLDEN_SIGNATURE, 'base64url')
    const sZero = Buffer.concat([golden.subarray(0, 32), Buffer.alloc(32, 0)])
    const result = verify({
      ...goldenEnvelope(),
      signatureBase64Url: sZero.toString('base64url'),
    })
    expect(result).toEqual({ ok: false, reason: 'signature-invalid' })
  })
  it('never throws on garbage envelopes', () => {
    const garbage: unknown[] = [0, true, NaN, { algorithm: {} }, new Date(), Buffer.from('x')]
    for (const envelope of garbage) {
      const result = verify(envelope)
      expect(result.ok).toBe(false)
    }
  })
})
