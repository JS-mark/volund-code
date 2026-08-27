↩ [返回索引 (README)](./README.md) · 关联章节：[§6a 插件核心](./06a-plugins-core.md) · [§19 插件内核](./19-plugin-kernel.md) · [PLUGIN-STATUS-UI-r1](./PLUGIN-STATUS-UI-r1.md) · [附录 C 配置表](./APPENDIX-C-config-schema.md)

---

# Volund CLI · /plugins 插件管理面板 + 市场链路白皮书 (r1)

> **状态**：r1.2（2026-08-26 安全收敛）——**已落地**：内置插件 `volund-plugin-manager`（/plugins 浏览 + install/inspect/approve/enable/disable/uninstall）、独立 `plugin-state.v2.json` 生命周期 authority、digest 校验安装链与激活期重验。远程 HTTPS 市场在发布者签名/吊销/trusted-key root 接通前只可浏览，执行安装 fail closed；回环源保留给本地开发。
> **文档类型**：ADR + 扩展规约
> **范围**：`packages/plugin-sdk`（CommandTabsView / volund.plugins 类型）/ `packages/plugin-runtime`（plugins.* 路由 + 权限映射 + integrity 参数）/ `packages/ui`（TabbedListView + 命令执行期 spinner）/ `packages/shared`（[plugins] schema）/ `apps/cli`（plugin-market.ts + runtime 装载端口 + volund-plugin-manager）/ `docs`（附录 C.2）
> **触发**：内置 /env 验证了「插件贡献命令 + 纯数据描述符」链路后，需要同链路的插件浏览/管理面板与远程获取机制；业界对标 claude-code 的 /plugins（tabs + 搜索 + loading）。

---

## §P1 目标与非目标

### P1.1 目标

1. **`/plugins` 命令（内置插件实现，自举）**：三页签浏览——Built-in（产物自带 `apps/cli/plugins/`）、Dev（`~/.volund/plugins-dev/` + `VOLUND_DEV_PLUGINS`）、Market（`[plugins] market` 索引 + 已装市场插件）；页签 ←/→ 切换、输入即搜索、Enter 看 detail，数据经 `volund.plugins.list()` 桥取宿主快照。
2. **多页签面板描述符**：`{ kind: 'tabs', title, placeholder, tabs: [{ id, label, entries }] }`——与 `kind: 'list'` 同类的纯数据契约，渲染权在 K0（插件自渲染仍是永久 non-goal）。
3. **命令执行期 loading**：斜杠命令 await 期间状态行切换为 spinner（`running /<name>`，tool 相位），命令不是 turn——esc 不挂中断。
4. **市场生命周期**：`/plugins install <name>` 只完成拉取、校验、原子落盘与 v2 登记，结果固定为 disabled。用户必须 `inspect` 权限与完整 permission hash，再执行 `approve <name> <hash>` 和 `enable <name>`；版本或权限 hash 变化自动撤销批准并禁用。`uninstall` 停用 + 删目录 + 删除 v2 记录。
5. **激活期完整性重验**：安装时写 `volund-market.json`（files[] digest 映射）；此后每次启动装载都把该映射传入 `verifyBundle`——本地篡改即拒载（拒绝发生在沙箱启动前）。

### P1.2 非目标（划清边界）

- **尚未做完**市场签名/吊销/key rotation，因此远程 HTTPS 市场不得执行安装；不能把 HTTPS + digest 当成发布者身份。`PluginRegistryClient` + `verifyPluginRegistryMetadata` 原语接入 trusted-key root 后才允许开放。
- **不做**面板内交互式安装（Space 切换 enable/disable、面板内按钮）——r1 安装走 `/plugins install <name>` 子命令；面板 Enter 只读 detail。
- **不复用** legacy Catalog authority：`LEGACY_PLUGIN_UNAVAILABLE` / `plugins/plugins.json` 维持 deny-only；本地三源统一由 `~/.volund/plugin-state.v2.json` 决定 installed/approved/enabled，运行时数组只代表 loaded，不再是另一套持久 authority。
- **不做**市场源的项目级覆盖：`plugins.market` 标注 projectOverride **forbidden**（项目 config 不得把下载指向第三方源）。

