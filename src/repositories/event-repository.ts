import { MongoServerError } from 'mongodb';
import type { Collection, Document, MongoClient } from 'mongodb';

import type { ValidatedEvent } from '../domain/event.js';

export type EventStatus = 'pending' | 'processing' | 'completed' | 'failed';

export type AttemptHistoryEntry = {
  attempt: number;
  claimedAt: Date;
  outcome: 'claimed' | 'retry_scheduled' | 'permanent_failure' | 'completed' | 'stale';
  error?: string;
};

export type StoredEvent = ValidatedEvent & {
  canonicalBody: string;
  bodyHash: string;
  status: EventStatus;
  attemptCount: number;
  attemptHistory: AttemptHistoryEntry[];
  lastError: string | null;
  nextAttemptAt: Date;
  claimedBy: string | null;
  leaseUntil: Date | null;
  acceptedAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

export type EventSummary = Pick<
  StoredEvent,
  | 'tenantId'
  | 'sourceId'
  | 'eventId'
  | 'externalJobId'
  | 'version'
  | 'operation'
  | 'status'
  | 'attemptCount'
  | 'lastError'
  | 'acceptedAt'
  | 'updatedAt'
>;

export type AcceptanceOutcome = 'accepted' | 'replayed' | 'conflict';

export type AcceptEventInput = {
  event: ValidatedEvent;
  canonicalBody: string;
  bodyHash: string;
  acceptedAt: Date;
};

export interface EventRepository {
  ensureIndexes(): Promise<void>;
  ping(): Promise<void>;
  accept(input: AcceptEventInput): Promise<AcceptanceOutcome>;
  findSummary(tenantId: string, sourceId: string, eventId: string): Promise<EventSummary | null>;
  claimNext(workerId: string, now: Date, leaseMs: number): Promise<StoredEvent | null>;
  completeClaim(
    event: StoredEvent,
    workerId: string,
    completedAt: Date,
    outcome: 'completed' | 'stale',
  ): Promise<boolean>;
  rescheduleClaim(
    event: StoredEvent,
    workerId: string,
    nextAttemptAt: Date,
    error: string,
    updatedAt: Date,
  ): Promise<boolean>;
  failClaim(event: StoredEvent, workerId: string, error: string, updatedAt: Date): Promise<boolean>;
}

export function createMongoEventRepository(
  client: MongoClient,
  databaseName: string,
): EventRepository {
  const database = client.db(databaseName);
  const events: Collection<StoredEvent> = database.collection<StoredEvent>('events');

  function identityFilter(event: ValidatedEvent) {
    return { tenantId: event.tenantId, sourceId: event.sourceId, eventId: event.eventId };
  }

  function claimedIdentityFilter(event: StoredEvent, workerId: string) {
    return { ...identityFilter(event), status: 'processing' as const, claimedBy: workerId };
  }

  function replayOutcome(
    existing: Pick<StoredEvent, 'canonicalBody'>,
    canonicalBody: string,
  ): AcceptanceOutcome {
    return existing.canonicalBody === canonicalBody ? 'replayed' : 'conflict';
  }

  return {
    async ensureIndexes(): Promise<void> {
      await events.createIndex(
        { tenantId: 1, sourceId: 1, eventId: 1 },
        { unique: true, name: 'events_event_identity_unique' },
      );
      await events.createIndex(
        { status: 1, nextAttemptAt: 1, leaseUntil: 1, acceptedAt: 1 },
        { name: 'events_queue_claim' },
      );
    },

    async ping(): Promise<void> {
      await database.command({ ping: 1 });
    },

    async accept(input: AcceptEventInput): Promise<AcceptanceOutcome> {
      const filter = identityFilter(input.event);
      const existing = await events.findOne(filter, { projection: { canonicalBody: 1 } });
      if (existing !== null) return replayOutcome(existing, input.canonicalBody);

      const storedEvent: StoredEvent = {
        ...input.event,
        canonicalBody: input.canonicalBody,
        bodyHash: input.bodyHash,
        status: 'pending',
        attemptCount: 0,
        attemptHistory: [],
        lastError: null,
        nextAttemptAt: input.acceptedAt,
        claimedBy: null,
        leaseUntil: null,
        acceptedAt: input.acceptedAt,
        createdAt: input.acceptedAt,
        updatedAt: input.acceptedAt,
      };

      try {
        const result = await events.insertOne(storedEvent, {
          writeConcern: { w: 'majority', j: true },
        });
        if (!result.acknowledged) throw new Error('MongoDB did not acknowledge event persistence');
        return 'accepted';
      } catch (error) {
        if (!(error instanceof MongoServerError) || error.code !== 11_000) throw error;
        const concurrentEvent = await events.findOne(filter, { projection: { canonicalBody: 1 } });
        if (concurrentEvent === null)
          throw new Error('Unique event identity conflict occurred but no event was found');
        return replayOutcome(concurrentEvent, input.canonicalBody);
      }
    },

    async findSummary(
      tenantId: string,
      sourceId: string,
      eventId: string,
    ): Promise<EventSummary | null> {
      return events.findOne(
        { tenantId, sourceId, eventId },
        {
          projection: {
            _id: 0,
            tenantId: 1,
            sourceId: 1,
            eventId: 1,
            externalJobId: 1,
            version: 1,
            operation: 1,
            status: 1,
            attemptCount: 1,
            lastError: 1,
            acceptedAt: 1,
            updatedAt: 1,
          },
        },
      );
    },

    async claimNext(workerId: string, now: Date, leaseMs: number): Promise<StoredEvent | null> {
      const leaseUntil = new Date(now.getTime() + leaseMs);
      const eligible: Document = {
        $or: [
          { status: 'pending', nextAttemptAt: { $lte: now } },
          { status: 'processing', leaseUntil: { $lte: now } },
        ],
      };

      return events.findOneAndUpdate(
        eligible,
        [
          {
            $set: {
              status: 'processing',
              claimedBy: workerId,
              leaseUntil,
              updatedAt: now,
              attemptCount: { $add: ['$attemptCount', 1] },
              attemptHistory: {
                $concatArrays: [
                  '$attemptHistory',
                  [{ attempt: { $add: ['$attemptCount', 1] }, claimedAt: now, outcome: 'claimed' }],
                ],
              },
            },
          },
        ],
        { sort: { nextAttemptAt: 1, acceptedAt: 1 }, returnDocument: 'after' },
      );
    },

    async completeClaim(
      event: StoredEvent,
      workerId: string,
      completedAt: Date,
      outcome: 'completed' | 'stale',
    ): Promise<boolean> {
      const result = await events.updateOne(claimedIdentityFilter(event, workerId), [
        {
          $set: {
            status: 'completed',
            leaseUntil: null,
            updatedAt: completedAt,
            attemptHistory: {
              $concatArrays: [
                '$attemptHistory',
                [{ attempt: '$attemptCount', claimedAt: completedAt, outcome }],
              ],
            },
          },
        },
      ]);
      return result.modifiedCount === 1;
    },

    async rescheduleClaim(
      event: StoredEvent,
      workerId: string,
      nextAttemptAt: Date,
      error: string,
      updatedAt: Date,
    ): Promise<boolean> {
      const result = await events.updateOne(claimedIdentityFilter(event, workerId), [
        {
          $set: {
            status: 'pending',
            claimedBy: null,
            leaseUntil: null,
            nextAttemptAt,
            lastError: error,
            updatedAt,
            attemptHistory: {
              $concatArrays: [
                '$attemptHistory',
                [
                  {
                    attempt: '$attemptCount',
                    claimedAt: updatedAt,
                    outcome: 'retry_scheduled',
                    error,
                  },
                ],
              ],
            },
          },
        },
      ]);
      return result.modifiedCount === 1;
    },

    async failClaim(
      event: StoredEvent,
      workerId: string,
      error: string,
      updatedAt: Date,
    ): Promise<boolean> {
      const result = await events.updateOne(claimedIdentityFilter(event, workerId), [
        {
          $set: {
            status: 'failed',
            claimedBy: null,
            leaseUntil: null,
            lastError: error,
            updatedAt,
            attemptHistory: {
              $concatArrays: [
                '$attemptHistory',
                [
                  {
                    attempt: '$attemptCount',
                    claimedAt: updatedAt,
                    outcome: 'permanent_failure',
                    error,
                  },
                ],
              ],
            },
          },
        },
      ]);
      return result.modifiedCount === 1;
    },
  };
}
