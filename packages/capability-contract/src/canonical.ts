import {
  CapabilityContractError,
  type CapabilityContractErrorCodeV1,
  type ContractErrorDetail,
} from './errors'

/**
 * Canonical JSON V1 (§19a.2): raw-byte admission, strict value domain, and
 * the canonical encoder. This is a bootstrap primitive of the capability
 * contract — the machine registry (ABI-00, not yet implemented) will reuse
 * exactly these rules for generated validators.
 *
 * The parsed representation is plain JSON (objects with original key order);
 * the canonical encoder is the only serializer and always re-sorts keys.
 */

const UTF8_REPLACEMENT = '\uFFFD'
const MAX_DEPTH = 32
const JSON_WHITESPACE = new Set([' ', '\t', '\n', '\r'])
const SAFE_INTEGER_MAX = 9007199254740991
const SAFE_INTEGER_MIN = -9007199254740991

export interface CanonicalParseLimits {
  /** Root byte limit; checked before any decoding (input-too-large). */
  readonly maxBytes: number
  /** Require the top-level value to be an object (§19a.2.1.3). */
  readonly requireTopLevelObject?: boolean
}

export interface CanonicalParseResult {
  /** Canonical re-encoding; equals the input bytes for accepted documents. */
  readonly canonicalBytes: Uint8Array
  /** Parsed value (objects keep original key order; use encodeCanonical to serialize). */
  readonly value: unknown
}

/** Strict UTF-8 validation: no BOM, overlong, surrogate, or truncated sequences. */
export function validateUtf8(bytes: Uint8Array): ContractErrorDetail | undefined {
  let index = 0
  const fail = (code: CapabilityContractErrorCodeV1): ContractErrorDetail => ({
    code,
    byteOffset: index,
  })
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    return fail('contract.bom-forbidden')
  while (index < bytes.length) {
    const lead = bytes[index]!
    if (lead < 0x80) {
      index += 1
      continue
    }
    let length: number
    let min: number
    if (lead >= 0xc2 && lead <= 0xdf) {
      length = 2
      min = 0x80
    } else if (lead >= 0xe0 && lead <= 0xef) {
      length = 3
      min = lead === 0xe0 ? 0xa0 : 0x80
      if (lead === 0xed) {
        // Surrogate halves must not appear in UTF-8 at all.
        const next = bytes[index + 1]
        if (next !== undefined && next >= 0xa0 && next <= 0xbf) return fail('contract.utf8-invalid')
      }
    } else if (lead >= 0xf0 && lead <= 0xf4) {
      length = 4
      min = lead === 0xf0 ? 0x90 : 0x80
    } else {
      // 0x80-0xBF stray continuation, 0xC0/0xC1 overlong, 0xF5-0xFF out of range.
      return fail('contract.utf8-invalid')
    }
    for (let offset = 1; offset < length; offset += 1) {
      const continuation = bytes[index + offset]
      const lowerBound = offset === 1 ? min : 0x80
      if (continuation === undefined || continuation < lowerBound || continuation > 0xbf)
        return fail('contract.utf8-invalid')
    }
    index += length
  }
  return undefined
}

const decodeUtf8 = (bytes: Uint8Array): string =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8')

const byteOffsetOf = (text: string, index: number): number =>
  Buffer.byteLength(text.slice(0, index), 'utf8')

interface ParseState {
  readonly text: string
  position: number
  readonly syntax: ContractErrorDetail[]
  readonly duplicates: ContractErrorDetail[]
  readonly valueDomain: ContractErrorDetail[]
}

