import { domainSeparatedBytes } from './digest'
import { verifyStrictEd25519, type StrictEd25519Key } from './signature'

/**
 * Authority subpath (§19a.13.2/§19a.13.3): the ONLY detached-signature
 * surface exported from this package, and it is pure — it accepts a closed
 * role plus public canonical bytes and never key material, handles, or
 * signing capability. The root barrel must not re-export this module.
 */

export interface DetachedSignatureEnvelope {
  readonly algorithm: 'ed25519'
  readonly keyId: string
  readonly signatureBase64Url: string
  readonly signedSchemaRole: string
  readonly version: 1
}

export interface VerifyDetachedSignatureInput {
  readonly expectedRole: string
  readonly canonicalBytes: Uint8Array
  readonly envelope: DetachedSignatureEnvelope
  readonly trustedKey: StrictEd25519Key
}

export type VerifyDetachedSignatureResult =
  | { readonly ok: true }
  | {
      readonly ok: false
      readonly reason: 'role-mismatch' | 'envelope-shape' | 'signature-invalid'
    }

/**
 * Pure preimage construction for detached signatures: verifier-built from
 * the CALLER-expected role and already-canonical bytes (§19a.3.4). The
 * envelope's self-reported role never selects the domain.
 */
export function buildDetachedSignaturePreimage(
  expectedRole: string,
  canonicalBytes: Uint8Array,
): Uint8Array {
  return domainSeparatedBytes(expectedRole, canonicalBytes)
}

export function verifyDetachedSignature(
  input: VerifyDetachedSignatureInput,
): VerifyDetachedSignatureResult {
  const envelope: unknown = input.envelope
  if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope))
    return { ok: false, reason: 'envelope-shape' }
  // Exact key set: unknown fields are rejected rather than silently ignored.
  // This bootstrap envelope intentionally omits `signedArtifact` from
  // §19a.3.4 SignatureEnvelopeV1 — the authority flow binds the payload via
  // caller-supplied `canonicalBytes` + `expectedRole`, not via a self-reported
  // artifact reference. The registry phase generates the full envelope schema.
  const keys = Object.keys(envelope).sort()
  if (
    keys.length !== 5 ||
    keys[0] !== 'algorithm' ||
    keys[1] !== 'keyId' ||
    keys[2] !== 'signatureBase64Url' ||
    keys[3] !== 'signedSchemaRole' ||
    keys[4] !== 'version'
  )
    return { ok: false, reason: 'envelope-shape' }
  const { algorithm, keyId, signatureBase64Url, signedSchemaRole, version } = envelope as Record<
    string,
    unknown
  >
  if (
    version !== 1 ||
    algorithm !== 'ed25519' ||
    typeof keyId !== 'string' ||
    keyId.length === 0 ||
    keyId.length > 128 ||
    // Visible ASCII only (0x21–0x7E): space is deliberately excluded — key ids
    // are machine identifiers, and a narrower reading fails closed. If the
    // registry freeze (ABI-00) later adopts inclusive 0x20–0x7E, align here.
    !/^[\x21-\x7e]+$/.test(keyId) ||
    typeof signatureBase64Url !== 'string'
  )
    return { ok: false, reason: 'envelope-shape' }
  if (signedSchemaRole !== input.expectedRole) return { ok: false, reason: 'role-mismatch' }
  const ok = verifyStrictEd25519(
    input.trustedKey,
    { signatureBase64Url },
    buildDetachedSignaturePreimage(input.expectedRole, input.canonicalBytes),
  )
  return ok ? { ok: true } : { ok: false, reason: 'signature-invalid' }
}
