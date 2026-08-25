> ↩ [返回索引 (README)](./README.md) · 关联章节：[§6a 插件核心](./06a-plugins-core.md)（§6.4.1a）· [§7 终端 UI](./07-terminal-ui.md)（§7.10）· [§11 CLI 命令](./11-cli-commands.md)（§11.3.14）· [§19 插件内核](./19-plugin-kernel.md) · [AGENT.md §4.10](../../../AGENT.md)

---

# Apollo Code · 插件 /status 面板扩展白皮书 (r1)

> **状态**：r1.1（2026-08-25）——**K0 渲染器 + dev 装载路径已落地**：约定目录 `~/.apollo/plugins-dev/<name>/` 自动发现（REPL 启动与 `apollo status` 均加载；`APOLLO_DEV_PLUGINS` 仅作仓库内开发的额外路径），经 `apollo-sandbox --run-plugin` 沙箱子进程激活（不经 Catalog，与冻结中的 legacy 安装路径 `~/.apollo/plugins` 完全隔离）；插件数据目录 `~/.apollo/plugins-dev-data/<name>/`。Catalog v2 生产路径仍待 CAT-01/02 + ABI-R1。
> **文档类型**：ADR + 扩展规约
> **范围**：`packages/plugin-sdk` / `packages/plugin-runtime`（bridge-server / local-plugin）/ `packages/ui`（StatusPanel）/ `apps/cli`（pluginDev 端口）/ `examples/plugin-status-demo`
> **触发**：/status 面板已实现五页签（Settings / Status / Config / Usage / Stats）后，第三方需要同等扩展位；评审结论是"数据契约式"（插件只产出描述符，K0 渲染），否决插件自渲染。

---

## §S1 目标与非目标

### S1.1 目标

1. **插件可向 /status 面板贡献只读内容**，粒度两档：section（追加进内置页签）与整页签（tab）。
2. **纯数据契约**：描述符经 bridge 以 JSON 可序列化数据传递，K0 侧 React/Ink 渲染——与 plugin-sdk "plain text only; executable components and markup are intentionally unsupported" 一致，不动摇。
3. **与 §6.4.1a 既有 `ui.status.registerSection` 草拟合并**：本白皮书收回该草拟并给出完整契约（含 tab 级）。

### S1.2 非目标（划清边界）

- **不做**插件自渲染（无 ink 组件、无虚拟节点代理协议——永久 non-goal，撞 §4.10.1 硬约束）。
- **不做**插件自定义按键/交互（面板键位表归 K0 所有）。
- **不做**插件读写其他 section/tab 或内核状态（描述符只出不进）。
- **不提供**跨会话历史统计直读 API（v1）。插件要算统计，用既有 bridge（`session.getUsage` / `storage` / 受权限约束的 `fs`）自行维护；若未来需要 K0 聚合数据，另立契约评审。
- **不承诺**实时刷新（面板数据是打开 / `r` 时刻的快照，同 §7.10）。

---

## §S2 与既有约束的张力（决策依据）

### S2.1 vs §7.10 / §11.3.14 的"section 模型"

**张力**：§7.10/§11.3.14 把 /status 描述为单面板 + section 列表；实现已演进为**页签模型**（Settings/Status/Config/Usage/Stats，Tab/←/→ 切换，打开时经 `controller.refresh()` 取数）。spec 与实现存在漂移。

**消解**：本契约以实现为准——`registerSection` 的产出追加到内置 `status` 页签末尾（保持 §6.4.1a 草拟语义）；`registerTab` 提供整页签。§7.10/§11.3.14 的 section 模型表述另行修订（漂移整改，不在本白皮书范围）。

### S2.2 vs plugin-sdk "executable components intentionally unsupported"

**消解**：描述符是纯数据（见 §S3.2），K0 渲染器把一切值当纯文本并经 guard；插件永远不持有渲染权。本白皮书不修改该约束，是在其内的扩展。

### S2.3 vs §6.4.1 non-goals（插件不能碰内核/其他插件）

**消解**：描述符单向流出（插件 → K0），无回写通道；`register*` 全部返回 `Disposable`，`deactivate` 由 plugin-runtime 兜底 dispose（§6.4.1 既有契约不变）。

---

## §S3 契约

### S3.1 Surface 与权限

| 项 | 值 |
|---|---|
| ABI v2 surface | `ui-surface`（§19.1.1/§19.6 既有 surface，本契约复用不新增） |
| SDK 常量 | `PLUGIN_UI_SURFACES += 'status-panel'`（manifest 静态贡献用；动态页签走桥方法） |
| Bridge 命名空间 | `apollo.ui.status`（§6.4.1a 草拟位置不变） |
| Manifest 权限 | `permissions.apollo` 包含 `'ui.status'`（与 tools.register 等同一命名空间，deny-by-default）；桥方法→权限映射见 plugin-runtime `BRIDGE_PERMISSIONS` |

**Disposable 跨桥语义**：`registerTab`/`registerSection` 的返回值在 RPC 桥上退化为 `null`——插件不能远程 dispose 单个注册；统一由 `deactivate`（插件进程终止）回收，与 §6.4.1 的 runtime 兜底语义一致。

**r1.1 已知缺口**：沙箱桥的 `apollo` 是泛化 RPC 代理，属性访问不触发 RPC——`apollo.plugin.name/version/dataDir` 在沙箱路径下**不可用**（v2 候选：run_plugin 经 argv 注入插件身份）。插件需要用到的自有元数据请自行硬编码或持久化到 dataDir。

### S3.2 描述符 schema（schemaVersion: 1）

