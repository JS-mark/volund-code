---
'@apollo-code/plugin-runtime': patch
'@apollo-code/shared': patch
'apollo-code': patch
---

Temporarily contain legacy plugin install and activation until Catalog v2 and the verified capability ABI can reopen them safely. Production manager/runtime paths are deny-only, stale approvals are projected disabled without a state rewrite, plugin machine errors follow the two-event NDJSON contract, and the published package excludes all test authority and legacy host seams.
