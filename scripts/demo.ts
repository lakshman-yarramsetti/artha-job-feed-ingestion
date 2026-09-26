import { readFile } from 'node:fs/promises';

type ScenarioRequest = { expectedStatus: number; body: Record<string, unknown> };
type Scenario = { phase1: ScenarioRequest[]; phase2: ScenarioRequest[] };

const baseUrl = process.env.BASE_URL ?? 'http://localhost:3000';
const timeoutMs = Number(process.env.DEMO_TIMEOUT_MS ?? 15_000);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function request(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${baseUrl}${path}`, init);
}

async function submit(entry: ScenarioRequest): Promise<void> {
  const response = await request('/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(entry.body),
  });
  if (response.status !== entry.expectedStatus) {
    throw new Error(
      `Expected ${entry.expectedStatus} for ${entry.body.eventId}, received ${response.status}: ${await response.text()}`,
    );
  }
}

async function waitForSettlement(entries: ScenarioRequest[]): Promise<void> {
  const accepted = entries.filter((entry) => entry.expectedStatus === 202);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const states = await Promise.all(
      accepted.map(async ({ body }) => {
        const response = await request(
          `/events/${encodeURIComponent(String(body.eventId))}?tenantId=${encodeURIComponent(String(body.tenantId))}&sourceId=${encodeURIComponent(String(body.sourceId))}`,
        );
        return response.ok
          ? ((await response.json()) as { status: string })
          : { status: 'missing' };
      }),
    );
    if (states.every((state) => state.status === 'completed' || state.status === 'failed')) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Timed out after ${timeoutMs}ms waiting for queue settlement`);
}

async function listAllJobs(
  tenantId: string,
  sourceId: string,
): Promise<Array<Record<string, unknown>>> {
  const jobs: Array<Record<string, unknown>> = [];
  let cursor: string | null = null;

  do {
    const query = new URLSearchParams({ tenantId, sourceId, status: 'all', limit: '100' });
    if (cursor !== null) query.set('cursor', cursor);
    const response = await request(`/jobs?${query}`);
    if (!response.ok) {
      throw new Error(`Could not list demo jobs: ${await response.text()}`);
    }
    const page = (await response.json()) as {
      items: Array<Record<string, unknown>>;
      nextCursor: string | null;
    };
    jobs.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== null);

  return jobs;
}

const scenario = JSON.parse(await readFile('fixtures/demo-scenario.json', 'utf8')) as Scenario;
assert(
  scenario.phase1.length + scenario.phase2.length === 20,
  'Demo fixture must contain 20 requests',
);

const health = await request('/health');
if (!health.ok) throw new Error(`Service is not ready: ${await health.text()}`);

for (const entry of scenario.phase1) await submit(entry);
await waitForSettlement(scenario.phase1);
for (const entry of scenario.phase2) await submit(entry);
await waitForSettlement(scenario.phase2);

const jobs = await listAllJobs('demo-tenant', 'main');
const byId = new Map(jobs.map((job) => [job.externalJobId, job]));
for (const [externalJobId, version] of [
  ['alpha', 4],
  ['beta', 3],
  ['gamma', 2],
] as const) {
  const job = byId.get(externalJobId);
  assert(
    job?.status === 'archived' && job.latestVersion === version,
    `Unexpected ${externalJobId} projection`,
  );
}
for (const externalJobId of ['delta', 'retry-job']) {
  assert(
    byId.get(externalJobId)?.status === 'active',
    `Expected active ${externalJobId} projection`,
  );
}
assert(!byId.has('failed-job'), 'A permanently failed event must not create a projection');

console.log(JSON.stringify({ result: 'passed', requests: 20, jobs: jobs.length }, null, 2));
