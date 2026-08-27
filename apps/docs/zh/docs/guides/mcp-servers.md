# 接入 MCP Server

> `.volund` 配置路径是冻结的存储兼容标识；所有 CLI 命令统一使用 `volund`。

Volund 是 MCP 客户端（stdio + HTTP，旧 SSE 自动回退）。配置对齐业界通用 `mcpServers` 键结构，与 Claude Code / Codex / Cursor 的配置互操作。

## 添加

```bash
# stdio(`--` 之后原样传给 server 进程)
volund mcp add context7 -- npx -y @context7/mcp
volund mcp add my-server -- node ./server.js --flag value
volund mcp add -e API_KEY=xxx context7 -- npx -y @context7/mcp

# 远程
volund mcp add -t http remote https://api.example.com/mcp
volund mcp add -t sse legacy https://old.example.com/sse
volund mcp add -t http -H 'Authorization: Bearer tok' remote https://api.example.com/mcp

# 写到项目级(.volund/mcp.toml,随仓库分发)
volund mcp add -s project my-server -- npx -y my-mcp
```

`-e KEY=VALUE` 与 `-H 'Key: value'` 可重复；同名 server 配置是整条覆盖，不合并。

也可以直接把业界 `.mcp.json` 放进仓库根——Volund 会话启动时只读导入（不改写该文件）:

```json
{
  "mcpServers": {
    "context7": { "command": "npx", "args": ["-y", "@context7/mcp"] },
    "remote": { "type": "http", "url": "https://api.example.com/mcp" }
  }
}
```

环境变量展开：值里支持 `${VAR}` 与 `${VAR:-default}`（未定义且无默认时展开为空串并给警告）。凭据建议走 `keyref://` 占位（`Authorization: keyref://mcp.<name>.Authorization`)，不要明文落盘。

## 配置与作用域

按优先级从高到低（同名整条覆盖）:

1. 项目级 `<cwd>/.volund/mcp.toml`(TOML `[mcp_servers.<name>]` 表）
2. 项目级 `<cwd>/.mcp.json`（业界 JSON，只读导入）
3. 用户级 `~/.volund/mcp.toml`

未信任的目录在启动时即被信任门拦下，不会自动连接其项目级 server。

## 管理

| 操作         | REPL                              | CLI                                           |
| ------------ | --------------------------------- | --------------------------------------------- |
| 列表/状态    | `/mcp` 面板                       | `volund mcp list`（连通性有界等待 4s 后快照） |
| 详情         | 面板里 Enter（元数据 + 工具清单） | `volund mcp inspect <name>`                   |
| 启停（持久） | 面板里 Space                      | `volund mcp enable\|disable <name>`           |
| 连通测试     | 面板里 `r`（全部重连）            | `volund mcp test <name>`                      |
| 删除         | —                                 | `volund mcp remove <name>`                    |

启停持久写在 `~/.volund/config.toml` 的 `[mcp] disabled` 名单。

## 排障

- `~/.volund/mcp.log`:JSONL 结构化日志（启动 / 连接 / 失败 / server stderr 逐行）。
- `volund doctor`:`mcp servers` 行显示配置数、连接数、失败数。
- 401/403 的 server 在面板里标为 `needs-auth`；OAuth 登录流程（`volund mcp login`）在 SM-07，当前可手动在配置里放 `Authorization` header 或 API key env。
