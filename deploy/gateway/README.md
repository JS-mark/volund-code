# volund 远程网关（gateway.ai-agentic.cc）

公网**中转**网关（relay）：桌面 volund（TUI/Web 控制台）主动向网关拨出 `/uplink`
注册，手机/机器客户端经网关中转控制**本机**会话（拓扑：手机 → 网关(VPS) →
uplink 隧道 → 本机）。网关是独立常驻进程，**不经 volund CLI**——由本目录的
Docker 镜像或直接 `node packages/gateway-server/dist/bin.js` 启动。

> 网关是独立的协议面：**任何实现了网关协议的应用都能对接**（不限于 volund）。
> 帧协议与 REST/WS 契约见 `packages/gateway-server/PROTOCOL.md`，
> TypeScript 帧类型由 `@volund/gateway-server` 导出（`src/protocol.ts`）。

- **认证**：自建 OAuth2 `client_credentials` → HS256 JWT Bearer
- **流式**：`POST /v1/chat/completions`（OpenAI 兼容，SSE）+ `GET /v1/ws`（WebSocket 交互会话）
- **配对**：一次性配对码 → `POST /pairing/redeem` 核销 → 移动设备长期 token
- **移动站**：`GET /` 同源托管 apps/mobile 静态产物（免 CORS）
- **会话模型**：volund 是单 runner 运行时——所有 turn 在本机串行执行；忙时请求排队，
  超过 `GATEWAY_QUEUE_TIMEOUT_MS` 返回 `409 gateway_session_busy`

## 端点一览

| 端点 | 认证 | 说明 |
| --- | --- | --- |
| `POST /oauth/token` | 客户端凭证 | 换取 access token（form-urlencoded 或 JSON；支持 Basic 头） |
| `GET /v1/health` | 无 | 健康检查（负载均衡/探针用） |
| `GET /v1/models` | Bearer | 模型列表（relay 下模型别名在本机侧解析，网关返回空表） |
| `GET /v1/sessions` | Bearer | 可恢复会话清单（经隧道取自本机） |
| `POST /v1/chat/completions` | Bearer | OpenAI 兼容补全；`stream: true` 走 SSE |
| `GET /v1/ws` | Bearer | WebSocket 交互会话通道（审批、打断、事件流） |
| `GET /v1/sessions/active/transcript` | Bearer | 活动会话持久化快照（移动端刷新重建视图） |
| `GET /uplink` | Bearer(uplink scope) | 本机 volund 反向拨出注册 |
| `POST /pairing/redeem` | 无（IP 限流） | 配对码核销 → 移动设备长期 token |
| `GET /`（非 API 路径） | 无 | 移动端网站静态托管（同源免 CORS） |

## 快速开始（Docker）

```bash
cd deploy/gateway
cp .env.example .env        # 填 GATEWAY_PUBLIC_URL 等
docker compose up -d --build
docker compose logs gateway # 首启打印 bootstrap client 明文凭证（只此一次，不落盘）
```

DNS 把 `gateway.ai-agentic.cc` 指到主机后，Caddy 自动签发/续期 TLS 证书。
网关服务不直接暴露端口，全部流量经 Caddy 终结 TLS 后反代。

### 生产环境注意事项

- **凭证存储**：`clients.json` 只存 client_secret 的域分隔 SHA-256 哈希，明文绝不落盘
  （bootstrap 明文只在首次启动日志里出现一次；老的明文格式文件下次启动自动迁移为哈希）。
  再进一步：把 `GATEWAY_TOKEN_SECRET` 也走 env（k8s REFID_001Q 等），则 `/data` 卷
  整个泄露也换不出可用凭证。
- **数据卷**：`/data`（VOLUND_HOME：客户端哈希、签名密钥、已配对设备表）必须持久化；
  删掉它 = 所有已签发 token 失效 + 已配对设备全部掉线。

## 本机接入（桌面侧）

网关起来后，本机 volund 不需要任何额外命令——远程控制随 volund.js（TUI +
Web 控制台）一起启动。配置在 Web 控制台「远程控制」tab 填（或手写
`~/.volund/config.toml`）：

```toml
[remote]
enabled = true
gateway_url = "https://gateway.ai-agentic.cc"
client_id = "volund-xxxx"
client_secret = "..."
```

> 客户端凭证需要 `uplink` scope（bootstrap 生成的客户端默认带）。

流程：远程控制页启动服务 → 本机拨出注册 → 「添加移动设备」生成配对码/二维码 →
手机打开网关地址输入/扫码 → 核销签发设备 token（默认 30 天，落盘
`/data/gateway/devices.json`，网关重启不掉线已配对设备）→ 手机站聊天/审批/会话切换
全部经隧道落本机。审批与桌面共享同一队列：手机、Web、TUI 任一端决策全端清卡。

安全面：设备 token 只授 chat scope（网关 API 面本就没有 workbench/文件写）；
会话 cwd 被关进本机工作区（网关与本机双重校验）；配对码一次性、5 分钟有效、
redeem 端点按 IP 限流；远程控制页可随时停止服务或撤销设备（撤销即 token 失效）。

## 客户端用法

以下示例中的 `REFID_002Q` / `REFID_004Q` 等是占位符：换成部署时拿到的真实值。
relay 下这些调用最终都路由到已注册的本机实例执行。

