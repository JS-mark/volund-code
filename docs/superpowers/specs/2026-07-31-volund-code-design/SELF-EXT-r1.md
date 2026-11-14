# 自扩展与内核行为替换白皮书 (SELF-EXT r1)

> **状态**：📋 PROPOSED — NOT SHIPPED。本文是目标契约，不描述当前产品能力。
> **日期**：2026-11-15
> **对标**：pi（badlogic/pi-mono）的两个招牌能力——①agent 在会话中给自己写扩展；②扩展可替换 harness 默认行为（如 compaction、状态条 widget）。
> **相关**：[§19 Plugin Kernel](./19-plugin-kernel.md) · [§19a Capability Contract](./19a-capability-contract.md) · [§18 Self-Development](./18-self-development.md) · [§8b.8 插件扩展点](./08b-context-policy.md) · [PLUGIN-STATUS-UI-r1](./PLUGIN-STATUS-UI-r1.md) · [PLUGIN-MANAGER-r1](./PLUGIN-MANAGER-r1.md)

---

## 0. 与 §18 的边界（先读这个）

§18「受控自我开发」管的是 **volund 仓库自身的候选变更审批管线**（K3 capability promotion，proposed/未交付）。本文管的是**另一个维度**：agent 在普通用户会话中，为用户的 harness 环境（`~/.volund/` 或项目 `.volund/`）编写和安装**用户域扩展**。

按 §18.1 术语表，这属于「**普通编码会话**：用户要求 Agent 完成任务」的 harness 行为，**不是** Self-Development，不得使用 self-evolution 等措辞。agent 写的扩展修改的是用户的扩展目录，永不触碰 volund 自身的实现包、信任根、权限/沙箱机制（§18.5.1 受保护面对所有路径一视同仁地生效——扩展代码本身就是被沙箱管的对象）。

## 1. 范围与非目标

**v1 范围**：

1. **内核行为扩展点注册表**：把「可被扩展替换/增强的内核行为」收编为显式契约（id、类型、默认实现、替换等级），首批收编 3 个点（§3.1）。
2. **agent 自写扩展流**：agent 经内置 skill 引导，在会话中编写一个用户/项目域插件，经 manifest 校验 + 用户审批后热加载激活。
3. **管理面**：/plugins 面板（TUI）与 web/mobile 插件面板新增 `agent` 来源域，可查看/启停/删除 agent 写的扩展。

**v1 明确不做**：

- 不做扩展市场分发（agent 写的扩展不进 market 索引；分享=用户手动拷目录）。
- 不做跨扩展依赖解析（每个 agent 扩展自包含，manifest 声明 capabilities，不声明 plugin 依赖）。
- 不做扩展的签名/catalog 信任根（§19a Catalog v2 交付前，agent 扩展一律走「未签名本地扩展」通道 + 首装人工审批）。
- 不允许 agent 扩展替换受保护面（§18.5.1 清单 + §19 四边界：沙箱桥/权限/事件契约/UI 渲染权中不开放的渲染权部分）。

## 2. 地基盘点（已有 vs 要建）

| 地基                                                        | 现状                          | 本文要做的                                                    |
| ----------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------- |
| Cordis 内核 + 插件桥贡献面（tools/hooks/prompt/session.on） | 已落地（§19 运行时内核）      | 扩展=普通插件，直接复用宿主与桥                               |
| 可替换 provider 桥（`webSearch.provide`）                   | 已落地（WebSearch 插件）      | 作为「替换型扩展点」的先例收编进注册表                        |
| 自定义 ContextPolicy 扩展点                                 | spec 已有（§8b.8），实现部分  | 收编为扩展点 #1，补齐「agent 替换」路径                       |
| /status 区块扩展（registerSection/registerTab）             | spec+落地（PLUGIN-STATUS-UI） | 收编为扩展点 #2                                               |
| 内置插件先例（volund-plugin-ask 注入提问引导）              | 已落地                        | 证明「插件改内核默认行为」可行                                |
| 插件沙箱宿主 + manifest 校验 + 市场安装链                   | 已落地（PLUGIN-MANAGER-r1）   | 复用宿主/校验；安装链不走 market，走本地目录                  |
| `.claude/agents`、`.claude/skills` 互操作                   | 已落地                        | **不在本文范围**（那是配置域，非代码扩展域）                  |
| cordis S3 热重载                                            | 未落地（§19 规划）            | v1 用「重载=重启插件宿主进程内 service」的保守语义，不依赖 S3 |
| agent 写代码能力（Edit/Write+权限门）                       | 已落地                        | 写入路径加守卫（只允许进扩展目录）                            |

