import { performance } from 'node:perf_hooks';

type EventBody = Record<string, unknown>;
type EventState = { status: 'pending' | 'processing' | 'completed' | 'failed' };

const baseUrl = process.env.BASE_URL ?? 'http://localhost:3000';
const concurrency = Number(process.env.LOAD_CONCURRENCY ?? 25);
const tenantId = process.env.LOAD_TENANT_ID ?? `load-tenant-${Date.now()}`;
const sourceId = 'load';
const drainTimeoutMs = Number(process.env.LOAD_DRAIN_TIMEOUT_MS ?? 600_000);
const expectedDistinctEvents = 1_000;
const expectedReplays = 200;
const expectedJobs = 900;
const orderedJobCount = 50;

function makeUpsert(eventId: string, externalJobId: string, version: number): EventBody {
  return {
    tenantId,
    sourceId,
    eventId,
    externalJobId,
    version,
    operation: 'upsert',
    payload: {
      title: `Load job ${externalJobId} v${version}`,
      company: 'Load Test',
      location: 'Surat',
      experienceMin: 1,
      experienceMax: 3,
      applyUrl: `https://example.test/jobs/${externalJobId}`,
      skills: ['TypeScript', 'MongoDB'],
    },
  };
}

async function post(body: EventBody): Promise<{ status: number; elapsedMs: number }> {
  const started = performance.now();
  const response = await fetch(`${baseUrl}/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, elapsedMs: performance.now() - started };
}

async function inPool<T>(items: T[], work: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (true) {
        const index = cursor++;
        if (index >= items.length) return;
        await work(items[index]!);
      }
    }),
  );
}

async function listAllJobs(): Promise<Array<{ externalJobId: string; latestVersion: number }>> {
  const result: Array<{ externalJobId: string; latestVersion: number }> = [];
  let cursor: string | null = null;
  do {
    const query = new URLSearchParams({ tenantId, sourceId, status: 'active', limit: '100' });
    if (cursor !== null) query.set('cursor', cursor);
    const response = await fetch(`${baseUrl}/jobs?${query}`);
    if (!response.ok) throw new Error(`Job listing failed: ${response.status}`);
    const page = (await response.json()) as {
      items: Array<{ externalJobId: string; latestVersion: number }>;
      nextCursor: string | null;
    };
    result.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== null);
  return result;
}

async function countTerminalEvents(eventIds: string[]): Promise<number> {
  let terminalCount = 0;
  await inPool(eventIds, async (eventId) => {
    const query = new URLSearchParams({ tenantId, sourceId });
    const response = await fetch(`${baseUrl}/events/${encodeURIComponent(eventId)}?${query}`);
    if (!response.ok) throw new Error(`Event lookup failed for ${eventId}: ${response.status}`);
    const event = (await response.json()) as EventState;
    if (event.status === 'completed' || event.status === 'failed') terminalCount += 1;
  });
  return terminalCount;
}

const health = await fetch(`${baseUrl}/health`);
if (!health.ok) throw new Error(`Service is not ready: ${health.status}`);

const distinct: EventBody[] = [];
for (let job = 0; job < orderedJobCount; job += 1) {
  for (const version of [3, 1, 2]) {
    distinct.push(makeUpsert(`load-ordered-${job}-v${version}`, `ordered-${job}`, version));
  }
}
for (let job = 0; distinct.length < expectedDistinctEvents; job += 1) {
  distinct.push(makeUpsert(`load-single-${job}`, `single-${job}`, 1));
}

const latencyMs: number[] = [];
const statuses = new Map<number, number>();
const startedAt = performance.now();
await inPool(distinct, async (body) => {
  const result = await post(body);
  latencyMs.push(result.elapsedMs);
  statuses.set(result.status, (statuses.get(result.status) ?? 0) + 1);
});

const replayBodies = Array.from({ length: expectedReplays }, (_, index) => distinct[index]!);
await inPool(replayBodies, async (body) => {
  const result = await post(body);
  latencyMs.push(result.elapsedMs);
  statuses.set(result.status, (statuses.get(result.status) ?? 0) + 1);
});

const submissionDurationMs = performance.now() - startedAt;
if (statuses.get(202) !== expectedDistinctEvents || statuses.get(200) !== expectedReplays) {
  throw new Error('Unexpected HTTP result counts: ' + JSON.stringify(Object.fromEntries(statuses)));
}

const drainStartedAt = performance.now();
const eventIds = distinct.map((event) => String(event.eventId));
let jobs: Array<{ externalJobId: string; latestVersion: number }> = [];
let terminalEventCount = 0;
let settled = false;
while (performance.now() - drainStartedAt < drainTimeoutMs) {
  [terminalEventCount, jobs] = await Promise.all([countTerminalEvents(eventIds), listAllJobs()]);
  const orderedCorrect = jobs
    .filter((job) => job.externalJobId.startsWith('ordered-'))
    .every((job) => job.latestVersion === 3);
  if (
    terminalEventCount === expectedDistinctEvents &&
    jobs.length === expectedJobs &&
    orderedCorrect
  ) {
    settled = true;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}

const queueDrainMs = performance.now() - drainStartedAt;
latencyMs.sort((left, right) => left - right);
const percentile = (value: number) => latencyMs[Math.ceil(latencyMs.length * value) - 1] ?? 0;
const orderedCorrect = jobs
  .filter((job) => job.externalJobId.startsWith('ordered-'))
  .every((job) => job.latestVersion === 3);
if (!settled) {
  throw new Error(
    `Load test did not settle within ${drainTimeoutMs}ms: terminal events=${terminalEventCount}/${expectedDistinctEvents}, jobs=${jobs.length}/${expectedJobs}, ordered correct=${orderedCorrect}`,
  );
}

console.log(
  JSON.stringify(
    {
      tenantId,
      concurrency,
      drainTimeoutMs,
      distinctEvents: expectedDistinctEvents,
      replayRequests: expectedReplays,
      statusCounts: Object.fromEntries(statuses),
      httpP50Ms: percentile(0.5),
      httpP95Ms: percentile(0.95),
      submissionDurationMs,
      queueDrainMs,
      terminalEventCount,
      finalJobCount: jobs.length,
      orderedVersionChecks: orderedJobCount,
    },
    null,
    2,
  ),
);