class Parser {
  constructor(private readonly state: ParseState) {}
  private failSyntax(message: string): never {
    this.state.syntax.push({
      code: 'contract.json-syntax',
      byteOffset: byteOffsetOf(this.state.text, this.state.position),
      fieldPath: message,
    })
    throw PARSE_ABORT
  }
  private failValueDomain(): void {
    this.state.valueDomain.push({
      code: 'contract.value-domain',
      byteOffset: byteOffsetOf(this.state.text, this.state.position),
    })
  }
  private peek(): string {
    return this.state.text[this.state.position] ?? ''
  }
  skipWhitespace(): void {
    while (JSON_WHITESPACE.has(this.peek())) this.state.position += 1
  }
  private expect(character: string, message: string): void {
    this.skipWhitespace()
    if (this.peek() !== character) this.failSyntax(message)
    this.state.position += 1
  }
  parseValue(depth: number): unknown {
    if (depth > MAX_DEPTH) {
      this.failValueDomain()
      throw PARSE_ABORT
    }
    this.skipWhitespace()
    const character = this.peek()
    if (character === '{') return this.parseObject(depth)
    if (character === '[') return this.parseArray(depth)
    if (character === '"') return this.parseString()
    if (character === '-' || (character >= '0' && character <= '9')) return this.parseNumber()
    if (this.state.text.startsWith('true', this.state.position)) {
      this.state.position += 4
      return true
    }
    if (this.state.text.startsWith('false', this.state.position)) {
      this.state.position += 5
      return false
    }
    if (this.state.text.startsWith('null', this.state.position)) {
      this.state.position += 4
      return null
    }
    this.failSyntax('unexpected token')
  }
  private parseObject(depth: number): Record<string, unknown> {
    this.expect('{', 'expected {')
    const value: Record<string, unknown> = {}
    this.skipWhitespace()
    if (this.peek() === '}') {
      this.state.position += 1
      return value
    }
    for (;;) {
      this.skipWhitespace()
      if (this.peek() !== '"') this.failSyntax('expected object key')
      const key = this.parseString()
      this.expect(':', 'expected :')
      const member = this.parseValue(depth + 1)
      if (Object.hasOwn(value, key))
        this.state.duplicates.push({
          code: 'contract.duplicate-key',
          byteOffset: byteOffsetOf(this.state.text, this.state.position),
        })
      value[key] = member
      this.skipWhitespace()
      if (this.peek() === ',') {
        this.state.position += 1
        continue
      }
      if (this.peek() === '}') {
        this.state.position += 1
        return value
      }
      this.failSyntax('expected , or }')
    }
  }
  private parseArray(depth: number): unknown[] {
    this.expect('[', 'expected [')
    const value: unknown[] = []
    this.skipWhitespace()
    if (this.peek() === ']') {
      this.state.position += 1
      return value
    }
    for (;;) {
      value.push(this.parseValue(depth + 1))
      this.skipWhitespace()
      if (this.peek() === ',') {
        this.state.position += 1
        continue
      }
      if (this.peek() === ']') {
        this.state.position += 1
        return value
      }
      this.failSyntax('expected , or ]')
    }
  }
  private parseString(): string {
    this.state.position += 1
    let value = ''
    for (;;) {
      const character = this.state.text[this.state.position]
      if (character === undefined) this.failSyntax('unterminated string')
      if (character === '"') {
        this.state.position += 1
        return value
      }
      if (character === '\\') {
        this.state.position += 1
        const escape = this.state.text[this.state.position]
        if (escape === undefined) this.failSyntax('unterminated escape')
        if (escape === '"' || escape === '\\' || escape === '/') {
          value += escape
          this.state.position += 1
          continue
        }
        if (
          escape === 'b' ||
          escape === 'f' ||
          escape === 'n' ||
          escape === 'r' ||
          escape === 't'
        ) {
          value += { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }[escape]!
          this.state.position += 1
          continue
        }
        if (escape === 'u') {
          const hex = this.state.text.slice(this.state.position + 1, this.state.position + 5)
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.failSyntax('invalid unicode escape')
          let codePoint = Number.parseInt(hex, 16)
          this.state.position += 5
          if (codePoint >= 0xdc00 && codePoint <= 0xdfff) {
            // Lone low surrogate.
            this.failValueDomain()
            codePoint = 0xfffd
          } else if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
            if (
              this.state.text[this.state.position] === '\\' &&
              this.state.text[this.state.position + 1] === 'u'
            ) {
              const low = this.state.text.slice(this.state.position + 2, this.state.position + 6)
              if (/^[0-9a-fA-F]{4}$/.test(low)) {
                const lowPoint = Number.parseInt(low, 16)
                if (lowPoint >= 0xdc00 && lowPoint <= 0xdfff) {
                  codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (lowPoint - 0xdc00)
                  this.state.position += 6
                }
              }
            }
            if (codePoint <= 0xdbff) {
              // Lone high surrogate.
              this.failValueDomain()
              codePoint = 0xfffd
            }
          }
          value += String.fromCodePoint(codePoint)
          continue
        }
        this.failSyntax('invalid escape')
      }
      const codePoint = character.codePointAt(0)!
      if (codePoint <= 0x1f) this.failSyntax('raw control character in string')
      this.state.position += character.length
      value += character
    }
  }
  private parseNumber(): number {
    const start = this.state.position
    if (this.peek() === '-') this.state.position += 1
    const integerStart = this.state.position
    if (this.peek() === '0') {
      this.state.position += 1
    } else if (this.peek() >= '1' && this.peek() <= '9') {
      while (this.peek() >= '0' && this.peek() <= '9') this.state.position += 1
    } else {
      this.failSyntax('invalid number')
    }
    const hasLeadingZero =
      this.state.position - integerStart > 1 && this.state.text[integerStart] === '0'
    let fractional = false
    if (this.peek() === '.') {
      fractional = true
      this.state.position += 1
      if (!(this.peek() >= '0' && this.peek() <= '9')) this.failSyntax('invalid fraction')
      while (this.peek() >= '0' && this.peek() <= '9') this.state.position += 1
    }
    let exponent = false
    if (this.peek() === 'e' || this.peek() === 'E') {
      exponent = true
      this.state.position += 1
      if (this.peek() === '+' || this.peek() === '-') this.state.position += 1
      if (!(this.peek() >= '0' && this.peek() <= '9')) this.failSyntax('invalid exponent')
      while (this.peek() >= '0' && this.peek() <= '9') this.state.position += 1
    }
    const literal = this.state.text.slice(start, this.state.position)
    if (hasLeadingZero) this.failSyntax('leading zero')
    if (fractional || exponent || literal === '-0') {
      this.state.position = start
      this.failValueDomain()
      throw PARSE_ABORT
    }
    const value = Number.parseInt(literal, 10)
    if (value > SAFE_INTEGER_MAX || value < SAFE_INTEGER_MIN) {
      this.state.position = start
      this.failValueDomain()
      throw PARSE_ABORT
    }
    return value
  }
}

