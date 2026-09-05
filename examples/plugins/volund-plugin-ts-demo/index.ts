/**
 * volund-plugin-ts-demo — TypeScript 插件入口示例。
 *
 * manifest 写 `"main": "index.ts"` 即可：宿主以 Node `--experimental-strip-types`
 * 装载（要求 Node ≥ 22.6）。类型擦除只支持可静态擦除的子集——interface / 类型
 * 标注 / 泛型可用；enum / namespace / 参数属性不支持，用到的插件请先编译成 JS。
 *
 * `import type` 会在装载时被整体擦除——对 `@volund/plugin-sdk` 的类型引用不产生
 * 任何运行时依赖，沙箱里不需要 node_modules。
 */
import type { VolundBridge } from '@volund/plugin-sdk'

interface CountInput {
  text: string
}

interface CountResult {
  words: number
  characters: number
  lines: number
}

const count = (input: CountInput): CountResult => ({
  words: input.text.split(/\s+/).filter(Boolean).length,
  characters: [...input.text].length,
  lines: input.text ? input.text.split('\n').length : 0,
})

interface DemoVolund extends Record<string, unknown> {
  log: { info(message: string): void }
  tools: {
    register(spec: {
      name: string
      description: string
      handler(input: unknown): Promise<unknown>
    }): Promise<unknown>
  }
}

export async function activate(volund: DemoVolund & Partial<VolundBridge>) {
  // 裸名即可：宿主自动收敛为 plugin:volund-plugin-ts-demo:ts-count
  await volund.tools.register({
    name: 'ts-count',
    description: 'Count words, characters and lines of the given text',
    handler: async (input: unknown) => count(input as CountInput),
  })
  await volund.log.info('volund-plugin-ts-demo activated')
}
