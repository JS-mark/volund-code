# volund 远程网关（ai-gateway.nexo-ai.top）

把本机/容器里的 volund 运行时（会话、工具、审批）暴露为远程 API。面向 Web 后端、
移动端后端、CI 等机器调用方。

- **认证**：自建 OAuth2 `client_credentials` → HS256 JWT Bearer
- **流式**：`POST /v1/chat/completions`（OpenAI 兼容，SSE）+ `GET /v1/ws`（WebSocket 交互会话）
- **上游**：可配置任意 OpenAI 兼容端点（volund `config.toml` 的 `[provider.*]`）
- **会话模型**：volund 是单 runner 运行时——所有 turn 串行执行；忙时请求排队，
  超过 `GATEWAY_QUEUE_TIMEOUT_MS` 返回 `409 gateway_session_busy`

## 端点一览

| 端点 | 认证 | 说明 |
| --- | --- | --- |
| `POST /oauth/token` | 客户端凭证 | 换取 access token（form-urlencoded 或 JSON；支持 Basic 头） |
| `GET /v1/health` | 无 | 健康检查（负载均衡/探针用） |
| `GET /v1/models` | Bearer | OpenAI 形状的模型列表（含 `[models.aliases]` 展开） |
| `GET /v1/sessions` | Bearer | 可恢复会话清单 |
| `POST /v1/chat/completions` | Bearer | OpenAI 兼容补全；`stream: true` 走 SSE |
| `GET /v1/ws` | Bearer | WebSocket 交互会话通道（审批、打断、事件流） |
| `GET /v1/sessions/active/transcript` | Bearer | 活动会话持久化快照（移动端刷新重建视图） |
| `GET /uplink` | Bearer(uplink scope) | **中转模式**：本机 volund 反向拨出注册（远程控制） |
| `POST /pairing/redeem` | 无（IP 限流） | **中转模式**：配对码核销 → 移动设备长期 token |
| `GET /`（非 API 路径） | 无 | **中转模式**：移动端网站静态托管（同源免 CORS） |

## 快速开始（Docker）

```bash
cd deploy/gateway
cp .env.example .env        # 填 OPENAI_API_KEY 等
mkdir -p workspace          # 会话工作区（agent 读写文件的根）
docker compose up -d --build
docker compose logs gateway # 首启打印 bootstrap client 明文凭证（只此一次，不落盘）
```

DNS 把 `ai-gateway.nexo-ai.top` 指到主机后，Caddy 自动签发/续期 TLS 证书。
网关服务不直接暴露端口，全部流量经 Caddy 终结 TLS 后反代。

### 生产环境注意事项

- **沙箱**：镜像内没有 volund-syscall 沙箱（原生模块不进镜像），工具直接跑在容器
  文件系统上——容器边界就是隔离边界。`GATEWAY_PERMISSION_MODE` 建议 `auto` 或 `full`；
  `ask` 模式下需要提权的命令会推审批卡到 WS 客户端，无人决策超时自动 deny。
- **凭证存储**：`clients.json` 只存 client_secret 的域分隔 SHA-256 哈希，明文绝不落盘
  （bootstrap 明文只在首次启动日志里出现一次；老的明文格式文件下次启动自动迁移为哈希）。
  再进一步：把 `GATEWAY_TOKEN_SECRET` 也走 env（k8s REFID_001Q 等），则 `/data` 卷
  整个泄露也换不出可用凭证。
- **数据卷**：`/data`（VOLUND_HOME：会话、客户端哈希、签名密钥、凭据）必须持久化；
  删掉它 = 所有已签发 token 失效 + 会话历史丢失。
- **上游配置**：把写好的 `config.toml` 挂到 `/data/config.toml`，例如：

  ```toml
  [provider.openai]
  baseUrl = "https://your-openai-compatible-upstream/v1"

  [models.aliases]
  fast = { provider = "openai", model = "gpt-4o-mini" }
  ```

## 远程控制中转模式（GATEWAY_RELAY=1）

