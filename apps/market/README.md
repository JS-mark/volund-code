# @volund/market

volund 插件 / Skill / MCP 市场服务端。Next.js（App Router）前后端一体：一组 API
同时服务自己的市场浏览页（antd）和 volund 客户端（TUI / Web 控制台市场页签）。

三个兼容层索引端点与 `packages/app-runtime` 的客户端解析器逐字段对齐
（`plugin-market.ts` / `skill-market.ts` / `mcp-market.ts`），volund 侧把本服务
配进 `~/.volund/config.toml` 即可浏览与安装，客户端零改动。

## 快速开始

```bash
# 仓库根安装依赖
pnpm install
pnpm --filter @volund/market dev            # http://127.0.0.1:4315
```

首次启动自动写入种子数据（`data/market.json` + `data/bundles/`）：
一个可完整安装的示例插件 `volund-plugin-demo`、anthropics/skills 官方仓库的
7 个真实可装 skill、3 个常用 MCP 条目。

## 两层 API

### 兼容层（volund 客户端直接消费，形状锁定）

| 端点                             | 说明                                                                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `GET /api/plugins/index.json`    | 插件索引 `{schemaVersion:1, plugins:[{name,version,files:[{path,digest:"sha256-…"}]}]}`，≤256 条，只发每插件最新版 |
| `GET /api/plugins/<name>/<path>` | 插件文件下载（客户端按索引 origin 拼同源 URL；只发索引内列出的文件，命中计一次下载）                               |
| `GET /api/skills/index.json`     | Skill 目录 `{version:1, entries:[{name,source,…}]}`                                                                |
| `GET /api/mcp/index.json`        | MCP 目录 `{version:1, entries:[{name,transport,…}]}`                                                               |

### 管理 API（自家 UI 与脚本用；写接口需 Bearer token）

| 端点                                                         | 说明                                                                                                                                   |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/plugins?q=&page=&pageSize=`                     | 插件列表（模糊搜 name/description/publisher）                                                                                          |
| `GET /api/v1/plugins/:name`                                  | 详情（全部版本、最新 manifest、文件 digest、readme）                                                                                   |
| `POST /api/v1/plugins`                                       | 发布：`{files:[{path,contentBase64}], publisher?, readme?}`；manifest 从 `files['manifest.json']` 解出并按宿主规则校验；同名同版本 409 |
| `DELETE /api/v1/plugins/:name`                               | 删除全部版本与 bundle                                                                                                                  |
| `GET/POST /api/v1/skills`、`GET/DELETE /api/v1/skills/:name` | Skill 目录 upsert（重名提交 = 更新；`source` 须是 SkillPort.install 认的 git 形态；`version` 可选 semver）                             |
| `GET/POST /api/v1/mcp`、`GET/DELETE /api/v1/mcp/:name`       | MCP 目录 upsert（重名提交 = 更新；stdio 必须有 command；http 必须有 url；`version` 可选 semver）                                       |
| `GET /api/health`                                            | 存活 + 条目计数                                                                                                                        |

## 客户端接入（volund 侧零改动）

```toml
# ~/.volund/config.toml —— URL 必须规范（客户端 isTrustedMarketSource 校验）
[plugins]
market = "http://127.0.0.1:4315/api/plugins/index.json"

[skills]
market = "http://127.0.0.1:4315/api/skills/index.json"

[mcp]
market = "http://127.0.0.1:4315/api/mcp/index.json"
```

## 发布插件

方式一：`/admin` 页面选插件目录上传（浏览器 folder picker，自动剔除
node_modules/.git/dist 等）。

方式二：脚本（CI 友好）：

```bash
MARKET_ADMIN_TOKEN=… node scripts/publish.mjs ./my-plugin \
  --base http://127.0.0.1:4315
```

manifest 要求（与 `@volund/plugin-runtime` validateManifest 同规则，服务端提前拦截）：

```json
{
  "name": "volund-plugin-<你的名字>",
  "version": "1.0.0",
  "type": "module",
  "main": "index.mjs",
  "engines": { "volund": "^0.1.0" },
  "permissions": { "volund": ["commands.register"] }
}
```

## 信任模型（与 plugin-market.ts 对齐）

- 索引浏览与文件下载：规范 HTTPS 或回环 http（LAN http 拒绝），逐文件 sha256。
- 插件可执行安装：客户端当前仅允许回环 http 源（发布者签名信任根接入前，
  远程 HTTPS 市场 fail closed）——本服务就是自建市场跑 `127.0.0.1` 的标准形态。
- Skill 安装不执行代码，走既有 git 通道，允许远程源直接装。
- MCP「安装」只预填表单，用户确认后落盘。
- 写接口：`MARKET_ADMIN_TOKEN` 未设置时整体关闭（503），设置后恒时比较。

## 数据与升级路径

- `data/market.json`：单文件 JSON 库（客户端契约把每目录上限压在 256 条，
  单文件足够）；写事务串行 + 临时文件原子换名。
- `data/bundles/<name>/<version>/…`：插件文件按版本落盘。
- 升级到 Postgres：替换 `src/lib/store.ts` 的 `readDatabase/updateDatabase`
  实现，路由层不感知。

## 契约权威

`src/lib/validate.ts` 的校验规则镜像客户端解析器；客户端是权威，改
`apollo-code/packages/app-runtime/src/{plugin,skill,mcp}-market.ts` 时须同步本仓库。
