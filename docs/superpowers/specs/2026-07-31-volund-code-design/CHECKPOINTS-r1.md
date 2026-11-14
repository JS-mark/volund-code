# 会话检查点与回卷白皮书 (CHECKPOINTS r1)

> **状态**：📋 PROPOSED — NOT SHIPPED。本文是目标契约，不描述当前产品能力。
> **日期**：2026-11-15
> **对标**：Claude Code 2.0 Checkpoints——会话全程自动打点，`/rewind` 把**对话与文件**恢复到任一历史时点（可选只回对话/只回文件/两者）。
> **相关**：[§2.7bis.3 文件共享治理与 /undo](./02-agent-loop.md) · [§8 会话与配置存储](./08-session-config.md) · [§8b ContextPolicy](./08b-context-policy.md) · [§4 工具与权限](./04-tools-permissions.md) · [§22 Web Console](./22-web-console.md)

---

## 0. 与 /undo 的关系（先读这个）

volund 已有 `/undo`：按 §2.7bis.3 血统规则，撤销**最近一个 tool 执行**的文件改动（BackupStore batch manifest，逆序逐 batch 撤销）。它回答「反悔刚才那一下」。

本文的 checkpoint/rewind 回答「**回到上午三点那个状态**」——任意历史时点的**对话+文件双域**恢复。两者关系：

| 维度     | `/undo`（现状保留）     | `/rewind`（本文新增）                            |
| -------- | ----------------------- | ------------------------------------------------ |
| 恢复目标 | 最近一个 mutation batch | 任意 checkpoint                                  |
| 域       | 仅文件                  | 文件 + 对话（可选域）                            |
| 引擎     | BackupStore batch 逆序  | **复用同一 batch 逆序引擎**（沿 batch 链走多步） |
| 对话影响 | 无                      | 截断到 checkpoint 锚点                           |

checkpoint **不自存文件副本**：它引用「该时点已发生的 mutation batch 链」，文件恢复=从当前状态沿链逆序回放逆向操作到目标时点。零额外存储空间的代价是对链完整性的依赖（§3.3 完整性守卫）。

## 1. 范围与非目标

**v1 范围**：会话内 checkpoint 自动/手动打点、`/rewind` TUI 面板、web/mobile 回合级「回到这里」、gateway RPC 腿、与 compaction 的边界语义。

**明确不做**：

- 不做跨机/跨会话恢复（checkpoint 随会话存储，不进 relay 同步面）。
- 不做无限历史：环形保留（默认 50 个或 7 天，`[checkpoints]` 配置段，进 APPENDIX-C）。
- **不替代 git**：checkpoint 面向「会话造成的改动」；用户/外部进程的改动不在快照域内（§3.2）。README 与文档必须像 Claude 一样声明这一点。
- 不回卷不可逆副作用（网络/git push/子进程效果）——只做披露（§3.4）。

## 2. Checkpoint 模型

```ts
interface Checkpoint {
  checkpointId: string
  sessionId: string
  createdAt: Timestamp
  trigger: 'turn-boundary' | 'pre-mutation' | 'manual'
  anchor: {
    kind: 'message-seq' // 对话域锚点 = JSONL 内消息序号
    seq: number // 打点时的 head seq
  }
  batchChain: BatchRef[] // 文件域 = 打点时已存在的 mutation batch 引用链（BackupStore manifest id 列表，按发生序）
}
```

- **事件面**：JSONL 追加 `checkpoint.created` 事件（append-only 语义合法；checkpoint 是纯引用，不拷贝内容）。**走事件新增全清单**：8 处同步点 + 3 个硬编码计数守卫 + resume 尾部 20-turn 窗口 prepend 规则 + 附录 D payload 登记 + per-event zod schema（r13-I8）。
- **打点策略**：
  - `turn-boundary`：每用户回合开始自动打点（对话域锚点为主用途）。
  - `pre-mutation`：每个文件 mutation batch 提交前自动打点（挂 mutateFiles manifest 钩点；与 batch 引用同源，无额外 IO）。
  - `manual`：`/checkpoint` 命令。
  - 环形上限触顶：淘汰最旧（`turn-boundary` 优先淘汰，`pre-mutation`/`manual` 次之）。
