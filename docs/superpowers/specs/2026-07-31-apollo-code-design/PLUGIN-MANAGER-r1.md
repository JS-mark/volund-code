↩ [返回索引 (README)](./README.md) · 关联章节：[§6a 插件核心](./06a-plugins-core.md) · [§19 插件内核](./19-plugin-kernel.md) · [PLUGIN-STATUS-UI-r1](./PLUGIN-STATUS-UI-r1.md) · [附录 C 配置表](./APPENDIX-C-config-schema.md)

---

# Apollo Code · /plugins 插件管理面板 + 市场链路白皮书 (r1)

> **状态**：r1（2026-08-25）——**已落地**：内置插件 `apollo-plugin-manager`（/plugins 三页签浏览 + install/uninstall 子命令）、`CommandTabsView` 多页签面板描述符、`apollo.plugins.*` 桥命名空间、`[plugins] market` 市场源配置、digest 校验安装链（下载 → 校验 → 落盘 `~/.apollo/plugins/<name>/` → 激活期完整性重验）。签名/吊销（registry verifier）留给 Catalog v2（CAT-01/02 + ABI-R1）。
> **文档类型**：ADR + 扩展规约
> **范围**：`packages/plugin-sdk`（CommandTabsView / apollo.plugins 类型）/ `packages/plugin-runtime`（plugins.* 路由 + 权限映射 + integrity 参数）/ `packages/ui`（TabbedListView + 命令执行期 spinner）/ `packages/shared`（[plugins] schema）/ `apps/cli`（plugin-market.ts + runtime 装载端口 + apollo-plugin-manager）/ `docs`（附录 C.2）
> **触发**：内置 /env 验证了「插件贡献命令 + 纯数据描述符」链路后，需要同链路的插件浏览/管理面板与远程获取机制；业界对标 claude-code 的 /plugins（tabs + 搜索 + loading）。

---

## §P1 目标与非目标

### P1.1 目标

1. **`/plugins` 命令（内置插件实现，自举）**：三页签浏览——Built-in（产物自带 `apps/cli/plugins/`）、Dev（`~/.apollo/plugins-dev/` + `APOLLO_DEV_PLUGINS`）、Market（`[plugins] market` 索引 + 已装市场插件）；页签 ←/→ 切换、输入即搜索、Enter 看 detail，数据经 `apollo.plugins.list()` 桥取宿主快照。
2. **多页签面板描述符**：`{ kind: 'tabs', title, placeholder, tabs: [{ id, label, entries }] }`——与 `kind: 'list'` 同类的纯数据契约，渲染权在 K0（插件自渲染仍是永久 non-goal）。
3. **命令执行期 loading**：斜杠命令 await 期间状态行切换为 spinner（`running /<name>`，tool 相位），命令不是 turn——esc 不挂中断。
4. **市场（远程）加载机制**：`[plugins] market` 指向索引 URL；`/plugins install <name>` 由宿主完成 拉索引 → 逐文件下载（同源约束 + sha256 digest 校验）→ manifest/engines 校验 → verifyBundle → 原子落盘 `~/.apollo/plugins/<name>/` → 立即激活；`uninstall` 停用 + 删目录。
5. **激活期完整性重验**：安装时写 `apollo-market.json`（files[] digest 映射）；此后每次启动装载都把该映射传入 `verifyBundle`——本地篡改即拒载（拒绝发生在沙箱启动前）。

### P1.2 非目标（划清边界）

- **不做**市场签名/吊销/key rotation（`PluginRegistryClient` + `verifyPluginRegistryMetadata` 原语保留给 Catalog v2；CAT-01/02 + ABI-R1 硬门不变）。
- **不做**面板内交互式安装（Space 切换 enable/disable、面板内按钮）——r1 安装走 `/plugins install <name>` 子命令；面板 Enter 只读 detail。
- **不动**legacy Catalog 授权路径：`LEGACY_PLUGIN_UNAVAILABLE` / `PluginManager` approvals（plugins.json）维持 deny-only；市场插件激活走本地沙箱链（与 builtin/dev 同链），不新增授权 authority。
- **不做**市场源的项目级覆盖：`plugins.market` 标注 projectOverride **forbidden**（项目 config 不得把下载指向第三方源）。

