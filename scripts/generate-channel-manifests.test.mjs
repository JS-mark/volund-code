import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  renderChannelFiles,
  TARGETS,
  validateChannelInput,
  writeChannelFiles,
} from './generate-channel-manifests.mjs'

const fixture = new URL('../docs/releases/channel-dry-run.json', import.meta.url)
const load = async () => JSON.parse(await readFile(fixture, 'utf8'))

void test('renders all channel manifests deterministically', async () => {
  const input = await load()
  assert.deepEqual(validateChannelInput(input), [])
  const first = renderChannelFiles(input)
  const second = renderChannelFiles(structuredClone(input))
  assert.deepEqual([...first], [...second])
  assert.match(first.get('homebrew/Formula/volund-code.rb'), /on_arm[\s\S]*on_intel/)
  assert.match(
    first.get('winget/VolundCode.VolundCode.yaml'),
    /Architecture: x64[\s\S]*Architecture: arm64/,
  )
  assert.match(first.get('winget/VolundCode.VolundCode.yaml'), /PackageName: Volund CLI/)
  assert.match(first.get('winget/VolundCode.VolundCode.yaml'), /PortableCommandAlias: volund/)
  assert.match(first.get('homebrew/Formula/volund-code.rb'), /Volund CLI/)
  assert.match(first.get('homebrew/Formula/volund-code.rb'), /"volund" => "volund"/)
  const apt = JSON.parse(first.get('apt/packages.json'))
  assert.deepEqual(
    apt.artifacts.map(({ target }) => target),
    TARGETS.filter((target) => target.startsWith('linux-')),
  )
  assert.deepEqual(new Set(apt.artifacts.map(({ libc }) => libc)), new Set(['glibc', 'musl']))
})

void test('checked-in dry-run output is current', async () => {
  await writeChannelFiles(
    await load(),
    fileURLToPath(new URL('../docs/releases/channel-dry-run', import.meta.url)),
    true,
  )
})

void test('rejects missing, duplicate, malformed checksum and wrong target mapping', async () => {
  const input = await load()
  input.assets.pop()
  input.assets.push({
    ...input.assets[0],
    sha256: 'wrong',
    url: input.assets[0].url.replace(input.assets[0].target, 'wrong-target'),
  })
  const errors = validateChannelInput(input).join('\n')
  assert.match(errors, /duplicate target/)
  assert.match(errors, /missing target win32-arm64-msvc/)
  assert.match(errors, /sha256/)
  assert.match(errors, /url must contain target/)
})

void test('fails closed when release evidence is promoted without authorization', async () => {
  const input = await load()
  input.evidenceGate = { ...input.evidenceGate, status: 'pass', releaseReady: true }
  input.assets[0].tier = 'Full'
  assert.match(validateChannelInput(input).join('\n'), /blocked/)
  assert.match(validateChannelInput(input).join('\n'), /Full tier requires authorized evidence/)
})

void test('detects stale generated output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'volund-channel-'))
  try {
    const input = await load()
    await assert.rejects(() => writeChannelFiles(input, root, true), /stale/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
