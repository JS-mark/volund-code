/**
 * @apollo-code/capability-contract root barrel (§19a.13.3).
 *
 * Bootstrap primitives only: Canonical JSON V1, nominal digests and domain
 * separation, and strict Ed25519 VERIFICATION helpers. The `./authority`
 * subpath (detached-signature preimage/verify) is intentionally NOT
 * re-exported here; plugin-sdk and production surfaces must not see it.
 */

export {
  CAPABILITY_CONTRACT_ERROR_CODE,
  CAPABILITY_ADMISSION_ERROR_CODE,
  PARSE_PHASES,
  CapabilityContractError,
} from './errors'
export type {
  CapabilityAdmissionErrorCodeV1,
  CapabilityContractErrorCodeV1,
  ContractErrorDetail,
} from './errors'

export { encodeCanonical, parseCanonicalJson, validateUtf8 } from './canonical'
export type { CanonicalParseLimits, CanonicalParseResult } from './canonical'

export {
  canonicalPayloadDigest,
  decodeBase64UrlStrict,
  domainSeparatedBytes,
  encodeBase64Url,
} from './digest'
export type {
  CanonicalPayloadDigestV1,
  ExternalDigestV1,
  JournalDigestV1,
  RawContentDigestV1,
  SelfDevRunJournalDigestV1,
} from './digest'

export { verifyStrictEd25519, verifyStrictEd25519Bytes } from './signature'
export type { StrictEd25519Key, StrictEd25519Signature } from './signature'