## §P2 契约

### P2.1 CommandTabsView（多页签列表面板描述符）

```
{ kind: 'tabs', title, placeholder?, tabs: [{ id, label, entries: CommandListEntry[] }] }
```

- 条目复用 `CommandListEntry`（id/label/value/status/detail）；守卫 `isCommandTabsView`（tabs 非空、逐条目校验），不合法按无输出处理（fail-open）。
- 交互：←/→ 切页签（**搜索词保留**、选中复位）、输入即过滤当前页签（复用 list-picker 的模糊评分）、↑/↓/PgUp/PgDn/Home/End 选择、Enter detail 进 transcript、Esc 关闭。
- `SlashCommand.run` 返回值契约扩为 `string | CommandListView | CommandTabsView | void`（plugin-sdk `CommandSpec.handler` 同步）。

### P2.2 `volund.plugins.*` 桥命名空间（可选，deny-by-default）

| 方法 | 权限（manifest `permissions.volund`） | 说明 |
| --- | --- | --- |
| `plugins.list()` | `plugins.read` | 三源装载快照 + 市场索引（未配置/失败 → `{ error }`，面板负责解释） |
| `plugins.inspect(name)` | `plugins.read` | 返回版本、source、完整权限声明、permission hash 与 installed/approved/enabled/loaded 四态 |
| `plugins.install(name)` | `plugins.manage` | 宿主侧校验并落盘，固定不激活；接受裸短名（`env` → `volund-plugin-env`） |
| `plugins.approve(name, permissionHash)` | `plugins.manage` | 只接受当前完整 hash；stale hash 拒绝。批准仍不激活 |
| `plugins.enable(name)` | `plugins.manage` | 仅当 version + permission hash 与批准记录完全一致时热激活 |
| `plugins.disable(name)` | `plugins.manage` | 热停用并保留安装目录与批准记录 |
| `plugins.uninstall(name)` | `plugins.manage` | **热卸载**（仅市场插件）：停用（命令/页签当场摘除、沙箱进程终止）+ 删 `~/.volund/plugins/<name>/`，当前会话立即生效 |

沙箱侧无网络——市场拉取/安装全部宿主完成（沙箱 Proxy 自动把 `volund.plugins.list()` 映射为桥 RPC）。安装整体共享 9s deadline（桥 RPC 10s 超时之内宿主必出结果）。已登记 `VOLUND_BRIDGE_CAPABILITIES`（local 通道 only）。

### P2.3 `[plugins] market` 配置与索引格式

- 配置：`[plugins] market = "https://…/index.json"`（用户级；项目级 forbidden）。规范 HTTPS（无凭据/query/hash）可拉取并浏览索引，但在签名信任根落地前安装报 `plugin_registry_signature_required`；回环 http（localhost/127.0.0.1/[::1]）仅用于本地开发与测试，可执行安装。
- 索引：`{ schemaVersion: 1, plugins: [{ name, version, description?, publisher?, files: [{ path, digest: "sha256-…" }] }] }`；上限 256 插件 / 每插件 64 文件 / 每文件 8MB / 索引 1MB；`manifest.json` 必在 files；path 限定安全相对路径（无 `..`）。
- 下载地址 = 索引 origin 下 `<plugin-name>/<path>`，强制同源；digest 逐文件校验，manifest 的 name/version 必须与索引一致。
- 装载：`~/.volund/plugins/` 自动发现后先 reconcile 到 `plugin-state.v2.json`；未批准或未启用的插件仅进入 inventory，不启动进程。eligible 插件再读 `volund-market.json` → `verifyBundle` → 沙箱激活。数据目录 `~/.volund/plugins-data/<name>/`。

### P2.4 时序与降级