## §P2 契约

### P2.1 CommandTabsView（多页签列表面板描述符）

```
{ kind: 'tabs', title, placeholder?, tabs: [{ id, label, entries: CommandListEntry[] }] }
```

- 条目复用 `CommandListEntry`（id/label/value/status/detail）；守卫 `isCommandTabsView`（tabs 非空、逐条目校验），不合法按无输出处理（fail-open）。
- 交互：←/→ 切页签（**搜索词保留**、选中复位）、输入即过滤当前页签（复用 list-picker 的模糊评分）、↑/↓/PgUp/PgDn/Home/End 选择、Enter detail 进 transcript、Esc 关闭。
- `SlashCommand.run` 返回值契约扩为 `string | CommandListView | CommandTabsView | void`（plugin-sdk `CommandSpec.handler` 同步）。

### P2.2 `apollo.plugins.*` 桥命名空间（可选，deny-by-default）

| 方法 | 权限（manifest `permissions.apollo`） | 说明 |
| --- | --- | --- |
| `plugins.list()` | `plugins.read` | 三源装载快照 + 市场索引（未配置/失败 → `{ error }`，面板负责解释） |
| `plugins.install(name)` | `plugins.manage` | 宿主侧安装 + 立即激活；接受裸短名（`env` → `apollo-plugin-env`） |
| `plugins.uninstall(name)` | `plugins.manage` | **热卸载**（仅市场插件）：停用（命令/页签当场摘除、沙箱进程终止）+ 删 `~/.apollo/plugins/<name>/`，当前会话立即生效 |

沙箱侧无网络——市场拉取/安装全部宿主完成（沙箱 Proxy 自动把 `apollo.plugins.list()` 映射为桥 RPC）。安装整体共享 9s deadline（桥 RPC 10s 超时之内宿主必出结果）。已登记 `APOLLO_BRIDGE_CAPABILITIES`（local 通道 only）。

### P2.3 `[plugins] market` 配置与索引格式

- 配置：`[plugins] market = "https://…/index.json"`（用户级；项目级 forbidden）。可信源 = 规范 HTTPS（无凭据/query/hash）或回环 http（localhost/127.0.0.1/[::1]，测试/自建源）；schema 只管形状（string），信任语义在 `plugin-market.ts`。
- 索引：`{ schemaVersion: 1, plugins: [{ name, version, description?, publisher?, files: [{ path, digest: "sha256-…" }] }] }`；上限 256 插件 / 每插件 64 文件 / 每文件 8MB / 索引 1MB；`manifest.json` 必在 files；path 限定安全相对路径（无 `..`）。
- 下载地址 = 索引 origin 下 `<plugin-name>/<path>`，强制同源；digest 逐文件校验，manifest 的 name/version 必须与索引一致。
- 装载：`~/.apollo/plugins/` 自动发现（dot 目录与无 manifest.json 的目录跳过）→ 读 `apollo-market.json` → `verifyBundle(dir, manifest, integrity)` → 沙箱激活。数据目录 `~/.apollo/plugins-data/<name>/`（与 dev 的 plugins-dev-data 分离）。

### P2.4 时序与降级

