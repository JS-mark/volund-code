#!/usr/bin/env node
// 部署自检：对运行中的 apollo-market 做契约冒烟测试。
//   node scripts/smoke.mjs [--base http://127.0.0.1:4315] [--token TOKEN]
// 覆盖：三个兼容层索引形状、插件文件下载 + sha256 逐一核对、
// 写接口鉴权（无 token / 错 token / 正确 token）、发布 → 索引可见 → 删除。
import { createHash } from 'node:crypto'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}
const base = flag('base', process.env.MARKET_BASE ?? 'http://127.0.0.1:4315').replace(/\/+$/, '')
const token = flag('token', process.env.MARKET_ADMIN_TOKEN)

let failures = 0
const check = (name, condition, detail = '') => {
  const mark = condition ? 'ok' : 'FAIL'
  if (!condition) failures += 1
  console.log(`[${mark}] ${name}${detail && !condition ? ` — ${detail}` : ''}`)
}
const getJson = async (path) => (await fetch(`${base}${path}`)).json()

// 1. health
const health = await getJson('/api/health')
check('health ok', health.ok === true, JSON.stringify(health))
check(
  'seeded counts',
  health.counts.plugins >= 1 && health.counts.skills >= 1 && health.counts.mcp >= 1,
)

// 2. plugin index contract
const pluginIndex = await getJson('/api/plugins/index.json')
check('plugin index schemaVersion', pluginIndex.schemaVersion === 1)
check(
  'plugin index entries valid',
  Array.isArray(pluginIndex.plugins) &&
    pluginIndex.plugins.length > 0 &&
    pluginIndex.plugins.every(
      (plugin) =>
        /^volund-plugin-[a-z0-9][a-z0-9._-]{0,127}$/.test(plugin.name) &&
        typeof plugin.version === 'string' &&
        Array.isArray(plugin.files) &&
        plugin.files.some((file) => file.path === 'manifest.json') &&
        plugin.files.every((file) => /^sha256-[a-f0-9]{64}$/.test(file.digest)),
    ),
)

