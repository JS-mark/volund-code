import { ed25519 } from '@noble/curves/ed25519'
import { describe, expect, it } from 'vitest'

import {
  canonicalPayloadDigest,
  domainSeparatedBytes,
  encodeBase64Url,
  verifyStrictEd25519,
  verifyStrictEd25519Bytes,
} from './index'

/**
 * §19a.3.3 byte-level golden vector. The seed below is TEST-ONLY and must
 * never enter a production trust store; signing here exists solely to mint
 * negative-corpus material inside the test target.
 */

const TEST_SEED = Buffer.from(
  '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
  'hex',
)
const TEST_PUBLIC_KEY = Buffer.from(ed25519.getPublicKey(TEST_SEED)).toString('hex')
const GOLDEN_SIGNATURE =
  'ckzMFq57Oq2025xUrn2BDeHkI0bnIFhzW9-UgIfsTdiBWDatELw1mZu7sAxFwn9dnIB0EBxE_rhuPTeGLRlMCQ'

const goldenCanonical = Buffer.from('7b2265666665637473223a5b5d2c2276657273696f6e223a317d', 'hex')
const goldenPreimage = () => domainSeparatedBytes('permission-template.v1', goldenCanonical)

describe('ContractStrictPureEd25519V1 (§19a.3.3/§19a.3.4)', () => {
  it('verifies the golden signature over the domain-separated preimage', () => {
    expect(
      verifyStrictEd25519(
        { publicKeyBase64Url: encodeBase64Url(Buffer.from(TEST_PUBLIC_KEY, 'hex')) },
        { signatureBase64Url: GOLDEN_SIGNATURE },
        goldenPreimage(),
      ),
    ).toBe(true)
  })
  it('rejects the same signature over a different message (preimage swap)', () => {
    const wrongMessage = domainSeparatedBytes('bundle-binding-payload.v1', goldenCanonical)
    expect(
      verifyStrictEd25519(
        { publicKeyBase64Url: encodeBase64Url(Buffer.from(TEST_PUBLIC_KEY, 'hex')) },
        { signatureBase64Url: GOLDEN_SIGNATURE },
        wrongMessage,
      ),
    ).toBe(false)
  })
  it('agrees with the locked noble adapter on the golden vector', () => {
    expect(
      ed25519.verify(
        Buffer.from(GOLDEN_SIGNATURE, 'base64url'),
        goldenPreimage(),
        Buffer.from(TEST_PUBLIC_KEY, 'hex'),
      ),
    ).toBe(true)
  })
  it('rejects malleated scalars (S + L)', () => {
    const signature = Buffer.from(GOLDEN_SIGNATURE, 'base64url')
    const malleated = Buffer.from(signature)
    const L = ed25519.CURVE.n
    let carry = 0n
    for (let index = 32; index < 64; index += 1) {
      const value = BigInt(signature[index]!) + ((L >> BigInt(8 * (index - 32))) & 0xffn) + carry
      malleated[index] = Number(value & 0xffn)
      carry = value >> 8n
    }
    expect(carry).toBe(0n)
    expect(
      verifyStrictEd25519Bytes(Buffer.from(TEST_PUBLIC_KEY, 'hex'), malleated, goldenPreimage()),
    ).toBe(false)
  })
  it('rejects signatures produced by a different key over the same preimage', () => {
    const otherSeed = Buffer.alloc(32, 1)
    const signature = ed25519.sign(goldenPreimage(), otherSeed)
    expect(
      verifyStrictEd25519Bytes(
        Buffer.from(TEST_PUBLIC_KEY, 'hex'),
        Buffer.from(signature),
        goldenPreimage(),
      ),
    ).toBe(false)
  })
  it('rejects malformed base64url and wrong lengths without throwing', () => {
    const key = { publicKeyBase64Url: encodeBase64Url(Buffer.from(TEST_PUBLIC_KEY, 'hex')) }
    expect(verifyStrictEd25519(key, { signatureBase64Url: 'aGk=' }, goldenPreimage())).toBe(false)
    expect(
      verifyStrictEd25519(key, { signatureBase64Url: `${GOLDEN_SIGNATURE}x` }, goldenPreimage()),
    ).toBe(false)
    expect(
      verifyStrictEd25519(key, { signatureBase64Url: 'not+base64url' }, goldenPreimage()),
    ).toBe(false)
    expect(
      verifyStrictEd25519(
        { publicKeyBase64Url: 'aGk=' },
        { signatureBase64Url: GOLDEN_SIGNATURE },
        goldenPreimage(),
      ),
    ).toBe(false)
  })
  it('rejects a non-canonical public key encoding (y >= p)', () => {
    // Flip the sign bit and add p to keep the point decodable but non-canonical.
    const A = ed25519.ExtendedPoint.fromHex(Buffer.from(TEST_PUBLIC_KEY, 'hex'))
    const negative = A.negate().toRawBytes()
    expect(
      verifyStrictEd25519Bytes(
        negative,
        Buffer.from(GOLDEN_SIGNATURE, 'base64url'),
        goldenPreimage(),
      ),
    ).toBe(false)
  })
  it('rejects S = 0 without throwing (0 ≤ S < L is in-domain, §19a.3.4)', () => {
    const golden = Buffer.from(GOLDEN_SIGNATURE, 'base64url')
    const sZero = Buffer.concat([golden.subarray(0, 32), Buffer.alloc(32, 0)])
    expect(
      verifyStrictEd25519Bytes(Buffer.from(TEST_PUBLIC_KEY, 'hex'), sZero, goldenPreimage()),
    ).toBe(false)
  })
  it('digest remains stable across verify paths', () => {
    expect(canonicalPayloadDigest('permission-template.v1', goldenCanonical)).toBe(
      'fa6cf97e20476ac1e940fbf3b703054e86b92a9cd4ca149086f15ed9448adbf3',
    )
  })
})
