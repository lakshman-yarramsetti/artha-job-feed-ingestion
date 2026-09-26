# Scale analysis

This is a design analysis, not a laptop benchmark. The local implementation currently uses MongoDB polling workers and has not been benchmarked at production throughput.

## Traffic and storage assumptions

| Input                 | Calculation                | Result                          |
| --------------------- | -------------------------- | ------------------------------- |
| 100,000 events/day    | 100,000 / 86,400           | 1.16 events/sec average         |
| 10,000,000 events/day | 10,000,000 / 86,400        | 115.74 events/sec average       |
| Raw event retention   | 10,000,000 × 1 KB × 7 days | about 70 GB decimal raw payload |
| Job projections       | stated input               | about 1,000,000 documents       |

The 70 GB figure excludes BSON/document overhead, canonical replay data, attempt history, indexes, replica copies, free space, and backups. A practical capacity plan must measure representative document sizes and index ratios rather than treating 70 GB as disk provisioned.

## Burst capacity and drain time

A 5,000 events/sec burst is 43.2 million events if it lasts a full day; it cannot be reconciled with a 10 million events/day average without a stated duration. The following are explicit illustrative assumptions, not measured service claims:

- one worker process sustains 100 verified projection attempts/sec at a chosen provider latency budget;
- 60 worker processes therefore provide 6,000 attempts/sec;
- MongoDB is provisioned to sustain the matching indexed write rate.

At 6,000/sec, the system has 1,000/sec headroom and can sustain a 5,000/sec burst indefinitely under those assumptions. At a smaller 1,000/sec deployment, the deficit is 4,000/sec. A five-minute burst creates 1.2 million queued events. Once arrivals fall away, 1,000/sec of spare drain capacity clears that backlog in 1,200 seconds (20 minutes), missing the five-minute processing target. To clear that five-minute burst backlog in five minutes after the burst, capacity needs the normal arrival rate plus 4,000/sec of drain capacity, or roughly 5,000/sec total after the burst; a safety margin is still required.

The two-loop local configuration has no general throughput claim. The measured local load result is documented in `QC_REPORT.md`; production capacity requires representative provider latency and MongoDB measurements.

## MongoDB data and indexes

The current `events` collection needs its event-identity unique index for replay safety and a queue claim index for due pending or expired leases. The `jobs` collection needs a job-identity unique index and a tenant/status/pagination index. At 10 million daily events, historical event/attempt documents dominate storage, while the roughly one million projections are comparatively small.

Raw accepted events should have a seven-day TTL only if that retention boundary is compatible with replay semantics. Once an event expires, the service can no longer identify it as a replay or conflict. A safer production design may retain compact replay-identity records longer than full raw payloads.

Hot job identities are a write-contention risk because all versions target one projection document. Version ordering is correct under contention, but a single job cannot scale its projection writes horizontally. Track per-job contention and apply per-key ordering/rate limits when a producer generates pathological version storms.

For sharding, use a tenant-derived shard key, for example a hashed `tenantId` combined with identity fields. Unique indexes must include the shard key, so uniqueness remains `{ tenantId, sourceId, eventId }` for events and `{ tenantId, sourceId, externalJobId }` for jobs. Sharding improves tenant distribution but does not remove a single hot job's document-level contention.

## Backpressure and fairness

The API should enforce bounded request size, per-tenant rate limits, and a queue-age/queue-depth admission policy. At sustained overload, return a retryable admission response before MongoDB becomes saturated. A single global polling queue can let a noisy tenant monopolize worker claims; production scheduling should use tenant partitions, weighted fair selection, or per-tenant concurrency caps.

Retries amplify load during provider outages. The current exponential backoff and maximum attempts bound each event, but production should add jitter, provider-wide circuit breaking, retry budgets, and separate capacity for recovery work so retry storms do not starve new accepted events.

## Metrics and alerts

Track and alert on accepted events/sec, replay/conflict/validation response rates, queue depth, oldest pending age, lease-expiry reclaim count, verification latency, provider status counts, attempts per event, terminal failures, projection stale rate, MongoDB operation latency, replication lag, disk usage, index size, and cache pressure.

Alert on queue age approaching the five-minute target, sustained provider failure spikes, rapidly rising retry backlog, MongoDB saturation, or an unexpected increase in stale/version-conflict events.

## When to introduce a broker

Keep the current MongoDB queue while throughput is modest, operational simplicity is more valuable than independent queue scaling, and polling/index costs remain acceptable. Introduce Kafka or another broker when sustained burst buffering, independent consumer scaling, partitioned ordering, replay, and tenant fairness exceed what indexed MongoDB polling can provide. A broker does not remove the need for idempotent projection writes or durable retry/failure state; it moves the queueing boundary and introduces cross-system delivery semantics that must be designed explicitly.
