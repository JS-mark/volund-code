/**
 * SkillController 域（§22.7.1 / Web 计划 P1-04c）：/skills 面板控制器 +
 * CLI 管理端口 + 斜杠命令同步的同一条装配（SKILLS-MCPS-r1 原生路径）。
 *
 * 从 createProductionPorts 的闭包迁入为显式 options 工厂；`process.cwd()` 等
 * 宿主读数经 getDefaultCwd 注入（Web server 传 workspace root）。行为等价。
 */
import { readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { loadTomlFile } from '@volund/config'
import { DefaultPromptComposer } from '@volund/core'
import type { PermissionSpec } from '@volund/permission'
import { sanitize } from '@volund/shared'
import type { Logger } from '@volund/shared'
import type { SkillEntry, SkillsRuntime } from '@volund/skills-runtime'
import { defaultSkillSources, SkillsRuntime as SkillsRuntimeClass } from '@volund/skills-runtime'

import { disabledNamesFrom, updateConfigDisabledList } from './config-edit'
import type { SlashCommandRegistryLike } from './contracts'
import type { SkillPort } from './ports'
import { SkillSlashCommands, slashInvocableSkillNames } from './skill-commands'
import { resolveSkillSpecToDirectories } from './skill-install'
import { buildStackedSkillInvocationText, mapAllowedTools, splitSkillStack } from './skill-tool'
import type { SkillsPanelController, SkillsPanelEntry } from './skills-panel'

/** 回合级 ephemeral 授权槽（skill allowed-tools）；由权限链在顶层会话装配。 */
export interface SkillGrantSink {
  grant(rules: ReadonlyArray<{ tool: string; spec: PermissionSpec }>): void
}

export interface SkillDomainOptions {
  readonly home: string
  readonly volundVersion: string
  readonly logger: Logger
  readonly emitTelemetry: (
    name: string,
    category: string,
    payload: Record<string, unknown>,
  ) => Promise<unknown> | void
  readonly slashCommands: SlashCommandRegistryLike
  /** 原 process.cwd() 读数（CLI 一次性端口）；Web 传 workspace root。 */
  readonly getDefaultCwd: () => string
  /** 原 homedir() 读数。 */
  readonly getUserHome: () => string
  /** 顶层会话的回合级授权槽；无活动会话时 undefined（invoke 直接跳过授权）。 */
  readonly getSkillGrants: () => SkillGrantSink | undefined
  /** 插件捆绑 skills 目录（内置/dev/market 三源，含插件启停后的惰性重解析）。 */
  readonly pluginSkillDirs: () => Promise<readonly string[]>
}

export interface SkillDomain {
  readonly skillsRuntimes: Set<SkillsRuntime>
  readonly skillsDisabled: Set<string>
  readonly skillCommands: SkillSlashCommands
  readonly skillsPanelController: SkillsPanelController
  readonly skillPort: SkillPort
  readonly ensureSkillsConfig: () => Promise<void>
  readonly syncSkillSlashCommands: () => void
}

export function createSkillDomain(options: SkillDomainOptions): SkillDomain {
  const skillsRuntimes = new Set<SkillsRuntime>()
  const skillsDisabled = new Set<string>()
  let skillsConfigLoaded = false
  async function ensureSkillsConfig(): Promise<void> {
    if (skillsConfigLoaded) return
    skillsConfigLoaded = true
    try {
      const config = await loadTomlFile(join(options.home, 'config.toml'), {
        onWarning: (message) => options.logger.warn(message),
      })
      for (const name of disabledNamesFrom(config.skills)) skillsDisabled.add(name)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  function skillsPanelEntries(): SkillsPanelEntry[] {
    const runtime = [...skillsRuntimes][0]
    if (!runtime) return []
    return runtime.entries().map(toPanelEntry)
  }
  // SKILLS-MCPS-r1 §S3.3a：每个 user-invocable skill 注册为同名 slash 命令。
  // `/skill-name [args]` = 一次性调用：skill body + 任务文本作为用户消息进当轮
  // 对话（不持久改 system prompt；区别于 /skill activate 的会话级激活与面板 a 键）。
  // 主会话 runtime 的 entries 是唯一快照源；首次装载、面板 r 重扫、启停切换后
  // 都会重新 sync（幂等 diff）。
  const skillCommands = new SkillSlashCommands({
    registry: options.slashCommands,
    invoke: async (name, args) => {
      const runtime = [...skillsRuntimes][0]
      if (!runtime) throw new Error('No active session; open a session first')
      // 业界堆叠：`/a /b task` —— 后续 token 命中已注册 skill 名即续堆（上限 6）。
      const { stack, taskArgs } = splitSkillStack(
        name,
        args,
        slashInvocableSkillNames(runtime.entries()),
      )
      const invocations = []
      for (const skillName of stack) invocations.push(await runtime.readInvocation(skillName))
      // 堆叠里每个 skill 的 allowed-tools 都授予回合级放行（我们的特点：授权语义
      // 与单调用一致，且会话级激活/自动激活不受影响）。
      for (const invocation of invocations)
        if (invocation.allowedTools?.length)
          options
            .getSkillGrants()
            ?.grant(
              mapAllowedTools(invocation.allowedTools, (message) => options.logger.warn(message)),
            )
      return {
        kind: 'submit',
        text: buildStackedSkillInvocationText(invocations, taskArgs),
      }
    },
    onWarn: (message) => options.logger.warn(message),
  })
  function syncSkillSlashCommands(): void {
    const runtime = [...skillsRuntimes][0]
    if (runtime) skillCommands.sync(runtime.entries())
  }
  function toPanelEntry(entry: SkillEntry): SkillsPanelEntry {
    return {
      name: entry.name,
      description: entry.description,
      scope: entry.scope,
      source: entry.path,
      status: entry.status,
      ...(entry.version ? { version: entry.version } : {}),
      ...(entry.reason ? { reason: entry.reason } : {}),
      flags: [
        ...(entry.disableModelInvocation ? ['disable-model-invocation'] : []),
        ...(entry.userInvocable ? [] : ['user-invocable-false']),
      ],
    }
  }
  const skillsPanelController: SkillsPanelController = {
    async list() {
      // §S3.8：面板数据加载采样（打开/刷新）。
      const entries = skillsPanelEntries()
      void options.emitTelemetry(
        'skills.panel_opened',
        'skills',
        sanitize({
          count: entries.length,
          broken_count: entries.filter(
            (entry) => entry.status === 'broken' || entry.status === 'incompatible',
          ).length,
        }),
      )
      return entries
    },
    async reload() {
      for (const runtime of skillsRuntimes) {
        await runtime.discover()
        await runtime.registerIndex()
      }
      syncSkillSlashCommands()
      return skillsPanelEntries()
    },
    async setActive(name, active) {
      if (skillsRuntimes.size === 0) throw new Error('No active session; open a session first')
      for (const runtime of skillsRuntimes) {
        if (active) await runtime.activate(name)
        else runtime.deactivate(name)
      }
      return `skill ${name} ${active ? 'activated' : 'deactivated'}`
    },
    async setEnabled(name, enabled) {
      if (enabled) skillsDisabled.delete(name)
      else {
        skillsDisabled.add(name)
        for (const runtime of skillsRuntimes) runtime.deactivate(name)
      }
      for (const runtime of skillsRuntimes) await runtime.registerIndex()
      syncSkillSlashCommands()
      await updateConfigDisabledList({ home: options.home, section: 'skills', name, add: !enabled })
      return `skill ${name} ${enabled ? 'enabled' : 'disabled'}`
    },
    async show(name) {
      const runtime = [...skillsRuntimes][0]
      const entry = runtime?.entries().find((item) => item.name === name)
      if (!entry || !entry.path) return `[failed to read: No SKILL.md available for ${name}]`
      try {
        const body = await readFile(entry.path, 'utf8')
        return body || `[${name}: SKILL.md is empty]`
      } catch (error) {
        return `[failed to read ${entry.path}: ${error instanceof Error ? error.message : String(error)}]`
      }
    },
  }
  // ── SKILLS-MCPS-r1 §S3.7：CLI 管理命令族端口（volund skill / volund mcp）────────
  /** CLI 一次性进程用：按当前 cwd 的多作用域源构造发现 runtime（无会话 composer）。 */
  async function listingSkillsRuntime(): Promise<SkillsRuntime> {
    await ensureSkillsConfig()
    return new SkillsRuntimeClass({
      sources: async () =>
        defaultSkillSources({
          volundHome: options.home,
          userHome: options.getUserHome(),
          cwd: options.getDefaultCwd(),
          pluginDirs: await options.pluginSkillDirs(),
        }),
      volundVersion: options.volundVersion,
      composer: new DefaultPromptComposer(),
      disabled: skillsDisabled,
      onWarning: (message) => options.logger.warn(message),
      onEvent: (event, payload) => void options.emitTelemetry(event, 'skills', sanitize(payload)),
    })
  }
  const skillPort: SkillPort = {
    async list() {
      const runtime = await listingSkillsRuntime()
      await runtime.discover()
      return runtime.entries().map((entry) => ({
        name: entry.name,
        description: entry.description,
        scope: entry.scope,
        status: entry.status,
        ...(entry.version ? { version: entry.version } : {}),
        path: entry.path,
      }))
    },
    async install(spec, installOptions) {
      const { directories, cleanup } = await resolveSkillSpecToDirectories(spec, {
        onInfo: (message) => options.logger.warn(message),
      })
      try {
        const runtime = await listingSkillsRuntime()
        // 逐个安装,失败（重名/目录已存在/格式错）记警告继续，其余照常装。
        const installedNames: string[] = []
        const failures: string[] = []
        for (const directory of directories) {
          try {
            const installed = await runtime.installFromDirectory(directory, {
              scope: installOptions?.scope ?? 'user',
            })
            installedNames.push(installed.name)
          } catch (error) {
            const name = directory.split('/').pop() ?? directory
            failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
        if (failures.length > 0)
          options.logger.warn(
            `skill install partial: ${failures.length} skipped (${failures.join('; ')})`,
          )
        await runtime.discover()
        // 只返回本次新装的（发现源里还有互操作路径等既有 skill，不该混进安装回执）。
        return runtime
          .entries()
          .filter((entry) => installedNames.includes(entry.name))
          .map((entry) => ({
            name: entry.name,
            description: entry.description,
            scope: entry.scope,
            status: entry.status,
            ...(entry.version ? { version: entry.version } : {}),
            path: entry.path,
          }))
      } finally {
        await cleanup()
      }
    },
    async uninstall(name, uninstallOptions) {
      const runtime = await listingSkillsRuntime()
      await runtime.discover()
      const entry = runtime
        .entries()
        .find(
          (item) =>
            item.name === name &&
            (!uninstallOptions?.scope || item.scope === uninstallOptions.scope) &&
            !item.interop,
        )
      if (!entry || !entry.path)
        throw new Error(
          `Skill not found in a managed (non-interop) ${uninstallOptions?.scope ?? 'user|project'} scope: ${name}`,
        )
      await rm(resolve(entry.path, '..'), { recursive: true, force: true })
    },
    async show(name) {
      const runtime = await listingSkillsRuntime()
      await runtime.discover()
      const entry = runtime.entries().find((item) => item.name === name)
      if (!entry || !entry.path) throw new Error(`No SKILL.md available for ${name}`)
      return readFile(entry.path, 'utf8')
    },
    async setEnabled(name, enabled) {
      await ensureSkillsConfig()
      if (enabled) skillsDisabled.delete(name)
      else skillsDisabled.add(name)
      await updateConfigDisabledList({ home: options.home, section: 'skills', name, add: !enabled })
    },
  }
  return {
    skillsRuntimes,
    skillsDisabled,
    skillCommands,
    skillsPanelController,
    skillPort,
    ensureSkillsConfig,
    syncSkillSlashCommands,
  }
}