const PARSE_ABORT = Symbol('parse-abort')

/** Scalar ranges forbidden by the value domain (§19a.2.2), fixed and version-free. */
function forbiddenScalar(codePoint: number): boolean {
  if (codePoint <= 0x1f) return true
  if (codePoint >= 0x7f && codePoint <= 0x9f) return true
  if (codePoint >= 0xfdd0 && codePoint <= 0xfdef) return true
  if ((codePoint & 0xfffe) === 0xfffe) return true
  return (
    codePoint === 0x61c ||
    codePoint === 0x200e ||
    codePoint === 0x200f ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069)
  )
}

function validateScalars(state: ParseState, value: unknown): void {
  if (typeof value === 'string') {
    for (const character of value) {
      if (forbiddenScalar(character.codePointAt(0)!)) {
        state.valueDomain.push({
          code: 'contract.value-domain',
          byteOffset: byteOffsetOf(state.text, state.text.indexOf(character)),
        })
        return
      }
    }
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) validateScalars(state, item)
    return
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, member] of Object.entries(value)) {
      for (const character of key) {
        if (forbiddenScalar(character.codePointAt(0)!)) {
          state.valueDomain.push({ code: 'contract.value-domain' })
          return
        }
      }
      validateScalars(state, member)
    }
  }
}

const compareBytes = (a: string, b: string): number =>
  Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))

