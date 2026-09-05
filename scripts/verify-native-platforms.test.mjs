import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../', import.meta.url)
const targets = [
  ['darwin-arm64', 'darwin', 'arm64'],
  ['darwin-x64', 'darwin', 'x64'],
  ['linux-arm64-gnu', 'linux', 'arm64', 'glibc'],
  ['linux-x64-gnu', 'linux', 'x64', 'glibc'],
  ['linux-arm64-musl', 'linux', 'arm64', 'musl'],
  ['linux-x64-musl', 'linux', 'x64', 'musl'],
  ['win32-arm64-msvc', 'win32', 'arm64'],
  ['win32-x64-msvc', 'win32', 'x64'],
]

void test('publishes all native binaries as versioned GitHub Release assets', async () => {
  const [workflow, bridge, workspace] = await Promise.all([
    readFile(new URL('.github/workflows/native.yml', root), 'utf8'),
    readFile(new URL('packages/native-bridge/package.json', root), 'utf8'),
    readFile(new URL('pnpm-workspace.yaml', root), 'utf8'),
  ])
  assert.match(workflow, /tags: \['v\*'\]/)
  assert.match(workflow, /release-assets\/volund-\$kind-\$suffix\$extension/)
  assert.match(workflow, /write-sidecar-checksums/)
  assert.match(workflow, /verify-standalone/)
  assert.doesNotMatch(workflow, /> checksums\.sha256/)
  assert.match(workflow, /gh release create "\$GITHUB_REF_NAME" "\$\{all_asset_paths\[@\]\}"/)
  assert.doesNotMatch(workflow, /gh release upload/)
  assert.doesNotMatch(bridge, /optionalDependencies/)
  assert.doesNotMatch(workspace, /platforms\/\*/)
  assert.match(workflow, /for kind in sandbox search fs/)
  assert.equal(targets.length * 3, 24)
})

void test('CI verifies foundation targets without weakening sandbox evidence', async () => {
  const nativeWorkflow = await readFile(new URL('.github/workflows/native.yml', root), 'utf8')
  assert.match(
    nativeWorkflow,
    /taiki-e\/install-action@[0-9a-f]{40} # cargo-deny\s+with:\s+tool: cargo-deny[\s\S]*cargo deny check licenses bans/,
  )
  assert.doesNotMatch(nativeWorkflow, /EmbarkStudios\/cargo-deny-action/)
  assert.match(
    nativeWorkflow,
    /Run strict doctor against sandbox-capable target artifacts[\s\S]*doctor --strict --json/,
  )
  assert.match(
    nativeWorkflow,
    /runner\.os == 'Windows'[\s\S]*pnpm turbo run build --filter=@volund\/cli\.\.\. --concurrency=1/,
    'Windows native jobs must avoid concurrent Node DLL initialization failures',
  )
  assert.match(
    nativeWorkflow,
    /runner\.os != 'Windows'[\s\S]*pnpm turbo run build --filter=@volund\/cli\.\.\./,
    'native jobs must not start the independent TypeDoc/VitePress build in parallel',
  )
  assert.doesNotMatch(nativeWorkflow, /runner\.os == 'Windows'[\s\S]{0,120}docs/)

  const escapeWorkflow = await readFile(
    new URL('.github/workflows/sandbox-escape.yml', root),
    'utf8',
  )
  assert.match(
    escapeWorkflow,
    /runner\.os == 'Linux' && matrix\.verification != 'partial-verified'[\s\S]*kernel\.unprivileged_userns_clone=1/,
  )
  assert.match(escapeWorkflow, /name: Record verification evidence\s+shell: bash\s+run:/)

  const windowsTier2 = await readFile(
    new URL('crates/volund-sandbox/tests/escape/windows-tier2.ps1', root),
    'utf8',
  )
  assert.match(escapeWorkflow, /verification: native-tier2/)
  assert.match(windowsTier2, /tier -ne 'partial'/)
  assert.match(windowsTier2, /acl_rollback/)
  assert.match(windowsTier2, /orphan_cleanup/)
  assert.match(windowsTier2, /SeDebugPrivilege\|SeShutdownPrivilege\|SeTakeOwnershipPrivilege/)
  assert.match(windowsTier2, /grandchild escape/)
  assert.match(windowsTier2, /outside the filesystem allowlist/)

  const graviton = await readFile(new URL('.github/workflows/graviton-evidence.yml', root), 'utf8')
  assert.match(graviton, /workflow_dispatch:/)
  assert.match(graviton, /self-hosted, linux, arm64, volund-graviton/)
  assert.match(graviton, /candidate_sha=.*inputs\.candidate_sha/)
  assert.match(graviton, /exit_code=/)

  const l3Evidence = await readFile(new URL('docs/releases/L3-EXTERNAL-EVIDENCE.md', root), 'utf8')
  assert.match(l3Evidence, /not executed/i)
  assert.match(l3Evidence, /default deny/)
  assert.match(windowsTier2, /ACE was not rolled back/)

  assert.match(nativeWorkflow, /Authenticode self-sign smoke \(non-production\)/)
  assert.match(nativeWorkflow, /timeout-minutes: 5/)
  assert.match(nativeWorkflow, /apt-get install -y osslsigncode/)
  assert.match(nativeWorkflow, /openssl req -x509/)
  assert.match(nativeWorkflow, /osslsigncode sign/)
  assert.match(nativeWorkflow, /osslsigncode verify/)
  assert.doesNotMatch(nativeWorkflow, /certutil|New-SelfSignedCertificate|signtool\.exe/)
  assert.match(nativeWorkflow, /Expected 3 Windows binaries/)
  assert.match(nativeWorkflow, /production_signature=false/)
  assert.match(nativeWorkflow, /macOS notarization external release gate/)
  assert.match(nativeWorkflow, /credentials=not-checked/)
  assert.match(nativeWorkflow, /submission=protected-release-environment-required/)
  assert.doesNotMatch(nativeWorkflow, /APPLE_ID|APPLE_TEAM_ID|APPLE_APP_PASSWORD/)
})
