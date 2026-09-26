import { describe, expect, it } from 'vitest';

import type { StoredEvent } from '../../src/repositories/event-repository.js';
import type { JobRepository } from '../../src/repositories/job-repository.js';
import { createProviderEventProcessor } from '../../src/workers/provider-event-processor.js';

function event(attemptCount: number): StoredEvent {
  return {
    tenantId: 'tenant-a',
    sourceId: 'main',
    eventId: 'event-1',
    externalJobId: 'job-1',
    version: 1,
    operation: 'archive',
    canonicalBody: '{}',
    bodyHash: 'hash',
    status: 'processing',
    attemptCount,
    attemptHistory: [],
    lastError: null,
    nextAttemptAt: new Date('2026-01-01T00:00:00.000Z'),
    claimedBy: 'worker-1',
    leaseUntil: new Date('2026-01-01T00:00:30.000Z'),
    acceptedAt: new Date('2026-01-01T00:00:00.000Z'),
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  };
}

function jobs(overrides: Partial<JobRepository> = {}): JobRepository {
  return {
    ensureIndexes: async () => {},
    latestVersion: async () => null,
    apply: async () => 'applied',
    list: async () => [],
    ...overrides,
  };
}

describe('provider event processor', () => {
  it('schedules increasing backoff for a retryable provider failure', async () => {
    const calls: unknown[][] = [];
    const processor = createProviderEventProcessor(
      {
        rescheduleClaim: async (...args) => {
          calls.push(args);
          return true;
        },
        failClaim: async () => true,
      },
      jobs(),
      { verify: async () => '503' },
      {
        workerId: 'worker-1',
        maximumAttempts: 3,
        backoffMs: 100,
        now: () => new Date('2026-01-01T00:00:00.000Z'),
      },
    );

    await expect(processor(event(2))).resolves.toBe('deferred');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[2]).toEqual(new Date('2026-01-01T00:00:00.200Z'));
    expect(calls[0]?.[3]).toBe('Provider verification returned 503');
  });

  it('fails retryable work after the third claimed attempt', async () => {
    const errors: string[] = [];
    const processor = createProviderEventProcessor(
      {
        rescheduleClaim: async () => true,
        failClaim: async (_event, _workerId, error) => {
          errors.push(error);
          return true;
        },
      },
      jobs(),
      { verify: async () => '429' },
      { workerId: 'worker-1', maximumAttempts: 3, backoffMs: 100 },
    );

    await expect(processor(event(3))).resolves.toBe('deferred');
    expect(errors).toEqual(['Provider verification returned 429; retry attempts exhausted']);
  });

  it('fails a 422 immediately without scheduling a retry', async () => {
    let scheduled = false;
    const errors: string[] = [];
    const processor = createProviderEventProcessor(
      {
        rescheduleClaim: async () => {
          scheduled = true;
          return true;
        },
        failClaim: async (_event, _workerId, error) => {
          errors.push(error);
          return true;
        },
      },
      jobs(),
      { verify: async () => '422' },
      { workerId: 'worker-1', maximumAttempts: 3, backoffMs: 100 },
    );

    await expect(processor(event(1))).resolves.toBe('deferred');
    expect(scheduled).toBe(false);
    expect(errors).toEqual(['Provider verification returned 422']);
  });

  it('skips provider verification for a stale event', async () => {
    let verified = false;
    const processor = createProviderEventProcessor(
      { rescheduleClaim: async () => true, failClaim: async () => true },
      jobs({ latestVersion: async () => 1 }),
      {
        verify: async () => {
          verified = true;
          return 'success';
        },
      },
      { workerId: 'worker-1', maximumAttempts: 3, backoffMs: 100 },
    );

    await expect(processor(event(1))).resolves.toBe('stale');
    expect(verified).toBe(false);
  });

  it('applies a verified event through the conditional job projection', async () => {
    let applied = false;
    const processor = createProviderEventProcessor(
      { rescheduleClaim: async () => true, failClaim: async () => true },
      jobs({
        apply: async () => {
          applied = true;
          return 'applied';
        },
      }),
      { verify: async () => 'success' },
      { workerId: 'worker-1', maximumAttempts: 3, backoffMs: 100 },
    );

    await expect(processor(event(1))).resolves.toBe('complete');
    expect(applied).toBe(true);
  });
});
