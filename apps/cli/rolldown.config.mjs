// oxlint-disable typescript/consistent-return
import { readFileSync } from 'node:fs'
import { cp } from 'node:fs/promises'

import { defineConfig } from 'rolldown'

const packageJson = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
const packageVersion = packageJson.version === '0.0.0' ? '0.0.0-dev+local' : packageJson.version
const version = process.env.VOLUND_BUILD_VERSION ?? packageVersion
const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
if (!semverPattern.test(version) || version === '0.0.0')
  throw new Error(`VOLUND_BUILD_VERSION must be a non-placeholder SemVer, received: ${version}`)

const identity = {
  version,
  ...(process.env.VOLUND_BUILD_COMMIT ? { commit: process.env.VOLUND_BUILD_COMMIT } : {}),
  ...(process.env.VOLUND_BUILD_CHANNEL ? { channel: process.env.VOLUND_BUILD_CHANNEL } : {}),
  ...(process.env.VOLUND_BUILD_TIME ? { builtAt: process.env.VOLUND_BUILD_TIME } : {}),
}
const identityModuleSuffix = '/src/shared/build-identity.ts'

export default defineConfig({
  input: 'src/bin.ts',
  output: {
    codeSplitting: false,
    file: 'dist/volund.js',
    format: 'esm',
    minify: false,
  },
  platform: 'node',
  plugins: [
    {
      name: 'volund-build-identity',
      load(id) {
        if (id.replaceAll('\\', '/').endsWith(identityModuleSuffix))
          return `export const buildIdentity = ${JSON.stringify(identity)}`
      },
    },
    {
      // 内置插件随产物分发：apps/cli/plugins/<name>/ → dist/plugins/<name>/
      // （运行时由 runtime.ts builtinPluginRoot() 按产物旁解析）。目录未随当前
      // 提交进仓库时跳过，运行时按"无内置插件"处理。
      name: 'volund-builtin-plugins',
      async writeBundle() {
        try {
          await cp(
            new URL('./plugins/', import.meta.url),
            new URL('./dist/plugins/', import.meta.url),
            {
              recursive: true,
            },
          )
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error
        }
      },
    },
  ],
  // 仓库内没有包声明 sideEffects:false，treeshake 只裁剪未使用的导出，
  // 模块顶层副作用全部保留。
  treeshake: false,
})
