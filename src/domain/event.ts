import { z } from 'zod';

const identifierSchema = z
  .string()
  .refine((value) => value.trim().length > 0, 'must be nonblank')
  .refine((value) => value === value.trim(), 'must not contain surrounding whitespace');

const displayStringSchema = z
  .string()
  .transform((value) => value.trim())
  .pipe(z.string().min(1, 'must be nonblank'));

const experienceSchema = z
  .object({
    experienceMin: z.number().int().min(0).max(50),
    experienceMax: z.number().int().min(0).max(50),
  })
  .refine((value) => value.experienceMin <= value.experienceMax, {
    message: 'experienceMin must be less than or equal to experienceMax',
    path: ['experienceMin'],
  });

const skillSchema = z
  .string()
  .transform((value) => value.trim().toLowerCase())
  .pipe(z.string().min(1, 'must be nonblank'));

const payloadSchema = z
  .object({
    title: displayStringSchema,
    company: displayStringSchema,
    location: displayStringSchema,
    experienceMin: experienceSchema.shape.experienceMin,
    experienceMax: experienceSchema.shape.experienceMax,
    applyUrl: z
      .string()
      .url('must be a valid URL')
      .refine((value) => new URL(value).protocol === 'https:', 'must use https://'),
    skills: z
      .array(skillSchema)
      .min(1, 'must contain at least one skill')
      .transform((skills) => [...new Set(skills)]),
  })
  .refine((value) => value.experienceMin <= value.experienceMax, {
    message: 'experienceMin must be less than or equal to experienceMax',
    path: ['experienceMin'],
  })
  .passthrough();

const commonEventSchema = {
  tenantId: identifierSchema,
  sourceId: identifierSchema,
  eventId: identifierSchema,
  externalJobId: identifierSchema,
  version: z.number().int().safe().positive(),
};

const upsertEventSchema = z
  .object({
    ...commonEventSchema,
    operation: z.literal('upsert'),
    payload: payloadSchema,
  })
  .passthrough();

const archiveEventSchema = z
  .object({
    ...commonEventSchema,
    operation: z.literal('archive'),
    payload: z.never().optional(),
  })
  .passthrough();

export const eventSchema = z.discriminatedUnion('operation', [
  upsertEventSchema,
  archiveEventSchema,
]);

export type ValidatedEvent = z.infer<typeof eventSchema>;

export type ValidationIssue = {
  path: string;
  message: string;
};

export type ValidationResult =
  { success: true; event: ValidatedEvent } | { success: false; issues: ValidationIssue[] };

export function validateEvent(input: unknown): ValidationResult {
  const result = eventSchema.safeParse(input);

  if (result.success) {
    return { success: true, event: result.data };
  }

  return {
    success: false,
    issues: result.error.issues.map((issue) => ({
      path: issue.path.length === 0 ? '$' : issue.path.join('.'),
      message: issue.message,
    })),
  };
}