直挂模式（默认）容器自带会话 runner；**中转模式**把网关变成纯中转——
本机 Mac 上的 volund（TUI/Web 控制台）主动向网关拨出 `/uplink`，手机经
网关中转控制**本机**会话（拓扑：手机 → 网关(VPS) → uplink 隧道 → 本机）。

```bash
# 网关侧（compose 环境加）：
GATEWAY_RELAY=1
GATEWAY_PUBLIC_URL=https://ai-gateway.nexo-ai.top   # 配对二维码里的入口地址
# 客户端需要 uplink scope（clients.json 里的 scopes 含 "uplink"；
# bootstrap 生成的客户端默认带）

# 本机侧（桌面 Web 控制台 → 远程控制 tab）：
# 网关地址 / client_id / client_secret 填进配置（写入 ~/.volund/config.toml）：
#   [remote]
#   enabled = true
#   gateway_url = "https://ai-gateway.nexo-ai.top"
#   client_id = "volund-xxxx"
#   client_secret = "..."
```

流程：远程控制页开开关 → 本机拨出注册 → 「添加移动设备」生成配对码/二维码 →
手机打开网关地址输入/扫码 → 核销签发设备 token（默认 30 天，落盘
`/data/gateway/devices.json`，网关重启不掉线已配对设备）→ 手机站聊天/审批/会话切换
全部经隧道落本机。审批与桌面共享同一队列：手机、Web、TUI 任一端决策全端清卡。

安全面：设备 token 只授 chat scope（网关 API 面本就没有 workbench/文件写）；
会话 cwd 被关进本机工作区（网关与本机双重校验）；配对码一次性、5 分钟有效、
redeem 端点按 IP 限流；远程控制页可随时撤销设备（撤销即 token 失效）。

## 客户端用法

以下示例中的 `REFID_002Q` / `REFID_004Q` 等是占位符：换成部署时拿到的真实值。

### 1. 换 token

```bash
curl -X POST https://ai-gateway.nexo-ai.top/oauth/token \
  -H 'content-type: application/x-www-form-urlencoded' \
  -d 'grant_type=client_credentials&client_id=REFID_002Q&client_secret=REFID_004Q'
# → {"access_token":"...","token_type":"Bearer","expires_in":3600,"scope":"chat sessions"}
```

### 2. OpenAI 兼容调用（任何 OpenAI SDK 都能用）

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://ai-gateway.nexo-ai.top/v1",
    api_key="<access_token>",
)
for chunk in client.chat.completions.create(
    model="gpt-4o",                      # 无 '/' 自动补 GATEWAY_DEFAULT_PROVIDER 前缀
    messages=[{"role": "user", "content": "把 README 翻译成英文"}],
    stream=True,
):
    print(chunk.choices[0].delta.content or "", end="")
```

多轮对话：首轮响应头 `x-volund-session-id` 返回会话 id，后续请求带扩展字段
`session_id` 续接（此时只取最后一条 user 消息作为本轮输入）：

```json
{
  "model": "gpt-4o",
  "session_id": "0190f7c2-...",
  "messages": [{"role": "user", "content": "再改成中文简体"}]
}
```

注意：这是 **agent 调用**——模型会在服务端执行工具（读写 workspace 文件、跑命令），
最终返回的是任务完成后的答复文本；tool_calls 不回传给客户端。

### 3. WebSocket 交互通道（审批/打断/事件流）

```
wss://ai-gateway.nexo-ai.top/v1/ws        # Authorization: Bearer <token>
                                           # 浏览器不能自定义头时用 ?access_token=<token>
