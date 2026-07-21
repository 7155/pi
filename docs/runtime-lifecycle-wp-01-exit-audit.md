# WP-01 Runtime Lifecycle Exit Audit

Date: 2026-07-19

## Scope

WP-01 is limited to product-neutral Pi runtime primitives. It does not introduce Room types, Room routing,
Agent speech, voice profiles, or product policy. `roomTypes` remains `false`.

## Exit gates

| Gate | Result | Code and evidence |
| --- | --- | --- |
| Structured queue owns `steer` and `followUp` | PASS | `Agent` stores both paths as `ContinuationEnvelope<AgentMessage>` in `ContinuationQueue`; legacy method names remain compatibility entry points. Agent and session regression tests exercise delivery. |
| RPC list and selective cancel | PASS | `list_continuations` and `cancel_continuation` support exactly one of continuation ID, correlation ID, or generation. RPC client serialization and session behavior are tested. |
| Continuation timer | PASS | `notBefore` schedules a wakeup. The wakeup enters the owning `AgentSession` cancellation and settlement lifecycle instead of bypassing it. Global abort cancels delayed work before firing. |
| Stale generation and effectively-once | PASS | Cancelling a generation advances the admission fence. Old work becomes terminal; idempotency-key duplicates resolve to the original envelope; a leased message is completed before it can be drained again. |
| Branch abort | PASS | A dedicated fault-injection test holds branch summarization open, calls the general `AgentSession.abort()`, and verifies the `branch_summary` registry receipt and clean drain. |

## Advertised capability state

- `sessionContinuationQueue`: `true`
- `sessionCancelOperationRegistry`: `true`
- `branchSummary`: `true`
- `continuationTimer`: `true`
- `roomTypes`: `false`

Capabilities were flipped only after their behavior tests passed.

## Residual boundaries

- The queue is in-memory. Durable continuation recovery belongs to the product persistence and replay work package.
- Completed and cancelled envelopes remain in the in-memory snapshot for audit until the session is discarded; retention and compaction are product policy.
- This work exposes mechanisms only. Room depth, budget, authorization, post visibility, and delegation policy remain outside Pi and must not be inferred from these flags.
