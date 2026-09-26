# QC report — Phase 12 final evidence

## Environment

- Host: `DESKTOP-RHLN6I0` (Dell Latitude 7490; 8 logical processors; about 8.4 GB RAM)
- Node.js: `v24.16.0`
- pnpm: `11.25.0`
- Docker Engine: `29.8.0`; Docker Compose: `v5.5.1`
- Local services: a fresh `docker compose down -v` followed by `docker compose up --build -d`; `/health` reported `status: ready, mongo: ready`.

## Final verification run

| Check                   | Actual result                                               |
| ----------------------- | ----------------------------------------------------------- |
| `pnpm format:check`     | passed                                                      |
| `pnpm lint`             | passed                                                      |
| `pnpm typecheck`        | passed                                                      |
| `pnpm test:unit`        | 5 files, 13 tests passed                                    |
| `pnpm test:integration` | 1 file, 9 real-MongoDB tests passed                         |
| `pnpm build`            | passed                                                      |
| `pnpm demo`             | passed: `{ "result": "passed", "requests": 20, "jobs": 5 }` |

The demo was run against a fresh Compose MongoDB volume. First-seen valid event requests are accepted with `202`; the scenario's intentional exact replay requests correctly receive `200`.

## Measured local load run

`pnpm test:load` was run against the fresh local service with `LOAD_DRAIN_TIMEOUT_MS=600000` (ten minutes). The script's timestamped load tenant prevents collision with the demo fixture.

| Measurement                  |        Actual result |
| ---------------------------- | -------------------: |
| Distinct valid events        |                1,000 |
| Exact replay requests        |                  200 |
| HTTP status counts           | 202: 1,000; 200: 200 |
| HTTP p50                     |             68.72 ms |
| HTTP p95                     |           122.987 ms |
| Submission duration          |        3,607.4294 ms |
| Queue drain time             |       124,391.903 ms |
| Terminal events              |                1,000 |
| Final active job projections |                  900 |
| Ordered-version checks       |                   50 |

These are one local-machine measurement, not a production capacity claim. The drain time is measured when all expected events are terminal and all 900 expected projections are present, rather than reporting the configured timeout.

## Failure hypotheses challenged

1. **Two workers could both claim one work item.** The verbose real-MongoDB integration run passed `allows only one of two concurrent workers to claim an event`. It concurrently calls `claimNext` from two worker identities and asserts exactly one non-null claim with attempt count 1.
2. **A crash after projection write but before acknowledgement could create another logical update.** The same verbose run passed `recovers after projection write before acknowledgement without a second logical job update`. It writes version 7, lets the first lease expire, reclaims with a second worker, confirms the projection remains version 7, completes as stale, and asserts one projection plus a completed event at attempt count 2.
3. **A provider failure could alter the projection or retry forever.** Unit verification passed all five provider-processor cases, including immediate `422` terminal failure, third-attempt retry exhaustion, increasing retry backoff, and stale work skipping provider verification. The clean 20-request demo also passed its fixture-driven failure and retry cases while ending with only five expected jobs.
4. **Documentation could promise behavior different from the code.** This report was compared with `scripts/load-test.ts`, which defaults `LOAD_DRAIN_TIMEOUT_MS` to 600,000 ms and settles only at 1,000 terminal events, 900 projections, and correct ordered versions. README's cursor description matches `job-repository.ts`: `updatedAt DESC`, then `sourceId ASC`, then `externalJobId ASC`; its provider maximum-attempt claim matches `environment.ts` default of 3 and the processor unit test. No throughput figure in `SCALE.md` is presented as this laptop result.

## Delivery context

- Reported focused time: approximately **7 hours**, including design review, implementation, Docker/environment troubleshooting, and final QC.
- The submitted revision is identified by the repository Git history and the commit SHA supplied with the submission.
