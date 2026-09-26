import { createHash } from 'node:crypto';

function canonicalize(value: unknown): unknown {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    typeof value === 'string'
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nestedValue]) => [key, canonicalize(nestedValue)]);

    return Object.fromEntries(entries);
  }

  throw new Error('Cannot canonicalize a non-JSON value');
}

export type CanonicalJson = {
  body: string;
  sha256: string;
};

/**
 * Objects are sorted recursively; array order is deliberately retained.
 */
export function canonicalizeJson(input: unknown): CanonicalJson {
  const body = JSON.stringify(canonicalize(input));

  return {
    body,
    sha256: createHash('sha256').update(body).digest('hex'),
  };
}
