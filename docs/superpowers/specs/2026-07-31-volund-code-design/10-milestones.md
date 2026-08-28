> ↩ [返回索引 (README)](./README.md) · ← [上一章: §9 构建 / CI / 分发](./09-build-ci-dist.md) · [下一章: §11 CLI 命令树](./11-cli-commands.md) →

---

## §10 Evidence-gated roadmap R0 → R6

Milestones describe observable product outcomes, not accumulated artifacts. The frozen [capability matrix](./16-capability-traceability.md) is the status authority. Historical L1–L5 issues, checkmarks, fixtures, mocks, dry-runs, and package tests are clues only.

### Status vocabulary

Only `missing`, `partial`, `implemented-unwired`, `verified-local`, `verified-ci`, `external-pending`, and `release-ready` are valid. `verified-local` requires a supported entry, runtime wiring, and boundary test on the recorded SHA. `verified-ci` binds required CI to the same SHA. `release-ready` additionally closes or explicitly excludes all external gates.

### Shared exit gate

Every stage requires: documented product entry and composition wiring; direct plus integration/E2E tests; same-SHA platform CI; docs, changeset disposition, DCO, linked PR and migration notes; independent evidence review; and separate handling for credentials, paid services, hardware, production signing/notarization, stores, registries, publication, and human approval.

### R0 — specification baseline and traceability

Freeze the SHA, enumerate all design capabilities, classify them in the matrix, build the dependency-ordered issue tree, and migrate APO-113. Exit only when no design item is unclassified and every row has source, entry, wiring, evidence, PR clue, state, and blocker.

### R1 — usable core loop and L1 local completeness

One provider completes a real local coding loop through CLI/TUI and JSON/no-TUI with tools, permission, trust, sandbox, backup, session persistence, streaming interruption, and truthful recovery/status. Mock provider proof does not close the paid dog-food external gate.

### R2 — state and continuity

Auth/config/session/context, complete local Memory, and skills remain coherent across restarts. Memory includes `memory-runtime`, CRUD, model tools, CLI, guide, pinned injection, mandatory `preWrite`, indexed recall, hooks, plugin bridge, doctor/reindex, attachments, approved sharing semantics, export/import, and a `/memory` decision. Exit requires a restart E2E and direct prompt-injection/permission tests.

### R3 — extensions and orchestration

MCP, plugins/bridge, subagent, fallback routing, native search/filesystem, and diagnostics work through supported configuration. Exit requires install/configure/run/diagnose E2E paths; defined-but-unwired classes do not pass.

### R4 — UX and multi-provider completeness

Ink TUI, slash commands, status/settings/config, attachments/vision, Anthropic/OpenAI/Gemini/Ollama, WebFetch/WebSearch, role/fallback routing, and automation modes behave consistently. Exit requires composition-root provider tests, real slash behaviors, wide/narrow TUI and JSON/no-TUI golden E2E evidence.

`Volund Web`（§22）是 R4 的**可选 product slice**，不阻塞 CLI/TUI 的 R4。若选入某个 release scope，它必须先完成 UI-neutral `app-runtime` 抽取，再以真实 `volund web` loopback 入口证明 session/chat/permission/tool/storage 复用；CLI/TUI 证据不能替代 browser E2E，网页组件测试也不能替代 production composition evidence。

### R5 — production readiness

Platform matrix, security evidence, native binaries, signing, notarization, channels, docs, and governance form a reproducible candidate. Exit requires candidate-SHA CI and real production approvals/signatures/publication evidence; fixtures and dry-runs never substitute.

### R6 — isolated advanced and conditional capabilities

Semantic/cost routing, provider signing, plugin registry, auto-update, team memory, advanced evolution, dynamic reflection (§21), local scheduled automation（§22 W-17）, and other v2 work require their own product/security decisions. They do not block earlier stages unless explicitly included in that release scope.

Remote access、手机控制、微信/企业微信、多实例和团队协作（§22 W-18）属于 **R6+ 长期独立项目**：不得以开放 `0.0.0.0` 或复用本地启动 nonce交付。它们需要独立身份/设备绑定、撤销、重放保护、transport trust、审计、abuse/privacy 模型、真实网络证据和人类安全门；本地 Web 的 release-ready 状态不自动向远程能力继承。

## Stage migration

- R0 runs first; later stages stay backlog and are promoted only after the preceding evidence barrier closes.
- Reuse or reopen matching issues. Create a new issue only when no durable scope owner exists.
- Historical `done` is linked as evidence; focused remediation owns the new gap.
- APO-113 no longer closes by exhausting an old non-terminal list. It closes only when the selected new-roadmap release scope reaches `release-ready`, or the owner explicitly narrows/cancels it.
- `RELEASE-CHECKLIST-L1.md` remains historical evidence, not current authority. New candidate checklists must be generated from selected matrix rows and bind results to an exact SHA.
