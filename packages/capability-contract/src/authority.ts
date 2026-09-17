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
  const { envelope } = input
  if (
    envelope.version !== 1 ||
    envelope.algorithm !== 'ed25519' ||
    typeof envelope.keyId !== 'string' ||
    envelope.keyId.length === 0 ||
    envelope.keyId.length > 128 ||
    envelope.signedSchemaRole !== input.expectedRole
  )
    return { ok: false, reason: 'role-mismatch' }
  const ok = verifyStrictEd25519(
    input.trustedKey,
    { signatureBase64Url: envelope.signatureBase64Url },
    buildDetachedSignaturePreimage(input.expectedRole, input.canonicalBytes),
  )
  return ok ? { ok: true } : { ok: false, reason: 'signature-invalid' }
}
