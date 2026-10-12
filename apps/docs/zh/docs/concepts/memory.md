# 记忆系统

Volund 的记忆系统让智能体跨会话积累持久知识——用户偏好、仓库惯例、踩坑教训——全部是
**人可读、可编辑、可版本化、可提交的 markdown 文件**。它与规则文件（`AGENT.md` /
`AGENTS.md` / `CLAUDE.md`）互补：规则是编译进 system prompt 的**信任指令**；记忆是可
召回的**参考数据**，永远不是指令。

## 什么东西放在哪

| 层   | 规则文件（信任）                                       | 记忆（参考数据）                 |
| ---- | ------------------------------------------------------ | -------------------------------- |
| 全局 | `~/.volund/AGENT.md`（`AGENTS.md` / `CLAUDE.md` 也可） | `~/.volund/memory/*.md`          |
| 项目 | `<仓库根>/AGENT.md` 逐目录发现                         | `<仓库根>/.volund/memory/*.md`   |
| 会话 | —                                                      | `~/.volund/memory/sessions/*.md` |

两级规则文件用同一套候选顺序——`AGENT.md` → `AGENTS.md`（开放约定）→ `CLAUDE.md`，
每级取第一个命中的，给 Claude Code / Codex 维护的文件直接可用。

项目记忆身份锚定在 **git root**（最近一个含 `.git` 的祖先目录），monorepo 的子包共享
`<仓库根>/.volund/memory/` 一份记忆池；非 git 目录身份即目录自身。其它项目的记录保留
在 `~/.volund/memory/projects/<projectId>/`。

记忆目录里只有 markdown：每条记录一个 `<YYYY-MM-DD>-<slug>-<id>.md`（文件名只是装饰，
frontmatter 的 `id` 才是身份），外加自动生成的 `MEMORY.md` 索引——一行一条记录，含
首行摘要和 `pinned` / `deleted` 标记。索引在每次写操作后重建，手编会被覆盖。机器状态
（搜索索引、锁、导入日志、插件审计）都在隐藏的 `.state/` 子目录里。

## 手写记忆文件

直接往记忆目录放一个文件即可：

```markdown
---
schemaVersion: 1
id: pnpm-convention
scope: project
workspaceId: local
pinned: true
---

本仓库一律用 pnpm，不用 npm。
```

必填只有 `schemaVersion`、`id`、`scope`（加 `workspaceId`，本部署恒为 `local`）；
`tags`、`pinned`、`source`、时间戳都可省略。校验不过的文件会被忽略但绝不删除。
对已有文件的手改在新会话生效；正在跑的会话用的是内存快照。

## 智能体怎么用记忆

- **pinned 注入**——三个 scope 中 `pinned: true` 的记录会编入 system prompt（窄
  scope 优先，有行数+token 双预算）。它们包在 `<untrusted source="memory:pinned">`
  里：智能体把它们当数据，绝不当指令执行。
- **自主召回**——模型面工具 `Memory.recall` 搜关键词索引；`Memory.get` 读全文，
  `Memory.list` 浏览。召回结果是 `<untrusted source="memory:recall">` 包裹内的摘要。
- **写入**——`Memory.create` / `Memory.update` / `Memory.delete` / `pin` / `unpin`。
  智能体被明确指导按「知识属于谁」选 scope（用户级偏好 → workspace，仓库事实 →
  project），且回复格式类契约应建议写规则文件而不是存记忆。

写记忆不弹任何权限——记忆目录是 volund 自己的领地，每次写入都过不可关闭的内容
守卫；显式 deny 规则仍然优先生效。

## 自动沉淀

会话正常结束时，volund 会用一次后台模型调用把本轮提炼成最多 3 条持久记忆——用户
偏好进 workspace，仓库事实进 project。短会话（不足两轮交互或转录过短）、SIGINT/
SIGTERM 硬退、以及设置 `VOLUND_MEMORY_AUTO_CONSOLIDATE=0|false` 时跳过。沉淀记忆的
provenance 是 `memory-consolidation`，和普通记忆一样出现在
`volund memory list --source agent` 里。

## 规则 vs 记忆——什么放哪个文件

- **规则文件**（`AGENT.md` 家族）：必须被*执行*的东西——回复格式、语气契约、工作流
  要求。它们是信任的 prompt 内容。
- **记忆**：应该*影响但不约束*的事实与偏好——「这个仓库用 pnpm」「用户喜欢简洁」。
  永远是参考。

## CLI

```
volund memory list | get | add | update | delete | pin | unpin | search | doctor | reindex | export | import
```

`search` 与智能体用的是同一个本地索引；`doctor` 检查存储与索引健康；
`export`/`import` 在机器间搬运版本化 JSON 归档（记忆文件本身直接拷贝或提交即可）。
`volund memory add --scope project "…" --pinned` 是手动给项目铺记忆最快的方式。

## 插件

插件经沙箱桥访问记忆（`volund.memory.create` 等），由插件 manifest 把门
（`permissions.memory`：`read` 作用域、`write`、`search`、`export`——write 默认关闭），
并汇入同一服务：scope ACL、不可关闭的内容守卫、每次写一条 `audit.jsonl`。插件发起
的写入带 `provenance.actorId: plugin:<name>`。注意 project 记忆文件位于工作区内，
拥有文件/命令权限的插件可以绕过桥直接编辑——该通道无审计（手编与工具直写一视
同仁：装载时校验，始终是参考数据）。

## 存储内部

每次写按文件原子（临时文件 → fsync → rename → 目录 fsync，权限 0600/0700），跨进程
由带 stale 恢复的锁文件串行化。旧版单文件 JSON 快照（`records.json`）在首次打开时
自动迁移为 markdown 并归档为 `records.json.imported`。软删除的记录保留文件，frontmatter
带 `deletedAt`。

## 安全说明

- 记忆内容过不可关闭的 preWrite 守卫：超长（64 KiB）、明显机密（API key、OAuth
  code）、非法 Unicode 在落盘前直接拒绝。
- 记忆是参考数据：pinned 注入和召回结果都无法闭合 untrusted 包裹，导入的记忆不
  获得额外权限。
