# @volund/provider-ollama

Ollama adapter with a localhost-safe default. The default endpoint is
`http://127.0.0.1:11434`; loopback HTTP endpoints are accepted without a prompt.

Non-loopback endpoints require a runtime `OllamaEndpointApproval` returned by
`approveOllamaEndpoint`. Approval is endpoint-specific, cannot be sourced from
project config, and is always refused in non-interactive mode. Plaintext HTTP is
called out separately in the confirmation prompt. Redirect targets are checked
with the same policy before any response body is consumed.

volund never sends credentials to Ollama. Remote endpoint verification must use
an injected HTTP port and is not performed by this package's offline tests.