- REPL 启动装载顺序：builtin → dev → market；单个失败不阻塞（startup notices + stderr + `plugin.local_load_failed` 遥测）。
- `/plugins` 打开：面板数据由命令执行期 spinner 覆盖；市场索引 60s 内存缓存，install/uninstall 后失效。索引未配置/拉取失败 → Market 页签显示配置指引/错误条目（不阻塞其他页签）。
- 安装失败：staging 清理，目标目录不动；安装成功只返回 permission hash 与权限声明，不激活。enable 时若完整性/沙箱启动失败，保持已安装状态但不伪报 loaded。
- **卸载边界（r1.1）**：仅市场插件可卸载（识别依据 = 装载来源 source=market 或 `volund-market.json` 元数据）。内置插件随产物分发、不可卸载；dev 插件目录归开发者管理（`~/.volund/plugins-dev/` / `VOLUND_DEV_PLUGINS`），卸载请求对这两类给出明确拒绝理由（"…builtin plugin … cannot be uninstalled" / "…dev plugin … remove its directory and restart"），不落任何裸 `plugin_not_installed`。同名重装 = 热换新（先停用旧实例再激活新版）。卸载保留数据目录 `~/.volund/plugins-data/<name>/`（重装复用）。
- **命令排序（r1.1）**：`CommandSpec.order?`（有限数，桥上非法值按未设置处理）经 dispatch → `CommandContribution.order` → 注册表 → UI `SlashCommand.order`。排序语义（`sortSlashCommands`，稳定排序）：按 order 升序；未设置的保持在未排序段（内置之后、按注册序）。**内置命令占 10 的倍数号段**（help=10、exit=20、clear=30、undo=40、status=50、context=60、compact=70、memory=80、resume=90、model=100、skills=110、mcp=120、skill=130）；插件用间隙值穿插（如 45 = /undo 与 /status 之间）或 > 130 排在内置之后。新增内置命令取下一个 10 的倍数。建议下拉、`/help`、注册表 snapshot 共用该顺序。

## §P3 安全模型（r1）

1. 沙箱不变量延续：插件代码只跑在 `volund-sandbox --run-plugin` 子进程，主进程只见经权限 guard 的桥方法；市场插件与 builtin/dev 同链，manifest 校验（engines）+ verifyBundle（路径逃逸/符号链接拒绝）+ per-file digest + 权限 guard 一样不少。
2. 网络拉取面：同源约束 + 逐文件 sha256 + 尺寸/数量上限 + deadline 只解决传输/资源边界，不证明发布者身份。远程安装必须有签名/吊销/trusted-key root；当前缺失即 fail closed。
3. authority：legacy `plugins/plugins.json` 只归冻结的 deny-only Catalog；v2 使用同级 `plugin-state.v2.json`，原子写入 installed/approved/enabled。市场安装目录仍为 `plugins/<name>`，loaded 只存在于内存且由 v2 状态派生。
4. 激活期重验：`volund-market.json` 是完整性锚点——装载时被篡改的文件在沙箱启动前即拒载。

## §P4 已落地清单（r1，2026-08-25）

1. `packages/ui`：`tabbed-list.ts`（守卫/键盘/分页纯逻辑）+ `TabbedListView` 组件 + `app.tsx` 接入（list/tabs 判别渲染）+ 命令执行期 spinner（`commandRunning` 期不挂 esc 中断）。
2. `packages/plugin-sdk`：`CommandTabsView` / `CommandTabsSection` / `PluginInventory*` / `PluginInstallResult` 类型 + `VolundBridge.plugins?` 命名空间 + `CommandSpec.handler` 返回值扩宽。
3. `packages/plugin-runtime`：`LocalPluginServices` 与能力矩阵覆盖 list/inspect/install/approve/enable/disable/uninstall；读操作映射 `plugins.read`，生命周期变更映射 `plugins.manage`。
4. `packages/shared`：`ConfigSchema` 增 `[plugins] market`（string?）+ registry 登记（projectOverride forbidden）+ 附录 C.2 行。
5. `apps/cli`：新增 `plugin-state.ts`（schema v2、原子持久化、版本/权限变化撤销批准）并让 runtime inventory/激活/卸载统一读取它；`plugin-market.ts` 对无签名远程安装 fail closed。
6. 内置插件 `volund-plugin-manager`：/plugins 三页签 + install/inspect/approve/enable/disable/uninstall/help；安装结果直接展示权限与精确批准命令。
