# Remote gateway (`volund gateway`)

`volund gateway` exposes the local volund runtime as a remote API: OAuth2 client
credentials, OpenAI-compatible SSE streaming, and a WebSocket channel for interactive
sessions (approvals, interrupts, live events). Built for web backends, mobile backends,
and CI callers.

> Deployment (Docker / Caddy / domain setup) lives in `deploy/gateway/README.md`.

## Start

```bash
volund gateway --port 8788          # or GATEWAY_PORT
```

With no clients configured, a bootstrap client is generated: its plaintext client_secret
prints once at startup, and `~/.volund/gateway/clients.json` (0600) stores only its
domain-separated SHA-256 hash — legacy plaintext files are migrated to hashes automatically
on next start. The JWT signing key is generated and persisted at
`~/.volund/gateway/token-key` — deleting it invalidates every issued token.

## Authentication

```bash
curl -X POST http://127.0.0.1:8788/oauth/token \
  -H 'content-type: application/x-www-form-urlencoded' \
  -d 'grant_type=client_credentials&client_id=REFID_002Q&client_secret=REFID_004Q'
```

Use the returned `access_token` as `Authorization: Bearer <token>` on all `/v1/*`
endpoints.

## Session & concurrency model

volund is a **single-runner** runtime: all turns serialize through a FIFO queue, and a
request that waits longer than `GATEWAY_QUEUE_TIMEOUT_MS` gets `409
gateway_session_busy`. The WS channel and chat/completions share the same active
session; without one, chat/completions creates an ephemeral session (detached after the
turn; resumable later via the `x-volund-session-id` response header).

## Endpoints

| Endpoint                    | Purpose                                                     |
| --------------------------- | ----------------------------------------------------------- |
| `POST /oauth/token`         | client_credentials grant (form / JSON / Basic header)       |
| `GET /v1/health`            | Health check (unauthenticated)                              |
| `GET /v1/models`            | Model list in the OpenAI shape (aliases expanded)           |
| `GET /v1/sessions`          | Resumable session list                                      |
| `POST /v1/chat/completions` | OpenAI-compatible; SSE when `stream: true`                  |
| `GET /v1/ws`                | WebSocket interactive channel (approvals/interrupts/events) |

### chat/completions mapping

- Text-only messages (`content` string or `[{type:"text"}]`); multimodal parts get
  `400 gateway_unsupported_content`.
- Without `session_id`: the whole message list is rendered as a transcript and
  submitted statelessly.
- With `session_id` (extension field): resumes that session; only the last user
  message is submitted.
- `model` containing `/` is a qualified `provider/model` id; bare names get the
  `GATEWAY_DEFAULT_PROVIDER` prefix; `[models.aliases]` names resolve too.
- This is an **agent call**: the model executes tools server-side and the final answer
  is returned; tool calls are not relayed. A turn that aborts on error returns
  `502 gateway_upstream_failed` (in-band error frame when streaming).

### WebSocket frame protocol

Client frames: `ping` / `session.start{cwd?}` / `session.resume{id}` / `session.end` /
`turn.submit{prompt, model?}` / `turn.interrupt` / `permission.decide{requestId, kind}`.
Server frames: `hello` / `event` (core event passthrough) / command replies /
`error{code, message}`. Browsers that cannot set headers authenticate with
`?access_token=`.

## Permission approvals

`GATEWAY_PERMISSION_MODE` selects ask/auto/full (default auto). Approval cards are
pushed to WS clients as `permission.request` events; any connected client may decide.
Undecided requests are auto-denied after `GATEWAY_PERMISSION_TIMEOUT_MS` (default
120s). chat/completions has no interactive approval surface — in ask mode, keep a WS
client connected or use auto/full.

## Security surface

- HS256 JWTs with enforced iss/exp/signature checks; constant-time client secret
  comparison;
- per-IP rate limit on `/oauth/token` (30/min default) and per-client on `/v1/*`
  (600/min default);
- 4 MiB JSON body cap, 1 MiB WS message cap; masked client frames enforced (RFC 6455);
- CORS disabled by default, explicit allowlist via `GATEWAY_CORS_ORIGINS`;
- WS `session.start` cwd is confined to `GATEWAY_WORKSPACE` (double realpath check).
