# Design: reliable job-feed ingestion

## Contract decisions

- Event identity is `(tenantId, sourceId, eventId)`; job identity is `(tenantId, sourceId, externalJobId)`. They solve separate problems and are never interchangeable.
- Archive events omit `payload`; the implementation rejects an archive containing a payload rather than silently ignoring it.
- For one job identity, only an event whose version is strictly greater than the successfully applied version can change the projection. Same-version events are completed as no-ops and cannot overwrite the first applied state.
- Required fields are validated while unknown JSON properties are retained in the canonical replay document. This avoids imposing an undocumented rejection rule while ensuring any added property changes replay content.

## Core invariants

1. An accepted valid event has exactly one durable `events` document and can be claimed from that document as durable queue work before `POST /events` returns `202`.
2. An invalid request creates no `events` document. Its event ID remains reusable after correction.
3. A repeated event identity with the same canonical parsed document returns `200`; a different canonical parsed document returns `409`; neither creates more work.
4. Event documents and job projections are always tenant- and source-scoped. No query looks up an event or job by an unscoped identifier.
5. `jobs.latestVersion` is the greatest version whose verification succeeded and whose conditional projection update won. A failed verification never changes a job.
6. A job projection changes only through an atomic conditional write requiring `incomingVersion > latestVersion` (or no existing projection). An archived projection is a versioned tombstone, not a deletion.
7. A queue event is owned by at most one worker lease at a time. Expired leases are eligible for another worker; queue state survives process restarts.
8. Provider attempts and failures are durably recorded. Normal provider-failure handling permits at most three claims/attempts, with increasing scheduled backoff for 429 and 503, and immediate terminal failure for 422.
9. Completion acknowledgement is idempotent. If a worker crashes after projection write and before queue completion, recovery can re-run the event, but the projection condition prevents a second logical job update.

## Collections and indexes

### `events`: durable acceptance log and queue

One event document serves as both the accepted-event record and the durable work item. Acceptance is a single MongoDB insert, eliminating a crash window between writing an event log and separately enqueueing work.

Each event stores identity and normalized fields, a canonical parsed body and SHA-256 body hash, queue status (`pending | processing | completed | failed`), lease metadata, attempt count/history, and the last error.

Indexes:

- unique `{ tenantId: 1, sourceId: 1, eventId: 1 }` for replay identity;
- `{ status: 1, nextAttemptAt: 1, leaseUntil: 1, acceptedAt: 1 }` for due and expired-lease claims.

### `jobs`: current projection

One document exists per job identity and stores `latestVersion`, status (`active | archived`), normalized upsert payload when active, and `updatedAt`.

Indexes:

- unique `{ tenantId: 1, sourceId: 1, externalJobId: 1 }` for projection/tombstone identity;
- `{ tenantId: 1, status: 1, updatedAt: -1, sourceId: 1, externalJobId: 1 }` for tenant-scoped listing and cursor pagination.

## Acceptance and replay boundary

The request handler fully parses and validates before touching MongoDB, so invalid identifiers are never reserved. It derives canonical JSON from the parsed request body, sorting object keys recursively while retaining array order.

For valid input, a scoped existing event is compared by canonical body: equal content returns `200`; different content returns `409`. New work is inserted in `pending` state and only then returns `202`. A concurrent duplicate-key error is resolved by rereading the scoped event and applying the same comparison. This makes concurrent identical submissions one accepted event and one replay, while concurrent conflicting submissions produce one `202` and one `409`.

This is exactly-once acceptance per event identity, not exactly-once execution. Worker execution is intentionally at-least-once because a process can fail after an external call or projection write.

## Worker lifecycle and leases

Two independently identified worker loops compete for the same `events` collection. An atomic `findOneAndUpdate` claims due `pending` work or expired `processing` work, sets a lease, and increments the attempt count. The prior state is part of the filter, so exactly one concurrent worker wins a claim.

An attempt is recorded at claim time. A crash immediately after claiming therefore consumes an attempt: otherwise repeated crashes could create unbounded abandoned claims without reaching the retry limit. Lease recovery makes the event eligible again and records a new history entry. The normal cap remains three total attempts, including the first.

Processing sequence:

1. Atomically claim due or abandoned work and record the attempt.
2. Read the current scoped job. If `latestVersion >= event.version`, complete the event as a stale no-op without provider verification.
3. Verify a non-stale event using the fixture-driven provider plan.
4. On success, conditionally apply the projection only when its stored version is lower. A duplicate-key first-write race is retried as the same conditional update, which either applies or is stale.
5. Mark the event completed. For 429/503, reschedule it with increasing configurable backoff unless attempts are exhausted. For 422 or exhausted retryable failure, mark it terminally failed with a useful error and attempt history.

The stale read is an optimization; the conditional projection write is the actual concurrency boundary.

## Failure behavior

| Failure point                                             | Durable result                                        | Recovery behavior                                                                                     |
| --------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Before event insert                                       | no acceptance                                         | request has not received `202`; retry is safe                                                         |
| After event insert, before `202`                          | pending event may exist                               | caller retry receives `200` for the same body; worker still processes it                              |
| After claim, before provider/projection                   | processing lease expires                              | another worker reclaims it; the original claim counts as an attempt                                   |
| Provider retryable failure                                | pending event with future `nextAttemptAt` and history | later worker retries without busy-looping                                                             |
| Provider permanent/exhausted failure                      | terminal failed event with history                    | projection remains unchanged; a later higher version can succeed                                      |
| After projection write, before completion acknowledgement | projection updated, event lease eventually expires    | recovery classifies the same version as stale and completes without another logical projection update |
| Completion acknowledgement failure                        | projection may already be valid                       | lease recovery remains idempotent through the version condition                                       |

The implementation cannot promise exactly-once external provider side effects across a crash after an external call. A real side-effecting provider needs an idempotency key or outbox-style integration.

## Alternatives outside the runnable core

- **Separate `work_items` collection without transactions:** a crash between event insertion and work insertion violates durable acceptance. A MongoDB transaction solves it but requires a replica set and increases local setup complexity.
- **Redis/BullMQ:** provides queue ergonomics but introduces another durable system and a cross-store atomicity boundary.
- **Kafka:** supports high-throughput replayable streams but its operational cost and projection/idempotency work are disproportionate for this focused local implementation.

## Verification coverage

Real-MongoDB integration coverage verifies unique-index replay/conflict races, tenant/source isolation, competing claims, lease recovery, concurrent version writes, archive tombstones, crash-after-projection recovery, and pagination. `QC_REPORT.md` contains the final command results and measured demo/load evidence.

## Production tenancy, bottleneck, and scope trade-off

`tenantId` is trusted demo input. In production, authentication establishes an authorized tenant context server-side; the API rejects or ignores a caller-supplied tenant ID that disagrees with that context. Database filters retain the authorized tenant ID as defense in depth, with roles controlling allowed source IDs and read/write permissions.

The first expected bottleneck is MongoDB queue claiming and hot job identities: workers can scan due work and contend on one popular projection document. The implementation uses supporting indexes, bounded polling, leases, and backoff, but deliberately omits sophisticated tenant scheduling and a broker. The single-collection queue/polling design is the explicit eight-hour trade-off: it is compact to explain and test while retaining durable recovery semantics.
