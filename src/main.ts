import 'dotenv/config';

import { MongoClient } from 'mongodb';

import { loadConfig } from './config/environment.js';
import { buildApp } from './http/app.js';
import { createFixtureProviderVerifier, loadProviderPlan } from './providers/provider-verifier.js';
import { createMongoEventRepository } from './repositories/event-repository.js';
import { createMongoJobRepository } from './repositories/job-repository.js';
import { EventWorker } from './workers/event-worker.js';
import { createProviderEventProcessor } from './workers/provider-event-processor.js';

const config = loadConfig(process.env);
const client = new MongoClient(config.mongoUri, {
  writeConcern: { w: 'majority', j: true },
});

await client.connect();

const eventRepository = createMongoEventRepository(client, config.mongoDatabase);
const jobRepository = createMongoJobRepository(client, config.mongoDatabase);
await Promise.all([eventRepository.ensureIndexes(), jobRepository.ensureIndexes()]);

const providerVerifier = createFixtureProviderVerifier(
  await loadProviderPlan(config.providerPlanPath),
);
const app = buildApp(eventRepository, jobRepository);
const workers = ['worker-1', 'worker-2'].map((workerId) => {
  const processor = createProviderEventProcessor(eventRepository, jobRepository, providerVerifier, {
    workerId,
    maximumAttempts: config.workerMaximumAttempts,
    backoffMs: config.workerRetryBackoffMs,
  });

  return new EventWorker(
    workerId,
    eventRepository,
    processor,
    config.workerLeaseMs,
    config.workerPollMs,
  );
});

workers.forEach((worker) => worker.start());

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  await Promise.all(workers.map((worker) => worker.stop()));
  await app.close();
  await client.close();
  process.exit(0);
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: '0.0.0.0', port: config.port });
