# @volund/app-runtime

## 0.2.0

### Minor Changes

- 7cfa6a4: Restore the /model selection across resume: the choice is now persisted as a `session.model_changed` event (appendix D.2, 26th event) in the session JSONL, `replaySessionState` rebuilds `SessionState.model` from it (events before the 20-turn tail window are replayed too, last one wins), and submits without a per-turn override use the pinned model as `explicitModel`. The TUI wires `onModelSelect` to session persistence, the model picker shows the restored model after `volund resume` / `/resume` / web-driven session switches, and switching to an unpinned session clears the stale override back to the global config default.

### Patch Changes

- Updated dependencies [5344f22]
- Updated dependencies [7e94e19]
- Updated dependencies [ad0e7b5]
- Updated dependencies [7ad5a34]
- Updated dependencies [7d1147e]
- Updated dependencies [4ac2411]
- Updated dependencies [4b83a10]
- Updated dependencies [e569469]
- Updated dependencies [9e969d3]
- Updated dependencies [7cfa6a4]
- Updated dependencies [a0eecf1]
  - @volund/auth@0.2.0
  - @volund/shared@0.2.0
  - @volund/native-bridge@0.2.0
  - @volund/plugin-runtime@0.1.1
  - @volund/config@0.2.0
  - @volund/core@0.2.0
  - @volund/plugin-sdk@0.2.0
  - @volund/storage@0.2.0
  - @volund/mcp-client@0.1.1
  - @volund/permission@0.1.1
  - @volund/provider-kit@0.1.1
  - @volund/skills-runtime@0.1.1
  - @volund/subagent@0.1.1
  - @volund/telemetry@0.1.1
  - @volund/tool-kit@0.1.1
  - @volund/tools@0.1.1
  - @volund/kernel@0.1.1
