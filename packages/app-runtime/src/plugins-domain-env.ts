/**
 * [env] 配置段的前置解析与生效快照（P1-04d）：/env 内置插件的数据源。
 * 从 apps/cli/src/runtime.ts 迁入，行为等价。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

import { loadTomlFile } from '@volund/config'
import type { EffectiveEnvEntry } from '@volund/plugin-sdk'
import type { JsonValue } from '@volund/shared'
import { MINIMAL_ENV_KEYS } from '@volund/tools'

/**
 * [env] 值的前置解析（applyEnv 写入 process.env 之前）：
 * - 开头 `~` / `~/...` → 用户主目录；
 * - `${VAR}` 与裸 `$VAR` → source 里已有的环境变量。**只有名字已设置才展开**：
 *   未设置的引用一律保持字面（值里的 `$` 常见于凭据/正则，撞不到真实环境变量名
 *   就不会被误伤）；`${VAR}` 形式未设置时额外回调 onUnresolved（显式意图，值得
 *   fail-visible），裸 `$VAR` 未设置则静默保持字面。
 * 单趟展开不递归；同段 key 互引用不支持——source 取应用前的环境快照。
 */
export function expandEnvValue(
  value: string,
  source: Record<string, string | undefined>,
  onUnresolved?: (name: string) => void,
): string {
  const tildeExpanded =
    value === '~' ? homedir() : value.startsWith('~/') ? `${homedir()}${value.slice(1)}` : value
  return tildeExpanded.replaceAll(
    /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g,
    (raw, braced: string | undefined, bare: string | undefined) => {
      const name = (braced ?? bare)!
      const resolved = source[name]
      if (resolved === undefined) {
        if (braced) onUnresolved?.(name)
        return raw
      }
      return resolved
    },
  )
}

/**
 * [env] 段的生效快照（/env 内置插件的数据源）：每次调用重读用户级 config.toml，
 * 与当前 process.env 对比出 effective / pending / overridden；sandboxPassthrough
 * 标出该名字是否经最小继承集（PATH/HOME/LANG/TZ）或 [tools] pass_through_env
 * 白名单进入沙箱。缺配置文件 → 空列表；类型错按 C.1 传播 config_invalid。
 *
 * 配置值先经前置解析（`~` / `${VAR}`，见 expandEnvValue）再与 process.env 比较：
 * `applied`（applyEnv 记录的应用值）在本进程跑过 applyEnv 时是精确基准；否则
 * （一次性子命令）按「扣除本段 key 的当前环境」就地展开，展示"应用后会是这个值"。
 */
export async function readEffectiveEnv(
  home: string,
  applied?: Record<string, string>,
): Promise<EffectiveEnvEntry[]> {
  let config: Record<string, JsonValue> = {}
  try {
    config = await loadTomlFile(join(home, 'config.toml'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const envSection =
    config.env && typeof config.env === 'object' && !Array.isArray(config.env)
      ? (config.env as Record<string, JsonValue>)
      : {}
  const toolsSection =
    config.tools && typeof config.tools === 'object' && !Array.isArray(config.tools)
      ? (config.tools as Record<string, JsonValue>)
      : {}
  const passThrough = new Set(MINIMAL_ENV_KEYS)
  if (Array.isArray(toolsSection.pass_through_env))
    for (const name of toolsSection.pass_through_env)
      if (typeof name === 'string' && name) passThrough.add(name)
  // 就地展开的基准要扣除本段 key：applyEnv 跑过的进程里这些名字的值来自配置
  // 本身，拿它们当引用基准会把自引用误判成已解析。
  const basis = { ...process.env }
  for (const key of Object.keys(envSection)) delete basis[key]
  const entries: EffectiveEnvEntry[] = []
  for (const [key, value] of Object.entries(envSection)) {
    if (typeof value !== 'string') continue
    const expected = applied?.[key] ?? expandEnvValue(value, basis)
    const actual = process.env[key] ?? null
    entries.push({
      key,
      configured: expected,
      actual,
      status: actual === null ? 'pending' : actual === expected ? 'effective' : 'overridden',
      sandboxPassthrough: passThrough.has(key),
    })
  }
  return entries
}
