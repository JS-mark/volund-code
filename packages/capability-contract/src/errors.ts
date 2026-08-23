/**
 * §19a.2.4 closed error codes and phase vectors for the capability contract.
 *
 * These enums are the single source for first-error reporting in this
 * package; the machine registry (ABI-00, not yet implemented) will generate
 * the same literals for TS and Rust. Numeric ids below are stable registry
 * ids, NOT an execution order: the phase vectors in `PHASE_VECTORS` define
 * which code is reported first.
 */

export const CAPABILITY_CONTRACT_ERROR_CODE = [
  'contract.input-too-large',
  'contract.utf8-invalid',
  'contract.bom-forbidden',
  'contract.json-syntax',
  'contract.duplicate-key',
  'contract.value-domain',
  'contract.noncanonical-bytes',
  'contract.schema-invalid',
  'contract.role-media-invalid',
  'contract.ref-invalid',
  'contract.digest-mismatch',
  'contract.limit-exceeded',
  'contract.closure-invalid',
  'contract.signature-invalid',
  'contract.authority-invalid',
] as const
export type CapabilityContractErrorCodeV1 = (typeof CAPABILITY_CONTRACT_ERROR_CODE)[number]

export const CAPABILITY_ADMISSION_ERROR_CODE = [
  'admission.production-fence-closed',
  'admission.protected-store-unavailable',
  'admission.state-stale-or-revoked',
  'admission.deadline-not-live',
  'admission.resource-unavailable',
  'admission.replay',
] as const
export type CapabilityAdmissionErrorCodeV1 = (typeof CAPABILITY_ADMISSION_ERROR_CODE)[number]

/**
 * parseArtifactBytes / parseControlBytes phase vector (§19a.2.4), left to
 * right: report the first phase that produced an error.
 */
export const PARSE_PHASES = [
  'contract.input-too-large',
  'contract.utf8-invalid',
  'contract.bom-forbidden',
  'contract.json-syntax',
  'contract.duplicate-key',
  'contract.value-domain',
  'contract.noncanonical-bytes',
  'contract.schema-invalid',
] as const satisfies readonly CapabilityContractErrorCodeV1[]

/** Raw byte offset (or undefined) attached to an error for tie-breaking. */
export interface ContractErrorDetail {
  readonly code: CapabilityContractErrorCodeV1
  /** Byte offset of the first offending token when the phase is positional. */
  readonly byteOffset?: number
  /** Bounded canonical field path (ASCII, ≤256 bytes) for schema phase ties. */
  readonly fieldPath?: string
}

export class CapabilityContractError extends Error {
  constructor(readonly detail: ContractErrorDetail) {
    super(detail.code)
    this.name = 'CapabilityContractError'
  }
}