- **快照域边界**：只覆盖 `<cwd>/**` 内、由会话工具（Edit/Write/…) 产生的改动；`/undo` 血统规则（lineage 根会话、worktree apply batch 同 manifest）原样适用——子代理的改动通过 lineage 归根，checkpoint 链含子代理 batch。

## 3. Rewind 语义

### 3.1 流程

```text
/rewind（或回合卡「回到这里」）→ checkpoint 列表 → 选点 → 选域（both 默认 / files / conversation）
→ 确认卡（列出将丢弃的消息数 + 将回卷的文件改动数 + 不可回卷副作用清单）
→ files 域：沿 batchChain 从当前状态逆序 apply 逆向操作至目标时点
→ conversation 域：JSONL tombstone 截断（§3.2）
→ 新回合从锚点继续（checkpoint.created 后追加 rewind.performed 事件）
```

### 3.2 对话域：tombstone，不物理删

- rewind 不删除 JSONL 字节；在打点时刻的 active segment 内写入截断标记（segment 尾部 `rewoundTo` 指针），replay/resume/usage 统计只读 active 指针以前的内容。
- 理由：审计不可删（对齐 §18.4.10 精神）+ resume 孤儿化类 bug 的防御（物理删除会让工具卡/子代理归属再炸一次）；分段模型（§8）已有 segment 概念，截断=关闭当前 segment、以锚点 seq 开新 segment。
- 跨压缩点：**v1 拒绝回卷到 compaction 摘要事件之前的 checkpoint**（类型化报错 `rewind_before_compaction`，提示可选的最早可回点）。跨压缩点恢复列为 CP-07 后续项（full-rehydrate 语义，不进 v1）。

### 3.3 文件域：batch 链逆序 + 完整性守卫

- 复用 /undo 的逆序引擎，逐 batch 校验当前文件内容与 batch 记录的 after-hash 一致后 apply 逆向；不一致（用户手改过）→ **停在该 batch**，类型化报错列出冲突文件，可选「强制跳过该文件继续」。
- 链断裂（BackupStore batch 被清理/TTL 淘汰）：checkpoint 标记 `filesDomain: partial|lost`，rewind 时只恢复对话域并明示文件域不可用。BackupStore 清理策略必须与 checkpoint 保留策略联动（batch 生命周期 ≥ 引用它的 checkpoint 生命周期）。
- worktree 域：worktree apply 的 batch 已进同一 manifest 血统，rewind 一并逆序（对齐 /undo U1 规则）。

### 3.4 不可逆副作用披露

确认卡必须列出打点→当前之间 transcript 中的不可逆工具调用（Bash 网络命令、git push、进程 spawn 等，按工具类型静态推导，不猜语义），文案「以下副作用无法随回卷撤销」。这是诚实性要求：Claude 同样只保护文件+对话。

### 3.5 权限与并发

1. **rewind 自身免审**：恢复的是用户已批准过的变更，且域限定 `<cwd>/**`；不弹 permission 卡，但必须弹 §3.1 确认卡（语义确认 ≠ 权限审批）。
2. **回合进行中禁止 rewind**：turnInFlight 时类型化拒绝（web/mobile 按钮置灰 + TUI 报错）；与发送队列/中断语义互斥（先收尾或中断再回卷）。
3. **网关并发**：TUI/web/mobile 同时连一会话时，rewind 走 session 级互斥锁（gateway 侧已有 turnFlight 概念可复用）；失败端收 `session.rewound` 视图帧强制重同步。

## 4. 三端与网关面

