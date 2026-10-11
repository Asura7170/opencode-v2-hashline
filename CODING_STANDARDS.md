# Coding Standards

Read during review, not implementation. Judgement calls no guardrail can enforce.

- Stale/ownership negative tests use real anchors from a foreign session, never invented ones (`"zzzz"` goes green even when the impl widens served-record as a side effect).
- A failed edit never mutates served-record: peek before serve, so stale surfaces before any write or serve side effect.
- Every skip path emits its reason into the per-message summary: no silent `catch { continue }` in gate paths.
- Gate checks run cheapest-first (excludes/oversize before ownership/quota), so the reported reason is the most relevant one.
