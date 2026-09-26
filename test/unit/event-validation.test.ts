import { describe, expect, it } from 'vitest';

import { validateEvent } from '../../src/domain/event.js';

const validUpsert = {
  tenantId: 'tenant-a',
  sourceId: 'main',
  eventId: 'event-1',
  externalJobId: 'job-1',
  version: 1,
  operation: 'upsert',
  payload: {
    title: ' Full Stack Developer ',
    company: ' Example Labs ',
    location: ' Surat ',
    experienceMin: 1,
    experienceMax: 3,
    applyUrl: 'https://example.test/jobs/job-1',
    skills: [' TypeScript ', 'MongoDB', 'typescript'],
  },
};

describe('event validation', () => {
  it('trims display values and normalizes skills while preserving skill order', () => {
    const result = validateEvent(validUpsert);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.event.payload).toMatchObject({
        title: 'Full Stack Developer',
        company: 'Example Labs',
        location: 'Surat',
        skills: ['typescript', 'mongodb'],
      });
    }
  });

  it('rejects surrounding identifier whitespace without normalizing it', () => {
    const result = validateEvent({ ...validUpsert, eventId: ' event-1 ' });
    expect(result.success).toBe(false);
  });

  it('rejects an archive that supplies payload', () => {
    const result = validateEvent({
      ...validUpsert,
      operation: 'archive',
      payload: validUpsert.payload,
    });
    expect(result.success).toBe(false);
  });
});
