# L1 Anthropic dog-food evidence

Status: **BLOCKED — no credential is available in the current agent environment.**

This file is the acceptance record, not evidence by itself. A human with an authorized Anthropic account must run the released candidate without exposing the credential to chat, logs, issues, commits, or telemetry.

## Required run

- Candidate commit/version: pending
- Host target and Sandbox Tier: pending
- `volund doctor --strict`: pending
- Real repository task: read a failing test, edit the implementation, run the relevant tests, and open a PR
- Provider: Anthropic through Volund CLI's verified credential flow
- Permission decisions: record each prompt category and allow/deny decision; do not record secret values or sensitive file content
- Test command and result: pending
- Dog-food PR URL: pending
- Session/export evidence, sanitized: pending

## Acceptance rules

The run fails if it uses a mock provider, injects a credential through source or logs, bypasses the sandbox, omits a permission decision, or lacks a real test and PR. After completion, replace `BLOCKED` with `PASS` or `FAIL` and attach durable evidence links.
