# R1 local evidence

R1 local verification is intentionally split into reproducible local evidence and external gates.

## Reproducible local gate

Run `pnpm test:l1-local-e2e` from the repository root. The gate builds the published CLI entry point and launches it as a child process with an isolated `VOLUND_HOME`, an empty credential environment, and no terminal UI. It verifies:

- `volund status --json` returns parseable, secret-free state without reading or disclosing a credential value;
- `volund chat --json --no-tui` rejects a missing prompt with stable `error` and `final` NDJSON records carrying `prompt_required`;
- neither process output nor locally persisted telemetry contains credential-shaped data.

The root `pnpm test` command includes this gate after building the CLI, so the evidence is attached to the exact commit under test rather than a fixture-only package test.

## External gates

- Real Anthropic coding-task dog-food is `external-pending`; it requires an explicitly authorized credential and may incur cost.
- macOS/Linux native build and sandbox-escape results are valid only when produced by `.github/workflows/native.yml` and `.github/workflows/sandbox-escape.yml` for the same candidate SHA. Local fallback or a prior successful run must not be promoted to platform evidence.
- CI and independent review remain required before R1 can advance beyond local verification.
