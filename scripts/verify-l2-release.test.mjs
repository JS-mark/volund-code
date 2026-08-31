import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../', import.meta.url)
const read = (path) => readFile(new URL(path, root), 'utf8')
const json = async (path) => JSON.parse(await read(path))

void test('generates TypeDoc markdown inside the private VitePress site', async () => {
  const [rootManifest, docsManifest, typedoc, docsWorkflow] = await Promise.all([
    json('package.json'),
    json('apps/docs/package.json'),
    json('typedoc.json'),
    read('.github/workflows/docs.yml'),
  ])
  assert.equal(docsManifest.private, true)
  assert.match(rootManifest.scripts['docs:api'], /typedoc/)
  assert.match(docsManifest.scripts.build, /docs:api/)
  assert.equal(typedoc.out, 'apps/docs/api')
  assert.deepEqual(typedoc.plugin, ['typedoc-plugin-markdown'])
  assert.match(docsWorkflow, /packages\/\*\/src\/\*\*/)
  assert.match(docsWorkflow, /actions\/deploy-pages@v4/)
  assert.match(docsWorkflow, /enablement: true/)
})

void test('configures weekly Renovate updates with manual major approval', async () => {
  const renovate = await json('renovate.json')
  assert.deepEqual(renovate.schedule, ['before 6am on monday'])
  const automatic = renovate.packageRules.find((rule) => rule.automerge === true)
  const major = renovate.packageRules.find((rule) => rule.matchUpdateTypes?.includes('major'))
  assert.deepEqual(automatic.matchUpdateTypes, ['minor', 'patch', 'pin', 'digest'])
  assert.equal(major.automerge, false)
  assert.equal(major.dependencyDashboardApproval, true)
})

void test('keeps native binaries on GitHub Releases and docs excluded from npm', async () => {
  const [nativeWorkflow, bridge] = await Promise.all([
    read('.github/workflows/native.yml'),
    json('packages/native-bridge/package.json'),
  ])
  assert.match(nativeWorkflow, /Publish versioned native Release assets/)
  assert.match(nativeWorkflow, /sidecars-checksums\.sha256/)
  assert.match(nativeWorkflow, /standalone-checksums\.sha256/)
  assert.equal(bridge.optionalDependencies, undefined)
  const changesets = await json('.changeset/config.json')
  assert.ok(changesets.ignore.includes('@volund/docs'))
})

void test('release automation versions through Changesets without bypassing external gates', async () => {
  const [workflow, checklist] = await Promise.all([
    read('.github/workflows/release.yml'),
    read('docs/releases/L2-RELEASE-CHECKLIST.md'),
  ])
  assert.match(workflow, /pnpm release:version:dry-run/)
  assert.match(workflow, /changesets\/action@v1/)
  assert.ok(
    workflow.indexOf('node --test scripts/verify-changesets-release-plan.test.mjs') <
      workflow.indexOf('pnpm release:version:dry-run'),
  )
  assert.doesNotMatch(workflow, /publish: pnpm release/)
  assert.match(checklist, /24\/24/)
  assert.match(checklist, /0\/2 real hardware/)
  assert.match(checklist, /Production Authenticode.*BLOCKED/i)
  assert.match(checklist, /Apple notarization.*BLOCKED/i)
  assert.doesNotMatch(checklist, /Production Authenticode[^\n]*PASS/i)
})

