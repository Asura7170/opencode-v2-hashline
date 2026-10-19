# Coding Standards

Read during review, not implementation. Judgement calls no guardrail can enforce.

- Stale/ownership negative tests use real anchors from a foreign session, never invented ones (`"zzzz"` goes green even when the impl widens served-record as a side effect).
- A failed edit never mutates served-record: peek before serve, so stale surfaces before any write or serve side effect.
- Every emitted skip carries its reason into the per-message summary; only explicit `@`, Cuota and the cap emit skips — bare mentions that fail and sensitive paths stay silent by design.
- Gate checks run cheapest-first (excludes/oversize before quota), so the reported reason is the most relevant one.
- Unit tests replicate the production geometry (one sidecar per session): a rule tested only under a shared-store fixture with foreign rows pre-seeded can pass while its production branch never fires.
- Every write preserves the file's EOL and BOM (read normalizes, write serializes with the detected style); a CRLF edit must diff only the anchored lines.
- Every user-file write re-validates the read snapshot before touching the file (E_FILE_CHANGED): a change on disk since the read must fail closed, never be silently overwritten.
