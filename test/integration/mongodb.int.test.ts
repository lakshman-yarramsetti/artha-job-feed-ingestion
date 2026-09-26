import { randomUUID } from 'node:crypto';

import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { canonicalizeJson } from '../../src/domain/canonical-json.js';
import { decodeJobCursor, encodeJobCursor } from '../../src/domain/job-cursor.js';
import { validateEvent } from '../../src/domain/event.js';
import {
  createMongoEventRepository,
  type StoredEvent,
} from '../../src/repositories/event-repository.js';
import { createMongoJobRepository } from '../../src/repositories/job-repository.js';

const mongoUri = process.env.MONGODB_URI ?? 'mongodb://localhost:27017';
const databaseName = `artha_integration_${randomUUID().replaceAll('-', '')}`;
const now = new Date('2026-01-01T00:00:00.000Z');

const client = new MongoClient(mongoUri);
const events = createMongoEventRepository(client, databaseName);
const jobs = createMongoJobRepository(client, databaseName);

function upsertEvent(overrides: Record<string, unknown> = {}) {
  const raw = {
    tenantId: 'tenant-a',
    sourceId: 'main',
    eventId: 'event-1',
    externalJobId: 'job-1',
    version: 1,
    operation: 'upsert',
    payload: {
      title: 'Developer',
      company: 'Example Labs',
      location: 'Surat',
      experienceMin: 1,
      experienceMax: 3,
      applyUrl: 'https://example.test/jobs/job-1',
      skills: ['TypeScript'],
    },
    ...overrides,
  };
  const parsed = validateEvent(raw);
  if (!parsed.success) throw new Error(JSON.stringify(parsed.issues));
  return { raw, event: parsed.event };
}

function archiveEvent(overrides: Record<string, unknown> = {}) {
  const raw = {
    tenantId: 'tenant-a',
    sourceId: 'main',
    eventId: 'event-archive',
    externalJobId: 'job-1',
    version: 1,
    operation: 'archive',
    ...overrides,
  };
  const parsed = validateEvent(raw);
  if (!parsed.success) throw new Error(JSON.stringify(parsed.issues));
  return { raw, event: parsed.event };
}

async function accept(raw: unknown, event: ReturnType<typeof upsertEvent>['event']) {
  const canonical = canonicalizeJson(raw);
  return events.accept({
    event,
    canonicalBody: canonical.body,
    bodyHash: canonical.sha256,
    acceptedAt: now,
  });
}

async function claim(event: StoredEvent, workerId: string): Promise<StoredEvent> {
  const claimed = await events.claimNext(workerId, now, 1_000);
  expect(claimed?.eventId).toBe(event.eventId);
  return claimed as StoredEvent;
}

