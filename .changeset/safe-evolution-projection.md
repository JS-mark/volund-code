---
'@volund/core': minor
'@volund/cli': minor
'@volund/shared': minor
'@volund/config': minor
'@volund/storage': minor
---

Make adaptive runtime tuning default-off and harden its persistence boundary. Configuration now
requires an explicit own-property boolean opt-in, context tuning uses exported frozen bounds plus
an atomic cross-field snapshot projection, and non-context persisted apply remains deny-only.
Configuration parsing also rejects prototype-pollution key segments
(`__proto__` / `constructor` / `prototype`) fail-closed. Evolution records are written as strict
version-1 JSONL, legacy records retain explicit compatibility provenance, invalid or future
records fail closed, and rollback consumes only validated context history. The flat V1 format is
intentionally not yet crash-atomic or evidence-grade; record identity, sequencing, dual-file
recovery, and migration diagnostics remain a separate T1b change.
