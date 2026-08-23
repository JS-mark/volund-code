import { createHash } from 'node:crypto'

/**
 * Nominal digest forms and domain separation (§19a.3). The five forms are
 * distinct nominal types: they must never collapse to a shared `string` in
 * signatures or storage.
 */

declare const rawContentDigestBrand: unique symbol
declare const externalDigestBrand: unique symbol
declare const canonicalPayloadDigestBrand: unique symbol
declare const journalDigestBrand: unique symbol
declare const selfDevRunJournalDigestBrand: unique symbol

export type RawContentDigestV1 = string & { readonly [rawContentDigestBrand]: never }
export type ExternalDigestV1 = string & { readonly [externalDigestBrand]: never }
export type CanonicalPayloadDigestV1 = string & { readonly [canonicalPayloadDigestBrand]: never }
export type JournalDigestV1 = string & { readonly [journalDigestBrand]: never }
export type SelfDevRunJournalDigestV1 = string & {
  readonly [selfDevRunJournalDigestBrand]: never
}

const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

/**
 * Domain-separated preimage (§19a.3.2):
 * ASCII("plugin-kernel-contract\0v1\0") || ASCII(role) || 0x00 ||
 * uint64_be(byte_length(canonicalBytes)) || canonicalBytes
 */
export function domainSeparatedBytes(role: string, canonicalBytes: Uint8Array): Uint8Array {
  const prefix = Buffer.from(`plugin-kernel-contract\0v1\0${role}\0`, 'utf8')
  const length = Buffer.alloc(8)
  length.writeUInt32BE(0, 0)
  length.writeUInt32BE(canonicalBytes.byteLength, 4)
  return Buffer.concat([prefix, length, Buffer.from(canonicalBytes)])
}

/** canonicalPayloadDigest = lower-hex SHA-256 over the domain-separated bytes. */
export function canonicalPayloadDigest(
  role: string,
  canonicalBytes: Uint8Array,
): CanonicalPayloadDigestV1 {
  return sha256Hex(domainSeparatedBytes(role, canonicalBytes)) as CanonicalPayloadDigestV1
}

/** Strict RFC 4648 base64url without padding (§19a.3.4). */
export function encodeBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

export function decodeBase64UrlStrict(input: string): Uint8Array | undefined {
  // Runtime callers may hand us anything (untrusted frames): never throw.
  if (typeof input !== 'string') return undefined
  if (input.length === 0 || input.includes('=') || input.includes('+') || input.includes('/'))
    return undefined
  if (!/^[A-Za-z0-9_-]+$/.test(input)) return undefined
  const bytes = Buffer.from(input, 'base64url')
  // Non-shortest encodings are impossible in base64, but re-encode equality
  // still rejects any decoder leniency and padding variants.
  return bytes.toString('base64url') === input ? new Uint8Array(bytes) : undefined
}
