import type { StoredEvent } from '../repositories/event-repository.js';

export type ClaimedEventRepository = {
  claimNext(workerId: string, now: Date, leaseMs: number): Promise<StoredEvent | null>;
  completeClaim(
    event: StoredEvent,
    workerId: string,
    completedAt: Date,
    outcome: 'completed' | 'stale',
  ): Promise<boolean>;
};

export type EventProcessor = (event: StoredEvent) => Promise<'complete' | 'stale' | 'deferred'>;

export class EventWorker {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  public constructor(
    private readonly workerId: string,
    private readonly repository: ClaimedEventRepository,
    private readonly processor: EventProcessor,
    private readonly leaseMs: number,
    private readonly pollMs: number,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public start(): void {
    if (this.timer !== undefined) {
      return;
    }

    this.timer = setInterval(() => void this.tick(), this.pollMs);
    void this.tick();
  }

  public async stop(): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }

    while (this.running) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  }

  public async tick(): Promise<boolean> {
    if (this.running) {
      return false;
    }

    this.running = true;

    try {
      const claimed = await this.repository.claimNext(this.workerId, this.now(), this.leaseMs);

      if (claimed === null) {
        return false;
      }

      const outcome = await this.processor(claimed);
      return outcome === 'deferred'
        ? true
        : this.repository.completeClaim(
            claimed,
            this.workerId,
            this.now(),
            outcome === 'stale' ? 'stale' : 'completed',
          );
    } finally {
      this.running = false;
    }
  }
}
