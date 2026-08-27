---
'@volund/shared': minor
---

Add per-event payload zod schemas for the 19 EventBus events (spec appendix D): `EVENT_SCHEMAS` registry, shared envelope schema with UUIDv7 ids, and `eventEnvelopeFor(type)` replay validation. CI-enforced via `scripts/verify-event-schemas.mjs` against the §2.3 event table.
