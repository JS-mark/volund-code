Upstream: https://github.com/openai/codex
Pinned commit: `ee0247f95a6fe2b094ba2253d82cae2a2b4c2dff`
License: Apache-2.0

The reviewed L1 import boundary and exact source inventory are recorded in
`VENDOR.toml`. volund's adapter stays dependency-minimal: the macOS base policy
is compiled into the binary, the Linux bundled-bwrap implementation is retained
as the audited reference for volund's digest adapter, and the Windows entrypoint
is provenance-only until L2. Every imported file retains the upstream license
and has a pinned SHA256 digest.
