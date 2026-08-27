import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const readRepoFile = (path) => readFile(resolve(root, path), 'utf8')

async function markdownFiles(directory, options = {}) {
  const { includeGeneratedApi = false } = options
  const entries = await readdir(resolve(root, directory), { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = `${directory}/${entry.name}`
      if (entry.isDirectory()) {
        if (
          (!includeGeneratedApi && entry.name === 'api') ||
          entry.name === 'dist' ||
          entry.name === 'cache'
        )
          return []
        return markdownFiles(path, options)
      }
      return entry.name.endsWith('.md') ? [path] : []
    }),
  )
  return nested.flat()
}

const requiredPages = [
  'apps/docs/index.md',
  'apps/docs/docs/getting-started/install.md',
  'apps/docs/docs/getting-started/first-run.md',
  'apps/docs/docs/getting-started/5min-tutorial.md',
  'apps/docs/docs/concepts/agent-loop.md',
  'apps/docs/docs/concepts/security-model.md',
  'apps/docs/docs/reference/cli.md',
  'apps/docs/docs/troubleshooting/auth.md',
  'apps/docs/docs/troubleshooting/sandbox.md',
  'apps/docs/docs/troubleshooting/common-errors.md',
]

const requiredChinesePages = [
  'apps/docs/zh/index.md',
  ...requiredPages.slice(1).map((page) => page.replace('apps/docs/', 'apps/docs/zh/')),
]

void test('ships every required L1 documentation page', async () => {
  await Promise.all([...requiredPages, ...requiredChinesePages].map(readRepoFile))
})

void test('keeps the docs site private and buildable', async () => {
  const [manifest, turbo] = await Promise.all([
    readRepoFile('apps/docs/package.json').then(JSON.parse),
    readRepoFile('turbo.json').then(JSON.parse),
  ])
  assert.equal(manifest.private, true)
  assert.match(manifest.scripts.build, /docs:api && vitepress build/)
  assert.ok(
    turbo.tasks.typecheck.dependsOn.includes('build'),
    'typecheck must wait for the same package build to avoid concurrent VitePress temp writes',
  )
})

void test('ships a branded responsive home instead of the default feature grid', async () => {
  const [home, theme, styles, logo] = await Promise.all([
    readRepoFile('apps/docs/.vitepress/theme/components/HomeLanding.vue'),
    readRepoFile('apps/docs/.vitepress/theme/index.ts'),
    readRepoFile('apps/docs/.vitepress/theme/custom.css'),
    readRepoFile('apps/docs/public/volund-mark.svg'),
  ])

  assert.match(home, /class="terminal-shell"/)
  assert.match(home, /class="architecture-rail"/)
  assert.match(home, /aria-label="Volund CLI system flow"/)
  assert.match(theme, /HomeLanding/)
  assert.match(styles, /prefers-reduced-motion/)
  assert.match(styles, /@media \(max-width: 760px\)/)
  assert.match(styles, /html:not\(\.dark\)/)
  assert.match(logo, /<svg/)
})

void test('configures bilingual GitHub Pages deployment under the custom subpath', async () => {
  const config = await readRepoFile('apps/docs/.vitepress/config.mts')
  assert.match(config, /base: '\/volund-code\/'/)
  assert.match(config, /hostname: 'https:\/\/js-mark\.com'/)
  assert.match(config, /url: `\/volund-code\/\$\{item\.url\}`/)
  assert.match(config, /lang: 'zh-CN'/)
  assert.match(config, /label: '简体中文'/)
})