| 端      | 面                                                                                                                                         |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| TUI     | `/rewind` 面板（checkpoint 列表：时间/触发/距当前消息数，选中→域选择→确认）；`/checkpoint` 手动打点；`/undo` 保留不动                      |
| web     | 回合卡 hover「回到这里」+ /rewind 入口；确认卡同 §3.1；rewind 后 chatFeed 全量重渲染（活体链已有 seq 混排，rewind 后按新 active 指针重排） |
| mobile  | 同 web（回合长按菜单）；确认卡文案走 ui-copy 双语表                                                                                        |
| gateway | RPC：`sessions.checkpoints.list` / `sessions.rewind`；视图帧 `session.rewound`（三端 reducer 同构改动，对照同步纪律）                      |

命令树（§11）新增 `/rewind`、`/checkpoint`；**实现时必须同步 `commandUsage`**（裸 prompt 派发契约：不登记会被静默吞成 prompt）。

## 5. 任务卡（CP-01…，建议三批）

| ID    | 内容                                                                                            | 批           |
| ----- | ----------------------------------------------------------------------------------------------- | ------------ |
| CP-01 | Checkpoint 模型 + `checkpoint.created` 事件全清单接线 + 打点三钩点（回合边界/mutation 前/手动） | 批 1         |
| CP-02 | `[checkpoints]` 配置段（环形上限/TTL）+ APPENDIX-C 登记                                         | 批 1         |
| CP-03 | 文件域回卷引擎（batch 链逆序 + 冲突停点 + 强制跳过）+ 完整性守卫（partial/lost）                | 批 2         |
| CP-04 | 对话域 tombstone 截断（segment 关闭/新开 + replay/resume/usage 只读 active）+ 跨压缩点拒绝      | 批 2         |
| CP-05 | TUI `/rewind`+`/checkpoint` + commandUsage 同步 + pty 实测                                      | 批 2         |
| CP-06 | web/mobile 回合卡入口 + 确认卡 + gateway RPC/视图帧 + 三端同构                                  | 批 3         |
| CP-07 | 跨压缩点 full-rehydrate（后续项，v1 明确拒绝）                                                  | 批 3（可裁） |

## 6. 验收门禁

- 单测：JSONL tombstone 后 replay/resume/usage 三读路径全部只认 active 指针；batch 链逆序在嵌套子代理 + worktree 混合场景的血统正确性（/undo U1 用例镜像扩展）。
- 崩溃恢复：rewind 中途 kill 进程 → 重启后状态一致（batch 引擎幂等 + segment 关闭原子）。
- e2e 三端：打点→改文件→rewind both→文件与对话均还原→继续回合；files-only 与 conversation-only 两变体；跨压缩点拒绝文案。
- 冲突用例：rewind 目标与当前文件间用户手改 → 停点列出冲突 → 强制跳过路径。
- pty 实测 TUI 面板（bundle 纪律）；web 走裸 harness 冒烟（web-ui-browser-smoke-method 配方）。

## 7. 待拍板

1. **打点密度默认值**：`turn-boundary` 每回合打点是否默认开（50 上限下，长会话会挤掉 pre-mutation 点）。本文倾向默认开 + 上限 50。
2. **conversation-only 域是否进 v1**：Claude 三域齐供；若 v1 只做 both（简单一致），web/mobile 入口少一个选择器。本文倾向三域齐做（引擎是同一个，域=开关组合）。
3. **esc-esc 快捷回卷到上一 turn-boundary**（Claude 惯例）：web 有全局 esc 中断绑定（antd 弹层冲突前科），TUI esc 是中断——建议 v1 不做快捷键，仅面板入口。
4. rewind 后 memory 沉淀/反思的输入窗口是否回卷：本文倾向**不回卷**（沉淀物是会话外资产，锚点窗口按新 active 指针取）——Mark 若要求一致性回卷需加 CP 任务。
5. BackupStore TTL 联动的具体倍数（batch 保留 ≥ checkpoint 保留 × 2 起）。