## 3. 契约设计

### 3.1 内核行为扩展点注册表（KernelExtensionPoint）

扩展点是一等契约，集中登记（`packages/kernel/src/extension-points.ts`），每项必须声明：

```ts
interface KernelExtensionPoint {
  id: string // 'context.policy' | 'status.section' | 'session.titleGenerator'
  kind: 'replace' | 'augment' // replace=单实现顶掉默认；augment=追加贡献
  contract: string // 契约类型引用（接口名 + 定义文件锚点）
  defaultImplementation: string // 内置默认实现标识
  maxContributions: number | 'unbounded' // replace=1（后注册者拒绝并报错）；augment=N
  protectedFace: boolean // true=永不开放（v1 全部 false，此字段为受保护面守卫预留）
}
```

**v1 首批三点**：

| 扩展点                   | kind    | 契约锚点                   | 默认实现             | 说明                                    |
| ------------------------ | ------- | -------------------------- | -------------------- | --------------------------------------- |
| `context.policy`         | replace | §8b.2 `ContextPolicy`      | 内置 default policy  | 自定义压缩/预算策略（8b.8 收编）        |
| `status.section`         | augment | PLUGIN-STATUS-UI §数据契约 | —                    | /status 区块/tab 声明式贡献             |
| `session.titleGenerator` | replace | §8.5 session 元数据        | 内置首条消息截断实现 | 会话标题生成（web/mobile 会话列表消费） |

规则：

- 替换型扩展点冲突处理：后注册者类型化拒绝（`extension_point_conflict`，进错误码 registry + docs 错误码页），先注册者生效；/plugins 面板显示当前占用者。
- 扩展点注册表有快照测试守卫（对齐 builtinTools 有序名单先例）；增删扩展点必须过 REVIEW。
- `protectedFace=true` 的点 v1 不存在；未来若收编权限/沙箱类行为，必须先过 §19/§19a 评审，不许悄悄开放。

### 3.2 agent 自写扩展流（五步管线）

```text
用户请求/agent 提议 → ① skill 引导写作 → ② 目录落盘+manifest 校验
→ ③ 审批卡（首装必审） → ④ 激活（宿主装载+扩展点注册） → ⑤ /plugins 面板可见可管
```

**① 写作引导**：新增内置插件 `volund-plugin-self-ext`，贡献 `extension-authoring` skill（$ARGUMENTS 取扩展用途描述）。skill 内容=SDK 契约摘要（扩展点表 + PluginManifest 最小示例 + 能力声明表），agent 据此写代码。skill 本体进内置插件源码，随版本走。

**② 落盘与校验**：

- 写入路径白名单：user 域 `~/.volund/extensions/<name>/`，project 域 `<cwd>/.volund/extensions/<name>/`；Write/Edit 守卫在 agent 域拒绝扩展目录之外的任何自我扩展写入（复用 fs 路径落盘的 `<cwd>/**` 泛化模式机制，新增 `extensions` 特判段）。
- manifest 必须声明 `origin: 'agent-authored'` + `capabilities: []`（最小声明，默认零能力，按需追加并重新审批）。
- 校验复用现有 manifest 校验器；校验失败的文件留在目录内但标记 invalid，面板可见。

**③ 审批**：首装与每次 capabilities 扩容都弹审批卡（复用 permission 卡 UI 三端已有着陆）；「项目内记住」语义可泛化到「此扩展此项目内记住」。**禁止静默自启**：agent 不得跳过审批（宿主装载器硬校验 `origin:'agent-authored'` 的 approved 标记）。

**④ 激活**：走现有插件宿主装载（沙箱内）；`replace` 型点注册时如已被占用即拒绝（§3.1 冲突规则）。v1 激活语义=下次会话生效 + 当前会话可选热加载（宿主重启该 service；失败回滚到默认实现并报类型化错误）。

