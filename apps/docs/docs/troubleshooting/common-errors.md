# Common errors

## Exit code 1

The command or input is invalid. Run `volund help` and correct the request.

## Exit code 2

A system dependency or provider failed. Run `volund doctor` and inspect sanitized diagnostics.

## Exit code 3

Strict mode detected a degraded sandbox. Install the matching native package or fix the host mechanism; do not bypass it for acceptance.

## Exit code 130

The current turn was interrupted with Ctrl+C. The session remains available to resume.

## Ollama endpoint refused

Ollama defaults to `http://127.0.0.1:11434`. Loopback HTTP endpoints work without
confirmation. Any non-loopback endpoint requires an interactive, endpoint-specific
danger confirmation; non-interactive runs refuse it. Remote plaintext HTTP is
especially dangerous because prompts and tool data cross the network unencrypted.
Project-level config cannot override provider `baseUrl` or `endpoint` values.

Redirects are not followed. If a proxy is required, configure its final HTTPS URL
at user scope and approve that exact endpoint. `volund doctor` integrations should
use the Ollama version probe (`GET /api/version`) and report tool support only for
Ollama 0.3 or newer.
