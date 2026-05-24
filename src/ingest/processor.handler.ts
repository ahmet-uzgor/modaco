import { NestFactory } from '@nestjs/core';
import type { SQSBatchResponse, SQSEvent, SQSHandler } from 'aws-lambda';
import { AppModule } from '../app.module';
import { PrismaService } from '../infra/prisma.service';
import { IngestProcessor } from './processor.service';

/**
 * AWS Lambda entrypoint for the processor half of Scenario A.
 *
 * Triggered by SQS messages emitted by the splitter:
 *   { batchId, chunkKey, chunkIndex }
 *
 * For each message we:
 *   1. Pull s3://modaco-ingest/chunks/{batchId}/{chunkIndex}.jsonl.
 *   2. Parse the JSONL into a row array.
 *   3. Hand it to IngestProcessor.processChunk — which is the same code
 *      path the local-dev runner uses. Idempotency keys make a retry
 *      from SQS safe.
 *   4. If processing throws (DB timeout, transient): we report the
 *      message as a partial-batch-item failure so SQS retries only the
 *      offending message, not the whole batch.
 *
 * On final completion of a batch (processedRows + failedRows == totalRows)
 * the batch is flipped to COMPLETED. The "did this chunk complete the
 * batch?" check is done inside the processor's $transaction by reading
 * the freshly-incremented counters.
 *
 * The AWS SDK calls are stubbed for the same reason as splitter.handler:
 * keeping the case-study build free of @aws-sdk/* dependencies that
 * aren't exercised by any test.
 */

interface ChunkMessageBody {
  batchId: string;
  chunkKey: string;
  chunkIndex: number;
}

let cachedContext: Awaited<ReturnType<typeof NestFactory.createApplicationContext>> | null = null;

async function getContext() {
  if (!cachedContext) {
    cachedContext = await NestFactory.createApplicationContext(AppModule, {
      logger: ['error', 'warn', 'log'],
    });
  }
  return cachedContext;
}

export const handler: SQSHandler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  const ctx = await getContext();
  const processor = ctx.get(IngestProcessor);
  const prisma = ctx.get(PrismaService);

  const failures: SQSBatchResponse['batchItemFailures'] = [];

  for (const record of event.Records) {
    let body: ChunkMessageBody;
    try {
      body = JSON.parse(record.body) as ChunkMessageBody;
    } catch (err) {
      // Malformed message — non-retryable. Mark as failed so DLQ picks it up.
      failures.push({ itemIdentifier: record.messageId });
      continue;
    }

    try {
      const rows = await fetchChunk(body.chunkKey);
      await processor.processChunk(body.batchId, rows);
      await maybeCompleteBatch(prisma, body.batchId);
    } catch (err) {
      // Transient or unexpected — let SQS retry just this message. The
      // (batch_id, row_key) PK on ingest_row_results and ON CONFLICT (sku)
      // on products make a retry idempotent.
      failures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures: failures };
};

async function maybeCompleteBatch(prisma: PrismaService, batchId: string): Promise<void> {
  const batch = await prisma.ingestBatch.findUnique({ where: { id: batchId } });
  if (!batch || batch.totalRows === null) return;
  if (batch.processedRows + batch.failedRows >= batch.totalRows && batch.status !== 'COMPLETED') {
    await prisma.ingestBatch.update({
      where: { id: batchId },
      data: { status: 'COMPLETED', finishedAt: new Date() },
    });
  }
}

async function fetchChunk(_chunkKey: string): Promise<unknown[]> {
  // TODO(production): replace with @aws-sdk/client-s3 GetObject + JSONL parse.
  //   const obj = await s3.send(new GetObjectCommand({ Bucket, Key: chunkKey }));
  //   const text = await streamToString(obj.Body as Readable);
  //   return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  throw new Error(
    'fetchChunk is a deployment stub — wire @aws-sdk/client-s3 before deploying the processor.',
  );
}
