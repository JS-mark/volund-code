export type SecretKind =
  | 'authorization_header'
  | 'aws_access_key'
  | 'credential_assignment'
  | 'credential_uri'
  | 'github_token'
  | 'google_api_key'
  | 'jwt'
  | 'npm_token'
  | 'openai_api_key'
  | 'private_key'
  | 'provider_token'

export interface SecretDetection {
  /** Stable, non-sensitive identifier suitable for security audit metadata. */
  readonly kind: SecretKind
}

interface SecretRule {
  readonly kind: SecretKind
  readonly pattern: RegExp
}

const secretRules: readonly SecretRule[] = [
  {
    kind: 'private_key',
    pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/i,
  },
  {
    kind: 'authorization_header',
    pattern:
      /\b(?:proxy[\s_-]*)?authorization\s*(?::|=>|->|=)\s*(?:bearer|basic|digest|token)\s*[A-Za-z0-9._~+/=-]{6,}/i,
  },
  {
    kind: 'openai_api_key',
    pattern: /(?:^|[^A-Za-z0-9])sk-(?:(?:proj|svcacct)-[A-Za-z0-9_-]{8,}|[A-Za-z0-9]{20,})/i,
  },
  {
    kind: 'github_token',
    pattern: /(?:^|[^A-Za-z0-9])(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})/i,
  },
  {
    kind: 'aws_access_key',
    pattern: /(?:^|[^A-Z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?:$|[^A-Z0-9])/,
  },
  {
    kind: 'jwt',
    pattern:
      /(?:^|[^A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}(?:$|[^A-Za-z0-9_-])/,
  },
  {
    kind: 'google_api_key',
    pattern: /(?:^|[^A-Za-z0-9])AIza[A-Za-z0-9_-]{20,}/,
  },
  {
    kind: 'npm_token',
    pattern: /(?:^|[^A-Za-z0-9])npm_[A-Za-z0-9]{20,}/i,
  },
  {
    kind: 'provider_token',
    pattern:
      /(?:^|[^A-Za-z0-9])(?:sk-ant-[A-Za-z0-9_-]{12,}|hf_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{12,}|sk_(?:live|test)_[A-Za-z0-9]{12,}|SG\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,})/i,
  },
]

const credentialUriPattern =
  /\b(?:https?|postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|amqps?|ftp|ssh):\/\/[^\s/:@]+:([^\s/@]+)@/i
const credentialKeySource = String.raw`(?:api[\s_.-]*key|access[\s_.-]*(?:key|token)|auth[\s_.-]*token|client[\s_.-]*secret|credential|oauth[\s_.-]*code|pass(?:phrase|word)|private[\s_.-]*key|secret|token)`
const credentialKeyPattern = new RegExp(`^(?:${credentialKeySource})$`, 'i')
const credentialAssignmentPattern = new RegExp(
  String.raw`\b${credentialKeySource}\s*(?::|=>|->|=)\s*["'\x60]?([^\s"'\x60,;]+)`,
  'i',
)

const harmlessPlaceholders = new Set([
  '***',
  '[redacted]',
  '<redacted>',
  'changeme',
  'example',
  'fake',
  'none',
  'null',
  'placeholder',
  'redacted',
  'sample',
  'test',
  'undefined',
  'value',
  'your-key-here',
  'your-token-here',
])

/**
 * Normalizes only the value used by secret detectors. Callers must retain the original value for
 * display, execution, persistence, and identity-sensitive matching.
 */
export function normalizeForSecretDetection(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/\p{Cf}/gu, '')
    .replace(/[‐‑‒–—―−]/g, '-')
}

/** Uses the same canonical credential-label grammar as assignment detection. */
export function isCredentialKeyForSecretDetection(value: string): boolean {
  return credentialKeyPattern.test(normalizeForSecretDetection(value))
}

function isHarmlessPlaceholder(value: string): boolean {
  const normalized = value.replace(/[.,]+$/g, '').toLocaleLowerCase('en-US')
  return (
    harmlessPlaceholders.has(normalized) ||
    /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(normalized) ||
    /^\{\{[A-Za-z_][A-Za-z0-9_.-]*\}\}$/.test(normalized)
  )
}

function containsCredentialValue(pattern: RegExp, value: string, minimumLength: number): boolean {
  const matcher = new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`)
  for (const match of value.matchAll(matcher)) {
    const candidate = match[1]
    if (
      candidate &&
      candidate.replace(/[.,]+$/g, '').length >= minimumLength &&
      !isHarmlessPlaceholder(candidate)
    )
      return true
  }
  return false
}

/**
 * Detects credential material without returning the matched value. Prefix rules are intentionally
 * strict; generic assignments require a credential label and ignore common documentation
 * placeholders to keep ordinary prose usable.
 */
export function detectSecret(value: string): SecretDetection | undefined {
  const normalized = normalizeForSecretDetection(value)
  for (const rule of secretRules) {
    if (rule.pattern.test(normalized)) return { kind: rule.kind }
  }

  if (containsCredentialValue(credentialUriPattern, normalized, 1))
    return { kind: 'credential_uri' }
  if (containsCredentialValue(credentialAssignmentPattern, normalized, 6))
    return { kind: 'credential_assignment' }

  return undefined
}
