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

void test('Changesets never mix ignored and publishable packages', async () => {
  const changesetDirectory = new URL('../.changeset/', import.meta.url)
  const { ignore } = JSON.parse(await readFile(new URL('config.json', changesetDirectory), 'utf8'))
  const ignoredPackages = new Set(ignore)
  const changesetFiles = (await readdir(changesetDirectory)).filter((file) => file.endsWith('.md'))

  for (const file of changesetFiles) {
    const contents = await readFile(new URL(file, changesetDirectory), 'utf8')
    const frontmatter = contents.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? ''
    const packages = [
      ...frontmatter.matchAll(/^['"]?([^'":]+)['"]?:\s+(?:major|minor|patch)$/gm),
    ].map(([, packageName]) => packageName)
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
    const validStatus = runChangesetStatus(root, validPlanPath)
    assert.equal(validStatus.status, 0, validStatus.stderr)

    const plan = JSON.parse(await readFile(validPlanPath, 'utf8'))
    assert.ok(plan.releases.length > 0)
    assert.ok(plan.releases.every(({ name }) => !name.startsWith('@volund/native-fs-')))
    assert.ok(plan.releases.every(({ name }) => !name.startsWith('@volund/native-sandbox-')))
    assert.ok(plan.releases.every(({ name }) => !name.startsWith('@volund/native-search-')))

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
