import { ed25519 } from '@noble/curves/ed25519'

import { decodeBase64UrlStrict } from './digest'

/**
 * ContractStrictPureEd25519V1 verification (§19a.3.4): a strict RFC 8032
 * subset with explicit canonicality, identity, small-order, torsion, and
 * scalar-range checks, and the exact non-cofactored verification equation.
 * This module only VERIFIES; signing material never enters this package.
 */

const CURVE_ORDER_L = ed25519.CURVE.n
const Point = ed25519.ExtendedPoint
const IDENTITY = Point.ZERO

/** noble's multiply rejects 0 scalars; 0·P is the identity by definition. */
const scalarMultiply = (point: NoblePoint, scalar: bigint): NoblePoint =>
  scalar === 0n ? Point.ZERO : point.multiply(scalar)

export interface StrictEd25519Key {
  /** 32 raw bytes (strict base64url, no padding). */
  readonly publicKeyBase64Url: string
}

export interface StrictEd25519Signature {
  /** 64 raw bytes (strict base64url, no padding). */
  readonly signatureBase64Url: string
}

type NoblePoint = ReturnType<typeof ed25519.ExtendedPoint.fromHex>

function canonicalPoint(bytes: Uint8Array): NoblePoint | undefined {
  try {
    const point = Point.fromHex(bytes)
    // fromHex rejects non-canonical encodings (y >= p); re-encode equality
    // additionally guards against any decoder leniency.
    return Buffer.from(point.toRawBytes()).compare(Buffer.from(bytes)) === 0 ? point : undefined
  } catch {
    return undefined
  }
}

function littleEndianScalar(bytes: Uint8Array): bigint {
  let value = 0n
  for (let index = bytes.byteLength - 1; index >= 0; index -= 1)
    value = (value << 8n) | BigInt(bytes[index]!)
  return value
}

/** h = SHA-512(R || A || M) interpreted little-endian, reduced mod L. */
function challengeScalar(R: Uint8Array, A: Uint8Array, message: Uint8Array): bigint {
  const hashed = ed25519.CURVE.hash(
    Buffer.concat([Buffer.from(R), Buffer.from(A), Buffer.from(message)]),
  )
  return (
    (littleEndianScalar(hashed.subarray(0, 32)) |
      (littleEndianScalar(hashed.subarray(32, 64)) << 256n)) %
    CURVE_ORDER_L
  )
}

/**
 * Verify a signature over `message` (the exact domain-separated bytes).
 * Returns false — never throws — for every malformed or failing input:
 * non-canonical A or R encodings, identity/small-order points,
 * non-torsion-free points, S >= L, or a failed verification equation.
 */
export function verifyStrictEd25519(
  key: StrictEd25519Key,
  signature: StrictEd25519Signature,
  message: Uint8Array,
): boolean {
  const publicKeyBytes = decodeBase64UrlStrict(key.publicKeyBase64Url)
  if (publicKeyBytes === undefined || publicKeyBytes.byteLength !== 32) return false
  const signatureBytes = decodeBase64UrlStrict(signature.signatureBase64Url)
  if (signatureBytes === undefined || signatureBytes.byteLength !== 64) return false
  return verifyStrictEd25519Bytes(publicKeyBytes, signatureBytes, message)
}

export function verifyStrictEd25519Bytes(
  publicKeyBytes: Uint8Array,
  signatureBytes: Uint8Array,
  message: Uint8Array,
): boolean {
  if (publicKeyBytes.byteLength !== 32 || signatureBytes.byteLength !== 64) return false
  const A = canonicalPoint(publicKeyBytes)
  if (A === undefined || A.equals(IDENTITY) || A.isSmallOrder() || !A.isTorsionFree()) return false
  const R = canonicalPoint(signatureBytes.subarray(0, 32))
  if (R === undefined || R.equals(IDENTITY) || R.isSmallOrder() || !R.isTorsionFree()) return false
  const S = littleEndianScalar(signatureBytes.subarray(32, 64))
  // §19a.3.4 scalar domain is 0 ≤ S < L; S = 0 must evaluate (not throw).
  if (S >= CURVE_ORDER_L) return false
  const h = challengeScalar(signatureBytes.subarray(0, 32), publicKeyBytes, message)
  // Exact non-cofactored equation: [S]B = R + [h]A. Both scalar products go
  // through the zero guard — noble's multiply rejects 0, and h ≡ 0 (mod L)
  // is unreachable for an attacker but must still not throw.
  return scalarMultiply(Point.BASE, S).equals(R.add(scalarMultiply(A, h)))
}
