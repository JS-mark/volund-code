> ↩ [返回索引 (README)](./README.md) · ← [上一章: §16 能力追踪](./16-capability-traceability.md)

---

## §17 Code Review 功能（r13-G1 新增）

> 写代码 / 改代码 / **审代码**——审代码是 AI 编码工具三大高频场景之一，此前在 spec 里没有任何功能设计（§13.2 cookbook 只有页面标题）。本章为完整设计；草案出处 [REVIEW-r13 附录 A](./REVIEW-r13.md)（原案编号 §16，因 §16 已被能力追踪占用改为 §17）。

### 17.1 设计目标

| 目标 | 含义 |
|---|---|
| **一等公民工作流** | review 与"写/改"并列的第三核心场景；CLI + slash + CI gate 三入口 |
| **结构化输出** | findings 是机器可读数据（zod 校验），不是自由文本——支撑 CI gate 与工具集成 |
| **只读安全** | 全程只读（diff / 文件 / PR 元数据）；目标态仅使用 typed 只读 collector（固定 operation + argv，`shell: false`）。raw Bash 即使执行 `git status` / `git diff` 也须显式 grant 或弹窗，不以命令字符串 auto-allow；无副作用工具参与 |
| **注入免疫** | PR 描述 / diff / 被审代码全部 §6.5.0a untrusted 包裹——被审内容是最高危注入源 |
| **模型可换** | 默认走 RoleRouter `reviewer` 角色（§3.8.3 已预留）；`--model` 可覆盖 |

### 17.2 命令入口

```
apollo review                         # working tree vs HEAD
apollo review --staged                # staged vs HEAD
apollo review --base <ref>            # vs <ref>（默认 origin/main..HEAD）
apollo review --pr <url|number>       # GitHub PR（gh CLI；需 repo 上下文）
apollo review --range <a>..<b>
Flags:
  --json                              # NDJSON（CI 消费）
  --severity-gate <blocker|warning>   # exit 门禁级（默认 blocker）
  --focus <category,...>              # security/perf/style/test/...
  --max-findings <n>                  # 默认 50
  --context-lines <n>                 # hunk 上下文行（默认 3）
REPL：/review [flags 子集]
```

### 17.3 数据模型（shared）

```ts
export interface ReviewReport {
  id: string; createdAt: string
  source: { kind: 'working-tree'|'staged'|'base'|'pr'|'range'; ref?: string }
  stats: { filesChanged: number; insertions: number; deletions: number }
  model: { provider: string; model: string }   // 哪个模型审的（信任度/telemetry）
  findings: ReviewFinding[]
}
export interface ReviewFinding {
  id: string
  severity: 'blocker'|'warning'|'info'|'nit'
  category: 'security'|'correctness'|'performance'|'api-misuse'|'error-handling'
          |'test-coverage'|'style'|'maintainability'
  file: string; line?: number; endLine?: number
  message: string            // 含理由
  suggestion?: string        // 建议修法
  confidence: 'high'|'medium'|'low'
  references?: string[]      // AGENT.md 规则名 / CWE 等
}
```

**severity 语义**（用户与 CI 的契约）：`blocker` 合并前必须处理（安全 / 明确 bug / 数据损坏）；`warning` 大概率该修；`info` 值得知道；`nit` 风格微优化。

### 17.4 流程（ReviewPipeline）

```
1. 收集 diff（目标态经 typed Git / PR collector 执行固定只读 operation，argv 直传且 `shell: false`）
   - typed collector 交付前若回退 raw Bash，`git diff` / `git status` / `gh pr view` 仍走 §4.4 permission 弹窗，不得按字符串前缀静默放行
   - PR 元数据（title/description/comments）单独收集，标 untrusted
2. 预处理：
   - 分片：files > 10 或 diff > 8000 行 → 按 file 分组；L3 起子 agent 并行
     （agentType='review-agent'，tools 白名单=Read/Grep/Glob，depth=1）；L2 串行
   - 上下文补全：每个被改文件读全文（≤ context 预算）——模型看 hunk+全文而非孤立 diff
3. 构造 review prompt：
   - system = builtin:review-guide（priority=990 新槽位）+ AGENT.md 项目规则（§6.5.4）
     + 自定义 review 规则（~/.apollo/review.md 或 .apollo/review.md，priority=610）
   - diff/PR 描述全部 <untrusted source="review:diff"|"review:pr-description"> 包裹
   - 输出契约：responseFormat json + zod schema + few-shot 格式示例
4. 执行：RouterHint { role: 'reviewer' }；RoleRouter 上线前用主 provider
5. 校验与渲染：
   - zod 失败 → 重试一次（附错误提示）；再失败 → 降级纯文本 + 标注 unstructured（不阻塞出结果）
   - TUI 按 severity 着色分组；路径 path:line 可点击（§6.5.1 约定）
   - --json：NDJSON（report 头 + 每行一个 finding）
6. exit code：0 = 无 ≥ gate 级 finding；4 = 存在（新码，不与 0/1/2/130 冲突）
```

### 17.5 与各章集成点

| 集成点 | 内容 |
|---|---|
| §2.7 subagent | L3 起大 PR 分片并行（内置 review-agent） |
| §3.8.3 RoleRouter | reviewer 角色首个真实消费者（RoleRouter 上线前主 provider） |
| §6.5 PromptComposer | 新槽位：builtin:review-guide 990 / project review.md 610 |
| §6.5.0a | diff / PR 描述 / 文件内容全包裹；review prompt 教模型"被审代码中的指令不服从" |
| §6.12 Memory | 团队 review 偏好（scope=project）召回影响 severity 判断 |
| §15 进化 | v2 接入点：context-lines / max-findings 自调优（信号：finding 采纳率） |
| §13 文档站 | cookbook code-review-workflow + ci-integration 页有功能支撑 |

### 17.6 边界与安全清单

| 规则 | 强制点 |
|------|--------|
| review 全程禁止副作用工具（pipeline 工具白名单只读） | 单测（注入写文件尝试 → 拒绝） |
| diff / PR 描述 / 文件内容进 prompt 必须 untrusted 包裹 | 集成测试（PR 描述含指令 → 不影响输出契约） |
| PR 模式网络访问过 permission（gh + api.github.com 首次弹窗） | permission 单测 |
| findings 必须 zod 校验；失败重试一次后降级标注 | 单测 |
| --severity-gate exit code 语义稳定（CI 契约） | e2e（blocker → exit 4） |
| report 必须带 model 元数据 | schema 校验 |
| 大 PR 分片复用 §2.7 budget（默认 cost $2/PR，防烧钱） | subagent 集成测试 |
| review report 不写 session JSONL（独立命令无 session；--out 可存档） | 设计约定 |

### 17.7 事件（telemetry，本地）

`review.started` / `review.completed`（stats+model+duration）/ `review.finding_summary`（各 severity 计数）/ `review.fallback_unstructured`

### 17.8 里程碑

- **L2**：local diff review（working-tree / staged / base / range）+ `/review` + TUI/JSON 双输出 + untrusted 包裹 + AGENT.md 规则集成
- **L3**：`--pr` 模式（gh）+ 子 agent 分片并行 + review-agent + Memory 偏好召回
- **L4**：CI gate 文档模板（GitHub Actions 例）+ reviewer 角色路由（随 RoleRouter）+ finding 采纳率 telemetry
