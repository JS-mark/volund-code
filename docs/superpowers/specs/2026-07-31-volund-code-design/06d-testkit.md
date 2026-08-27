> ↩ [返回索引 (README)](./README.md) · ← [上一章: §6c Memory 系统 (6.12)](./06c-memory-system.md) · [下一章: §7 终端 UI](./07-terminal-ui.md) →

---

## §6.13 测试基建（packages/testkit）（r13-I5 新增）

> spec 有约 150 个"单元测试"强制点，但测试怎么写没有基础设施设计。AI-native 范式下这是高杠杆缺失——没有 testkit，每个测试从零造假数据，质量必然参差。本节定义 **dev-only** 测试基建包 `packages/testkit`。

### 6.13.1 能力清单

| # | 设施 | 用途 | 服务对象 |
|---|------|------|----------|
| 1 | `MockProvider` | 可编程假 chunk 流 | 全部 core / router 测试 |
| 2 | `fakeClock` | 假时钟 | hook 5s 超时 / 退避 / idle 回收测试 |
| 3 | `tempvolundHome()` | 隔离环境 | config / credentials / memory 测试 |
| 4 | `sessionFixture(id)` | 预构造 JSONL | storage / replay / 迁移测试 |
| 5 | ink-testing-library | UI 组件快照 | ui 测试选型 |
| 6 | `nativeStub` | native-bridge 内存假实现 | 全部依赖 native 的单测 |

### 6.13.2 MockProvider（核心设施）

```ts
// implements ProviderClient（§3.2 契约），可编程脚本化 chunk 流
import { MockProvider, scriptChunks } from '@volund/testkit'

const provider = new MockProvider('mock', scriptChunks([
  { kind: 'message.start', messageId: 'm1' },
  { kind: 'text.delta', text: 'hello' },
  { kind: 'tool_use.start', id: 't1', name: 'Read' },
  { kind: 'tool_use.delta', id: 't1', argsFragment: '{"path":"a.ts"' },
  { kind: 'tool_use.delta', id: 't1', argsFragment: '}' },
  { kind: 'tool_use.end', id: 't1' },
  { kind: 'usage', usage: { input: 10, output: 5 } },
  { kind: 'message.stop', stopReason: 'tool_use' },
]))

// 故障注入（§3.9a / §3.2 聚合规则的测试支撑）
provider.interruptAt(3, { reason: 'rst' })     // 第 n 个 chunk 后 emit message.interrupted
provider.errorAfter(5, providerError)          // 第 n 个 chunk 后发 error chunk
provider.duplicateUsage()                      // 两次 usage chunk（累计规则用例）
provider.brokenToolJson('t1')                  // 破损 JSON argsFragment（I1 聚合用例）
provider.truncateUtf8At('😀')                  // 多字节字符切 chunk 边界（§3.9a decoder 用例）
```

### 6.13.3 其余设施

```ts
// fakeClock：vitest fake timers 的语义封装（不漏真实 setTimeout）
fakeClock(async () => { await clock.advance(6000) /* hook 超时 5s 用例 */ })

// tempvolundHome()：每测试隔离 HOME + 预填结构
const home = await tempvolundHome({ config: { [memory]: { enabled: true } }, credentials: 'fake' })
// 自动 tmpdir + teardown；测试内 process.env.HOME 指向它

// sessionFixture(id)：预构造 JSONL 变体
sessionFixture('legal-5-turns')      // 合法 5 turn
sessionFixture('truncated-last-line')// 尾行截断（§8.2 容错用例）
sessionFixture('future-version-v99') // 未来版本（§8.2 迁移用例）

// nativeStub：NativeBridge 内存假实现
const native = nativeStub({ available: { sandbox: 'probing' } })  // 可编程三态（§5.8 启动时序用例）
```

### 6.13.4 依赖归属与边界

- `testkit` → 依赖 `provider-kit`（MockProvider 实现其接口）+ `core`（**type-only**）+ `shared`——不引入 `apps/cli` / `tools`，不破坏 §1.2 分层边界。
- `devDependencies` only：任何运行时包**禁止**依赖 testkit（ESLint 边界规则，与 §1.2 同机制）。
- UI 测试选型钉死 **ink-testing-library**（官方、无真终端依赖、支持 snapshot）。

### 6.13.5 与 §1 布局的差量

`packages/testkit` 加入 §1 workspace 包清单（dev-only，不进 §9 发布产物）。发布名 `@volund/testkit` **私有**（不发包，workspace 内引用），插件/hook 作者的测试可引用。

### 6.13.6 里程碑

- **L1**：首批设施（MockProvider + fakeClock + tempvolundHome）**与 core 同 PR 交付（测试先行）**——spec 的 L1 强制点测试直接建立在其上。
- **L2**：sessionFixture 全变体 + nativeStub（服务 §8.2 迁移与 §5.8 时序测试）。
- **L3**：无新增（稳定维护）。

### 6.13.7 边界与安全清单

| 规则 | 强制点 |
|------|--------|
| MockProvider 必须 implements ProviderClient（防契约漂移） | typecheck CI |
| testkit 代码禁止出现在运行时依赖图 | ESLint 边界规则 |
| tempvolundHome 必须真实隔离 HOME（不污染开发者机器） | 测试 teardown 断言 |
| nativeStub 的 probing 三态可编程（§5.8 时序用例） | 单测 |
