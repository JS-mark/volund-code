# 市场与自建目录

Volund 从 `~/.volund/config.toml` 读取三份市场索引——插件、Skill、MCP Server 各一份。任何提供预期索引格式的可信 URL 都能用；Web 控制台的市场页签和 REPL 会浏览这些索引并从中安装。

## 配置

```toml
[plugins]
market = "https://market.example.com/plugins/index.json"

[skills]
market = "https://market.example.com/skills/index.json"

[mcp]
market = "https://market.example.com/mcp/index.json"
```

索引在每次拉取时重新读取（skill 与 MCP 索引有 60 秒进程内缓存，按源地址键控），改完 URL 下次刷新即生效，无需重启。

未配置时，skills 与 MCP 有内置默认源（[anthropics/skills](https://github.com/anthropics/skills) 市场清单经 jsDelivr 分发、官方 MCP Registry v0 API）；plugins 没有默认——先配置源，市场页签才有条目。

## 信任模型

- 索引浏览要求规范的 HTTPS URL 或回环 HTTP（LAN HTTP 一律拒绝）。
- **插件是可执行代码**：签名信任根接入前，远程 HTTPS 源的安装按
  `plugin_registry_signature_required` fail closed；回环 HTTP 源今天就能装——这是自建市场的官方支持路径。每个文件下载时做 digest 校验，每次激活前重新校验。
- **Skill 是提示层内容、不执行代码**：安装走 git 通道，允许远程源直接装。
- **MCP 条目从不静默安装**——选中即预填 add 表单，确认后才写入 `mcp.toml`。

## 自建市场（`@volund/market`）

仓库自带独立市场服务端 `apps/market`——一个 Next.js 应用，三个索引端点与 volund 客户端解析器逐字段对齐，客户端零改动即可浏览与安装。

构建并推送镜像：

```bash
REGISTRY=registry.example.com/volund sh apps/market/scripts/image-push.sh
```

运行（数据持久化在 `volund-market-data` 卷；首次启动播种示例插件、样例 Skill 与 MCP 条目）：

```bash
docker run -d --name volund-market \
  -p 4315:4315 \
  -e MARKET_ADMIN_TOKEN=你的写接口令牌 \
  -v volund-market-data:/app/data \
  --restart unless-stopped \
  registry.example.com/volund/volund-market:1.0.0
```

把 volund 指过去——回环 HTTP 源可执行安装，插件真实落盘：

```toml
[plugins]
market = "http://127.0.0.1:4315/api/plugins/index.json"

[skills]
market = "http://127.0.0.1:4315/api/skills/index.json"

[mcp]
market = "http://127.0.0.1:4315/api/mcp/index.json"
```

## 发布条目

服务端 `/admin` 页面、REST API（`/api/v1/*`，Bearer `MARKET_ADMIN_TOKEN`）、或
`apps/market/scripts/publish.mjs`（CI 友好，直接发布插件目录）都可以：

- **插件**：发布含 `manifest.json` 与 bundle 文件的目录——manifest 按宿主同一套规则校验（`volund-plugin-*` 命名、semver、`engines.volund`），文件按版本留档并记录 sha256 digest。
- **Skill / MCP**：目录条目，可选 semver `version`；同名重复提交即更新（upsert）。skill 的 `source` 须为 git URL / GitHub tree URL / `owner/repo` 简写。

完整 API 参考与部署细节见 `apps/market/README.md`。
