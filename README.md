# Artha.link job-feed ingestion service

This service accepts versioned job-feed events, records accepted work durably in MongoDB, processes it asynchronously with two competing worker loops, and exposes current job state and event status.

## Requirements

- Node.js 22+
- Docker Compose

## Setup

```powershell
pnpm install --frozen-lockfile
docker compose up --build -d
```

The API listens at `http://localhost:3000`. Confirm readiness with:

```powershell
Invoke-RestMethod http://localhost:3000/health
```

## Commands

```powershell
pnpm check
pnpm test:unit
pnpm test:integration
pnpm demo
pnpm test:load
```

`pnpm demo` expects a clean demo dataset because the fixture uses fixed event IDs. For a local reset, this removes the Compose MongoDB volume:

```powershell
docker compose down -v
docker compose up --build -d
pnpm demo
```

The load test generates its own timestamped tenant ID and does not require a reset.

## Measured local verification

The final clean local run completed the 20-request demo with 5 jobs. The load run accepted 1,000 distinct events and 200 exact replays (`202: 1,000`, `200: 200`), reached 1,000 terminal events and 900 final projections, and verified 50 out-of-order job histories. On `DESKTOP-RHLN6I0` (Dell Latitude 7490, 8 logical processors, about 8.4 GB RAM; Node `v24.16.0`; Docker `29.8.0`), HTTP p50/p95 were 68.72 ms / 122.987 ms and measured queue drain time was 124,391.903 ms. This is a local measurement, not a production performance guarantee. Full evidence is in `QC_REPORT.md`.

## API

- `POST /events` accepts one event and returns `202` only after MongoDB acknowledges durable persistence. Replays with the same parsed JSON return `200`; conflicting reuse of an event ID returns `409`.
- `GET /jobs?tenantId=...&sourceId=...&status=active&limit=20&cursor=...` lists current projections. `status` supports `active`, `archived`, and `all`.
- `GET /events/:eventId?tenantId=...&sourceId=...` returns acceptance/processing status, attempts, and last error.
- `GET /health` returns `200` only when MongoDB is reachable; it returns `503` when MongoDB is unavailable.

Pagination is forward-only, sorted by `updatedAt DESC`, `sourceId ASC`, then `externalJobId ASC`. It is not a transactionally frozen snapshot: changes between page requests can move an item to a different later page.

## Known limitations

- The assignment PDF references a supplied 20-request fixture scenario, but no separate fixture file was included in the assignment email (only the PDF itself). I built a synthetic fixture (`fixtures/demo-scenario.json`) that matches the documented scenario characteristics (invalid inputs, replays, tenant/source collisions, stale changes, failures) as closely as possible from the spec's description. Replace it with the actual supplied fixture before submission if it becomes available.
- The fake provider plan is loaded at process start; changing `fixtures/provider-plan.json` requires an app restart.
- Queue polling and the single `events` collection are deliberate local-build trade-offs. They are not the recommended final architecture for high-volume production traffic.
- Worker execution is at-least-once. The conditional projection write prevents duplicate logical job state, but an external provider with side effects would need an idempotency key or outbox-style integration.
- The load test waits until all 1,000 events are terminal and all 900 expected projections are present, with a configurable `LOAD_DRAIN_TIMEOUT_MS` (default: 600,000 ms). This corrects the earlier fixed-duration wait, which could report an incomplete queue as a final-state failure.
- Reported focused time spent: approximately 7 hours, including design review, implementation, Docker/environment troubleshooting, and final QC.
- The repository has no Git commit yet. Create meaningful progress commits and record the final SHA before submission.

## Submission checklist

- Replace the synthetic demo fixture if the supplied fixture is located.

- Add the final Git SHA to the documentation.
