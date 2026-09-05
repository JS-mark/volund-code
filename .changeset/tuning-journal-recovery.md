---
'@volund/core': minor
'@volund/cli': minor
'@volund/shared': minor
'@volund/storage': minor
---

Give the adaptive tuning store crash-recoverable, cross-process-coordinated persistence.
New records are written as flat schema-version-2 lines carrying a store-assigned record id and a
per-namespace monotonic sequence (strictly increasing; regressions are dropped with a fixed
diagnostic). Every dual append runs under a best-effort cross-process lock and a
`.evolution-txn.json` journal (PREPARED → NAMESPACE_DURABLE → BOTH_DURABLE, fsync at each step):
recovery proves a commit only when both files end with the exact journalled record, aborts torn
partial writes back to the journalled pre-sizes, and fails closed into a RECOVERY_REQUIRED state
that refuses appends until manual intervention. `volund doctor` surfaces the tuning journal
health. Honesty limits: file content is fsynced but new-file creation cannot be made durable
across power loss without a directory fsync (no portable Node API; Windows deployments must
disclose), the lock is a local coordination primitive rather than a security boundary, and the
audit trail is still not promotion evidence for later shadow/apply stages without further review.
