# Coding Standards

Read during review, not implementation. Judgement calls no guardrail can enforce.

- Stale/ownership negative tests use real anchors from a foreign session, never invented ones (`"zzzz"` goes green even when the impl widens served-record as a side effect).
- A failed edit never mutates served-record: peek before serve, so stale surfaces before any write or serve side effect.
