# WebSearch security contract

`WebSearch` only defines a replaceable provider interface; volund ships no real search
service by default, so without a configured provider the feature fails closed. The
`MockWebSearchProvider` in the repository exists solely for offline contract tests — it
never touches the network, needs no API key, and incurs no service cost.

Every query must pass the permission gate first. The permission request contains only
the provider identifier and the redacted query; execution logs record a short hash of
the query, the provider, and the result count — never the raw query, result bodies, or
credentials.

Results keep the provider's return order with no hidden cross-provider ranking. Counts,
per-item summaries, and total characters are capped, and results are returned wrapped in
a sourced `<untrusted>` block; tag characters inside results are encoded so the wrapper
cannot be closed early. This marker tells the model to treat search results as data
rather than instructions — it does not replace the permission gate, WebFetch domain
allowlists, or SSRF protections.

Real search providers, API keys, online calls, and billing are not enabled and require
separate authorization and security review. A future provider that fetches result pages
must reuse WebFetch's canonical domain permission, per-hop DNS re-resolution,
private-network / metadata address rejection, redirect policy, and response limits — it
must not bypass those primitives.