```

客户端 → 服务端（JSON 帧，`ref` 可选、应答原样带回）：

| type | 字段 | 说明 |
| --- | --- | --- |
| `ping` | — | → `pong` |
| `session.start` | `cwd?` | 新建会话（cwd 限 workspace 内）→ `session.attached` |
| `session.resume` | `id` | 恢复会话 → `session.attached` |
| `session.end` | — | 结束当前会话 → `session.ended` |
| `turn.submit` | `prompt`, `model?` | 提交一轮 → `turn.accepted`（排队语义） |
| `turn.interrupt` | — | 打断在途 turn |
| `permission.decide` | `requestId`, `kind` | 审批决策（allow-once / deny / …） |

服务端 → 客户端：`hello`（连接即发）、`event`（core 事件流透传：
`stream.delta` / `tool.*` / `turn.completed` 等）、`view` 事件（`permission.request`
审批卡）、各命令应答、`error`（带 `code`）。

最小 Node 客户端：

```js
const ws = new WebSocket("wss://ai-gateway.nexo-ai.top/v1/ws?access_token=" + token)
ws.onmessage = (e) => {
  const frame = JSON.parse(e.data)
  if (frame.type === "hello") ws.send(JSON.stringify({ type: "session.start" }))
  if (frame.type === "session.attached")
    ws.send(JSON.stringify({ type: "turn.submit", prompt: "列出 workspace 文件" }))
  if (frame.type === "event" && frame.event.type === "stream.delta")
    process.stdout.write(frame.event.payload.fragment ?? "")
}
```

## 环境变量全表

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `GATEWAY_HOST` / `GATEWAY_PORT` | `0.0.0.0` / `8788` | 绑定地址 |
| `GATEWAY_CLIENTS` | — | OAuth 客户端 JSON 数组（优先于文件；`secret` 明文只在内存） |
| `GATEWAY_CLIENTS_FILE` | `<home>/gateway/clients.json` | 客户端文件（只存 `secretHash`） |
| `GATEWAY_TOKEN_SECRET` | 生成并落盘 | JWT HS256 签名密钥（任意长字符串，内部 SHA256 拉伸） |
| `GATEWAY_TOKEN_TTL_SECONDS` | `3600` | token 有效期 |
| `GATEWAY_PERMISSION_MODE` | `auto` | ask / auto / full |
| `GATEWAY_PERMISSION_TIMEOUT_MS` | `120000` | 审批无人决策自动 deny 的超时（0 关闭） |
| `GATEWAY_QUEUE_TIMEOUT_MS` | `600000` | turn 排队上限，超时 409 |
| `GATEWAY_MAX_TURN_HOLD_MS` | `1800000` | 单 turn 持锁上限（防卡死） |
| `GATEWAY_RATE_LIMIT_RPM` | `600` | 每客户端每分钟 API 上限 |
| `GATEWAY_TOKEN_RATE_LIMIT_RPM` | `30` | 每 IP 每分钟颁证上限 |
| `GATEWAY_CORS_ORIGINS` | 空 | 跨域白名单（逗号分隔；空 = 不下发 CORS 头） |
| `GATEWAY_DEFAULT_PROVIDER` | `openai` | 裸模型名补的 provider 前缀 |
| `GATEWAY_WORKSPACE` | 进程 cwd | 会话工作区根（session cwd 不能逃逸此目录） |

## 错误码

所有错误响应为 `{"error": {"code", "message"}}`：

| code | HTTP | 含义 |
| --- | --- | --- |
| `gateway_auth_invalid` | 401 | token 缺失/过期/签名不符 |
| `gateway_client_rejected` | 401 | 客户端凭证错误 |
| `gateway_grant_unsupported` | 400 | grant_type 非 client_credentials |
| `gateway_rate_limited` | 429 | 限流（带 Retry-After） |
| `gateway_schema_invalid` | 400/404 | body/帧非法、未知端点 |
| `gateway_session_busy` | 409 | 单 runner 被占或排队超时 |
| `gateway_session_not_found` | 404 | session_id 不可恢复 |
| `gateway_unsupported_content` | 400 | 多模态 part（走 WS 通道的附件能力） |
| `gateway_upstream_failed` | 502 | 运行时错误 |
| `gateway_ws_protocol_error` | WS 帧 | 非 JSON / 缺 type / 未知帧类型 |

## 非 Docker 运行

```bash
pnpm build --filter @volund/cli
GATEWAY_PORT=8788 node apps/cli/dist/volund.js gateway
```