void test('npm publication consumes an artifact-bound plan behind smoke, environment, and OIDC gates', async () => {
  const workflow = await read('.github/workflows/publish-npm.yml')
  assert.match(workflow, /workflow_dispatch/)
  assert.doesNotMatch(workflow, /\n\s*push:/)
  assert.match(workflow, /permissions:\n  contents: read/)
  assert.equal(workflow.match(/id-token: write/g)?.length, 1)
  assert.doesNotMatch(workflow, /NPM_TOKEN|NODE_AUTH_TOKEN|--provenance/)
  assert.match(
    workflow,
    /publish:\n+        description:[\s\S]*?default: false\n+        type: boolean/,
  )
  assert.match(workflow, /dist_tag:[\s\S]*?default: next[\s\S]*?- next\n+          - latest/)
  assert.match(workflow, /group: npm-release-\$\{\{ inputs\.dist_tag \}\}/)
  assert.doesNotMatch(workflow, /group:[^\n]*inputs\.tag/)
  assert.match(workflow, /cancel-in-progress: false/)
  assert.match(workflow, /REQUESTED_TAG: \$\{\{ inputs\.tag \}\}/)
  assert.match(
    workflow,
    /\^v\(0\|\[1-9\]\[0-9\]\*\)\\\.\(0\|\[1-9\]\[0-9\]\*\)\\\.\(0\|\[1-9\]\[0-9\]\*\)\$/,
  )
  assert.ok(
    workflow.indexOf('Validate stable tag before checkout') <
      workflow.indexOf('uses: actions/checkout@'),
  )
  for (const block of workflow.matchAll(/run: \|\n((?: {10}.+(?:\n|$))*)/g)) {
    assert.doesNotMatch(block[1], /\$\{\{ inputs\./)
    assert.doesNotMatch(block[1], /\bnpm publish\b|tarballs\/\*|for .*\.tgz/)
  }
  assert.match(workflow, /git show-ref --verify "\$tag_ref"/)
  assert.match(workflow, /git rev-parse --verify "\$tag_ref\^\{commit\}"/)
  assert.match(workflow, /"\$head_commit" != "\$GITHUB_SHA"/)
  assert.match(workflow, /standalone-checksums\.sha256/)
  assert.match(workflow, /release-manifest\.json/)
  assert.match(workflow, /node-version: 22\.14\.0/)
  assert.equal(workflow.match(/node-version: 24\.5\.0/g)?.length, 2)
  assert.equal(workflow.match(/'11\.5\.1'/g)?.length, 2)
  assert.doesNotMatch(workflow, /--clobber/)
  assert.match(
    workflow,
    /verify-remote-assets \\\n+            --input remote-assets\.txt --mode exact/,
  )
  assert.match(workflow, /verify-standalone \\\n+            --directory standalone-assets/)
  assert.match(
    workflow,
    /pack-standalone-npm\.mjs \\\n+            --archives standalone-assets \\\n+            --output npm-candidate/,
  )
  assert.match(
    workflow,
    /verify-npm-publish-plan\.mjs \\\n+            --output npm-candidate \\\n+            --archives standalone-assets \\\n+            --source-root \.[\s\S]*?--bun-version '1\.3\.6'/,
  )
  assert.match(workflow, /artifact_id: \$\{\{ steps\.upload\.outputs\.artifact-id \}\}/)
  assert.match(workflow, /artifact_digest: \$\{\{ steps\.upload\.outputs\.artifact-digest \}\}/)
  assert.match(workflow, /actions\/upload-artifact@[0-9a-f]{40}/)
  assert.match(workflow, /artifact_name=npm-publish-bundle-/)
  assert.match(workflow, /include-hidden-files: true/)
  assert.match(workflow, /publish-bundle\/trusted\/standalone-assets/)
  assert.match(workflow, /publish-bundle\/trusted\/apps\/cli\/bin/)
  assert.match(
    workflow,
    /cp npm-candidate\/\.volund-npm-output\.json npm-candidate\/publish-plan\.json/,
  )
  assert.match(workflow, /cp -R npm-candidate\/tarballs publish-bundle\/npm-candidate\//)
  assert.doesNotMatch(workflow, /mv npm-candidate publish-bundle\/npm-candidate/)
  assert.doesNotMatch(workflow, /publish-bundle\/npm-candidate\/packages/)
  assert.equal(workflow.match(/--layout packed-only/g)?.length, 5)
  assert.equal(workflow.match(/--layout full/g)?.length, 1)
  assert.match(workflow, /temporary-registry-smoke:\n+    needs: prepare/)
  assert.match(workflow, /test-npx-temporary-registry\.mjs/)
  assert.equal(
    workflow.match(/artifact-ids: \$\{\{ needs\.prepare\.outputs\.artifact_id \}\}/g)?.length,
    2,
  )
  assert.equal(workflow.match(/\.digest == \$digest/g)?.length, 2)
  assert.equal(workflow.match(/\.workflow_run\.head_sha == \$head_sha/g)?.length, 2)
  assert.equal(workflow.match(/\.workflow_run\.id == \$run_id/g)?.length, 2)
  assert.ok(
    workflow.indexOf('Hard-verify artifact identity before download') <
      workflow.indexOf('uses: actions/download-artifact@'),
  )
  assert.match(workflow, /publish:\n+    if: \$\{\{ inputs\.publish \}\}/)
  assert.match(workflow, /- temporary-registry-smoke/)
  assert.match(workflow, /environment: npm-release/)
  assert.match(
    workflow,
    /NPM_TRUSTED_PUBLISHING_READY: \$\{\{ vars\.NPM_TRUSTED_PUBLISHING_READY \}\}/,
  )
  assert.match(workflow, /NPM_TRUSTED_PUBLISHING_READY" != 'true'/)
  assert.match(workflow, /publish-npm-plan\.mjs[\s\S]*?--registry https:\/\/registry\.npmjs\.org/)
  assert.doesNotMatch(
    workflow,
    /build-all-standalone|normalize-release-sbom|anchore\/sbom-action|setup-bun|cargo|apps\/cli\/dist\/standalone/,
  )
})

void test('native workflow assembles standalone archives and attaches them to the Release', async () => {
  const workflow = await read('.github/workflows/native.yml')
  assert.match(workflow, /oven-sh\/setup-bun@[0-9a-f]{40}/)
  assert.match(workflow, /build-all-standalone\.mjs standalone-sidecars release-metadata/)
  assert.match(workflow, /name: standalone-archives/)
  assert.match(workflow, /standalone-checksums\.sha256/)
  assert.match(workflow, /sidecars-checksums\.sha256/)
  assert.match(workflow, /generate-release-manifest\.mjs/)
  assert.match(workflow, /if: startsWith\(github\.ref, 'refs\/tags\/v'\)/)
  assert.match(workflow, /--tag "\$GITHUB_REF_NAME"/)
  assert.match(workflow, /--commit "\$GITHUB_SHA"/)
  assert.match(workflow, /--bun-version "\$bun_version"/)
  assert.doesNotMatch(workflow, /--clobber/)
  assert.doesNotMatch(workflow, /gh release upload/)
  assert.doesNotMatch(workflow, /gh release delete|gh api[^\n]*--method DELETE/)
  assert.match(workflow, /gh release create "\$GITHUB_REF_NAME" "\$\{all_asset_paths\[@\]\}"/)
  assert.match(workflow, /--repo "\$GITHUB_REPOSITORY" --draft --verify-tag --generate-notes/)
  assert.match(
    workflow,
    /gh release edit "\$GITHUB_REF_NAME" --repo "\$GITHUB_REPOSITORY" \\\n+            --draft=false --verify-tag/,
  )
  assert.match(workflow, /all_asset_paths\+=\("\$asset_path"\)/)
  assert.match(workflow, /\$\{#all_asset_paths\[@\]\} -ne 34/)
  assert.match(workflow, /write-sidecar-checksums/)
  assert.match(workflow, /verify-local-release/)
  assert.match(workflow, /group: native-release-\$\{\{ github\.ref \}\}/)
  assert.match(workflow, /cancel-in-progress: false/)
  assert.match(
    workflow,
    /github-release:\n[\s\S]*?runs-on: ubuntu-24\.04\n    environment: release\n[\s\S]*?permissions:\n      contents: write/,
  )
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/)
  assert.match(workflow, /git ls-remote --exit-code --refs origin "refs\/tags\/\$tag"/)
  assert.match(workflow, /git fetch --force origin "\+refs\/tags\/\$tag:refs\/tags\/\$tag"/)
  assert.match(workflow, /"\$tag_commit" != "\$head_commit" \|\| "\$head_commit" != "\$GITHUB_SHA"/)

  assert.equal(workflow.match(/secrets\.RELEASE_POLICY_TOKEN/g)?.length, 2)
  assert.equal(workflow.match(/immutable-releases/g)?.length, 2)
  assert.equal(workflow.match(/verify-immutable/g)?.length, 2)
  assert.equal(workflow.match(/verify-rulesets/g)?.length, 2)
  assert.match(workflow, /-F includes_parents=true -F targets=tag -F per_page=100/)
  assert.match(workflow, /GH_TOKEN="\$RELEASE_POLICY_TOKEN" gh api --method GET/)
  assert.match(workflow, /GH_TOKEN: \$\{\{ github\.token \}\}/)

  assert.match(
    workflow,
    /gh api graphql -f query="\$release_query" \\\n+            -F owner="\$owner" -F name="\$repository" -F tag="\$GITHUB_REF_NAME"/,
  )
  assert.doesNotMatch(workflow, /query='[^']*\$GITHUB_/)
  assert.match(workflow, /--expect any/)
  assert.match(workflow, /--expect draft/)
  assert.match(workflow, /--expect published/)

  const localValidation = workflow.indexOf('verify-local-release')
  const initialImmutable = workflow.indexOf('release-policy-initial/immutable.json')
  const initialRuleset = workflow.indexOf('release-policy-initial/ruleset-index.json')
  const initialStateGate = workflow.indexOf('--input release-state-initial.json')
  const preCreateTag = workflow.indexOf(
    'git ls-remote --exit-code --refs origin "refs/tags/$GITHUB_REF_NAME"',
  )
  const create = workflow.indexOf('gh release create')
  const createdDraftGate = workflow.indexOf('--input release-state-created-draft.json')
  const initialDownload = workflow.indexOf(
    'gh release download "$GITHUB_REF_NAME" --repo "$GITHUB_REPOSITORY"',
  )
  const prepublishImmutable = workflow.indexOf('release-policy-prepublish/immutable.json')
  const prepublishRuleset = workflow.indexOf('release-policy-prepublish/ruleset-index.json')
  const prepublishStateGate = workflow.indexOf('--input release-state-prepublish.json')
  const prepublishDownload = workflow.indexOf(
    'gh release download "$GITHUB_REF_NAME" --repo "$GITHUB_REPOSITORY"',
    initialDownload + 1,
  )
  const prepublishTag = workflow.indexOf(
    'git ls-remote --exit-code --refs origin "refs/tags/$GITHUB_REF_NAME"',
    preCreateTag + 1,
  )
  const publish = workflow.indexOf('gh release edit')
  const publishedStateGate = workflow.indexOf('--input release-state-published.json')
  const publishedDownload = workflow.indexOf(
    'gh release download "$GITHUB_REF_NAME" --repo "$GITHUB_REPOSITORY"',
    prepublishDownload + 1,
  )
  for (const index of [
    localValidation,
    initialImmutable,
    initialRuleset,
    initialStateGate,
    preCreateTag,
    create,
    createdDraftGate,
    initialDownload,
    prepublishImmutable,
    prepublishRuleset,
    prepublishStateGate,
    prepublishDownload,
    prepublishTag,
    publish,
    publishedStateGate,
    publishedDownload,
  ])
    assert.notEqual(index, -1)
  assert.ok(localValidation < initialImmutable)
  assert.ok(initialImmutable < initialRuleset)
  assert.ok(initialRuleset < initialStateGate)
  assert.ok(initialStateGate < preCreateTag)
  assert.ok(preCreateTag < create)
  assert.ok(create < createdDraftGate)
  assert.ok(createdDraftGate < initialDownload)
  assert.ok(initialDownload < prepublishImmutable)
  assert.ok(prepublishImmutable < prepublishRuleset)
  assert.ok(prepublishRuleset < prepublishStateGate)
  assert.ok(prepublishStateGate < prepublishDownload)
  assert.ok(prepublishDownload < prepublishTag)
  assert.ok(prepublishTag < publish)
  assert.ok(publish < publishedStateGate)
  assert.ok(publishedStateGate < publishedDownload)

  const releaseJobStart = workflow.indexOf('  github-release:')
  assert.notEqual(releaseJobStart, -1)
  const preReleaseJobs = workflow.slice(0, releaseJobStart)
  const releaseJob = workflow.slice(releaseJobStart)
  assert.doesNotMatch(preReleaseJobs, /secrets\.|contents: write/)
  assert.match(
    preReleaseJobs,
    /credentials=not-checked\\nsubmission=protected-release-environment-required/,
  )
  assert.doesNotMatch(preReleaseJobs, /APPLE_ID|APPLE_TEAM_ID|APPLE_APP_PASSWORD/)
  assert.equal(releaseJob.match(/secrets\./g)?.length, 2)
  assert.equal(releaseJob.match(/secrets\.RELEASE_POLICY_TOKEN/g)?.length, 2)
  const secretStepNames = [
    'Require immutable releases through the read-only policy token',
    'Recheck immutable releases immediately before draft publication',
  ]
  for (const stepName of secretStepNames) {
    const stepStart = releaseJob.indexOf(`- name: ${stepName}`)
    const stepEnd = releaseJob.indexOf('\n      - name:', stepStart + 1)
    const step = releaseJob.slice(stepStart, stepEnd === -1 ? undefined : stepEnd)
    assert.notEqual(stepStart, -1)
    assert.match(step, /RELEASE_POLICY_TOKEN: \$\{\{ secrets\.RELEASE_POLICY_TOKEN \}\}/)
    assert.match(step, /GH_TOKEN="\$RELEASE_POLICY_TOKEN" gh api --method GET/)
    assert.doesNotMatch(step, /gh release (?:create|edit)|github\.token/)
  }
})

void test('GraphQL Release queries alias the official releaseAssets connection', async () => {
  const workflow = await read('.github/workflows/native.yml')
  const aliases = workflow.match(
    /assets: releaseAssets\(first: 100\) \{ totalCount nodes \{ name size digest \} \}/g,
  )
  assert.equal(aliases?.length, 3)
  assert.doesNotMatch(workflow, /\bassets\s*\(first\s*:/)
})

void test('release workflows pin and normalize CycloneDX metadata without action uploads', async () => {
  const nativeWorkflow = await read('.github/workflows/native.yml')
  const action = 'anchore/sbom-action@e22c389904149dbc22b58101806040fa8d37a610'
  assert.match(nativeWorkflow, new RegExp(action))
  assert.match(nativeWorkflow, /syft-version: v1\.51\.1/)
  assert.match(nativeWorkflow, /format: cyclonedx-json/)
  assert.match(nativeWorkflow, /output-file: release-metadata\/sbom\.raw\.cdx\.json/)
  assert.match(nativeWorkflow, /upload-artifact: false/)
  assert.match(nativeWorkflow, /upload-release-assets: false/)
  assert.match(nativeWorkflow, /cp LICENSE NOTICE release-metadata\//)
  assert.match(nativeWorkflow, /generate-release-manifest\.mjs normalize-sbom/)
  assert.match(nativeWorkflow, /--output release-metadata\/sbom\.cdx\.json/)
  assert.match(nativeWorkflow, /build-all-standalone\.mjs standalone-sidecars release-metadata/)
})

void test('all external actions in production workflows are pinned to full commit SHAs', async () => {
  const workflows = await Promise.all([
    read('.github/workflows/native.yml'),
    read('.github/workflows/publish-npm.yml'),
  ])
  for (const workflow of workflows) {
    const uses = [...workflow.matchAll(/\buses:\s+([^\s#]+)/g)].map((match) => match[1])
    assert.ok(uses.length > 0)
    for (const action of uses) assert.match(action, /^[^@\s]+@[0-9a-f]{40}$/)
  }
  assert.match(
    workflows[0],
    /dtolnay\/rust-toolchain@[0-9a-f]{40} # stable[\s\S]*toolchain: stable/,
  )
  assert.match(
    workflows[0],
    /taiki-e\/install-action@[0-9a-f]{40} # cargo-deny\s+with:\s+tool: cargo-deny/,
  )
})

void test('release verifier uses bounded no-follow file descriptors and strict commands', async () => {
  const [verifier, npmPacker, npmPlanVerifier, npmPublisher, npmSmoke, npmWrapper, rootManifest] =
    await Promise.all([
      read('scripts/release/verify-release-assets.mjs'),
      read('scripts/release/pack-standalone-npm.mjs'),
      read('scripts/release/verify-npm-publish-plan.mjs'),
      read('scripts/release/publish-npm-plan.mjs'),
      read('scripts/release/test-npx-temporary-registry.mjs'),
      read('apps/cli/bin/volund.cjs'),
      json('package.json'),
    ])
  assert.match(verifier, /O_RDONLY \| constants\.O_NOFOLLOW/)
  assert.match(verifier, /RELEASE_ASSET_LIMITS = Object\.freeze/)
  for (const limit of [
    'checksumBytes',
    'manifestBytes',
    'remoteListBytes',
    'sidecarBytes',
    'archiveBytes',
  ])
    assert.match(verifier, new RegExp(`${limit}:`))
  assert.match(verifier, /handle\.read\(/)
  assert.match(verifier, /open\(destination, 'wx'/)
  assert.match(verifier, /unlink\(destination\)/)
  assert.match(verifier, /const COMMAND_FLAGS = Object\.freeze/)
  assert.doesNotMatch(verifier, /\breadFile\b|\bcopyFile\b/)

  // GitHub Release 策略门已并入同一个校验工具（子命令 verify-immutable / verify-rulesets 等）
  assert.match(verifier, /jsonBytes: 1024 \* 1024/)
  assert.match(verifier, /rulesets: 100/)
  assert.match(verifier, /releaseAssets: 100/)
  assert.match(verifier, /requiredInclude: 'refs\/tags\/v\*'/)
  assert.match(
    verifier,
    /REQUIRED_RULE_TYPES = Object\.freeze\(\['creation', 'update', 'deletion'\]\)/,
  )
  assert.match(verifier, /requiredRules: REQUIRED_RULE_TYPES/)
  assert.match(
    verifier,
    /Ruleset bypass-capable repository administrators are a trusted deployment boundary/,
  )
  assert.match(verifier, /create, update, or delete refs\/tags\/v\*/)
  assert.match(verifier, /published release is mutable/)
  assert.match(npmPacker, /validateStandaloneArchiveBuffer/)
  assert.match(npmPacker, /\[npmCli, 'pack', '\.', '--json', '--ignore-scripts'/)
  assert.match(npmPacker, /process\.execPath/)
  assert.match(npmPacker, /Node \$\{NPM_PACK_TOOL\.nodeVersion\} and npm/)
  assert.match(npmPacker, /npm_config_userconfig: userconfig/)
  assert.match(npmPacker, /npm_config_ignore_scripts: 'true'/)
  assert.match(npmPacker, /await handle\.chmod\(mode\)/)
  assert.match(npmPacker, /aggregateCompressedBytes/)
  assert.match(npmPacker, /trustedArchiveDirectory: archives/)
  assert.match(npmPacker, /trustedSourceRoot: repositoryRoot/)
  assert.match(npmPacker, /NPM_OUTPUT_MARKER/)
  assert.match(npmPacker, /verifyNpmPublishPlan/)
  assert.match(npmPacker, /mkdtemp\(join\(dirname\(output\), '\.volund-npm-stage-'\)\)/)
  assert.doesNotMatch(
    npmPacker,
    /buildAllStandalone|buildStandalone|setup-bun|\bcargo\b|apps\/cli\/dist\/standalone|spawnSync\(['"]tar/,
  )
  assert.match(npmPlanVerifier, /constants\.O_RDONLY \| constants\.O_NOFOLLOW/)
  for (const limit of [
    'markerBytes',
    'planBytes',
    'tarballBytes',
    'tarBytes',
    'tarEntries',
    'tarEntryBytes',
    'packageJsonBytes',
    'nativeManifestBytes',
    'checksumBytes',
    'wrapperBytes',
    'metadataBytes',
    'releaseManifestBytes',
    'standaloneChecksumsBytes',
    'readmeBytes',
    'licenseBytes',
  ])
    assert.match(npmPlanVerifier, new RegExp(`${limit}:`))
  assert.match(npmPlanVerifier, /NPM_PACK_TOOL = Object\.freeze/)
  assert.match(npmPlanVerifier, /publish plan source/)
  assert.match(npmPlanVerifier, /trustedArchiveDirectory and trustedSourceRoot are required/)
  assert.match(npmPlanVerifier, /non-canonical npm@10 metadata/)
  assert.match(npmPlanVerifier, /canonical single-member npm@10 gzip encoding/)
  assert.match(npmPlanVerifier, /data follows NUL terminator/)
  assert.match(npmPlanVerifier, /ownership marker is not canonical/)
  assert.match(npmPlanVerifier, /has an invalid description/)
  assert.match(npmPlanVerifier, /NPM_PUBLISH_ORDER/)
  assert.match(npmPlanVerifier, /seven platforms, volund-cli, then volund-code/)
  assert.doesNotMatch(npmPlanVerifier, /spawnSync\(['"]tar|execSync|\breadFile\b/)
  assert.match(npmWrapper, /spawn\(executable, process\.argv\.slice\(2\)/)
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) assert.match(npmWrapper, new RegExp(signal))
  assert.doesNotMatch(npmWrapper, /spawnSync/)
  assert.match(npmPublisher, /nodeVersion: '24\.5\.0'/)
  assert.match(npmPublisher, /npmVersion: '11\.5\.1'/)
  assert.match(npmPublisher, /ACTIONS_ID_TOKEN_REQUEST_TOKEN/)
  assert.match(npmPublisher, /ACTIONS_ID_TOKEN_REQUEST_URL/)
  assert.match(npmPublisher, /NPM_OIDC_ENVIRONMENT_KEYS/)
  assert.match(npmPublisher, /for \(const descriptor of descriptors\)/)
  assert.ok(
    npmPublisher.indexOf('const initial = []') < npmPublisher.indexOf("if (mode === 'preflight')"),
  )
  assert.match(
    npmPublisher,
    /\[\s*'publish',[\s\S]*?resolve\(candidateDirectory, item\.descriptor\.tarball\)/,
  )
  assert.doesNotMatch(npmPublisher, /\[\s*'dist-tag',\s*'add'|npm dist-tag add/)
  assert.match(npmPublisher, /repair the tag manually before retrying/)
  assert.match(npmPublisher, /npm has no publish CAS/)
  assert.match(npmPublisher, /mutation-adjacent reread/)
  assert.match(npmPublisher, /AbortSignal\.timeout\(10_000\)/)
  assert.match(npmPublisher, /timeout: NPM_REGISTRY_TIMEOUT_MS/)
  assert.match(npmPlanVerifier, /candidateLayout === 'full'/)
  assert.match(
    npmPlanVerifier,
    /NPM_CANDIDATE_LAYOUTS = Object\.freeze\(\['full', 'packed-only'\]\)/,
  )
  assert.doesNotMatch(npmPublisher, /shell: true|execSync|\.tgz\*|\bglob\b/)
  assert.match(npmSmoke, /VERDACCIO_VERSION = '6\.10\.1'/)
  assert.match(npmSmoke, /uplinks: \{\}/)
  assert.match(npmSmoke, /publish: \$authenticated/)
  assert.doesNotMatch(npmSmoke, /publish: \$all/)
  assert.match(npmSmoke, /VERDACCIO_LOG_LIMIT/)
  assert.match(npmSmoke, /AbortSignal\.timeout/)
  assert.match(npmSmoke, /timeout: TEMPORARY_REGISTRY_TIMEOUT_MS/)
  assert.match(npmSmoke, /--omit=optional/)
  assert.match(npmSmoke, /--yes[\s\S]*--registry[\s\S]*volund-cli@/)
  assert.equal(rootManifest.devDependencies.verdaccio, '6.10.1')
  assert.match(rootManifest.scripts.test, /scripts\/release\/verify-release-assets\.test\.mjs/)
  assert.match(rootManifest.scripts.test, /scripts\/release\/verify-npm-publish-plan\.test\.mjs/)
  assert.match(rootManifest.scripts.test, /scripts\/release\/publish-npm-plan\.test\.mjs/)
  assert.match(
    rootManifest.scripts.test,
    /scripts\/release\/test-npx-temporary-registry\.test\.mjs/,
  )
})
