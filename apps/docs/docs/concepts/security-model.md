# Security model

Volund treats file writes, commands, and network access as explicit side effects. The permission layer decides first; destructive commands and plugin execution then use the Rust sandbox. Volund discloses one process-wide tier:

- **Full**: all required isolation mechanisms are active.
- **Partial**: useful isolation is active with stated limitations.
- **Weak**: only limited controls are available.
- **None**: side-effect tools are denied unless the user explicitly accepts dangerous mode.

Never infer a tier from a successful build. Use the runtime probe and read its limitations. Permission approval is not proof that a command is safe.

## Prompt injection threat model

Trusted instruction sources are the system prompt and instructions you enter directly. Files, tool results, web content, MCP responses, subagent output, and memory are untrusted data, even when they contain text that looks like an instruction.

Volund marks such content with an encoded `<untrusted source="...">` wrapper before it reaches the model. The wrapper is source-traceable and cannot be closed by embedded text, but model compliance is best-effort rather than a security boundary. Permission checks and sandboxing remain necessary.

Treat requests inside untrusted content to reveal secrets, weaken safeguards, run unrelated commands, or contact unexpected hosts as injection attempts. Deny the permission, inspect the source, and restate the intended task in your own words.

Credentials belong only in Volund's masked login flow. Volund sanitizes auth telemetry and keeps telemetry local by default.

## WebFetch network boundary

WebFetch asks for permission by canonical HTTP(S) origin. A session or project grant for one
origin does not grant another origin, including redirect targets. URL credentials and non-HTTP
schemes are rejected.

Before every connection and redirect hop, Volund resolves the hostname and rejects the request if
any answer is loopback, private, link-local, reserved, multicast, documentation-only, or a cloud
metadata address. The connection is pinned to the validated address so DNS cannot change between
validation and socket creation. Responses are limited by time, request rate, redirect count,
content type, bytes, and model-facing characters. Web content remains untrusted. Audit events omit
query strings, response bodies, request headers, and credentials.
