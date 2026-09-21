/**
 * 市场数据模型。三个索引契约类型与 volund 客户端逐字段对齐：
 * - PluginIndex  ← packages/app-runtime/src/plugin-market.ts（parseMarketIndex）
 * - SkillIndex   ← packages/app-runtime/src/skill-market.ts（parseSkillMarketIndex）
 * - McpIndex     ← packages/app-runtime/src/mcp-market.ts（parseMcpMarketIndex）
 * 客户端解析器是形状契约的唯一权威；这里只做同形声明，改客户端须同步改这里。
 */

/** 客户端可下载文件规格：path 为插件目录内相对路径，digest 为 sha256。 */
export interface MarketFileSpec {
  readonly path: string
  readonly digest: `sha256-${string}`
}

/** 兼容层索引：GET /api/plugins/index.json（schemaVersion 1）。 */
export interface PluginIndexEntry {
  readonly name: string
  readonly version: string
  readonly description?: string
  readonly publisher?: string
  readonly files: readonly MarketFileSpec[]
}
export interface PluginIndex {
  readonly schemaVersion: 1
  readonly plugins: readonly PluginIndexEntry[]
}

/** 兼容层索引：GET /api/skills/index.json（version 1）。 */
export interface SkillIndexEntry {
  readonly name: string
  readonly description?: string
  readonly version?: string
  /** volund SkillPort.install 的 source 形态：git URL | github tree URL | owner/repo 简写。 */
  readonly source: string
  readonly homepage?: string
}
export interface SkillIndex {
  readonly version: 1
  readonly entries: readonly SkillIndexEntry[]
}

/** 兼容层索引：GET /api/mcp/index.json（version 1）。 */
export interface McpIndexEntry {
  readonly name: string
  readonly description?: string
  /**
   * 版本标签。客户端 v1 解析器只取已知字段、忽略未知键，带上不破坏解析，
   * 供市场页展示与未来客户端版本读取；git 源 skill 的惯例值是分支/ref。
   */
  readonly version?: string
  readonly transport: 'stdio' | 'http'
  readonly url?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly command?: string
  readonly args?: readonly string[]
  readonly env?: Readonly<Record<string, string>>
  readonly homepage?: string
}
export interface McpIndex {
  readonly version: 1
  readonly entries: readonly McpIndexEntry[]
}

/** 服务端内部模型：插件按版本留档，索引只发最新版。 */
export interface PluginVersionRecord {
  readonly version: string
  readonly publishedAt: string
  readonly manifest: Record<string, unknown>
  readonly files: readonly MarketFileSpec[]
  readonly readme?: string
}
export interface PluginRecord {
  readonly name: string
  readonly publisher?: string
  readonly description?: string
  readonly createdAt: string
  readonly updatedAt: string
  /** 文件下载计数（≈ 安装次数 × 文件数），只增不减。 */
  readonly downloads: number
  readonly versions: readonly PluginVersionRecord[]
}
export interface SkillRecord extends SkillIndexEntry {
  readonly addedAt: string
}
export interface McpRecord extends McpIndexEntry {
  readonly addedAt: string
}
export interface MarketDatabase {
  readonly seededAt: string
  // 顶层容器可变：updateDatabase 的事务在原库对象上就地改写后原子落盘。
  plugins: Record<string, PluginRecord>
  skills: Record<string, SkillRecord>
  mcp: Record<string, McpRecord>
}
