/**
 * §15 T0 context tuning 装载（P1-04d）：显式布尔 opt-in 的持久化调优值。
 * 从 apps/cli/src/runtime.ts 迁入，行为等价。
 */
import { join } from 'node:path'

import { loadTomlFile } from '@volund/config'
import { EvolutionEngine } from '@volund/core'
import type { ContextTunableParam, EvolutionPersistence } from '@volund/core'
import type { JsonValue } from '@volund/shared'
import type { Logger } from '@volund/shared'

export async function loadProductionContextTuning(options: {
  readonly home: string
  readonly persistence: EvolutionPersistence
  readonly logger: Pick<Logger, 'warn'>
}): Promise<{
  readonly config: Record<string, JsonValue>
  readonly values: Record<ContextTunableParam, number>
}> {
  let enabled = false
  let config: Record<string, JsonValue> = {}
  try {
    config = await loadTomlFile(join(options.home, 'config.toml'), {
      onWarning: (message) => options.logger.warn(message),
    })
    const section = config.evolution
    enabled = Boolean(
      section &&
      typeof section === 'object' &&
      !Array.isArray(section) &&
      Object.hasOwn(section, 'enabled') &&
      section.enabled === true,
    )
  } catch (error) {
    // A missing file means the documented default-off posture. Syntax, type, and I/O
    // failures are configuration failures and must stop Runner construction (§8.3/C.1).
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return {
    config,
    values: await new EvolutionEngine(options.persistence, { enabled }).values(),
  }
}

/**
 * 插件命令贡献 → 斜杠命令注册表（UI 经 subscribe 热更新）。handler 在插件沙箱里
 * 经桥执行，返回字符串即作为系统消息进 transcript。撞内置名 / 撞已注册命令时
 * warn + 跳过该命令（不拖累插件其余贡献）；返回注销函数集（deactivate 时摘除）。
 */
