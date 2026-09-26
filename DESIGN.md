# Design: reliable job-feed ingestion

## Phase 1 status

This is the initial design note written before implementation. It records the invariants the code and tests must preserve. Operational observations, exact commands, and final trade-offs will be completed only after they have been implemented and measured.

## Requirements clarifications from the assignment

- Event identity is `(tenantId, sourceId, eventId)`; job identity is `(tenantId, sourceId, externalJobId)`. They solve separate problems and are never interchangeable.
- The PDF says an archive **omits** `payload`. I will therefore validate an archive with a present `payload` as invalid, rather than silently ignore it. This is stricter than the build prompt's "no payload is expected/required" phrasing, so the PDF governs this choice.
- The PDF also asks us to document same-job, same-version conflicting content. It is outside the fixture contract. The runnable rule will be deterministic: successful processing only replaces a job when `event.version > job.latestVersion`; another event at the same version is a no-op and cannot overwrite the first applied state. We will surface this through the event's completed no-op state and document that a production system could additionally quarantine/alert on a semantic-version conflict.
- The specification does not require unknown JSON properties to be rejected. We will validate all required fields and retain the whole parsed JSON document for replay comparison. This avoids inventing a stricter contract while ensuring an added property makes a replay different content.

## Core invariants

1. An accepted valid event has exactly one durable `events` document and can be claimed from that document as durable queue work before `POST /events` returns `202`.
2. An invalid request creates no `events` document. Its event ID is reusable after correction.
3. A repeated event identity with the same canonical parsed document returns `200`; a different canonical parsed document returns `409`; neither makes more work.
4. Event documents and job projections are always tenant- and source-scoped. No query may look up an event or job by an unscoped identifier.
5. `jobs.latestVersion` is the greatest version whose verification succeeded and whose conditional projection update won. A failed verification never changes a job.
6. A job projection can only change through an atomic conditional write requiring `incomingVersion > latestVersion` (or no existing projection). An archived projection is a tombstone with a version, not a deletion.
7. A queue event is owned by at most one worker lease at a time. Expired leases are eligible for another worker; queue state survives process restarts.
8. Provider attempts and failures are durably recorded. Normal provider-failure handling permits at most three claims/attempts, with increasing scheduled backoff for 429 and 503, and immediate terminal failure for 422.
9. Completion acknowledgement is idempotent. If a worker crashes after projection write and before queue completion, recovery can re-run the event, but the projection conditional prevents a second logical job update.

## Proposed collections and indexes

### `events` - durable log and durable queue

Rather than split `events` and `work_items`, one event document serves both roles. This gives acceptance a single durable MongoDB insert: there is no crash window between writing an event log record and separately enqueueing its work item.

Key fields will include:

- identity fields and the validated, normalized event fields;
- `canonicalBody` and a SHA-256 `bodyHash` for replay comparison (object keys sorted recursively; arrays retain order);
- work state: `pending | processing | completed | failed`, `nextAttemptAt`, `claimedBy`, `leaseUntil`;
- `attemptCount`, `attemptHistory`, and `lastError`.

Indexes:

- unique `{ tenantId: 1, sourceId: 1, eventId: 1 }` - replay identity;
- queue-claim support `{ status: 1, nextAttemptAt: 1, leaseUntil: 1, tenantId: 1, sourceId: 1 }` (the exact key order may be adjusted after observing the claim query);
- event lookup `{ tenantId: 1, sourceId: 1, eventId: 1 }` is covered by the unique index.

### `jobs` - current projection

One document per job identity, containing `latestVersion`, `status: active | archived`, the normalized upsert payload when active, and `updatedAt`.

Indexes:

- unique `{ tenantId: 1, sourceId: 1, externalJobId: 1 }` - one projection/tombstone per logical job;
- pagination index to be finalized with the cursor sort, likely `{ tenantId: 1, sourceId: 1, status: 1, updatedAt: -1, externalJobId: 1 }`.

## Acceptance and replay boundary

The request handler will fully parse and validate first. Only valid input reaches replay lookup/insert, so invalid IDs are never reserved. It computes the canonical form from the parsed request body, not from normalized fields: this implements the assignment's comparison of parsed JSON documents, ignoring object-key order but preserving array order.

For a valid request, it checks the unique event identity first. If it exists, it compares `canonicalBody`: equal returns `200`; different returns `409`. If absent, it inserts an `events` document already in `pending` state and then returns `202`. Concurrent inserts are resolved by the unique index: after duplicate-key error, re-read the existing scoped event and apply the same canonical comparison. This makes concurrent identical submissions one accepted event and concurrent conflicting submissions one `202` plus one `409`.

This is exactly-once _acceptance per event identity_, not exactly-once execution. Worker processing is intentionally at-least-once because a process may die after an external call or a projection write.

## Worker lifecycle and leases

At least two independently identified worker loops will run against the same `events` collection. A claim uses one atomic `findOneAndUpdate`, selecting either due `pending` work or expired `processing` work, and changing it to `processing` with a lease and incremented attempt count. It must require the old state in its filter, so only one worker wins.

