import { describe, expect, it } from 'vitest';

import { decodeJobCursor, encodeJobCursor } from '../../src/domain/job-cursor.js';

describe('job cursor', () => {
  it('round-trips every sort field', () => {
    const source = {
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      sourceId: 'main',
      externalJobId: 'job-1',
    };

    expect(decodeJobCursor(encodeJobCursor(source))).toEqual(source);
  });

  it('rejects malformed cursors', () => {
    expect(decodeJobCursor('not-a-cursor')).toBeNull();
  });
});
