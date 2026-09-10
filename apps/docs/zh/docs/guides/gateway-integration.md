# 网关接入（协议集成）

远程网关是**独立的协议面**：任何实现了网关协议的应用都能对接，不依赖 volund
代码库。公网实例 `https://gateway.ai-agentic.cc`（或按
[远程网关](/zh/docs/guides/remote-gateway) 自部署）。

- 字段级契约：[packages/gateway-server/PROTOCOL.md](https://github.com/JS-mark/volund-code/blob/main/packages/gateway-server/PROTOCOL.md)
- TypeScript 帧类型：`@volund/gateway-server` 导出
  （`MachineFrame` / `GatewayFrame` / `ClientFrame` / `ServerFrame`）

对接方分两类：**客户端应用**（驱动会话：移动站、Web 后端、CI）与
**机器运行时**（承接会话：桌面 volund 或你自己的 agent 实现）。

## 对接方式 A：客户端应用（REST + WebSocket）

### 1. 换 token

向网关运维申请机器凭证（client_id / client_secret，scope 含 `chat sessions`）：

```bash
curl -X POST https://gateway.ai-agentic.cc/oauth/token \
  -H 'content-type: application/x-www-form-urlencoded' \
  -d 'grant_type=client_credentials&client_id=REFID_002Q&client_secret=REFID_004Q'
# → {"access_token":"...","token_type":"Bearer","expires_in":3600,"scope":"chat sessions"}
```

token 是 HS256 JWT，过期前用同一凭证重取即可（401 时重取并重放请求）。

### 2. 驱动会话（OpenAI 兼容）

```python
from openai import OpenAI

client = OpenAI(base_url="https://gateway.ai-agentic.cc/v1", api_key="<access_token>")
for chunk in client.chat.completions.create(
    model="claude-sonnet-4",   # 裸名/别名在机器侧按 [models.aliases] 解析
    messages=[{"role": "user", "content": "把 README 翻译成英文"}],
    stream=True,
):
    print(chunk.choices[0].delta.content or "", end="")
```

多轮续接：首轮响应头 `x-volund-session-id` 拿会话 id，后续请求带扩展字段
`session_id`（此时只取最后一条 user 消息）。注意这是 **agent 调用**——模型在
机器侧执行工具，返回任务完成后的答复；tool_calls 不回传。

### 3. 交互通道（审批 / 打断 / 事件流）

```
wss://gateway.ai-agentic.cc/v1/ws?access_token=<token>
```

客户端帧：`ping` / `session.start{cwd?}` / `session.resume{id}` / `session.end` /
`turn.submit{prompt, model?}` / `turn.interrupt` /
`permission.decide{requestId, kind}`（均可带 `ref`，应答原样带回）。
服务端帧：`hello`（连接即发，含会话与待审批快照）/ `event`（事件流透传）/
各命令应答 / `error{code, message}`。逐帧字段见 PROTOCOL.md「客户端面」。

### 4. 限流与错误

错误统一为 `{"error": {"code", "message"}}`；`gateway_rate_limited`(429) 带
Retry-After，按它退避。完整错误码表见 PROTOCOL.md。

## 对接方式 B：机器运行时（/uplink 反向拨出）

当你想让自己的 agent 运行时被远程客户端驱动时，实现机器面协议——
拨出方不暴露任何端口，NAT/防火墙友好：

1. **凭证**：机器凭证 scope 须含 `uplink`。
2. **拨出**：WebSocket 连 `wss://gateway.ai-agentic.cc/uplink?access_token=<token>`。
3. **注册（首帧必须）**：`uplink.register`，携带
   `instance{instanceId, workspaceCwd, hostname?, version?, channels[], active,
pendingPermissions[]}`；收到 `uplink.registered` 后进入在线态。
   同 client 重连顶替旧连接——断线后指数退避重拨（参考实现：1s 起、×2、30s 封顶）。
4. **承接 RPC**：实现全部 8 个 hub 方法（`hub.start/resume/submit/interrupt/
closeActive/decide`、`sessions.list`、`session.transcript`），应答
   `rpc.result{id, ok, result|error}`。
5. **上行**：hub 事件透传 `event{envelope}`；活动会话/待审批变化时推
   `uplink.state{active, pendingPermissions}`（两字段同帧成对）。
6. **配对/设备管理**（可选）：经 `req{ref, method, params}` 调
   `pairing.create` / `devices.list` / `device.revoke`。

TypeScript 参考实现：[`@volund/remote-link`](https://github.com/JS-mark/volund-code/tree/main/packages/remote-link)
（volund 桌面端用的就是它；可直接复用或按 PROTOCOL.md 自实现）。
其他语言照 `MachineFrame` / `GatewayFrame` 的 JSON 形状实现即可。

## 移动站接入

移动站是协议的一个客户端实现（apps/mobile），两种托管形态：

- **网关同源**（默认）：网关 `VOLUND_MOBILE_ASSET_DIR` 指向静态产物即可，零配置。
- **独立部署**：站点挂任意静态托管（`deploy/mobile/` 镜像 / CDN），网关侧配
  `GATEWAY_MOBILE_PUBLIC_URL`（配对链接指向移动站并自动携带 `&gw=` 网关地址）
  - `GATEWAY_CORS_ORIGINS`（跨源放行站点 Origin）。移动站把 `gw` 写入
    localStorage 后跨源直连网关；用户也可在配对页手填网关地址。

## 自部署清单

```bash
# 网关（relay，独立进程）
docker build -f deploy/gateway/Dockerfile -t volund-gateway .
docker run -d -p 8788:8788 -v volund-home:/data volund-gateway

# 移动站（可选，独立部署）
docker build -f deploy/mobile/Dockerfile -t volund-mobile .
docker run -d -p 8080:80 volund-mobile
```

生产环境把 `GATEWAY_PUBLIC_URL` 配成网关公网地址（如
`https://gateway.ai-agentic.cc`），TLS 由前置 Caddy/CDN 终结。完整 env 表与
Caddy 示例见 `deploy/gateway/README.md`。
