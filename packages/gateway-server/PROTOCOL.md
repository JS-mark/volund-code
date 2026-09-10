# volund 网关协议（REMOTE-GATEWAY-PROTOCOL v1）

网关是**独立的协议面**：任何按本文档实现帧协议的应用都能对接，不依赖 volund
代码库。TypeScript 实现方可以直接引用机器可读的帧类型
（`src/protocol.ts`，经 `@volund/gateway-server` 导出）。

## 角色与拓扑

```
客户端（移动站 / Web 后端 / CI）            机器（agent 运行时，如 volund 桌面端）
  REST /v1/* + WS /v1/ws  ──►  网关（公网中转）  ◄── WS /uplink（反向拨出）
```

- **网关（gateway）**：纯中转。认证、限流、路由、配对、设备注册表；不持有会话。
- **机器（machine）**：真正跑会话的 agent 运行时。不暴露端口，向网关反向拨出
  `/uplink` 并注册；客户端流量按 OAuth client 路由到对应机器。
- **客户端（client/device）**：浏览器、移动站、CI 等。REST + `/v1/ws` 驱动会话。

## 认证

`POST /oauth/token`，grant_type=client_credentials（form-urlencoded / JSON /
Basic 头均可）→ `{access_token, token_type, expires_in, scope}`。access_token 是
HS256 JWT（强制 iss/exp/签名）。scope 分面：

| scope      | 用途                                  |
| ---------- | ------------------------------------- |
| `uplink`   | 机器拨出 `/uplink`（注册 + 承接 RPC） |
| `chat`     | `/v1/chat/completions`、`/v1/ws`      |
| `sessions` | `/v1/sessions`、transcript            |

配对核销（`POST /pairing/redeem`）签发的**设备 token** 绑定机器 client，
只授 `chat` scope，默认 30 天，撤销即 401。撤销同时踢存量：该设备已建立的
`/v1/ws` 连接被网关以 `1008 device_revoked` 主动关闭（客户端应据此回配对页，
而不是带死凭证无限重连）。

## 机器面：`GET /uplink`（WebSocket）

认证：`Authorization: Bearer <token>` 或 `?access_token=`（浏览器 WS 不能设头）。
JSON 文本帧，`type` 判别；未知帧类型网关以 1002 关闭。

### 本机 → 网关（MachineFrame）

| type              | 字段                                                                                                | 说明                                                                                                                                                                                             |
| ----------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `uplink.register` | `instance{instanceId, workspaceCwd, hostname?, version?, channels[], active, pendingPermissions[]}` | **必须是首帧**；注册即路由。同 client 重连时新连接顶替旧连接（旧连接以 1008 `replaced by a newer uplink` 关闭，在途 RPC 立即失败；被顶替方应让位停连而非立即重拨，否则两个同凭证实例会互抢注册） |
| `uplink.state`    | `active`, `pendingPermissions[]`                                                                    | 活动会话/待审批快照变化时重推；两字段同帧成对                                                                                                                                                    |
| `event`           | `envelope{kind, event, sessionId?, cursor?}`                                                        | hub 事件透传，与 `/v1/ws` 下行 event 同信封                                                                                                                                                      |
| `rpc.result`      | `id, ok, result? \| error?{code,message}`                                                           | 网关 hub RPC 的应答                                                                                                                                                                              |
| `req`             | `ref, method, params`                                                                               | 本机发起的命令（见下表）                                                                                                                                                                         |
| `ping`            | —                                                                                                   | 应用级心跳 → `pong`                                                                                                                                                                              |

### 网关 → 本机（GatewayFrame）

| type                | 字段                                       | 说明                                       |
| ------------------- | ------------------------------------------ | ------------------------------------------ |
| `uplink.registered` | `serverId, version`                        | 注册确认                                   |
| `rpc`               | `id, method, params`                       | hub 方法调用，本机须实现全部方法（见下表） |
| `res`               | `ref, ok, result? \| error?{code,message}` | `req` 的应答                               |
| `pong`              | —                                          | 心跳应答                                   |

