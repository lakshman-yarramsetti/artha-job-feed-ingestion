# AI usage record

## Tool and scope

- Tool/model: Codex, GPT-5 family model as identified by the local Codex environment.
- Use: incremental design critique, TypeScript implementation, test design, documentation drafting, and command interpretation.
- Working method: code was produced phase by phase; the user reviewed each phase's command output before authorizing the next phase.

## Artifacts affected

AI-assisted work affected the application source, tests, Docker setup, fixtures, demo/load scripts, and documentation in this repository. Commit identifiers are kept in Git history and the submission email rather than embedded in this file, avoiding a self-referential final-commit amendment.

## Accepted and changed work

Accepted AI-assisted design choices include the MongoDB-backed `events` queue, claim-time attempt counting, conditional job projection writes, and canonical JSON replay comparison. The user requested changes when Docker/pnpm startup behavior and the demo response-body handling exposed defects; those changes were implemented and then independently checked with formatter, lint, TypeScript, tests, and build commands.

## Independent verification performed

- Phase 12 clean setup passed: after `docker compose down -v` and `docker compose up --build -d`, `/health` reported MongoDB ready.
- The 20-request demo passed with 5 final jobs.
- The load test accepted 1,000 distinct events plus 200 replays, reached 1,000 terminal events and 900 projections, and measured a 124,391.903 ms queue drain time. Its p50/p95 HTTP measurements were 68.72 ms / 122.987 ms on the recorded local environment.
- Formatter, lint, TypeScript, unit tests (13), real-MongoDB integration tests (9), and build all passed in the final run. The verbose integration run individually confirmed the worker-claim, lease-recovery, crash-after-projection, versioning, tombstone, and pagination cases.
- Commit identifiers are verified from `git log` and `git rev-parse HEAD` after the final documentation commit.
  No material defect is fabricated here. This record distinguishes checks actually run from work still pending.