**⑤ 管理面**：/plugins（TUI）与 web/mobile 插件面板加 `agent` 域标签；行操作=启停/删除/查看 manifest；删除即移目录（带确认卡）。

### 3.3 事件与工具面

- 事件：`extension.suggested` / `extension.installed` / `extension.activation_failed` 三个，走事件新增全清单（8 处同步点 + 3 个硬编码计数守卫 + resume 尾窗 prepend 规则，见事件新增清单记忆/§2.7bis 先例），payload 进附录 D 登记 + per-event zod schema（r13-I8 纪律）。
- 错误码：`extension_point_conflict` / `extension_manifest_invalid` / `extension_approval_required` / `extension_load_failed` 进 APPENDIX-B + shared registry（verify:error-codes 门禁会咬，先登记后 emit——reflection 三码 11 天红的前车之鉴）。
- 工具：**不新增工具**。写扩展=既有 Write/Edit + 守卫；装/激活=审批卡动作；避免 builtinTools 有序名单快照再动一次。

### 3.4 权限与沙箱不变量

1. agent 扩展代码永远运行在插件沙箱宿主内，与市场安装的第三方插件同级信任（未签名档）。
2. 扩展的 capabilities 即其权限上界：未声明的桥调用类型化拒绝。
3. agent 不得写其它扩展的目录（守卫按 `<cwd>/.volund/extensions/**` + `~/.volund/extensions/**` 白名单收口，跨名写入拒绝）。
4. 扩展可被 /plugins 禁用；禁用后其扩展点槽位回落默认实现。
5. 受保护面（§18.5.1）对扩展源码的**装载**不可谈判：扩展声明 capabilities 碰权限/沙箱/审批域 → manifest 校验直接拒绝。

## 4. 任务卡（EXT-01…，建议两批）

| ID     | 内容                                                                                                 | 批   |
| ------ | ---------------------------------------------------------------------------------------------------- | ---- |
| EXT-01 | 扩展点注册表 + 三点收编（context.policy/status.section/session.titleGenerator）+ 冲突语义 + 快照守卫 | 批 1 |
| EXT-02 | `session.titleGenerator` 扩展点落地（默认实现抽出为可替换）                                          | 批 1 |
| EXT-03 | 写入守卫：扩展目录白名单 + 跨名拒绝 + manifest `origin:'agent-authored'` 校验                        | 批 1 |
| EXT-04 | 审批卡接线（首装/capabilities 扩容/项目内记住）                                                      | 批 2 |
| EXT-05 | `volund-plugin-self-ext` 内置插件 + extension-authoring skill                                        | 批 2 |
| EXT-06 | /plugins `agent` 域（TUI+web+mobile）+ 三事件 + 四错误码全清单接线                                   | 批 2 |
| EXT-07 | 文档面：docs 指南页（写第一个扩展教程）+ CLI 参考                                                    | 批 2 |

批 1 交付即可独立验证（扩展点机制 + 人工写一个示例扩展）；批 2 闭环「agent 自己写」。

## 5. 验收门禁

- 扩展点注册表快照测试（增删点必须显式改测试）。
- e2e：agent 全链一次（提议→写→审→装→激活→status 出现新区块/标题变化）；审批拒绝路径（装不上、面板显示 pending-invalid）。
- 冲突用例：两个 replace 型扩展抢同一点，后者类型化拒绝且面板可见占用者。
- 守卫用例：agent 试图写扩展目录外 / 跨扩展名 / capabilities 未声明而调桥——三路全拒。
- pty 实测 TUI /plugins agent 域（bundle 改动纪律：非渲染路径全绿不算数）。

## 6. 待拍板

1. **首批扩展点范围**：本文钉 3 个（context.policy / status.section / session.titleGenerator）；`commit message 生成`、`reflection 触发策略` 候补，Mark 圈。
2. **project 域信任门**：`.volund/extensions/**` 是项目内可提交内容，撞 REM-29（项目级 config/mcp.toml 内容信任门）射程——project 域扩展首装是否叠加「内容信任门」（hash 变更即重审）。
3. **热加载深度**：当前会话立即生效 vs 一律下次会话（保守）。本文倾向：replace 型下次会话，augment 型立即。
4. 扩展目录是否随 `/memory` 落盘恢复一起进会话恢复面（大概率不进，先不收）。
