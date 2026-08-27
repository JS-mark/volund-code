#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const TARGETS = [
  'darwin-arm64',
  'darwin-x64',
  'linux-x64-gnu',
  'linux-arm64-gnu',
  'linux-x64-musl',
  'linux-arm64-musl',
  'win32-x64-msvc',
  'win32-arm64-msvc',
]

const SHA256 = /^[a-f0-9]{64}$/
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const safe = (value) => JSON.stringify(String(value))
const displayName = 'Volund CLI'
const commandName = 'volund'
const description = 'Open, model-agnostic AI coding CLI'

export function validateChannelInput(input) {
  const errors = []
  if (input?.schemaVersion !== 1) errors.push('schemaVersion must equal 1')
  if (!VERSION.test(input?.version ?? ''))
    errors.push('version must be a semver without a v prefix')
  if (input?.license !== 'Apache-2.0') errors.push('license must equal Apache-2.0')
  if (!Array.isArray(input?.dependencies)) errors.push('dependencies must be an array')
  if (!input?.evidenceGate || input.evidenceGate.status !== 'blocked')
    errors.push('evidenceGate.status must be blocked for an unauthorized dry-run')
  if (input?.evidenceGate?.releaseReady !== false)
    errors.push('evidenceGate.releaseReady must be false for a dry-run')
  if (!input?.evidenceGate?.source?.trim()) errors.push('evidenceGate.source is required')
  if (!input?.disclosure?.includes('NOT PUBLISHED'))
    errors.push('disclosure must explicitly contain NOT PUBLISHED')

  const assets = new Map()
  for (const [index, asset] of (input?.assets ?? []).entries()) {
    if (!TARGETS.includes(asset?.target)) errors.push(`assets[${index}]: unsupported target`)
    if (assets.has(asset?.target)) errors.push(`assets[${index}]: duplicate target ${asset.target}`)
    assets.set(asset?.target, asset)
    if (!URL.canParse(asset?.url ?? '') || !asset.url.startsWith('https://'))
      errors.push(`assets[${index}]: url must be https`)
    if (!asset?.url?.includes(`v${input.version}`))
      errors.push(`assets[${index}]: url must contain version v${input.version}`)
    if (!asset?.url?.includes(asset?.target ?? ''))
      errors.push(`assets[${index}]: url must contain target ${asset?.target}`)
    if (!SHA256.test(asset?.sha256 ?? ''))
      errors.push(`assets[${index}]: sha256 must be 64 lowercase hex characters`)
    if (!['Full', 'Partial', 'Weak', 'None'].includes(asset?.tier))
      errors.push(`assets[${index}]: tier must be Full, Partial, Weak, or None`)
    if (asset?.tier === 'Full')
      errors.push(`assets[${index}]: Full tier requires authorized evidence`)
    if (!asset?.tierReason?.trim()) errors.push(`assets[${index}]: tierReason is required`)
  }
  for (const target of TARGETS) if (!assets.has(target)) errors.push(`missing target ${target}`)
  if (assets.size !== TARGETS.length)
    errors.push(`expected exactly ${TARGETS.length} unique assets, received ${assets.size}`)
  return [...new Set(errors)].toSorted()
}

const yaml = (input, assets) =>
  `# ${input.disclosure}\nPackageIdentifier: VolundCode.VolundCode\nPackageVersion: ${input.version}\nPackageLocale: en-US\nPublisher: ${displayName}\nPackageName: ${displayName}\nLicense: ${input.license}\nShortDescription: ${description}\nManifestType: singleton\nManifestVersion: 1.9.0\nInstallers:\n${assets
    .map(
      (asset) =>
        `  - Architecture: ${asset.target.includes('arm64') ? 'arm64' : 'x64'}\n    InstallerType: zip\n    InstallerUrl: ${asset.url}\n    InstallerSha256: ${asset.sha256.toUpperCase()}\n    NestedInstallerType: portable\n    NestedInstallerFiles:\n      - RelativeFilePath: volund.exe\n        PortableCommandAlias: ${commandName}\n    # Tier: ${asset.tier}; ${asset.tierReason}`,
    )
    .join('\n')}\n`

export function renderChannelFiles(input) {
  const errors = validateChannelInput(input)
  if (errors.length) throw new Error(`invalid channel input:\n${errors.join('\n')}`)
  const byTarget = new Map(input.assets.map((asset) => [asset.target, asset]))
  const mac = ['darwin-arm64', 'darwin-x64'].map((target) => byTarget.get(target))
  const windows = ['win32-x64-msvc', 'win32-arm64-msvc'].map((target) => byTarget.get(target))
  const linux = TARGETS.filter((target) => target.startsWith('linux-')).map((target) =>
    byTarget.get(target),
  )
  const formula = `# ${input.disclosure}\nclass VolundCode < Formula\n  desc ${safe(`${displayName} — ${description}`)}\n  homepage "https://github.com/JS-mark/volund-code"\n  version ${safe(input.version)}\n  license ${safe(input.license)}\n\n${mac
    .map(
      (asset) =>
        `  on_${asset.target.includes('arm64') ? 'arm' : 'intel'} do\n    url ${safe(asset.url)}\n    sha256 ${safe(asset.sha256)}\n    # Tier: ${asset.tier}; ${asset.tierReason}\n  end`,
    )
    .join(
      '\n\n',
    )}\n\n  def install\n    bin.install "volund"\n    bin.install_symlink "volund" => "${commandName}"\n  end\nend\n`
  const apt = {
    schemaVersion: 1,
    disclosure: input.disclosure,
    evidenceGate: input.evidenceGate,
    package: 'volund-code',
    version: input.version,
    license: input.license,
    dependencies: input.dependencies,
    artifacts: linux.map(({ target, url, sha256, tier, tierReason }) => ({
      target,
      architecture: target.includes('arm64') ? 'arm64' : 'amd64',
      libc: target.endsWith('-musl') ? 'musl' : 'glibc',
      format: target.endsWith('-musl') ? 'portable-tarball' : 'deb-dry-run',
      url,
      sha256,
      tier,
      tierReason,
    })),
  }
  const checksums =
    input.assets
      .map((asset) => `${asset.sha256}  ${new URL(asset.url).pathname.split('/').at(-1)}`)
      .join('\n') + '\n'
  return new Map([
    ['homebrew/Formula/volund-code.rb', formula],
    ['winget/VolundCode.VolundCode.yaml', yaml(input, windows)],
    ['apt/packages.json', `${JSON.stringify(apt, null, 2)}\n`],
    ['checksums.sha256', checksums],
  ])
}

export async function writeChannelFiles(input, output, check = false) {
  const files = renderChannelFiles(input)
  for (const [relative, content] of files) {
    const path = join(output, relative)
    if (check) {
      if ((await readFile(path, 'utf8').catch(() => '')) !== content)
        throw new Error(`${relative} is stale`)
    } else {
      await mkdir(resolve(path, '..'), { recursive: true })
      await writeFile(path, content)
    }
  }
  return createHash('sha256')
    .update([...files.values()].join('\0'))
    .digest('hex')
}

async function main(argv) {
  const value = (flag) => argv[argv.indexOf(flag) + 1]
  const inputPath = value('--input')
  const output = value('--output')
  if (!inputPath || !output)
    throw new Error(
      'usage: generate-channel-manifests.mjs --input <json> --output <directory> [--check]',
    )
  const input = JSON.parse(await readFile(inputPath, 'utf8'))
  const digest = await writeChannelFiles(input, output, argv.includes('--check'))
  process.stdout.write(`channel dry-run digest ${digest}\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
