/**
 * ConfigController 域（§8.3 / 附录 C / P1-04e）：config 端口的完整实现——
 * applyEnv、health、status、updatePreference、listMerged、setValue/unsetValue、
 * filePaths。从 createProductionPorts 迁入；行为等价。`/env` 的 appliedEnv
 * 基准槽由本域持有（插件域经 getAppliedEnv 读取）。
 */
import { access, mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { loadConfig, loadTomlFile, parseTomlFile } from '@volund/config'
import { isProjectOverrideForbidden, VolundError } from '@volund/shared'
import type { JsonValue, Logger } from '@volund/shared'

import {
  assignConfigValue,
  assertConfigKeyValue,
  deleteConfigValue,
  readConfigFileOrEmpty,
  writeConfigFile,
} from './config-edit'
import type { LocalPluginHub } from './plugins-domain'
import { expandEnvValue } from './plugins-domain-env'
import { runtimeStatusData } from './status'
import type { StatusRuntimeOptions } from './status'
import { validateStatusConfigValue } from './status-view'

export interface ConfigDomainOptions {
  readonly home: string
  readonly logger: Logger
  readonly statusRuntime: StatusRuntimeOptions
  readonly localPluginHub: LocalPluginHub
}

/** config 端口形状（与 VolundPorts['config'] 结构一致）。 */
export interface ConfigDomain {
  /** [env] applyEnv 应用值快照（/env 生效判定的精确基准；插件域经此读取）。 */
  readonly appliedEnv: () => Record<string, string> | undefined
  readonly port: {
    applyEnv(): Promise<void>
    health(cwd: string): Promise<{ valid: boolean; detail: string }>
    status(input: {
      cwd: string
      sessionId?: string
      includeStats?: boolean
    }): Promise<import('./status-view').StatusPanelData>
    updatePreference(
      id: string,
      value: import('./status-view').StatusValue,
      input: { cwd: string; sessionId: string },
    ): Promise<import('./status-view').StatusPanelData>
    listMerged(input: { cwd: string }): Promise<{
      config: Record<string, JsonValue>
      warnings: string[]
    }>
    setValue(input: {
      cwd: string
      key: string
      value: JsonValue
      project?: boolean
    }): Promise<{ file: string }>
    unsetValue(input: {
      cwd: string
      key: string
      project?: boolean
    }): Promise<{ file: string; removed: boolean }>
    filePaths(input: { cwd: string }): { user: string; project: string }
  }
}

export function createConfigDomain(options: ConfigDomainOptions): ConfigDomain {
  let appliedEnvEntries: Record<string, string> | undefined
  const port: ConfigDomain['port'] = {
    /**
     * [env] 段（§8.3 / 附录 C）：会话启动时把用户级 config.toml 的显式环境变量
     * 写入 process.env——之后 spawn 的子进程（native worker / 插件宿主 / MCP
     * stdio）随之继承；沙箱内 Bash 走 env_clear 白名单模型，仅 [tools]
     * pass_through_env 列出的名字进入（值可来自这里写入的 process.env）。
     * 值先经 expandEnvValue 前置解析（`~` / `${VAR}`）；解析后的应用值记入
     * appliedEnvEntries，作为 /env 生效判定的精确基准。
     * 缺文件是 no-op；类型错按 C.1 传播 config_invalid（启动 fail）。
     */
    async applyEnv() {
      let config: Record<string, JsonValue>
      try {
        config = await loadTomlFile(join(options.home, 'config.toml'), {
          onWarning: (message) => options.logger.warn(message),
        })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      }
      const section = config.env
      if (!section || typeof section !== 'object' || Array.isArray(section)) return
      // 展开基准 = 写入前的环境快照：${PATH} 这类"在已有值上追加"的写法拿到的
      // 是启动时已有的值；同段 key 互引用不支持（快照里还没有它们）。
      const basis = { ...process.env }
      const applied: Record<string, string> = {}
      for (const [key, value] of Object.entries(section)) {
        if (typeof value !== 'string') continue
        const resolvedValue = expandEnvValue(value, basis, (name) =>
          options.logger.warn(
            `[env] ${key}: referenced variable ${name} is not set; kept the placeholder literal`,
          ),
        )
        process.env[key] = resolvedValue
        applied[key] = resolvedValue
      }
      appliedEnvEntries = applied
    },
    async health(cwd) {
      try {
        const warnings: string[] = []
        for (const path of [
          join(options.home, 'config.toml'),
          join(cwd, '.volund', 'config.toml'),
        ]) {
          try {
            await access(path)
            // r13-I4 §8.3：未知 key warn + 忽略；已知 key 类型错 → fail（file + key + 期望类型）
            await loadTomlFile(path, {
              onWarning: (message) => warnings.push(message),
            })
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
        }
        return warnings.length > 0
          ? { valid: true, detail: warnings.join('; ') }
          : { valid: true, detail: 'valid' }
      } catch (error) {
        return { valid: false, detail: error instanceof Error ? error.message : String(error) }
      }
    },
    async status(input) {
      return runtimeStatusData(options.home, options.statusRuntime, input, options.localPluginHub)
    },
    async updatePreference(id, value, input) {
      const data = await runtimeStatusData(
        options.home,
        options.statusRuntime,
        { ...input, includeStats: true },
        options.localPluginHub,
      )
      const item = data.config.find((candidate) => candidate.id === id)
      if (!item) throw new Error(`Unknown configuration item: ${id}`)
      validateStatusConfigValue(item, value)
      const path = join(options.home, 'config.toml')
      let config: Record<string, JsonValue> = {}
      try {
        config = await parseTomlFile(path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      const preferences = config.preferences
      const target =
        preferences && typeof preferences === 'object' && !Array.isArray(preferences)
          ? (preferences as Record<string, JsonValue>)
          : ((config.preferences = {}) as Record<string, JsonValue>)
      target[id] = value
      await mkdir(options.home, { recursive: true })
      const temporary = `${path}.${process.pid}.tmp`
      await writeFile(temporary, serializePreferenceConfig(config), {
        encoding: 'utf8',
        mode: 0o600,
      })
      await rename(temporary, path)
      return runtimeStatusData(
        options.home,
        options.statusRuntime,
        { ...input, includeStats: true },
        options.localPluginHub,
      )
    },
    /**
     * §11.3.3 `volund config list` 的合并视图：user + project 两层文件经
     * loadConfig 的层合并与 projectOverride forbidden 过滤。这是只读检视
     * （同 health 的 parse-only），不等于会话生效语义——会话还叠加 defaults
     * /env/flags 与项目配置信任门。
     */
    async listMerged({ cwd }: { cwd: string }) {
      const warnings: string[] = []
      const user = await loadTomlFile(join(options.home, 'config.toml'), {
        onWarning: (message) => warnings.push(message),
      }).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
        throw error
      })
      const project = await loadTomlFile(join(cwd, '.volund', 'config.toml'), {
        onWarning: (message) => warnings.push(message),
      }).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
        throw error
      })
      const forbidden: string[] = []
      const { config: merged } = await loadConfig({
        defaults: {},
        global: user,
        project,
        trustProjectConfig: true,
        warning: (key) =>
          forbidden.push(`project override of '${key}' is forbidden (§8.3.1); ignored`),
      })
      return { config: merged, warnings: [...warnings, ...forbidden] }
    },
    async setValue({ cwd, key, value, project }) {
      if (project && isProjectOverrideForbidden(key))
        throw new VolundError(
          'config_project_forbidden',
          `'${key}' cannot be set in project config (data-flow gate, §8.3.1)`,
        )
      assertConfigKeyValue(key, value)
      const file = project ? join(cwd, '.volund', 'config.toml') : join(options.home, 'config.toml')
      const config = await readConfigFileOrEmpty(file)
      assignConfigValue(config, key, value)
      await writeConfigFile(file, config)
      return { file }
    },
    async unsetValue({ cwd, key, project }) {
      // unset 不做 forbidden 门：从 project 配置里移除 forbidden key 是清理，应当允许。
      const file = project ? join(cwd, '.volund', 'config.toml') : join(options.home, 'config.toml')
      const config = await readConfigFileOrEmpty(file)
      const removed = deleteConfigValue(config, key)
      if (removed) await writeConfigFile(file, config)
      return { file, removed }
    },
    filePaths({ cwd }: { cwd: string }) {
      return {
        user: join(options.home, 'config.toml'),
        project: join(cwd, '.volund', 'config.toml'),
      }
    },
  }
  return { appliedEnv: () => appliedEnvEntries, port }
}

/** preferences 写盘序列化器（updatePreference 的输出格式冻结；与 toml.ts 的通用序列化器语义不同，不合并）。 */
function serializePreferenceConfig(config: Record<string, JsonValue>): string {
  const lines: string[] = []
  for (const [section, raw] of Object.entries(config)) {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      lines.push(`[${section}]`)
      for (const [key, value] of Object.entries(raw))
        lines.push(`${key} = ${JSON.stringify(value)}`)
      lines.push('')
    } else lines.push(`${section} = ${JSON.stringify(raw)}`)
  }
  return `${lines.join('\n').trim()}\n`
}
