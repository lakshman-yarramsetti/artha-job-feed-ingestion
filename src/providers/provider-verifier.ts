import { readFile } from 'node:fs/promises';

import { z } from 'zod';

import type { StoredEvent } from '../repositories/event-repository.js';

const providerOutcomeSchema = z.enum(['success', '429', '422', '503']);

const providerPlanSchema = z.object({
  default: providerOutcomeSchema.default('success'),
  events: z.record(z.string(), z.array(providerOutcomeSchema).min(1)).default({}),
});

export type ProviderOutcome = z.infer<typeof providerOutcomeSchema>;

export type ProviderVerifier = {
  verify(event: StoredEvent): Promise<ProviderOutcome>;
};

export type ProviderPlan = z.infer<typeof providerPlanSchema>;

function eventPlanKey(event: StoredEvent): string {
  return `${event.tenantId}/${event.sourceId}/${event.eventId}`;
}

export async function loadProviderPlan(filePath: string): Promise<ProviderPlan> {
  const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'));
  return providerPlanSchema.parse(parsed);
}

export function createFixtureProviderVerifier(plan: ProviderPlan): ProviderVerifier {
  return {
    async verify(event: StoredEvent): Promise<ProviderOutcome> {
      const outcomes = plan.events[eventPlanKey(event)];

      if (outcomes === undefined) {
        return plan.default;
      }

      const index = Math.min(event.attemptCount - 1, outcomes.length - 1);
      return outcomes[index] ?? plan.default;
    },
  };
}