/** Canonical JSON V1 encoder: sorted keys, minimal escapes, raw UTF-8 scalars. */
export function encodeCanonical(value: unknown): Uint8Array {
  const chunks: string[] = []
  const write = (text: string): void => {
    chunks.push(text)
  }
  const writeString = (text: string): void => {
    write('"')
    for (const character of text) {
      const codePoint = character.codePointAt(0)!
      if (codePoint > 0x1f && codePoint < 0x7f && !forbiddenScalar(codePoint)) {
        // Escapes exist only for the two JSON metacharacters (§19a.2.3).
        write(character === '"' ? '\\"' : character === '\\' ? '\\\\' : character)
        continue
      }
      // Canonical encoder only receives domain-valid values; unreachable for
      // parsed documents, defended for programmatic callers.
      if (character === '"' || character === '\\') {
        write(`\\${character}`)
        continue
      }
      write(character)
    }
    write('"')
  }
  const writeValue = (item: unknown): void => {
    if (item === null) return write('null')
    if (item === true) return write('true')
    if (item === false) return write('false')
    if (typeof item === 'number') {
      if (!Number.isInteger(item) || item > SAFE_INTEGER_MAX || item < SAFE_INTEGER_MIN)
        throw new TypeError('canonical encoder requires safe integers')
      write(String(item))
      return
    }
    if (typeof item === 'string') return writeString(item)
    if (Array.isArray(item)) {
      write('[')
      item.forEach((element, index) => {
        if (index > 0) write(',')
        writeValue(element)
      })
      write(']')
      return
    }
    if (typeof item === 'object') {
      write('{')
      const entries = Object.entries(item as Record<string, unknown>).sort(([a], [b]) =>
        compareBytes(a, b),
      )
      entries.forEach(([key, member], index) => {
        if (index > 0) write(',')
        writeString(key)
        write(':')
        writeValue(member)
      })
      write('}')
      return
    }
    throw new TypeError('canonical encoder received a non-JSON value')
  }
  writeValue(value)
  return new TextEncoder().encode(chunks.join(''))
}

/**
 * Raw-byte admission + parse + canonical re-encode equality (§19a.2.1).
 * Throws CapabilityContractError with the FIRST error per the parse phase
 * vector; never includes raw bytes or document values in the error.
 */
export function parseCanonicalJson(
  bytes: Uint8Array,
  limits: CanonicalParseLimits,
): CanonicalParseResult {
  if (bytes.byteLength > limits.maxBytes)
    throw new CapabilityContractError({ code: 'contract.input-too-large' })
  const utf8Error = validateUtf8(bytes)
  if (utf8Error !== undefined) throw new CapabilityContractError(utf8Error)
  const text = decodeUtf8(bytes)
  if (text.includes(UTF8_REPLACEMENT) && !Buffer.from(bytes).includes(Buffer.of(0xef, 0xbf, 0xbd)))
    throw new CapabilityContractError({ code: 'contract.utf8-invalid' })
  const state: ParseState = {
    text,
    position: 0,
    syntax: [],
    duplicates: [],
    valueDomain: [],
  }
  const parser = new Parser(state)
  let value: unknown
  try {
    value = parser.parseValue(1)
    parser.skipWhitespace()
    if (state.position !== text.length)
      state.syntax.push({ code: 'contract.json-syntax', fieldPath: 'trailing content' })
  } catch (error) {
    if (error !== PARSE_ABORT) throw error
  }
  if (state.syntax.length === 0 && state.duplicates.length === 0) validateScalars(state, value)
  const reported =
    state.syntax[0] ??
    state.duplicates[0] ??
    state.valueDomain[0] ??
    (state.syntax.length > 0 || state.duplicates.length > 0 || state.valueDomain.length > 0
      ? [...state.syntax, ...state.duplicates, ...state.valueDomain][0]
      : undefined)
  if (reported !== undefined) throw new CapabilityContractError(reported)
  if (
    limits.requireTopLevelObject !== false &&
    (typeof value !== 'object' || value === null || Array.isArray(value))
  )
    throw new CapabilityContractError({ code: 'contract.schema-invalid', fieldPath: '' })
  const canonicalBytes = encodeCanonical(value)
  if (!Buffer.from(canonicalBytes).equals(Buffer.from(bytes)))
    throw new CapabilityContractError({ code: 'contract.noncanonical-bytes' })
  return { canonicalBytes, value }
}

/** Convenience for programmatic callers: encode + digest-ready canonical bytes. */
export function canonicalHex(value: unknown): string {
  return Buffer.from(encodeCanonical(value)).toString('hex')
}