### 1. 换 token

```bash
curl -X POST https://gateway.ai-agentic.cc/oauth/token \
  -H 'content-type: application/x-www-form-urlencoded' \
  -d 'grant_type=client_credentials&client_id=REFID_002Q&client_secret=REFID_004Q'
# → {"access_token":"...","token_type":"Bearer","expires_in":3600,"scope":"chat sessions"}
```

### 2. OpenAI 兼容调用（任何 OpenAI SDK 都能用）

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://gateway.ai-agentic.cc/v1",
    api_key="<access_token>",
)
for chunk in client.chat.completions.create(
    model="gpt-4o",                      # 别名/裸名在本机侧按 [models.aliases] 解析
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

注意：这是 **agent 调用**——模型会在本机执行工具（读写工作区文件、跑命令），
最终返回的是任务完成后的答复文本；tool_calls 不回传给客户端。

### 3. WebSocket 交互通道（审批/打断/事件流）

```
wss://gateway.ai-agentic.cc/v1/ws        # Authorization: Bearer <token>
                                           # 浏览器不能自定义头时用 ?access_token=<token>
```

客户端 → 服务端（JSON 帧，`ref` 可选、应答原样带回）：

| type | 字段 | 说明 |
| --- | --- | --- |
| `ping` | — | → `pong` |
| `session.start` | `cwd?` | 新建会话（cwd 限本机工作区内）→ `session.attached` |
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
const ws = new WebSocket("wss://gateway.ai-agentic.cc/v1/ws?access_token=" + token)
ws.onmessage = (e) => {
  const frame = JSON.parse(e.data)
  if (frame.type === "hello") ws.send(JSON.stringify({ type: "session.start" }))
  if (frame.type === "session.attached")
    ws.send(JSON.stringify({ type: "turn.submit", prompt: "列出工作区文件" }))
  if (frame.type === "event" && frame.event.type === "stream.delta")
    process.stdout.write(frame.event.payload.fragment ?? "")
}
```

## 环境变量全表

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `GATEWAY_HOST` / `GATEWAY_PORT` | `0.0.0.0` / `8788` | 绑定地址 |
| `GATEWAY_PUBLIC_URL` | 按请求 Host 推断 | 配对二维码/移动站入口的公网基地址 |
| `GATEWAY_MOBILE_PUBLIC_URL` | 同 `GATEWAY_PUBLIC_URL` | 移动站**单独部署**时的站点地址；配对链接指向它并自动携带 `&gw=<网关地址>` |
| `VOLUND_MOBILE_ASSET_DIR` | 自动探测 | 移动站静态产物目录（apps/mobile/out；移动站单独部署时无需配置） |
| `GATEWAY_CLIENTS` | — | OAuth 客户端 JSON 数组（优先于文件；`secret` 明文只在内存） |
| `GATEWAY_CLIENTS_FILE` | `<home>/gateway/clients.json` | 客户端文件（只存 `secretHash`） |
| `GATEWAY_TOKEN_SECRET` | 生成并落盘 | JWT HS256 签名密钥（任意长字符串，内部 SHA256 拉伸） |
| `GATEWAY_TOKEN_TTL_SECONDS` | `3600` | token 有效期 |
| `GATEWAY_PERMISSION_TIMEOUT_MS` | `120000` | 审批无人决策自动 deny 的超时（0 关闭） |
| `GATEWAY_QUEUE_TIMEOUT_MS` | `600000` | turn 排队上限，超时 409 |
| `GATEWAY_MAX_TURN_HOLD_MS` | `1800000` | 单 turn 持锁上限（防卡死） |
| `GATEWAY_RATE_LIMIT_RPM` | `600` | 每客户端每分钟 API 上限 |
| `GATEWAY_TOKEN_RATE_LIMIT_RPM` | `30` | 每 IP 每分钟颁证上限 |
| `GATEWAY_CORS_ORIGINS` | 空 | 跨域白名单（逗号分隔；空 = 不下发 CORS 头） |

直挂模式遗留的 `GATEWAY_PERMISSION_MODE` / `GATEWAY_DEFAULT_PROVIDER` /
`GATEWAY_WORKSPACE` 独立入口不再读取（权限模式与模型别名都在本机侧）。

## 移动站单独部署

移动站默认可由本网关同源托管（`VOLUND_MOBILE_ASSET_DIR`）；也可以**完全独立
部署**（静态 CDN / 独立镜像，见 `deploy/mobile/`）。独立部署时网关侧加两个 env：

```bash
GATEWAY_MOBILE_PUBLIC_URL=https://m.example.com   # 配对链接指向移动站
GATEWAY_CORS_ORIGINS=https://m.example.com        # 跨源放行移动站 REST 调用
```

配对链接自动变成 `https://m.example.com/#pair=CODE&gw=<网关地址>`——移动站把
`gw` 写进 localStorage 后跨源直连网关；同源托管形态（不配这两个 env）行为不变。

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
pnpm build --filter @volund/gateway-server --filter @volund/mobile
GATEWAY_PORT=8788 node packages/gateway-server/dist/bin.js
# 或：pnpm --filter @volund/gateway-server start
```
