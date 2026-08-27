# `@volund/provider-gemini`

Gemini `generateContent` adapter for Volund CLI. The package maps the provider-neutral
message and tool contracts to Gemini REST requests and normalizes SSE responses back to
`ProviderChunk` values.

The client receives credential and HTTP ports from the application assembly layer. It
does not read environment variables or call the network directly. Construct it with the
same model used for requests so `countTokens()` can use Gemini's model-specific endpoint:

```ts
const gemini = new GeminiClient({ credentials, http, model: 'gemini-2.5-pro' })
```

Tests use mocked ports only. No real credential or online provider call is required.
