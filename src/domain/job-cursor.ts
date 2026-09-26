export type JobCursor = {
  updatedAt: Date;
  sourceId: string;
  externalJobId: string;
};

export function encodeJobCursor(cursor: JobCursor): string {
  return Buffer.from(
    JSON.stringify({
      updatedAt: cursor.updatedAt.toISOString(),
      sourceId: cursor.sourceId,
      externalJobId: cursor.externalJobId,
    }),
  ).toString('base64url');
}

export function decodeJobCursor(encoded: string): JobCursor | null {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));

    if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
      return null;
    }

    const value = decoded as Record<string, unknown>;
    const updatedAt = typeof value.updatedAt === 'string' ? new Date(value.updatedAt) : null;

    if (
      updatedAt === null ||
      Number.isNaN(updatedAt.getTime()) ||
      typeof value.sourceId !== 'string' ||
      typeof value.externalJobId !== 'string'
    ) {
      return null;
    }

    return {
      updatedAt,
      sourceId: value.sourceId,
      externalJobId: value.externalJobId,
    };
  } catch {
    return null;
  }
}
