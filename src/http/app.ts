import Fastify from 'fastify';

import { canonicalizeJson } from '../domain/canonical-json.js';
import { decodeJobCursor, encodeJobCursor } from '../domain/job-cursor.js';
import { validateEvent } from '../domain/event.js';
import type { EventRepository } from '../repositories/event-repository.js';
import type { JobListStatus, JobRepository } from '../repositories/job-repository.js';

const maximumPageSize = 100;
const defaultPageSize = 20;

function readSingleQueryValue(query: unknown, name: string): string | undefined {
  if (query === null || typeof query !== 'object' || Array.isArray(query)) return undefined;
  const value = (query as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : undefined;
}

function isIdentifier(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0 && value === value.trim();
}

function parseLimit(value: string | undefined): number | null {
  if (value === undefined) return defaultPageSize;
  if (!/^\d+$/.test(value)) return null;
  const limit = Number(value);
  return Number.isSafeInteger(limit) && limit >= 1 && limit <= maximumPageSize ? limit : null;
}

function parseStatus(value: string | undefined): JobListStatus | null {
  if (value === undefined) return 'active';
  return value === 'active' || value === 'archived' || value === 'all' ? value : null;
}

export function buildApp(eventRepository: EventRepository, jobRepository: JobRepository) {
  const app = Fastify({ logger: true });

  app.post('/events', async (request, reply) => {
    const validation = validateEvent(request.body);
    if (!validation.success) {
      return reply.code(400).send({ error: 'validation_error', issues: validation.issues });
    }

    const canonicalBody = canonicalizeJson(request.body);
    const outcome = await eventRepository.accept({
      event: validation.event,
      canonicalBody: canonicalBody.body,
      bodyHash: canonicalBody.sha256,
      acceptedAt: new Date(),
    });

    if (outcome === 'accepted') {
      return reply.code(202).send({ eventId: validation.event.eventId, status: 'accepted' });
    }
    if (outcome === 'replayed') {
      return reply.code(200).send({ eventId: validation.event.eventId, status: 'replayed' });
    }
    return reply
      .code(409)
      .send({ error: 'event_identity_conflict', eventId: validation.event.eventId });
  });

  app.get('/jobs', async (request, reply) => {
    const tenantId = readSingleQueryValue(request.query, 'tenantId');
    const sourceId = readSingleQueryValue(request.query, 'sourceId');
    const status = parseStatus(readSingleQueryValue(request.query, 'status'));
    const limit = parseLimit(readSingleQueryValue(request.query, 'limit'));
    const encodedCursor = readSingleQueryValue(request.query, 'cursor');
    const cursor = encodedCursor === undefined ? null : decodeJobCursor(encodedCursor);

    if (!isIdentifier(tenantId) || (sourceId !== undefined && !isIdentifier(sourceId))) {
      return reply.code(400).send({
        error: 'validation_error',
        message: 'tenantId and sourceId must be valid identifiers',
      });
    }
    if (status === null || limit === null || (cursor === null && encodedCursor !== undefined)) {
      return reply
        .code(400)
        .send({ error: 'validation_error', message: 'invalid status, limit, or cursor' });
    }

    const jobs = await jobRepository.list(
      sourceId === undefined
        ? { tenantId, status, limit: limit + 1, cursor }
        : { tenantId, sourceId, status, limit: limit + 1, cursor },
    );
    const hasNextPage = jobs.length > limit;
    const items = hasNextPage ? jobs.slice(0, limit) : jobs;
    const finalItem = items.at(-1);

    return reply.send({
      items,
      nextCursor:
        hasNextPage && finalItem !== undefined
          ? encodeJobCursor({
              updatedAt: finalItem.updatedAt,
              sourceId: finalItem.sourceId,
              externalJobId: finalItem.externalJobId,
            })
          : null,
    });
  });

  app.get('/events/:eventId', async (request, reply) => {
    const params = request.params as { eventId?: unknown };
    const eventId = typeof params.eventId === 'string' ? params.eventId : undefined;
    const tenantId = readSingleQueryValue(request.query, 'tenantId');
    const sourceId = readSingleQueryValue(request.query, 'sourceId');

    if (!isIdentifier(tenantId) || !isIdentifier(sourceId) || !isIdentifier(eventId)) {
      return reply.code(400).send({
        error: 'validation_error',
        message: 'tenantId, sourceId, and eventId must be valid identifiers',
      });
    }

    const event = await eventRepository.findSummary(tenantId, sourceId, eventId);
    return event === null ? reply.code(404).send({ error: 'event_not_found' }) : reply.send(event);
  });

  app.get('/health', async (_request, reply) => {
    try {
      await eventRepository.ping();
      return reply.send({ status: 'ready', mongo: 'ready' });
    } catch {
      return reply.code(503).send({ status: 'not_ready', mongo: 'unavailable' });
    }
  });

  return app;
}