describe('MongoDB integration: durability, queueing, and version safety', () => {
  beforeAll(async () => {
    await client.connect();
  });

  beforeEach(async () => {
    await client.db(databaseName).dropDatabase();
    await Promise.all([events.ensureIndexes(), jobs.ensureIndexes()]);
  });

  afterAll(async () => {
    await client.db(databaseName).dropDatabase();
    await client.close();
  });

  it('uses the unique index to make concurrent identical acceptance one event and one replay', async () => {
    const { raw, event } = upsertEvent();
    const outcomes = await Promise.all([accept(raw, event), accept(raw, event)]);

    expect(outcomes.sort()).toEqual(['accepted', 'replayed']);
    expect(await client.db(databaseName).collection('events').countDocuments()).toBe(1);
  });

  it('returns conflict for concurrent different content under one event identity', async () => {
    const first = upsertEvent();
    const different = upsertEvent({ payload: { ...first.raw.payload, title: 'Different title' } });
    const outcomes = await Promise.all([
      accept(first.raw, first.event),
      accept(different.raw, different.event),
    ]);

    expect(outcomes).toContain('accepted');
    expect(outcomes).toContain('conflict');
    expect(await client.db(databaseName).collection('events').countDocuments()).toBe(1);
  });

  it('keeps event identities isolated by tenant and source', async () => {
    const tenantA = upsertEvent();
    const tenantB = upsertEvent({ tenantId: 'tenant-b' });
    const otherSource = upsertEvent({ sourceId: 'secondary' });

    await expect(accept(tenantA.raw, tenantA.event)).resolves.toBe('accepted');
    await expect(accept(tenantB.raw, tenantB.event)).resolves.toBe('accepted');
    await expect(accept(otherSource.raw, otherSource.event)).resolves.toBe('accepted');
    expect(await client.db(databaseName).collection('events').countDocuments()).toBe(3);
  });

  it('allows only one of two concurrent workers to claim an event', async () => {
    const { raw, event } = archiveEvent();
    await accept(raw, event);

    const [left, right] = await Promise.all([
      events.claimNext('worker-left', now, 1_000),
      events.claimNext('worker-right', now, 1_000),
    ]);
    const winner = left ?? right;

    expect(winner).not.toBeNull();
    expect([left, right].filter((value) => value !== null)).toHaveLength(1);
    expect(winner?.attemptCount).toBe(1);
  });

  it('recovers a lease abandoned by a stopped worker and consumes another attempt', async () => {
    const { raw, event } = archiveEvent();
    await accept(raw, event);
    const firstClaim = await claim(event as StoredEvent, 'worker-a');

    const recovered = await events.claimNext('worker-b', new Date(now.getTime() + 1_001), 1_000);
    expect(recovered?.eventId).toBe(event.eventId);
    expect(recovered?.attemptCount).toBe(2);
    expect(recovered?.claimedBy).toBe('worker-b');

    await expect(
      events.completeClaim(
        recovered as StoredEvent,
        'worker-b',
        new Date(now.getTime() + 1_002),
        'completed',
      ),
    ).resolves.toBe(true);
    const summary = await events.findSummary(event.tenantId, event.sourceId, event.eventId);
    expect(summary).toMatchObject({ status: 'completed', attemptCount: 2 });
    expect(firstClaim.claimedBy).toBe('worker-a');
  });

  it('keeps the greatest successfully applied version despite concurrent projection writes', async () => {
    const versionTwo = upsertEvent({ eventId: 'v2', version: 2 });
    const versionThree = upsertEvent({ eventId: 'v3', version: 3 });
    const storedTwo = { ...versionTwo.event, canonicalBody: '{}', bodyHash: '2' } as StoredEvent;
    const storedThree = {
      ...versionThree.event,
      canonicalBody: '{}',
      bodyHash: '3',
    } as StoredEvent;

    await Promise.all([jobs.apply(storedTwo, now), jobs.apply(storedThree, now)]);
    const listed = await jobs.list({
      tenantId: 'tenant-a',
      status: 'all',
      limit: 10,
      cursor: null,
    });

    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ latestVersion: 3, status: 'active' });
  });

  it('preserves an archive tombstone against a delayed older upsert', async () => {
    const archive = archiveEvent({ version: 5 });
    const oldUpsert = upsertEvent({ eventId: 'old-upsert', version: 4 });

    await jobs.apply(
      { ...archive.event, canonicalBody: '{}', bodyHash: 'archive' } as StoredEvent,
      now,
    );
    await jobs.apply(
      { ...oldUpsert.event, canonicalBody: '{}', bodyHash: 'old' } as StoredEvent,
      now,
    );
    const listed = await jobs.list({
      tenantId: 'tenant-a',
      status: 'all',
      limit: 10,
      cursor: null,
    });

    expect(listed[0]).toMatchObject({ latestVersion: 5, status: 'archived' });
    expect(listed[0]?.payload).toBeUndefined();
  });

  it('recovers after projection write before acknowledgement without a second logical job update', async () => {
    const { raw, event } = upsertEvent({ version: 7 });
    await accept(raw, event);
    const firstClaim = await claim(event as StoredEvent, 'worker-a');
    await jobs.apply(firstClaim, now);

    const recovered = await events.claimNext('worker-b', new Date(now.getTime() + 1_001), 1_000);
    expect(recovered?.attemptCount).toBe(2);
    expect(await jobs.latestVersion(recovered as StoredEvent)).toBe(7);
    await events.completeClaim(
      recovered as StoredEvent,
      'worker-b',
      new Date(now.getTime() + 1_002),
      'stale',
    );

    const listed = await jobs.list({
      tenantId: 'tenant-a',
      status: 'all',
      limit: 10,
      cursor: null,
    });
    const summary = await events.findSummary(event.tenantId, event.sourceId, event.eventId);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ latestVersion: 7, status: 'active' });
    expect(summary).toMatchObject({ status: 'completed', attemptCount: 2 });
  });

  it('returns deterministic pagination boundaries', async () => {
    for (const [index, externalJobId] of ['job-a', 'job-b', 'job-c'].entries()) {
      const event = upsertEvent({ eventId: `page-${index}`, externalJobId, version: 1 });
      await jobs.apply(
        { ...event.event, canonicalBody: '{}', bodyHash: externalJobId } as StoredEvent,
        new Date(now.getTime() - index * 1_000),
      );
    }

    const first = await jobs.list({ tenantId: 'tenant-a', status: 'all', limit: 2, cursor: null });
    const cursor = encodeJobCursor({
      updatedAt: first[1]!.updatedAt,
      sourceId: first[1]!.sourceId,
      externalJobId: first[1]!.externalJobId,
    });
    const second = await jobs.list({
      tenantId: 'tenant-a',
      status: 'all',
      limit: 2,
      cursor: decodeJobCursor(cursor),
    });

    expect(first.map((job) => job.externalJobId)).toEqual(['job-a', 'job-b']);
    expect(second.map((job) => job.externalJobId)).toEqual(['job-c']);
  });
});
