/**
 * TOML 序列化原语（P1-04c）：config-edit / mcp / permissions-store 共用。
 * 从 apps/cli/src/mcp.ts 迁入，行为等价。
 */
import type { JsonValue } from '@volund/shared'

export function serializeToml(config: Record<string, JsonValue>): string {
  const lines: string[] = []
  const tables: Array<{ path: string; value: Record<string, JsonValue> }> = []
  for (const [key, value] of Object.entries(config)) {
    if (value && typeof value === 'object' && !Array.isArray(value))
      tables.push({ path: key, value: value as Record<string, JsonValue> })
    else lines.push(`${tomlKey(key)} = ${tomlValue(value)}`)
  }
  const emitTable = (path: string, table: Record<string, JsonValue>) => {
    const scalars = Object.entries(table).filter(
      ([, value]) => !(value && typeof value === 'object' && !Array.isArray(value)),
    )
    const nested = Object.entries(table).filter(
      ([, value]) => value && typeof value === 'object' && !Array.isArray(value),
    ) as Array<[string, Record<string, JsonValue>]>
    if (scalars.length > 0 || nested.length === 0) lines.push('', `[${tomlSectionPath(path)}]`)
    for (const [key, value] of scalars) lines.push(`${tomlKey(key)} = ${tomlValue(value)}`)
    for (const [key, value] of nested) emitTable(`${path}.${key}`, value)
  }
  for (const table of tables) emitTable(table.path, table.value)
  return `${lines.join('\n').replace(/^\n+/, '')}\n`
}
/**
 * TOML 值序列化：标量走 JSON（basic string 转义与 TOML 兼容），嵌套结构产出
 * TOML 内联表/数组（`{ tool = "Bash" }`，`=` 语法）——permissions.toml 的对象
 * 数组必须能被外部 TOML 工具读取，不能落成 JSON 的冒号语法。键序原样保留
 * （grant key 依赖 spec 键序，往返不得规范化）。
 */
function tomlValue(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map((item) => tomlValue(item)).join(', ')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).map(
      ([key, item]) => `${tomlKey(key)} = ${tomlValue(item)}`,
    )
    return entries.length > 0 ? `{ ${entries.join(', ')} }` : '{}'
  }
  return JSON.stringify(value)
}
function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key)
}
/** 表路径按段校验：`mcp_servers.demo.env` 合法（点号是段分隔符，不是 key 字符）。 */
function tomlSectionPath(path: string): string {
  return path.split('.').every((segment) => /^[A-Za-z0-9_-]+$/.test(segment))
    ? path
    : path
        .split('.')
        .map((segment) => (/^[A-Za-z0-9_-]+$/.test(segment) ? segment : JSON.stringify(segment)))
        .join('.')
}