### hub RPC 方法（rpc 帧 method；本机侧实现）

| method                | params                           | result                              | 说明                                                            |
| --------------------- | -------------------------------- | ----------------------------------- | --------------------------------------------------------------- |
| `hub.start`           | `{cwd}`                          | `{id}`                              | 新建会话；cwd 被关进本机工作区（本机二次校验，防 symlink 逃逸） |
| `hub.resume`          | `{id}`                           | `{id}`                              | 恢复会话                                                        |
| `hub.submit`          | `{prompt, model?, attachments?}` | `'accepted'`                        | 提交一轮（单 runner 串行；model 别名在本机侧解析）              |
| `hub.interrupt`       | `{}`                             | `null`                              | 打断在途 turn                                                   |
| `hub.closeActive`     | `{}`                             | `null`                              | 结束活动会话                                                    |
| `hub.decide`          | `{requestId, kind}`              | `null`                              | 审批决策（本机队列幂等，过期决策静默忽略）                      |
| `hub.stageAttachment` | `{mime, dataBase64}`             | `{kind, mime, size, handle}`        | 附件暂存进 AttachmentStore（60s 超时）                          |
| `hub.readAttachment`  | `{handle}`                       | `{mime, dataBase64} \| undefined`   | 附件字节回放（60s 超时；读不到回 undefined → 网关 404）         |
| `sessions.list`       | `{}`                             | `unknown[]`                         | 可恢复会话清单                                                  |
| `session.transcript`  | `{}`                             | `{id?, cwd?, transcript[]}`         | 活动会话持久化快照                                              |
| `models.list`         | `{}`                             | `{current?, options: [{id,label}]}` | 模型清单（本机当前生效模型 + 可切换候选）                       |

### uplink 命令（req 帧 method；由网关应答）

| method           | params       | result                                                |
| ---------------- | ------------ | ----------------------------------------------------- |
| `pairing.create` | `{}`         | `{code, url, expiresAt}`（一次性 8 位码，5 分钟有效） |
| `devices.list`   | `{}`         | `{devices: [{id, name, pairedAt, lastSeen}]}`         |
| `device.revoke`  | `{deviceId}` | `{revoked: boolean}`（撤销即 token 失效）             |

### 同步语义（实现方注意）

- 网关侧把 `active`/`pendingPermissions` 缓存为**快照**（注册帧 + state 帧），
  同步属性被 RPC 化后仍能同步读；`hub.start/resume/closeActive` 的 RPC 应答
  会先做乐观更新，权威值以随后的 state 帧为准。
- RPC 默认 15s 超时（`504 gateway_upstream_failed`）；链路断开时在途 RPC 以
  `503 gateway_uplink_offline` 失败。
- 事件广播按来源机器过滤：客户端只收到其认证 client 对应机器的事件。

## 客户端面

### REST（Bearer）

