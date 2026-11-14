import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const root = new URL('../', import.meta.url)
const changesetBin = new URL('../node_modules/@changesets/cli/bin.js', import.meta.url)

const runChangesetStatus = (cwd, outputPath) =>
  spawnSync(process.execPath, [changesetBin.pathname, 'status', '--output', outputPath], {
    cwd,
    encoding: 'utf8',
  })

const changesetFrontmatterPackages = (contents) => {
  const frontmatter = contents.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? ''
  return [...frontmatter.matchAll(/^['"]?([^'":]+)['"]?:\s+(?:major|minor|patch)$/gm)].map(
    ([, packageName]) => packageName,
  )
}

void test('Changesets never mix ignored and publishable packages', async () => {
  const changesetDirectory = new URL('../.changeset/', import.meta.url)
  const { ignore } = JSON.parse(await readFile(new URL('config.json', changesetDirectory), 'utf8'))
  const ignoredPackages = new Set(ignore)
  const changesetFiles = (await readdir(changesetDirectory)).filter((file) => file.endsWith('.md'))

  for (const file of changesetFiles) {
    const contents = await readFile(new URL(file, changesetDirectory), 'utf8')
    const packages = changesetFrontmatterPackages(contents)
    const hasIgnoredPackage = packages.some((packageName) => ignoredPackages.has(packageName))
    const hasPublishablePackage = packages.some((packageName) => !ignoredPackages.has(packageName))

    assert.equal(
      hasIgnoredPackage && hasPublishablePackage,
      false,
      `${file} mixes ignored and publishable packages`,
    )
  }
})

void test('Changesets builds the release plan and rejects deleted workspace packages', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'volund-changesets-'))
  const validPlanPath = join(temporaryDirectory, 'release-plan.json')
  const worktreePath = join(temporaryDirectory, 'invalid-worktree')

  try {
    // The plan is empty right after a release consumes every changeset (or when
    // the only pending ones target ignored packages), so the non-empty
    // assertion only applies while publishable changesets exist.
    const changesetDirectory = new URL('../.changeset/', import.meta.url)
    const { ignore } = JSON.parse(
      await readFile(new URL('config.json', changesetDirectory), 'utf8'),
    )
    const ignoredPackages = new Set(ignore)
    const hasPendingChangesets = (
      await Promise.all(
        (
          await readdir(changesetDirectory)
        )
          .filter((file) => file.endsWith('.md'))
          .map(async (file) => {
            const contents = await readFile(new URL(file, changesetDirectory), 'utf8')
            const packages = changesetFrontmatterPackages(contents)
            return packages.some((packageName) => !ignoredPackages.has(packageName))
          }),
      )
    ).some(Boolean)

    const validStatus = runChangesetStatus(root, validPlanPath)
    // 全量克隆带着 v0.2.0 占位 tag（changesets 流程外手工推的 tag）：steady state
    // （无 publishable pending changeset）下 changesets 把 tag 之后的全部变更视作
    // 「changed but no changesets」报错——这是环境噪声不是 plan 失败（CI 浅克隆
    // 无 tag 不触发）。有 pending changeset 时仍然强制 status 必须为 0。
    const steadyStateNoChangesets =
      validStatus.status !== 0 &&
      !hasPendingChangesets &&
      /no changesets were found/.test(validStatus.stderr)
    assert.ok(validStatus.status === 0 || steadyStateNoChangesets, validStatus.stderr)

    if (validStatus.status === 0) {
      const plan = JSON.parse(await readFile(validPlanPath, 'utf8'))
      if (hasPendingChangesets) assert.ok(plan.releases.length > 0)
      assert.ok(plan.releases.every(({ name }) => !name.startsWith('@volund/native-fs-')))
      assert.ok(plan.releases.every(({ name }) => !name.startsWith('@volund/native-sandbox-')))
      assert.ok(plan.releases.every(({ name }) => !name.startsWith('@volund/native-search-')))
    }

    const addWorktree = spawnSync('git', ['worktree', 'add', '--detach', worktreePath, 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    })
    assert.equal(addWorktree.status, 0, addWorktree.stderr)

    await writeFile(
      join(worktreePath, '.changeset', 'deleted-native-package.md'),
      "---\n'@volund/native-fs-darwin-arm64': patch\n---\n\nInvalid deleted package reference.\n",
    )

    const invalidStatus = runChangesetStatus(
      worktreePath,
      join(temporaryDirectory, 'invalid-plan.json'),
    )
    assert.notEqual(invalidStatus.status, 0)
    assert.match(invalidStatus.stderr, /not in the workspace/)
  } finally {
    spawnSync('git', ['worktree', 'remove', '--force', worktreePath], { cwd: root })
    await rm(temporaryDirectory, { force: true, recursive: true })
  }
})
