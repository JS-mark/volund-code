import { spawnSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { JsonValue } from '@volund/shared'

import { getConfigValue } from '../../config-edit'
import { serializeToml } from '../../mcp'
import type { CliIo, CommandDefinition } from '../../shared/cli-types'

/**
 * §11.3.3 `volund config`。set/unset 的 key 校验与 projectOverride 数据流向门
 * 在端口实现里（runtime.ts 的 config port），命令层只做参数解析与呈现。
 */
export function createConfigCommand(io: CliIo): CommandDefinition {
  return {
    name: 'config',
    async run({ args, cwd, ports }) {
      const config = ports.config
      if (!config.listMerged || !config.setValue || !config.unsetValue || !config.filePaths)
        return { exitCode: 2, stdout: '', stderr: 'config commands are not wired in this build' }
      const action = args._[1] ?? 'list'
      const project = args.project === true
      try {
        if (action === 'list') {
          const { config: merged, warnings } = await config.listMerged({ cwd })
          const stderr = warnings.length > 0 ? `${warnings.join('\n')}\n` : ''
          if (args.json) return { exitCode: 0, stdout: `${JSON.stringify(merged)}\n`, stderr }
          return {
            exitCode: 0,
            stdout:
              Object.keys(merged).length > 0 ? serializeToml(merged) : 'No configuration set.\n',
            stderr,
          }
        }
        if (action === 'get') {
          const key = args._[2]
          if (!key) return { exitCode: 2, stdout: '', stderr: 'config get requires a key' }
          const { config: merged } = await config.listMerged({ cwd })
          const value = getConfigValue(merged, key)
          if (value === undefined)
            return { exitCode: 3, stdout: '', stderr: `No config value for key '${key}'` }
          if (args.json)
            return { exitCode: 0, stdout: `${JSON.stringify({ key, value })}\n`, stderr: '' }
          return {
            exitCode: 0,
            stdout: `${typeof value === 'string' ? value : JSON.stringify(value)}\n`,
            stderr: '',
          }
        }
        if (action === 'set') {
          const key = args._[2]
          const raw = args._[3]
          if (!key || raw === undefined)
            return { exitCode: 2, stdout: '', stderr: 'config set requires a key and a value' }
          const value = parseValue(raw)
          if (value === null)
            return {
              exitCode: 2,
              stdout: '',
              stderr: 'config values must be a string, number, boolean, array, or object',
            }
          const { file } = await config.setValue({ cwd, key, value, project })
          return {
            exitCode: 0,
            stdout: args.json
              ? `${JSON.stringify({ key, value, file })}\n`
              : `Set ${key} in ${file}\n`,
            stderr: '',
          }
        }
        if (action === 'unset') {
          const key = args._[2]
          if (!key) return { exitCode: 2, stdout: '', stderr: 'config unset requires a key' }
          const { file, removed } = await config.unsetValue({ cwd, key, project })
          if (!removed)
            return { exitCode: 3, stdout: '', stderr: `Key '${key}' is not set in ${file}` }
          return {
            exitCode: 0,
            stdout: args.json
              ? `${JSON.stringify({ key, removed, file })}\n`
              : `Removed ${key} from ${file}\n`,
            stderr: '',
          }
        }
        if (action === 'path') {
          const paths = config.filePaths({ cwd })
          return {
            exitCode: 0,
            stdout: args.json
              ? `${JSON.stringify(paths)}\n`
              : `${project ? paths.project : paths.user}\n`,
            stderr: '',
          }
        }
        if (action === 'edit') {
          if (!io.isInteractiveTerminal?.())
            return {
              exitCode: 2,
              stdout: '',
              stderr: 'config edit requires an interactive terminal',
            }
          const file = project ? config.filePaths({ cwd }).project : config.filePaths({ cwd }).user
          // 编辑器需要真实文件：缺文件时建空文件（0600），与 set 的写盘权限一致。
          await mkdir(dirname(file), { recursive: true })
          await writeFile(file, '', { encoding: 'utf8', mode: 0o600, flag: 'a' })
          const editor = process.env.VISUAL ?? process.env.EDITOR ?? 'vi'
          const result = spawnSync(editor, [file], { stdio: 'inherit' })
          if (result.error) throw result.error
          if (result.status !== 0)
            return {
              exitCode: result.status ?? 1,
              stdout: '',
              stderr: `${editor} exited ${result.status}`,
            }
          // 保存后立即按 C.1 校验一遍：类型错会在下次启动时 fail，这里提前亮出来。
          const health = await config.health(cwd)
          if (health.valid === false) return { exitCode: 1, stdout: '', stderr: health.detail }
          return {
            exitCode: 0,
            stdout: health.detail === 'valid' ? '' : `${health.detail}\n`,
            stderr: '',
          }
        }
        return { exitCode: 2, stdout: '', stderr: `Unknown config action: ${action}` }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const code =
          error !== null && typeof error === 'object' && 'code' in error
            ? String(error.code)
            : undefined
        const usageError =
          code === 'config_unknown_key' ||
          code === 'config_project_forbidden' ||
          code === 'config_invalid'
        return { exitCode: usageError ? 2 : 1, stdout: '', stderr: message }
      }
    },
  }
}

/** JSON 字面量（数字/布尔/数组/对象）按类型写入，否则按字符串处理。 */
function parseValue(raw: string): JsonValue {
  try {
    return JSON.parse(raw) as JsonValue
  } catch {
    return raw
  }
}
