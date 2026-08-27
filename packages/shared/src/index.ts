export type JsonPrimitive = boolean | null | number | string
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

export interface Logger {
  debug(message: string, context?: Record<string, JsonValue>): void
  error(message: string, context?: Record<string, JsonValue>): void
  info(message: string, context?: Record<string, JsonValue>): void
  warn(message: string, context?: Record<string, JsonValue>): void
}

export class VolundError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: JsonValue,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'VolundError'
  }
}

export { validateWorkspacePath } from './path-guard'
export { productIdentity, type ProductIdentity } from './product-identity'
export { sanitize } from './sanitize'
export {
  detectSecret,
  isCredentialKeyForSecretDetection,
  normalizeForSecretDetection,
  type SecretDetection,
  type SecretKind,
} from './secret-detector'
export * from './config-schema'
export * from './error-codes'
export * from './errors'
export * from './events'
export * from './protocol'
