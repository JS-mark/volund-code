---
'@volund/shared': minor
'@volund/core': minor
'@volund/app-runtime': minor
'@volund/ui': minor
'@volund/cli': patch
---

Restore the /model selection across resume: the choice is now persisted as a `session.model_changed` event (appendix D.2, 26th event) in the session JSONL, `replaySessionState` rebuilds `SessionState.model` from it (events before the 20-turn tail window are replayed too, last one wins), and submits without a per-turn override use the pinned model as `explicitModel`. The TUI wires `onModelSelect` to session persistence, the model picker shows the restored model after `volund resume` / `/resume` / web-driven session switches, and switching to an unpinned session clears the stale override back to the global config default.
