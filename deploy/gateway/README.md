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

## 快速开始（Docker）

```bash
cd deploy/gateway
cp .env.example .env        # 填 OPENAI_API_KEY 等
mkdir -p workspace          # 会话工作区（agent 读写文件的根）
docker compose up -d --build
docker compose logs gateway # 首启打印 bootstrap client 凭证（只此一次）
```

DNS 把 `ai-gateway.nexo-ai.top` 指到主机后，Caddy 自动签发/续期 TLS 证书。
网关服务不直接暴露端口，全部流量经 Caddy 终结 TLS 后反代。

### 生产环境注意事项

- **沙箱**：镜像内没有 volund-syscall 沙箱（原生模块不进镜像），工具直接跑在容器
  文件系统上——容器边界就是隔离边界。`GATEWAY_PERMISSION_MODE` 建议 `auto` 或 `full`；
  `ask` 模式下需要提权的命令会推审批卡到 WS 客户端，无人决策超时自动 deny。
- **数据卷**：`/data`（VOLUND_HOME：会话、客户端、签名密钥、凭据）必须持久化；
  删掉它 = 所有已签发 token 失效 + 会话历史丢失。
- **上游配置**：把写好的 `config.toml` 挂到 `/data/config.toml`，例如：

  ```toml
  [provider.openai]
  baseUrl = "https://your-openai-compatible-upstream/v1"

  [models.aliases]
  fast = { provider = "openai", model = "gpt-4o-mini" }
  ```

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
| `GATEWAY_CLIENTS` | — | OAuth 客户端 JSON 数组（优先于文件） |
| `GATEWAY_CLIENTS_FILE` | `<home>/gateway/clients.json` | 客户端文件 |
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