void test('keeps current docs on the canonical Volund display and CLI identity', async () => {
  const files = [
    ...(await markdownFiles('apps/docs')),
    ...(await markdownFiles('docs/rfcs')),
    ...(await markdownFiles('docs/superpowers/specs/2026-07-31-volund-code-design')),
  ].filter((path) => path !== 'apps/docs/api-intro.md' && !/\/REVIEW-[^/]+\.md$/.test(path))
  const oldCommand =
    /(?:`|\$ |^|\s)apollo\s+(?:chat|login|logout|config|history|resume|restore|model|plugin|skill|mcp|hook|memory|context|evolution|review|doctor|status|telemetry|completion|version|help|selfdev|reflect|update)\b/m

  for (const file of files) {
    const content = await readRepoFile(file)
    assert.doesNotMatch(
      content,
      /\b(?:Apollo Code|Apollo CODE|Apollo)\b/,
      `${file} has an old display brand`,
    )
    assert.doesNotMatch(content, oldCommand, `${file} uses the legacy command as canonical`)
  }
})

void test('brands generated API prose while preserving explicit compatibility ABI', async () => {
  const [typedoc, apiIntro, apiFiles] = await Promise.all([
    readRepoFile('typedoc.json'),
    readRepoFile('apps/docs/api-intro.md'),
    markdownFiles('apps/docs/api', { includeGeneratedApi: true }),
  ])
  const staleGeneratedProse =
    /\b(?:Apollo Code|Apollo CODE|Apollo)\b|registered by the apollo runtime|apollo 只读不写|YOU\/APOLLO|apollo mcp inspect/
  const oldCommand =
    /(?:`|\$ |^|\s)apollo\s+(?:chat|login|logout|config|history|resume|restore|model|plugin|skill|mcp|hook|memory|context|evolution|review|doctor|status|telemetry|completion|version|help|selfdev|reflect|update)\b/m

  assert.match(typedoc, /"name": "Volund CLI API"/)
  assert.match(typedoc, /"readme": "apps\/docs\/api-intro\.md"/)
  assert.match(apiIntro, /^# Volund CLI API/m)
  assert.match(apiIntro, /frozen v1 compatibility ABI/)
  assert.ok(apiFiles.length > 0, 'TypeDoc API output must exist before docs verification')

  for (const file of apiFiles) {
    const content = await readRepoFile(file)
    if (file !== 'apps/docs/api/README.md')
      assert.doesNotMatch(content, staleGeneratedProse, `${file} has stale generated brand prose`)
    assert.doesNotMatch(content, oldCommand, `${file} uses the legacy command as canonical`)
  }

  const generatedIndex = await readRepoFile('apps/docs/api/README.md')
  assert.match(generatedIndex, /^# Volund CLI API/m)
  assert.match(generatedIndex, /frozen v1 compatibility ABI/)
})

void test('documents the prompt-injection trust boundary', async () => {
  const security = await readRepoFile('apps/docs/docs/concepts/security-model.md')
  assert.match(security, /Prompt injection threat model/i)
  assert.match(security, /<untrusted source="...">/)
  assert.match(security, /best-effort/i)
})

void test('does not claim blocked release evidence', async () => {
  const dogfood = await readRepoFile('docs/releases/L1-DOGFOOD.md')
  const signoff = await readRepoFile('docs/releases/L1-SIGNOFF.md')
  assert.match(dogfood, /BLOCKED/)
  assert.match(signoff, /PENDING/)
  assert.doesNotMatch(`${dogfood}\n${signoff}`, /ANTHROPIC_API_KEY\s*=/)
})

void test('ships an auditable L1 final verification runbook', async () => {
  const runbook = await readRepoFile('docs/releases/L1-FINAL-VERIFICATION.md')

  for (const required of [
    'Status: **PROCEDURE ONLY',
    '## Roles and separation of duties',
    '## Entry criteria',
    '## Phase 1 — Freeze the candidate',
    '## Phase 2 — Automated and target evidence',
    '## Phase 3 — Real Anthropic dog-food',
    '## Phase 4 — BDFL and security sign-off',
    '## Phase 5 — Release decision and publication boundary',
    '## Failure, retry, and rollback rules',
    '## Evidence manifest',
  ])
    assert.match(runbook, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))

  assert.match(runbook, /mock[^\n]*PRE-FLIGHT ONLY/i)
  assert.match(runbook, /Closes APO-15/)
  assert.match(runbook, /credential[^\n]*(must not|never|禁止)/i)
  assert.match(runbook, /not published/i)
})
