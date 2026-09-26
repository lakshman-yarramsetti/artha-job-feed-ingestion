import { describe, expect, it } from 'vitest';

import type { StoredEvent } from '../../src/repositories/event-repository.js';
import { EventWorker } from '../../src/workers/event-worker.js';

function claimedEvent(): StoredEvent {
  return {
    tenantId: 'tenant-a',
    sourceId: 'main',
    eventId: 'event-1',
    externalJobId: 'job-1',
    version: 1,
    operation: 'archive',
    canonicalBody: '{"eventId":"event-1"}',
    bodyHash: 'hash',
    status: 'processing',
    attemptCount: 1,
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

describe('EventWorker', () => {
  it('processes and conditionally acknowledges a claimed event', async () => {
    const event = claimedEvent();
    const calls: string[] = [];
    const repository = {
      claimNext: async (workerId: string) => {
        calls.push(`claim:${workerId}`);
        return event;
      },
      completeClaim: async (completed: StoredEvent, workerId: string) => {
        calls.push(`complete:${completed.eventId}:${workerId}`);
        return true;
      },
    };
    const worker = new EventWorker(
      'worker-1',
      repository,
      async (processed) => {
        calls.push(`process:${processed.eventId}`);
        return 'complete';
      },
      30_000,
      250,
      () => new Date('2026-01-01T00:00:00.000Z'),
    );

    await expect(worker.tick()).resolves.toBe(true);
    expect(calls).toEqual(['claim:worker-1', 'process:event-1', 'complete:event-1:worker-1']);
  });

  it('does not run overlapping ticks for one worker', async () => {
    let releaseClaim: (() => void) | undefined;
    const blockedClaim = new Promise<null>((resolve) => {
      releaseClaim = () => resolve(null);
    });
    const repository = {
      claimNext: async () => blockedClaim,
      completeClaim: async () => true,
    };
    const worker = new EventWorker('worker-1', repository, async () => 'complete', 30_000, 250);

    const firstTick = worker.tick();
    await expect(worker.tick()).resolves.toBe(false);
    releaseClaim?.();
    await expect(firstTick).resolves.toBe(false);
  });
});
