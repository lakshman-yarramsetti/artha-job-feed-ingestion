import type { StoredEvent } from '../repositories/event-repository.js';
import type { JobRepository } from '../repositories/job-repository.js';
import type { ProviderVerifier } from '../providers/provider-verifier.js';

export type ProviderProcessingRepository = {
  rescheduleClaim(
    event: StoredEvent,
    workerId: string,
    nextAttemptAt: Date,
    error: string,
    updatedAt: Date,
  ): Promise<boolean>;
  failClaim(event: StoredEvent, workerId: string, error: string, updatedAt: Date): Promise<boolean>;
};

export type ProviderProcessorResult = 'complete' | 'stale' | 'deferred';

export type ProviderProcessorConfig = {
  workerId: string;
  maximumAttempts: number;
  backoffMs: number;
  now?: () => Date;
};

export function createProviderEventProcessor(
  repository: ProviderProcessingRepository,
  jobs: JobRepository,
  verifier: ProviderVerifier,
  config: ProviderProcessorConfig,
): (event: StoredEvent) => Promise<ProviderProcessorResult> {
  const now = config.now ?? (() => new Date());

  return async (event: StoredEvent): Promise<ProviderProcessorResult> => {
    const existingVersion = await jobs.latestVersion(event);

    if (existingVersion !== null && existingVersion >= event.version) {
      return 'stale';
    }

    const outcome = await verifier.verify(event);

    if (outcome === 'success') {
      return (await jobs.apply(event, now())) === 'applied' ? 'complete' : 'stale';
    }

    const updatedAt = now();
    const error = `Provider verification returned ${outcome}`;

    if (outcome === '422') {
      await repository.failClaim(event, config.workerId, error, updatedAt);
      return 'deferred';
    }

    if (event.attemptCount >= config.maximumAttempts) {
      await repository.failClaim(
        event,
        config.workerId,
        `${error}; retry attempts exhausted`,
        updatedAt,
      );
      return 'deferred';
    }

    const delayMs = config.backoffMs * 2 ** (event.attemptCount - 1);
    const nextAttemptAt = new Date(updatedAt.getTime() + delayMs);
    await repository.rescheduleClaim(event, config.workerId, nextAttemptAt, error, updatedAt);
    return 'deferred';
  };
}
