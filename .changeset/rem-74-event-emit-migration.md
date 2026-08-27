---
'@volund/core': minor
---

Migrate every EventBus emit point to the appendix D payload contract (r13-I8): the emit/forward exits now validate payloads against `EVENT_SCHEMAS[type]` and throw on violation, `stream.delta` carries incremental `{messageId, kind, fragment}` shapes, `tool.requested` is emitted before permission/execution, subagent bubbles keep the original `event.id` with envelope-only `parentTurnId`/`parentDepth` tags, and `replaySessionState` rebuilds `SessionState` from JSONL events (legacy `session.snapshot` rows are consumed read-only as a baseline; no new snapshots are written).
