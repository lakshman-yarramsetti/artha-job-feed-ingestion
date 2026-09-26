import { MongoServerError } from 'mongodb';
import type { Collection, Filter, MongoClient, UpdateFilter } from 'mongodb';

import type { JobCursor } from '../domain/job-cursor.js';
import type { StoredEvent } from './event-repository.js';

type UpsertPayload = Extract<StoredEvent, { operation: 'upsert' }>['payload'];

export type JobProjection = {
  tenantId: string;
  sourceId: string;
  externalJobId: string;
  latestVersion: number;
  status: 'active' | 'archived';
  payload?: UpsertPayload;
  updatedAt: Date;
};

export type ProjectionOutcome = 'applied' | 'stale';
export type JobListStatus = 'active' | 'archived' | 'all';

export type ListJobsInput = {
  tenantId: string;
  sourceId?: string;
  status: JobListStatus;
  limit: number;
  cursor: JobCursor | null;
};

export interface JobRepository {
  ensureIndexes(): Promise<void>;
  latestVersion(event: StoredEvent): Promise<number | null>;
  apply(event: StoredEvent, updatedAt: Date): Promise<ProjectionOutcome>;
  list(input: ListJobsInput): Promise<JobProjection[]>;
}

export function createMongoJobRepository(client: MongoClient, databaseName: string): JobRepository {
  const jobs: Collection<JobProjection> = client.db(databaseName).collection<JobProjection>('jobs');

  function identityFilter(event: StoredEvent) {
    return {
      tenantId: event.tenantId,
      sourceId: event.sourceId,
      externalJobId: event.externalJobId,
    };
  }

  function projectionUpdate(event: StoredEvent, updatedAt: Date): UpdateFilter<JobProjection> {
    return event.operation === 'upsert'
      ? {
          $set: {
            latestVersion: event.version,
            status: 'active' as const,
            payload: event.payload,
            updatedAt,
          },
        }
      : {
          $set: {
            latestVersion: event.version,
            status: 'archived' as const,
            updatedAt,
          },
          $unset: { payload: true as const },
        };
  }

  async function updateExistingIfNewer(event: StoredEvent, updatedAt: Date): Promise<boolean> {
    const filter = { ...identityFilter(event), latestVersion: { $lt: event.version } };
    const result = await jobs.updateOne(filter, projectionUpdate(event, updatedAt));
    return result.modifiedCount === 1;
  }

  return {
    async ensureIndexes(): Promise<void> {
      await jobs.createIndex(
        { tenantId: 1, sourceId: 1, externalJobId: 1 },
        { unique: true, name: 'jobs_job_identity_unique' },
      );
      await jobs.createIndex(
        { tenantId: 1, status: 1, updatedAt: -1, sourceId: 1, externalJobId: 1 },
        { name: 'jobs_tenant_status_pagination' },
      );
    },

    async latestVersion(event: StoredEvent): Promise<number | null> {
      const job = await jobs.findOne(identityFilter(event), { projection: { latestVersion: 1 } });
      return job?.latestVersion ?? null;
    },

    async apply(event: StoredEvent, updatedAt: Date): Promise<ProjectionOutcome> {
      const filter = { ...identityFilter(event), latestVersion: { $lt: event.version } };

      try {
        const result = await jobs.updateOne(filter, projectionUpdate(event, updatedAt), {
          upsert: true,
        });
        return result.modifiedCount === 1 || result.upsertedCount === 1 ? 'applied' : 'stale';
      } catch (error) {
        if (!(error instanceof MongoServerError) || error.code !== 11_000) {
          throw error;
        }

        return (await updateExistingIfNewer(event, updatedAt)) ? 'applied' : 'stale';
      }
    },

    async list(input: ListJobsInput): Promise<JobProjection[]> {
      const filter: Filter<JobProjection> = { tenantId: input.tenantId };

      if (input.sourceId !== undefined) {
        filter.sourceId = input.sourceId;
      }

      if (input.status !== 'all') {
        filter.status = input.status;
      }

      if (input.cursor !== null) {
        filter.$or = [
          { updatedAt: { $lt: input.cursor.updatedAt } },
          { updatedAt: input.cursor.updatedAt, sourceId: { $gt: input.cursor.sourceId } },
          {
            updatedAt: input.cursor.updatedAt,
            sourceId: input.cursor.sourceId,
            externalJobId: { $gt: input.cursor.externalJobId },
          },
        ];
      }

      return jobs
        .find(filter)
        .sort({ updatedAt: -1, sourceId: 1, externalJobId: 1 })
        .limit(input.limit)
        .toArray();
    },
  };
}
