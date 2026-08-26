import { statusPanelFromWelcome } from '@apollo-code/ui'
import type { StatusPanelData, WelcomePanelData } from '@apollo-code/ui'

import type { CommandDefinition } from '../../shared/cli-types'

export interface StatusPresentation {
  buildFallback(cwd: string): Promise<WelcomePanelData>
  renderText(data: StatusPanelData): string
}

export function createStatusCommand(presentation: StatusPresentation): CommandDefinition {
  return {
    name: 'status',
    async run({ args, cwd, ports }) {
      // dev 插件（~/.apollo/plugins-dev 约定目录 + APOLLO_DEV_PLUGINS 额外路径）
      // 在一次性命令里同样激活，让 `apollo status --json` 能看到插件页签；用完即回收。
      // 内置插件不在此装载：它们贡献的是命令而非页签，一次性命令没有 REPL 生命周期。
      let activated = 0
      if (ports.localPlugins) {
        const extraDirs = (process.env.APOLLO_DEV_PLUGINS ?? '')
          .split(',')
          .map((dir) => dir.trim())
          .filter(Boolean)
        const { loaded } = await ports.localPlugins.loadDevPlugins(extraDirs)
        activated = loaded.length
      }
      try {
        const data = ports.config.status
          ? await ports.config.status({ cwd, includeStats: true })
          : statusPanelFromWelcome(await presentation.buildFallback(cwd))
        return {
          exitCode: 0,
          stdout: args.json ? `${JSON.stringify(data)}\n` : presentation.renderText(data),
          stderr: '',
        }
      } finally {
        if (activated > 0) await ports.localPlugins?.deactivateAll()
      }
    },
  }
}
