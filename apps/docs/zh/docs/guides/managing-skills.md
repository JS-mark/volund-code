# 管理 Skill

Skill 是提示层能力包：一个目录 + 一份 `SKILL.md`(YAML frontmatter + Markdown 指令)，可选附 `scripts/`、`references/`、`assets/`。Volund 对齐 [agentskills.io](https://agentskills.io) 开放标准，与 Claude Code / Codex / Cursor 等共用同一文件格式。

## 安装

```bash
# 本地目录（目录里要有 SKILL.md,name 须与目录名一致）
volund skill install ./my-skill

# GitHub 仓库（根有 SKILL.md 装 root;否则装一层子目录里全部带 SKILL.md 的）
volund skill install github:anthropics/skills
volund skill install anthropics/skills          # 同义简写
volund skill install https://github.com/you/skills-repo.git
volund skill install file:///path/to/local-repo
# 嵌套仓库也支持(如 anthropics/claude-plugins-official 的 plugins/<name>/skills/…):任意深度扫描,单个失败跳过其余
 # 本地 git 仓库

# 装到项目级(随仓库分发,团队共用)
volund skill install anthropics/skills --scope project   # → <cwd>/.volund/skills/
```

也可以用生态自带工具安装，Volund 会自动发现（互操作路径，只读）:

```bash
npx skills add <query>          # skills.sh 装到 ~/.agents/skills
```

## 发现与作用域

按优先级从高到低发现（同名覆盖）:

1. 项目级 `<cwd>/.volund/skills/`
2. 项目级 `<cwd>/.agents/skills/`（业界互操作路径，只读）
3. 用户级 `~/.volund/skills/`
4. 用户级 `~/.agents/skills/`（互操作路径，只读）

同名 skill 在高优先级层存在时，低优先级层的同名条目标记为 `shadowed`（面板里可见原因），不报错。

## 使用

| 方式                     | 语义                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------- |
| `/skill-name [任务]`     | 一次性调用：skill 指令 + 任务文本作为当轮用户消息进对话（不持久改 system prompt)            |
| `/skill activate <name>` | 会话级常驻：skill 注入 system prompt 直到 `/skill deactivate`                               |
| `/skills` 面板 `a` 键    | 同 `/skill activate`                                                                        |
| 模型自动                 | 模型看到索引后调 `Skill.activate` 工具；frontmatter `disable-model-invocation: true` 时禁用 |

## 管理

| 操作         | REPL                         | CLI                                         |
| ------------ | ---------------------------- | ------------------------------------------- |
| 列表/状态    | `/skills` 面板               | `volund skill list [--scope user\|project]` |
| 详情         | 面板里 Enter（只读滚动视图） | `volund skill show <name>`                  |
| 启停（持久） | 面板里 Space                 | `volund skill enable\|disable <name>`       |
| 重扫描       | 面板里 `r`                   | —                                           |
| 卸载         | —                            | `volund skill uninstall <name>`             |

启停持久写在 `~/.volund/config.toml` 的 `[skills] disabled` 名单；重扫后 SKILL.md 编辑免重启生效。