```ts
// ApolloBridge.ui.status
status: {
  /** 追加一个只读 section 到内置 status 页签末尾（§6.4.1a 草拟收回于此）。 */
  registerSection(spec: {
    id: string                     // 插件内唯一；冲突拒绝
    title: string                  // ≤ 40 字符
    render(): { rows: [string, string | number | boolean][] } | null
  }): Disposable

  /** 贡献一个整页签。 */
  registerTab(spec: {
    id: string                     // 全局唯一；'settings'|'status'|'config'|'usage'|'stats' 为内核保留，冲突拒绝
    label: string                  // ≤ 12 字符（TabBar 单格宽度预算）
    render(): PluginTabBody | null // null = 本次打开不渲染该页签
  }): Disposable
}

/** 三种声明式体例；全部由 K0 渲染。 */
type PluginTabBody =
  | { kind: 'rows'; sections: { title?: string; rows: [string, string | number | boolean][] }[] }
  | { kind: 'heatmap'; heatmap: { start: string; days: number[] }; legend?: string }
  | { kind: 'table'; columns: string[]; rows: string[][] }
```

- `rows` 体例即现有两列 `label: value` 渲染；`heatmap` 复用 Stats 页签的数据形状（`start` = 周日 `YYYY-MM-DD`，`days[i]` = start+i 天计数）与渲染器；`table` 是受限多列表。
- `render()` 在**面板打开时**与用户按 `r` 时重取（无自动轮询，§7.10 语义延伸）；返回值必须 JSON 可序列化，函数/类实例/undefined 属性一律拒绝。

### S3.3 Sanitize 规则（K0 侧强制，渲染前执行）

| 规则 | 阈值/行为 |
|---|---|
| control-character guard | 所有字符串剥 ANSI escape / C0 / bidi 控制符（沿用 §7.10 对插件 section 的既有规则） |
| 凭据模式拒绝 | 任何字符串命中敏感 key 模式（authorization/api key/token/credential/passphrase/oauth 等，与 status 配置过滤同一正则族）→ 整个描述符拒绝并记 telemetry |
| 行数/尺寸上限 | section ≤ 20 行、tab ≤ 40 行；heatmap `days` ≤ 371；table ≤ 4 列 × 20 行；label ≤ 40 字符、value ≤ 200 字符；超出截断并标注 `… (truncated)` |
| 数值合法 | `days`/数值字段必须 finite ≥ 0；非法 → 描述符拒绝 |
| 日期合法 | `heatmap.start` 必须匹配 `YYYY-MM-DD` 且为可解析日期 |

### S3.4 渲染与降级

- 插件 `render()` 抛错或 sanitize 拒绝 → 该 section/tab 显示一行 `section error: <label>`，**不 crash 面板**（§7.9/§7.10 降级语义延伸）；core 页签不受影响。
- 插件 disabled / dispose 后 → 对应 section/tab 不出现；页签集合动态派生，TabBar 顺序 = 内核五页签 + 插件页签（按注册序）。
- `r` 在插件页签上 = 仅重取该页签描述符；在内核页签上行为不变。

---

## §S4 版本与落地

1. **版本**：描述符 `schemaVersion: 1`；未来新增 `PluginTabBody.kind` 是 minor（旧内核忽略未知 kind 并显示降级行），破坏性格式变更升 major。
2. **落地前置（硬门）**：`LEGACY_PLUGIN_UNAVAILABLE` 重开（CAT-01/02 + ABI-R1 + 安全评审）之后才允许接运行时。
3. **已落地（r1.1，2026-08-25）**：
   1. `plugin-sdk`：`PluginStatusTabBody` / `PluginStatusTabSpec` / `PluginStatusSectionSpec` + `ApolloBridge.ui.status`。
   2. `plugin-runtime`：`PluginBridgeServer`（fd3 JSONRPC 宿主侧 + `callback.invoke` 反向调用）、`activateLocalPlugin`（manifest 校验 → bundle 校验 → 沙箱 profile → `apollo-sandbox --run-plugin`）、`createLocalPluginDispatch`（权限 guard + 方法路由）、`BRIDGE_PERMISSIONS` 增 `ui.status.*` / `session.getUsage` / `log.*` 映射；`sandboxProfile` 放行 darwin 系统 OpenSSL 配置（否则沙箱内 node 起不来）。
   3. `packages/ui`：StatusPanel 页签集合动态化 + `sanitizePluginTabs`（§S3.3）+ 三种体例渲染器（heatmap 复用抽取的公共 `StatusHeatmap`）。
   4. `apps/cli`：`pluginDev` 端口（`activateLocal`/`deactivateAll`）；`APOLLO_DEV_PLUGINS=<dir>` 在 REPL 启动与 `apollo status` 一次性命令里激活；runtimeStatusData 在面板数据组装时经桥回调 render 取值。
   5. 活样例：`examples/plugin-status-demo`（Plug=rows / Pulse=heatmap 两页签）。
4. **解禁后实现清单**（按依赖序）：
   1. `plugin-sdk`：`PluginUiSurface += 'status-panel'` + 描述符类型（type-only，保持 sdk 零运行时副作用）。
   2. `plugin-runtime`：`apollo.ui.status` bridge + permission 检查 + sanitize（guard/上限/凭据拒绝）。
   3. `packages/ui`：StatusPanel 页签集合动态化 + `heatmap`/`table` 渲染器（heatmap 复用 StatsView 抽取的公共组件）。
   4. `apps/cli`：注册表接线 + `apollo status --json` 输出插件 section（字段省略规则同 §11.3.14 诚实显示）。
   5. CI：契约校验脚本（描述符 schema 对 plugin-sdk 类型 diff）+ §7.10/§11.3.14 漂移修订。
