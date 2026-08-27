# `@volund/provider-openai`

OpenAI Chat Completions adapter for Volund CLI's neutral `provider-kit` contract.

The client receives credential and HTTP ports from the application assembly layer. It never reads
environment variables or calls global `fetch`. Streaming responses normalize text, parallel tool
calls, usage, errors, aborts, and truncated streams into `ProviderChunk` values.

Online smoke tests require an authorized credential and are intentionally outside the offline test
suite. The package tests use recorded synthetic SSE frames and never make network requests.
