export type AppConfig = {
  mongoUri: string;
  mongoDatabase: string;
  port: number;
  workerLeaseMs: number;
  workerPollMs: number;
  workerRetryBackoffMs: number;
  workerMaximumAttempts: number;
  providerPlanPath: string;
};

function readPort(value: string | undefined): number {
  const port = value === undefined ? 3000 : Number(value);

  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }

  return port;
}

function readPositiveInteger(name: string, value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? fallback : Number(value);

  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }

  return parsed;
}

export function loadConfig(environment: NodeJS.ProcessEnv): AppConfig {
  const mongoUri = environment.MONGODB_URI ?? 'mongodb://localhost:27017';
  const mongoDatabase = environment.MONGODB_DB ?? 'artha_job_feed';
  const providerPlanPath = environment.PROVIDER_PLAN_PATH ?? 'fixtures/provider-plan.json';

  if (mongoUri.trim().length === 0) {
    throw new Error('MONGODB_URI must be nonblank');
  }

  if (mongoDatabase.trim().length === 0) {
    throw new Error('MONGODB_DB must be nonblank');
  }

  if (providerPlanPath.trim().length === 0) {
    throw new Error('PROVIDER_PLAN_PATH must be nonblank');
  }

  return {
    mongoUri,
    mongoDatabase,
    port: readPort(environment.PORT),
    workerLeaseMs: readPositiveInteger('WORKER_LEASE_MS', environment.WORKER_LEASE_MS, 30_000),
    workerPollMs: readPositiveInteger('WORKER_POLL_MS', environment.WORKER_POLL_MS, 250),
    workerRetryBackoffMs: readPositiveInteger(
      'WORKER_RETRY_BACKOFF_MS',
      environment.WORKER_RETRY_BACKOFF_MS,
      1_000,
    ),
    workerMaximumAttempts: readPositiveInteger(
      'WORKER_MAXIMUM_ATTEMPTS',
      environment.WORKER_MAXIMUM_ATTEMPTS,
      3,
    ),
    providerPlanPath,
  };
}