- REPL 启动装载顺序：builtin → dev → market；单个失败不阻塞（startup notices + stderr + `plugin.local_load_failed` 遥测）。
- `/plugins` 打开：面板数据由命令执行期 spinner 覆盖；市场索引 60s 内存缓存，install/uninstall 后失效。索引未配置/拉取失败 → Market 页签显示配置指引/错误条目（不阻塞其他页签）。
- 安装失败：staging 清理，目标目录不动（旧版本继续可用）；安装成功但激活失败：目录保留（下次启动重试），错误上抛展示。
- **卸载边界（r1.1）**：仅市场插件可卸载（识别依据 = 装载来源 source=market 或 `apollo-market.json` 元数据）。内置插件随产物分发、不可卸载；dev 插件目录归开发者管理（`~/.apollo/plugins-dev/` / `APOLLO_DEV_PLUGINS`），卸载请求对这两类给出明确拒绝理由（"…builtin plugin … cannot be uninstalled" / "…dev plugin … remove its directory and restart"），不落任何裸 `plugin_not_installed`。同名重装 = 热换新（先停用旧实例再激活新版）。卸载保留数据目录 `~/.apollo/plugins-data/<name>/`（重装复用）。
- **命令排序（r1.1）**：`CommandSpec.order?`（有限数，桥上非法值按未设置处理）经 dispatch → `CommandContribution.order` → 注册表 → UI `SlashCommand.order`。排序语义（`sortSlashCommands`，稳定排序）：按 order 升序；未设置的保持在未排序段（内置之后、按注册序）。**内置命令占 10 的倍数号段**（help=10、exit=20、clear=30、undo=40、status=50、context=60、compact=70、memory=80、resume=90、model=100、skills=110、mcp=120、skill=130）；插件用间隙值穿插（如 45 = /undo 与 /status 之间）或 > 130 排在内置之后。新增内置命令取下一个 10 的倍数。建议下拉、`/help`、注册表 snapshot 共用该顺序。

## §P3 安全模型（r1）

1. 沙箱不变量延续：插件代码只跑在 `apollo-sandbox --run-plugin` 子进程，主进程只见经权限 guard 的桥方法；市场插件与 builtin/dev 同链，manifest 校验（engines）+ verifyBundle（路径逃逸/符号链接拒绝）+ per-file digest + 权限 guard 一样不少。
2. 新增面 = 宿主网络拉取：同源约束 + HTTPS（回环 http 例外）+ 逐文件 sha256 + 尺寸/数量上限 + 整体 deadline，规避注册源投毒与资源耗尽。
3. 与 legacy 的目录共存（偏差声明）：市场插件落盘 `~/.apollo/plugins/`，与 `plugins.json` approvals 同目录互不读取。PLUGIN-STATUS-UI-r1 中「dev 发现与 legacy 路径完全隔离」对 dev 仍成立；市场路径选择共存而非新目录，理由：下载后即本地插件、单一安装根、与 claude-code 的 `~/.claude/plugins` 惯例对齐。legacy `PluginManager.uninstall` 按名删目录的行为仍存在，但市场流程有自己的 uninstall（先停用再删）。
4. 激活期重验：`apollo-market.json` 是完整性锚点——装载时被篡改的文件在沙箱启动前即拒载。

## §P4 已落地清单（r1，2026-08-25）

1. `packages/ui`：`tabbed-list.ts`（守卫/键盘/分页纯逻辑）+ `TabbedListView` 组件 + `app.tsx` 接入（list/tabs 判别渲染）+ 命令执行期 spinner（`commandRunning` 期不挂 esc 中断）。
2. `packages/plugin-sdk`：`CommandTabsView` / `CommandTabsSection` / `PluginInventory*` / `PluginInstallResult` 类型 + `ApolloBridge.plugins?` 命名空间 + `CommandSpec.handler` 返回值扩宽。
3. `packages/plugin-runtime`：`LocalPluginServices` 增 `listPlugins` / `installMarketPlugin` / `uninstallMarketPlugin`；`BRIDGE_PERMISSIONS` 增 `plugins.list→plugins.read`、`plugins.install/uninstall→plugins.manage`；`activateLocalPlugin` 增 `integrity` 参数；能力矩阵 +3。
4. `packages/shared`：`ConfigSchema` 增 `[plugins] market`（string?）+ registry 登记（projectOverride forbidden）+ 附录 C.2 行。
5. `apps/cli`：`plugin-market.ts`（源信任/索引校验/digest 安装/元数据/卸载）+ runtime 装载端口重构（`LoadedPluginEntry` 单插件可卸载、`loadMarketPlugins`、市场索引缓存、桥服务实现、telemetry `plugin.market_installed`）+ `cli.ts` 启动装载市场插件。
6. 内置插件 `apollo-plugin-manager`（apps/cli/plugins/）：/plugins 三页签 + install/uninstall/help 子命令 + dev/market 空态指引。
