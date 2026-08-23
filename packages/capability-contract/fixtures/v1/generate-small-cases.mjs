import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { canonicalPayloadDigest, domainSeparatedBytes, encodeCanonical } from '../../dist/index.js'

const fixturesRoot = join(import.meta.dirname, 'small')
mkdirSync(fixturesRoot, { recursive: true })

const hex = (bytes) => Buffer.from(bytes).toString('hex')
const bytes = (text) => Buffer.from(text, 'utf8')
const bytesHex = (hexString) => Buffer.from(hexString, 'hex')

const cases = []

const accept = (caseId, rawBytes, role) => {
  const canonicalBytes = encodeCanonical(JSON.parse(rawBytes.toString('utf8')))
  if (!Buffer.from(canonicalBytes).equals(rawBytes))
    throw new Error(`accept case ${caseId} is not canonical`)
  const domain = domainSeparatedBytes(role, canonicalBytes)
  cases.push({
    caseId,
    caseKind: 'contract',
    expectation: {
      canonicalHex: hex(canonicalBytes),
      digestExpectation: {
        digestRole: role,
        kind: 'typed',
        value: canonicalPayloadDigest(role, canonicalBytes),
      },
      domainHex: hex(domain),
      kind: 'accept',
      signatureExpectation: { kind: 'none' },
      version: 1,
    },
    expectedMediaRole: null,
    expectedRole: role,
    inputPath: `small/${caseId}.bin`,
    version: 1,
  })
  writeFileSync(join(fixturesRoot, `${caseId}.bin`), rawBytes)
}

const reject = (caseId, rawBytes, errorCode, role = null) => {
  cases.push({
    caseId,
    caseKind: 'contract',
    expectation: {
      errorCode,
      errorEnum: 'CapabilityContractErrorCodeV1',
      kind: 'reject',
      phase: 'parseArtifactBytes',
      version: 1,
    },
    expectedMediaRole: null,
    expectedRole: role,
    inputPath: `small/${caseId}.bin`,
    version: 1,
  })
  writeFileSync(join(fixturesRoot, `${caseId}.bin`), rawBytes)
}

// ---- accept cases (canonical bytes in, canonical bytes/digest out) ----
accept('accept-empty-object', bytes('{}'), 'registry-meta-schema.v1')
accept(
  'accept-golden-permission-template',
  bytes('{"effects":[],"version":1}'),
  'permission-template.v1',
)
accept('accept-integer', bytes('{"n":123}'), 'permission-template.v1')
accept('accept-raw-utf8', bytes('{"k":"héllo"}'), 'permission-template.v1')
accept('accept-nested', bytes('{"a":[1,{"b":true}],"c":null}'), 'permission-template.v1')
// `__proto__` is a plain own key: it must survive parse → canonical re-encode
// byte-identically (a prototype-setter swallow would fail noncanonical-bytes).
accept('accept-dunder-proto', bytes('{"__proto__":1}'), 'permission-template.v1')

// ---- reject cases: byte-level admission ----
reject('reject-bom', Buffer.concat([bytesHex('efbbbf'), bytes('{}')]), 'contract.bom-forbidden')
reject('reject-utf8-overlong', bytesHex('22c0af22'), 'contract.utf8-invalid')
reject('reject-utf8-surrogate-half', bytesHex('22eda08022'), 'contract.utf8-invalid')
reject(
  'reject-utf8-truncated',
  Buffer.concat([bytes('{"k":"a'), bytesHex('c3')]),
  'contract.utf8-invalid',
)

// ---- reject cases: syntax (whole-document syntax wins over later phases) ----
reject('reject-json-syntax', bytes('{"a":1'), 'contract.json-syntax')
reject('reject-leading-zero', bytes('{"n":01}'), 'contract.json-syntax')
// The sign does not launder a leading zero: `-01` is a document syntax error,
// not a value-domain finding (phase vector §19a.2.4).
reject('reject-negative-leading-zero', bytes('{"n":-01}'), 'contract.json-syntax')
// A pending member key with no value is a syntax error at the first member
// too — never a silently shortened object.
reject('reject-missing-member-value', bytes('{"a":}'), 'contract.json-syntax')
reject(
  'reject-raw-control',
  Buffer.concat([bytes('{"k":"a'), bytesHex('0a'), bytes('"}')]),
  'contract.json-syntax',
)

// ---- reject cases: duplicate keys by decoded scalar ----
reject('reject-duplicate-key', bytes('{"a":1,"a":2}'), 'contract.duplicate-key')
reject('reject-duplicate-key-escaped', bytes('{"a":1,"\\u0061":2}'), 'contract.duplicate-key')
reject(
  'reject-duplicate-key-dunder-proto',
  bytes('{"__proto__":1,"__proto__":2}'),
  'contract.duplicate-key',
)

// ---- reject cases: value domain ----
reject(
  'reject-depth-33',
  Buffer.from(`${'['.repeat(33)}${']'.repeat(33)}`),
  'contract.value-domain',
)
// Far beyond the depth cap: proves the parser is bounded by the counter, not
// by the call stack (a RangeError here would be an implementation defect).
reject(
  'reject-depth-1000',
  Buffer.from(`${'['.repeat(1000)}${']'.repeat(1000)}`),
  'contract.value-domain',
)
reject('reject-exponent', bytes('{"n":1e3}'), 'contract.value-domain')
reject('reject-float', bytes('{"n":1.5}'), 'contract.value-domain')
reject('reject-negzero', bytes('{"n":-0}'), 'contract.value-domain')
reject('reject-unsafe-integer', bytes('{"n":9007199254740992}'), 'contract.value-domain')
reject('reject-escaped-c0', bytes('{"k":"\\u0000"}'), 'contract.value-domain')
reject('reject-escaped-c1', bytes('{"k":"\\u009f"}'), 'contract.value-domain')
reject('reject-lone-low-surrogate', bytes('{"k":"\\udc00"}'), 'contract.value-domain')
reject('reject-lone-high-surrogate', bytes('{"k":"\\ud800"}'), 'contract.value-domain')
reject(
  'reject-noncharacter',
  Buffer.concat([bytes('{"k":"'), bytesHex('efb790'), bytes('"}')]),
  'contract.value-domain',
)
reject(
  'reject-bidi',
  Buffer.concat([bytes('{"k":"'), bytesHex('e280ae'), bytes('"}')]),
  'contract.value-domain',
)

// ---- reject cases: schema shape ----
reject('reject-top-level-array', bytes('[1]'), 'contract.schema-invalid')

// ---- reject cases: non-canonical bytes ----
reject('reject-noncanonical-escaped-key', bytes('{"\\u0061":1}'), 'contract.noncanonical-bytes')
reject('reject-noncanonical-unsorted', bytes('{"b":1,"a":2}'), 'contract.noncanonical-bytes')
reject('reject-noncanonical-whitespace', bytes('{"a": 1}'), 'contract.noncanonical-bytes')

const finalCases = cases.sort((a, b) =>
  Buffer.compare(Buffer.from(a.caseId), Buffer.from(b.caseId)),
)

const lines = finalCases.map((item) => Buffer.from(encodeCanonical(item)).toString('utf8'))
const text = `${lines.join('\n')}\n`
writeFileSync(join(import.meta.dirname, 'small-cases.ndjson'), text)
console.log(`wrote ${finalCases.length} cases`)
for (const item of finalCases) console.log(' ', item.caseId, item.expectation.kind)