| 端点                                 | 说明                                                                                                                                                      |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/health`                     | 健康检查（无需认证；relay 下含 `relay.instances`）                                                                                                        |
| `GET /v1/models`                     | 模型清单（relay 经隧道 `models.list` 取自本机）；OpenAI `data` 形状 + `current` 默认模型字段                                                              |
| `GET /v1/sessions`                   | 会话清单（经隧道取自本机）                                                                                                                                |
| `GET /v1/sessions/active/transcript` | 活动会话快照（移动端刷新重建视图）                                                                                                                        |
| `POST /v1/chat/completions`          | OpenAI 兼容；`stream:true` 走 SSE；`session_id` 扩展字段续接会话                                                                                          |
| `POST /v1/attachments`               | 附件上传（原始字节直传，Content-Type 限 image/png·jpeg·gif·webp，≤20 MiB）；字节经隧道进本机 AttachmentStore，返回 `{kind,mime,size,handle}`              |
| `GET /v1/attachments/{handle}`       | 附件字节回放（移动站 transcript 图片回显）；handle 即 AttachmentStore 内容寻址引用，二进制应答带不可变长缓存；读不到 → 404 `gateway_attachment_not_found` |
| `POST /pairing/redeem`               | 配对码核销（无认证，IP 限流）→ 设备 token                                                                                                                 |

### WebSocket `GET /v1/ws`（Bearer 或 ?access_token=）

客户端帧（ClientFrame）：`ping` / `session.start{cwd?}` / `session.resume{id}` /
`session.end` / `turn.submit{prompt, model?, attachments?}` / `turn.interrupt` /
`permission.decide{requestId, kind}`——均可带 `ref`，应答原样带回。

`attachments` 为已暂存附件的引用数组（`{kind, chip, mime, size, handle?}`，先经
`POST /v1/attachments` 换 handle）；prompt 为空时以 chip（如 `[image_1]`）占位。
hub RPC 面相应多出 `hub.stageAttachment{mime, dataBase64}`（字节 base64 进站，
60s 超时）与 `models.list`（模型清单，供 `GET /v1/models`）；uplink 连接的
WS 帧上限因此放到 32 MiB，/v1/ws 客户端面仍为 1 MiB。

服务端帧（ServerFrame）：`hello{serverId, version, session, pendingPermissions}`
（连接即发）/ `pong` / `session.attached{id, cwd?}` / `session.ended` /
`turn.accepted` / `turn.interrupt_requested` /
`permission.decided{requestId, decided}` / `event`（事件信封透传）/
`error{code, message}`。

`event` 信封除本机透传外，网关在 relay 模式会合成两个 `kind=view` 的机器在线
状态事件：uplink 断开时 `machine.offline`、注册/重连成功时 `machine.online{cwd}`
（被新连接顶替的旧连接断开不重复发 offline）；客户端应用其提示链路状态，
命令应答里的 `gateway_uplink_offline` 错误帧是同一语义的被动兜底。

### 配对流程

1. 机器侧 `req: pairing.create` → `{code, url, expiresAt}`；
   `url` 指向移动站（`GATEWAY_MOBILE_PUBLIC_URL`，缺省为网关自身），
   形如 `<site>/#pair=CODE[&gw=<网关地址>]`。
2. 设备打开 url（或手动输入网关地址 + 配对码）→ `POST /pairing/redeem`
   `{code, name}` → `{access_token, device_id, expires_in}`。
3. 设备 token 直连 `/v1/ws` + REST；机器侧 `device.revoke` 可即时撤销。

## 错误码

`{error: {code, message}}`：`gateway_auth_invalid`(401) /
`gateway_client_rejected`(401) / `gateway_grant_unsupported`(400) /
`gateway_rate_limited`(429) / `gateway_schema_invalid`(400/404) /
`gateway_session_busy`(409) / `gateway_session_not_found`(404) /
`gateway_unsupported_content`(400) / `gateway_upstream_failed`(502) /
`gateway_uplink_offline`(503) / `gateway_ws_protocol_error`(WS 帧内)。

## 安全约束

- `/oauth/token` 每 IP 限流（默认 30/min），`/v1/*` 每客户端限流（默认 600/min），
  `/pairing/redeem` 每 IP 限流。
- JSON body 上限 4 MiB，WS 消息上限 1 MiB；客户端帧必须掩码（RFC 6455）。
- CORS 默认关闭，`GATEWAY_CORS_ORIGINS` 显式开白名单（移动站独立部署时必须）。
- 会话 cwd 网关/本机双重 realpath 校验，不得逃逸本机工作区。

## 兼容约定

- 帧/字段**只增不改**：新增 `type`、新增 optional 字段都是兼容变更；
  接收方必须忽略未知字段。
- 破坏性变更升级协议主版本（v2 将另起文档与类型命名空间）。