// 3. file download + digest 逐文件核对（同源 URL 形态与客户端 fileUrl 一致）
for (const plugin of pluginIndex.plugins) {
  for (const file of plugin.files) {
    const response = await fetch(`${base}/api/plugins/${plugin.name}/${file.path}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    const actual = createHash('sha256').update(bytes).digest('hex')
    check(
      `download ${plugin.name}/${file.path}`,
      response.ok && actual === file.digest.slice('sha256-'.length),
      `status=${response.status} digest mismatch`,
    )
  }
}

// 4. 未索引文件 404（任意文件读防护）
const smuggled = await fetch(`${base}/api/plugins/volund-plugin-demo/../market.json`)
check('path traversal rejected', smuggled.status === 404, `status=${smuggled.status}`)

// 5. skill / mcp index contract
const skillIndex = await getJson('/api/skills/index.json')
check(
  'skill index contract',
  skillIndex.version === 1 &&
    Array.isArray(skillIndex.entries) &&
    skillIndex.entries.every(
      (entry) =>
        /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(entry.name) && typeof entry.source === 'string',
    ),
)
const mcpIndex = await getJson('/api/mcp/index.json')
check(
  'mcp index contract',
  mcpIndex.version === 1 &&
    Array.isArray(mcpIndex.entries) &&
    mcpIndex.entries.every(
      (entry) =>
        (entry.transport === 'stdio' && typeof entry.command === 'string') ||
        (entry.transport === 'http' && typeof entry.url === 'string'),
    ),
)

// 6. 写接口鉴权：无 token / 错 token 拒绝
const noToken = await fetch(`${base}/api/v1/skills`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'x', source: 'a/b' }),
})
check(
  'write without token rejected',
  noToken.status === 401 || noToken.status === 503,
  `status=${noToken.status}`,
)
const badToken = await fetch(`${base}/api/v1/skills`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' },
  body: JSON.stringify({ name: 'x', source: 'a/b' }),
})
check('write with wrong token rejected', badToken.status === 401, `status=${badToken.status}`)

if (token) {
  // 7. skill CRUD（重名 = upsert 更新版本）+ 422 校验
  const addSkill = await fetch(`${base}/api/v1/skills`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      name: 'smoke-test-skill',
      source: 'https://github.com/anthropics/skills/tree/main/skills/xlsx',
      version: '2.0.0',
      description: 'smoke test entry',
    }),
  })
  check('skill create 201', addSkill.status === 201, `status=${addSkill.status}`)
  const upsert = await fetch(`${base}/api/v1/skills`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      name: 'smoke-test-skill',
      source: 'https://github.com/anthropics/skills/tree/main/skills/pdf',
      version: '3.0.0',
    }),
  })
  check('duplicate skill upserts 200', upsert.status === 200, `status=${upsert.status}`)
  const invalid = await fetch(`${base}/api/v1/skills`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ name: 'Bad_Name', source: 'a/b' }),
  })
  check('invalid skill 422', invalid.status === 422, `status=${invalid.status}`)
  const skillVisible = await getJson('/api/skills/index.json')
  const smokeSkill = skillVisible.entries.find((entry) => entry.name === 'smoke-test-skill')
  check(
    'skill visible in compat index with updated version',
    Boolean(smokeSkill && smokeSkill.version === '3.0.0' && smokeSkill.source.endsWith('/pdf')),
  )
  const removeSkill = await fetch(`${base}/api/v1/skills/smoke-test-skill`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
  })
  check('skill delete 200', removeSkill.status === 200, `status=${removeSkill.status}`)

  // 7b. mcp CRUD（upsert 语义同 skill，版本随条目进兼容层索引）
  const addMcp = await fetch(`${base}/api/v1/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      name: 'smoke-test-mcp',
      transport: 'http',
      url: 'https://mcp.example.com/mcp',
      version: '1.2.3',
    }),
  })
  check('mcp create 201', addMcp.status === 201, `status=${addMcp.status}`)
  const mcpVisible = await getJson('/api/mcp/index.json')
  const smokeMcp = mcpVisible.entries.find((entry) => entry.name === 'smoke-test-mcp')
  check(
    'mcp visible with version in compat index',
    Boolean(smokeMcp && smokeMcp.version === '1.2.3'),
  )
  const removeMcp = await fetch(`${base}/api/v1/mcp/smoke-test-mcp`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
  })
  check('mcp delete 200', removeMcp.status === 200, `status=${removeMcp.status}`)

  // 8. 插件发布 → 索引可见 → 同版本 409 → 坏 manifest 422 → 删除
  const manifest = {
    name: 'volund-plugin-smoke-test',
    version: '0.0.1',
    type: 'module',
    main: 'index.mjs',
    engines: { volund: '^0.1.0' },
    permissions: { volund: [] },
  }
  const encode = (value) => Buffer.from(value, 'utf8').toString('base64')
  const bundle = {
    files: [
      { path: 'manifest.json', contentBase64: encode(`${JSON.stringify(manifest, null, 2)}\n`) },
      { path: 'index.mjs', contentBase64: encode('export const activate = () => {}\n') },
    ],
    publisher: 'smoke',
  }
  const publish = await fetch(`${base}/api/v1/plugins`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(bundle),
  })
  check(
    'plugin publish 201',
    publish.status === 201,
    `status=${publish.status} ${JSON.stringify(await publish.json().catch(() => ({})))}`,
  )
  const republish = await fetch(`${base}/api/v1/plugins`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(bundle),
  })
  check('same version 409', republish.status === 409, `status=${republish.status}`)
  const badBundle = {
    files: [
      {
        path: 'manifest.json',
        contentBase64: encode(JSON.stringify({ ...manifest, name: 'not-volund' })),
      },
    ],
  }
  const invalidPlugin = await fetch(`${base}/api/v1/plugins`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(badBundle),
  })
  check('invalid plugin 422', invalidPlugin.status === 422, `status=${invalidPlugin.status}`)
  const pluginVisible = await getJson('/api/plugins/index.json')
  check(
    'published plugin visible in compat index',
    pluginVisible.plugins.some((plugin) => plugin.name === 'volund-plugin-smoke-test'),
  )
  const removePlugin = await fetch(`${base}/api/v1/plugins/volund-plugin-smoke-test`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
  })
  check('plugin delete 200', removePlugin.status === 200, `status=${removePlugin.status}`)
} else {
  console.log('[skip] write-API positive cases (no token given)')
}

// 9. 页面可达
for (const path of ['/', '/admin', '/entries/plugins/volund-plugin-demo']) {
  const response = await fetch(`${base}${path}`)
  check(`page ${path}`, response.ok, `status=${response.status}`)
}

console.log(failures === 0 ? '\nall smoke checks passed' : `\n${failures} check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