The worker records an attempt when it claims. Therefore, a worker crash after a successful claim consumes an attempt. This is a deliberate bounded-work choice: otherwise repeated crashes could spend unbounded provider calls without ever reaching retry exhaustion. Lease recovery makes the event eligible again; its next claim receives a new attempt-history entry. The normal provider-failure cap remains three total attempts, including the first.

Processing sequence:

1. Atomically claim a due or abandoned event and record the attempt.
2. Read the current scoped job. If its `latestVersion >= event.version`, complete the event as a stale no-op without provider verification.
3. Otherwise execute the fixture-driven provider verification.
4. For success, atomically apply the projection only if its current version is lower than the event version. A first-write race may produce a duplicate-key error; retry the same conditional update, at which point it either applies or is correctly stale.
5. Mark the event completed. For 429/503, schedule a later `pending` attempt with increasing configurable backoff unless attempts are exhausted. For 422, or exhausted retryable failure, mark it terminally `failed` with a useful error and complete history.

The stale check is only an optimization. The conditional projection write is the actual correctness boundary and is required even after a non-stale read, because another worker can finish a higher version in between.

## Failure matrix

| Failure point                                             | Durable result                                        | Recovery/correctness behavior                                                                                                 |
| --------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Before event insert                                       | no acceptance                                         | request has not received `202`; retry is safe                                                                                 |
| After event insert, before `202`                          | pending event may exist                               | caller retry gets `200` if same body; worker still processes it                                                               |
| After claim, before provider/projection                   | processing lease expires                              | another worker reclaims it; the original claim counts as an attempt                                                           |
| Provider retryable failure                                | pending event with future `nextAttemptAt` and history | later worker retries; no busy loop                                                                                            |
| Provider permanent/exhausted failure                      | terminal failed event with history                    | projection remains unchanged; later higher event may still succeed                                                            |
| After projection write, before completion acknowledgement | projection updated, event lease eventually expires    | recovery sees same/lower version as stale, makes no logical projection change, and completes the event                        |
| Completion acknowledgement failure                        | projection may already be valid                       | lease recovery is idempotent via version condition; provider work could be repeated only if recovery cannot classify it stale |

The design cannot promise exactly-once external provider side effects across a crash after an external call. The fixture verifier is safe for this assignment; a real side-effecting provider would need an idempotency key/outbox-style integration.

## Alternatives rejected for the runnable core

- **Separate `work_items` collection without transactions:** a crash between event insertion and work insertion violates durable acceptance. A MongoDB transaction would solve it, but requiring a replica set raises local setup complexity. Storing queue state in `events` gives a single-document acceptance boundary.
- **Redis/BullMQ:** excellent queue ergonomics, but adds an additional durable system and cross-store atomicity problem. It is expressly outside the runnable-core scope.
- **Kafka:** useful for high-throughput replayable streams, but its operational cost and projection/idempotency work are disproportionate for an eight-hour local assignment; it belongs in the scale discussion, not the core.

## Risks to prove with integration tests

- unique-index races during concurrent identical and conflicting acceptance;
- two workers racing to claim one document and an expired lease being reclaimed;
- version write races, archive-before-upsert, and stale delayed work;
- crash after projection before acknowledgement;
- persistence across API/worker restart.

## Production tenancy note

`tenantId` is trusted demo input only. In production, authentication would establish an authorized tenant context server-side; the API would reject or ignore a caller-supplied tenant ID that disagrees with that context. Every database filter would still include the authorized tenant ID as defense in depth, with roles determining allowed source IDs and read/write permissions.

## Expected first bottleneck and budget trade-off

The first likely bottleneck is MongoDB queue claiming and hot job identities: many workers repeatedly scanning due work or contending on one popular job projection. We will use supporting indexes, bounded batch/poll behavior, leases, and backoff, but will not build sophisticated tenant scheduling or a broker in the initial version. The deliberate eight-hour trade-off is a single-collection durable queue and polling workers: it is simpler to explain and test than a separate broker, while retaining the required recovery semantics.

## Implemented collection details

The current implementation uses `events` as both durable acceptance log and queue. Its indexes are the unique event identity `{ tenantId, sourceId, eventId }` and queue-claim support `{ status, nextAttemptAt, leaseUntil, acceptedAt }`. An accepted event stores `canonicalBody`, `bodyHash`, normalized fields, status, lease details, attempt count/history, and last error.

`jobs` has unique job identity `{ tenantId, sourceId, externalJobId }` plus `{ tenantId, status, updatedAt: -1, sourceId, externalJobId }` for listing. The cursor contains the full sort tie-breaker `(updatedAt, sourceId, externalJobId)`. Job listing is forward-only and not a frozen snapshot.

Workers complete events only after provider verification and conditional projection application. Retry/failure/complete transitions require the active event lease's worker identity. A stale event skips provider verification when a stored projection has an equal or newer version; the conditional job update remains the race-safety boundary.

## Verified-to-date evidence

Separate real-Mongo integration coverage passed for replay uniqueness, conflicting reuse, tenant/source isolation, competing claims, lease recovery, concurrent version writes, archive tombstones, crash-after-projection recovery, and pagination. `QC_REPORT.md` contains the completed final-QC evidence and measured local demo/load results.
