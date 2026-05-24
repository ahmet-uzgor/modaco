import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createReadStream } from 'node:fs';
import { access } from 'node:fs/promises';
import * as path from 'node:path';
import { ENV_TOKEN } from '../config/config.module';
import type { Env } from '../config/env';
import { PrismaService } from '../infra/prisma.service';
import { JobRunner } from '../jobs/job-runner.service';
import { MetricsService } from '../observability/metrics.service';
import { IngestProcessor } from './processor.service';
import { IngestSplitter } from './splitter.service';
import { presentBatch, type IngestBatchPresented, type StartIngestDto } from './ingest.dto';

/**
 * Orchestrates the local-dev equivalent of the splitter → SQS → processor
 * pipeline from plan §8.
 *
 *   POST /ingest/batches with { vendorId, sourceFile }:
 *
 *     1. Resolve the file path safely against INGEST_DIR (no path traversal).
 *     2. Look up (vendor_id, source_file) — if a batch already exists, return
 *        it. Idempotency at the batch level (plan §8): re-POSTing the same
 *        (vendor_id, source_file) doesn't kick off a duplicate processing run.
 *     3. Otherwise insert a PROCESSING batch row, return 202, hand the
 *        actual work to JobRunner.
 *
 *   The background job:
 *     - Streams the file through IngestSplitter, which feeds chunks to
 *       IngestProcessor.processChunk one at a time (backpressure keeps
 *       memory bounded).
 *     - On completion, flips status to COMPLETED and records totalRows.
 *     - On unexpected failure, flips status to FAILED — partial progress
 *       stays committed (row-level idempotency means a retry is safe).
 */
@Injectable()
export class IngestService {
  private readonly logger = new Logger(IngestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly splitter: IngestSplitter,
    private readonly processor: IngestProcessor,
    private readonly jobs: JobRunner,
    private readonly metrics: MetricsService,
    @Inject(ENV_TOKEN) private readonly env: Env,
  ) {}

  async startBatch(dto: StartIngestDto): Promise<IngestBatchPresented> {
    const filePath = this.resolveSourceFile(dto.sourceFile);
    try {
      await access(filePath);
    } catch {
      throw new BadRequestException(`Source file not found inside INGEST_DIR: ${dto.sourceFile}`);
    }

    const existing = await this.prisma.ingestBatch.findUnique({
      where: { vendorId_sourceFile: { vendorId: dto.vendorId, sourceFile: dto.sourceFile } },
    });
    if (existing) {
      // Plan §8 idempotency: re-POSTing the same (vendor, file) returns the
      // existing batch rather than spawning a parallel run. Manual retry
      // semantics for FAILED batches are out of scope for the case study;
      // operators can clear the batch row by hand.
      return presentBatch(existing);
    }

    const created = await this.prisma.ingestBatch.create({
      data: {
        vendorId: dto.vendorId,
        sourceFile: dto.sourceFile,
        status: 'PROCESSING',
      },
    });
    this.metrics.ingestBatches.inc({ transition: 'started' });

    this.jobs.enqueue(`ingest-batch:${created.id}`, async () => {
      await this.runBatch(created.id, filePath);
    });

    return presentBatch(created);
  }

  async getBatch(id: string): Promise<IngestBatchPresented> {
    const row = await this.prisma.ingestBatch.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`Batch ${id} not found`);
    return presentBatch(row);
  }

  private resolveSourceFile(sourceFile: string): string {
    const base = path.resolve(this.env.INGEST_DIR);
    const target = path.resolve(base, sourceFile);
    // Defense in depth — the Zod regex already prevents `..` in sourceFile,
    // but resolve+startsWith is the canonical no-traversal check.
    if (!target.startsWith(base + path.sep) && target !== base) {
      throw new BadRequestException('sourceFile must resolve inside INGEST_DIR');
    }
    return target;
  }

  private async runBatch(batchId: string, filePath: string): Promise<void> {
    try {
      const stream = createReadStream(filePath, { encoding: 'utf8' });
      const result = await this.splitter.split(stream, this.env.INGEST_CHUNK_SIZE, async (rows) => {
        await this.processor.processChunk(batchId, rows);
      });

      await this.prisma.ingestBatch.update({
        where: { id: batchId },
        data: {
          status: 'COMPLETED',
          totalRows: result.totalRows,
          finishedAt: new Date(),
        },
      });
      this.metrics.ingestBatches.inc({ transition: 'completed' });

      this.logger.log(
        { batchId, totalRows: result.totalRows, chunks: result.chunkCount },
        'ingest batch completed',
      );
    } catch (err) {
      this.logger.error({ batchId, err }, 'ingest batch failed');
      await this.prisma.ingestBatch
        .update({
          where: { id: batchId },
          data: { status: 'FAILED', finishedAt: new Date() },
        })
        .catch((markErr) => {
          this.logger.error({ batchId, err: markErr }, 'failed to record FAILED status');
        });
      this.metrics.ingestBatches.inc({ transition: 'failed' });
    }
  }
}
