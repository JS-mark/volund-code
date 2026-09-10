# Gateway integration

The remote gateway is a **standalone protocol surface**: any application that implements
the gateway protocol can integrate, without depending on the volund codebase. Public
instance `https://gateway.ai-agentic.cc` (or self-host per the
[remote gateway](/docs/guides/remote-gateway) guide).

- Field-level contract:
  [packages/gateway-server/PROTOCOL.md](https://github.com/JS-mark/volund-code/blob/main/packages/gateway-server/PROTOCOL.md)
- TypeScript frame types: exported from `@volund/gateway-server`
  (`MachineFrame` / `GatewayFrame` / `ClientFrame` / `ServerFrame`)

There are two kinds of integrators: **client applications** (drive sessions: mobile
sites, web backends, CI) and **machine runtimes** (host sessions: desktop volund or your
own agent implementation).

## Option A: client application (REST + WebSocket)

### 1. Get a token

Ask the gateway operator for machine credentials (client_id / client_secret with the
`chat sessions` scopes):

```bash
curl -X POST https://gateway.ai-agentic.cc/oauth/token \
  -H 'content-type: application/x-www-form-urlencoded' \
  -d 'grant_type=client_credentials&client_id=REFID_002Q&client_secret=REFID_004Q'
# → {"access_token":"...","token_type":"Bearer","expires_in":3600,"scope":"chat sessions"}
```

The token is an HS256 JWT; re-request it with the same credentials before expiry (on a
401, refresh and retry once).

### 2. Drive a session (OpenAI-compatible)

```python
from openai import OpenAI

client = OpenAI(base_url="https://gateway.ai-agentic.cc/v1", api_key="<access_token>")
for chunk in client.chat.completions.create(
    model="claude-sonnet-4",   # bare names/aliases resolve machine-side via [models.aliases]
    messages=[{"role": "user", "content": "Translate the README into English"}],
    stream=True,
):
    print(chunk.choices[0].delta.content or "", end="")
```

Multi-turn: read the `x-volund-session-id` response header on the first call, then pass
the extension field `session_id` (only the last user message is submitted on
continuation). Note this is an **agent call** — the model executes tools machine-side
and you get the final answer; tool calls are not relayed.

### 3. Interactive channel (approvals / interrupts / live events)

```
wss://gateway.ai-agentic.cc/v1/ws?access_token=<token>
```

Client frames: `ping` / `session.start{cwd?}` / `session.resume{id}` / `session.end` /
`turn.submit{prompt, model?}` / `turn.interrupt` /
`permission.decide{requestId, kind}` (all accept an optional `ref`, echoed in replies).
Server frames: `hello` (sent on connect, carries the session and pending-approval
snapshot) / `event` (live event passthrough) / command replies / `error{code, message}`.
Frame-by-frame fields: see "client plane" in PROTOCOL.md.

### 4. Rate limits and errors

Errors are always `{"error": {"code", "message"}}`; `gateway_rate_limited` (429) carries
Retry-After — back off accordingly. Full error-code table in PROTOCOL.md.

## Option B: machine runtime (dial out via /uplink)

Implement the machine plane when you want your own agent runtime to be driven by remote
clients — the dial-out side exposes no ports at all (NAT/firewall friendly):

1. **Credentials**: the machine client needs the `uplink` scope.
2. **Dial**: WebSocket to `wss://gateway.ai-agentic.cc/uplink?access_token=<token>`.
3. **Register (must be the first frame)**: `uplink.register` with
   `instance{instanceId, workspaceCwd, hostname?, version?, channels[], active,
pendingPermissions[]}`; wait for `uplink.registered`. Reconnecting with the same
   client replaces the stale connection — redial with exponential backoff on drop
   (reference: 1s start, ×2, 30s cap).
4. **Serve RPCs**: implement all 8 hub methods (`hub.start/resume/submit/interrupt/
closeActive/decide`, `sessions.list`, `session.transcript`), answering with
   `rpc.result{id, ok, result|error}`.
5. **Uplink pushes**: forward hub events as `event{envelope}`; push
   `uplink.state{active, pendingPermissions}` whenever the active session or pending
   approvals change (both fields always travel together).
6. **Pairing/device management** (optional): issue `req{ref, method, params}` for
   `pairing.create` / `devices.list` / `device.revoke`.

TypeScript reference implementation:
[`@volund/remote-link`](https://github.com/JS-mark/volund-code/tree/main/packages/remote-link)
(used by desktop volund; reuse it directly or implement against PROTOCOL.md). For other
languages, follow the JSON shapes of `MachineFrame` / `GatewayFrame`.

## Mobile site integration

The mobile site is a client-side implementation of the protocol (apps/mobile), with two
hosting shapes:

- **Same-origin on the gateway** (default): point `VOLUND_MOBILE_ASSET_DIR` at the static
  export — zero configuration.
- **Standalone deployment**: host the site on any static host (the `deploy/mobile/`
  image / a CDN), set `GATEWAY_MOBILE_PUBLIC_URL` on the gateway (pairing links point at
  the mobile site and carry `&gw=<gateway URL>`) and add the site origin to
  `GATEWAY_CORS_ORIGINS`. The site persists the `gw` parameter to localStorage and talks
  to the gateway cross-origin; users can also enter the gateway address on the pair view.

## Self-hosting checklist

```bash
# Gateway (relay, standalone process)
docker build -f deploy/gateway/Dockerfile -t volund-gateway .
docker run -d -p 8788:8788 -v volund-home:/data volund-gateway

# Mobile site (optional, standalone)
docker build -f deploy/mobile/Dockerfile -t volund-mobile .
docker run -d -p 8080:80 volund-mobile
```

In production, set `GATEWAY_PUBLIC_URL` to the gateway's public address (e.g.
`https://gateway.ai-agentic.cc`) and terminate TLS on a fronting Caddy/CDN. The full env
table and a Caddy example live in `deploy/gateway/README.md`.
