/**
 * apollo-plugin-manager — 内置插件：/plugins 浏览与管理。
 *
 * 面板（无参数）：三页签浏览当前装载与市场可装的插件——
 *   Built-in（产物自带 apps/cli/plugins/）/ Dev（~/.apollo/plugins-dev +
 *   APOLLO_DEV_PLUGINS）/ Market（[plugins] market 索引 + 已装市场插件）。
 * 交互：←/→ 切页签、输入即搜索、↑/↓ 选择、Enter 看 detail、Esc 关闭。
 * 数据全部来自宿主侧 apollo.plugins.list()（沙箱内无网络，索引由宿主拉取）；
 * 打开面板前的装载耗时由宿主 TUI 的命令执行 spinner 覆盖。
 *
 * 子命令：/plugins install <name>（宿主下载 + digest 校验 + 落盘
 * ~/.apollo/plugins/<name>/ + 立即激活）、/plugins uninstall <name>（热：
 * 停用 + 摘命令/页签 + 删目录，当前会话立即生效；仅市场插件——内置随产物
 * 分发不可卸，dev 目录归开发者管理，命中会给明确拒绝理由）。
 * 与 dev/builtin 同一条装载链路（apollo-sandbox --run-plugin + fd3 桥）。
 */
const shortName = (name) => name.replace(/^apollo-plugin-/, '')

function loadedEntry(plugin) {
  const badges = [`loaded`, `${plugin.commands} cmd${plugin.commands === 1 ? '' : 's'}`]
  if (plugin.statusTabs > 0) badges.push(`${plugin.statusTabs} tab${plugin.statusTabs === 1 ? '' : 's'}`)
  return {
    id: plugin.name,
    label: shortName(plugin.name),
    value: plugin.version,
    status: badges.join(' · '),
    detail: [
      `${plugin.name} @ ${plugin.version}`,
      `source: ${plugin.source} (${plugin.dir})`,
      `contributions: ${plugin.commands} command(s), ${plugin.statusTabs} status tab(s)`,
      plugin.source === 'builtin'
        ? 'Shipped with the Apollo artifact (apps/cli/plugins/) — builtin plugins cannot be uninstalled.'
        : plugin.source === 'dev'
          ? 'Discovered from ~/.apollo/plugins-dev/ or APOLLO_DEV_PLUGINS — dev plugins are managed by their directory; remove it and restart the REPL to unload.'
          : 'Installed from the plugin market (~/.apollo/plugins/). Hot-uninstall with: /plugins uninstall ' + shortName(plugin.name),
    ].join('\n'),
  }
}

function marketTab(inventory) {
  const entries = inventory.market.installed.map((plugin) => ({
    ...loadedEntry(plugin),
    status: 'installed',
  }))
  const registry = inventory.market.registry
  if ('error' in registry) {
    entries.push({
      id: '__market_unavailable',
      label: registry.error.includes('no market configured') ? 'market not configured' : 'market unavailable',
      value: '',
      status: 'error',
      detail: [
        registry.error,
        '',
        'Configure a market index to browse and install remote plugins:',
        '',
        '  # ~/.apollo/config.toml',
        '  [plugins]',
        '  market = "https://your-registry.example/apollo-plugins/index.json"',
        '',
        'Index format: { "schemaVersion": 1, "plugins": [{ name, version, description,',
        'publisher, files: [{ path, digest: "sha256-..." }] }] } — every file is',
        'digest-verified on download and re-verified on each activation.',
        'Loopback http URLs are allowed for local registries and tests.',
      ].join('\n'),
    })
    return entries
  }
  const installed = new Set(inventory.market.installed.map((plugin) => plugin.name))
  for (const listing of registry.plugins) {
    if (installed.has(listing.name)) continue
    entries.push({
      id: listing.name,
      label: shortName(listing.name),
      value: listing.version,
      status: `available · ${listing.publisher ?? 'unattributed'}`,
      detail: [
        `${listing.name} @ ${listing.version}`,
        listing.publisher ? `publisher: ${listing.publisher}` : '',
        listing.description ? `description: ${listing.description}` : '',
        `source: ${registry.source}`,
        '',
        `Install with: /plugins install ${shortName(listing.name)}`,
      ]
        .filter(Boolean)
        .join('\n'),
    })
  }
  return entries
}

export async function activate(apollo) {
  await apollo.commands.register({
    name: 'plugins',
    order: 56,
    description: 'Browse and manage plugins (builtin · dev · market)',
    handler: async (args) => {
      const plugins = apollo.plugins
      if (!plugins)
        return '/plugins is unavailable: this host does not expose the plugins bridge namespace.'
      const [action, target] = args
      if (action === 'install' || action === 'uninstall') {
        if (!target)
          return `Usage: /plugins ${action} <name>\nExample: /plugins ${action} env`
        try {
          if (action === 'install') {
            const result = await plugins.install(target)
            return [
              `Installed ${result.name} @ ${result.version} → ${result.dir}`,
              'The plugin is active in this session; commands and tabs are live.',
            ].join('\n')
          }
          const result = await plugins.uninstall(target)
          return `Uninstalled ${result.name} (removed from ~/.apollo/plugins/).`
        } catch (error) {
          return `/plugins ${action} failed: ${error instanceof Error ? error.message : String(error)}`
        }
      }
      if (action && action !== 'help')
        return [
          `Unknown /plugins subcommand: ${action}`,
          'Usage: /plugins · /plugins install <name> · /plugins uninstall <name>',
        ].join('\n')
      if (action === 'help')
        return [
          'Usage:',
          '  /plugins                  browse builtin / dev / market plugins',
          '  /plugins install <name>   install from the market (digest-verified)',
          '  /plugins uninstall <name> remove a market-installed plugin',
        ].join('\n')
      let inventory
      try {
        inventory = await plugins.list()
      } catch (error) {
        return `/plugins is unavailable: ${error instanceof Error ? error.message : String(error)}`
      }
      const devEntries = inventory.dev.map(loadedEntry)
      if (!devEntries.length)
        devEntries.push({
          id: '__dev_empty',
          label: 'no dev plugins',
          value: '~/.apollo/plugins-dev/<name>/',
          status: 'empty',
          detail: [
            'Dev plugins auto-load from ~/.apollo/plugins-dev/<name>/ (a directory',
            'containing manifest.json + an ESM entry), or from extra paths listed in',
            'the APOLLO_DEV_PLUGINS=<dir>[,<dir>...] environment variable.',
            'Failures never block the REPL — they show up as startup notices.',
          ].join('\n'),
        })
      return {
        kind: 'tabs',
        title: 'Plugins — builtin · dev · market',
        placeholder: 'Search by name, version, or status',
        tabs: [
          {
            id: 'builtin',
            label: `Built-in (${inventory.builtin.length})`,
            entries: inventory.builtin.map(loadedEntry),
          },
          { id: 'dev', label: `Dev (${inventory.dev.length})`, entries: devEntries },
          {
            id: 'market',
            label: `Market (${inventory.market.installed.length})`,
            entries: marketTab(inventory),
          },
        ],
      }
    },
  })
  await apollo.log.info('apollo-plugin-manager activated')
}
