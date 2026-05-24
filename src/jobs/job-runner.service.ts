import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';

/**
 * In-process job runner for background work.
 *
 * Phase 4 / Scenario B materialization is an "async job" in the plan: the
 * POST /promotions response returns 202 Accepted, the heavy bulk SQL runs
 * later. In production this maps to SQS + Lambda; locally we just fire it
 * inside the same Node process with `setImmediate`.
 *
 * The runner tracks in-flight promises so tests can `await flush()` and be
 * sure the materialization is done before they assert. The same hook also
 * lets the Nest lifecycle drain pending work on graceful shutdown.
 *
 * Errors are caught and logged — they never escape, otherwise an unhandled
 * promise rejection would crash the process and break the "fire and forget"
 * contract.
 */
@Injectable()
export class JobRunner implements OnModuleDestroy {
  private readonly logger = new Logger(JobRunner.name);
  private inFlight = new Set<Promise<void>>();

  enqueue(name: string, job: () => Promise<void>): void {
    const wrapped = new Promise<void>((resolve) => {
      setImmediate(() => {
        job()
          .catch((err) => {
            this.logger.error({ err, job: name }, 'background job failed');
          })
          .finally(() => {
            this.inFlight.delete(wrapped);
            resolve();
          });
      });
    });
    this.inFlight.add(wrapped);
  }

  /**
   * Wait for every in-flight job — including jobs enqueued by other jobs
   * during the drain — to settle. Tests call this after a POST to make
   * assertions deterministic.
   */
  async flush(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.inFlight.size === 0) return;
    this.logger.log({ pending: this.inFlight.size }, 'draining jobs before shutdown');
    await this.flush();
  }
}
