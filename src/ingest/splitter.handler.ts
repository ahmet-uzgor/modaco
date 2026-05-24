import { NestFactory } from '@nestjs/core';
import type { S3Event, S3Handler } from 'aws-lambda';
import type { Readable } from 'node:stream';
import { AppModule } from '../app.module';
import { ENV_TOKEN } from '../config/config.module';
import type { Env } from '../config/env';
import { PrismaService } from '../infra/prisma.service';
import { IngestSplitter } from './splitter.service';

/**
 * AWS Lambda entrypoint for the splitter half of the Scenario A pipeline.
 *
 * Triggered by an `S3:ObjectCreated:*` event on `s3://modaco-ingest/raw/...`.
 *
 *   For each record in the event:
 *     1. Open a streaming S3 GetObject on the new key.
 *     2. INSERT an ingest_batches row keyed by (vendor_id, source_file).
 *        UNIQUE makes the call idempotent against duplicate S3 events.
 *     3. Run IngestSplitter against the stream, with an onChunk callback that
 *        writes the chunk as JSONL to s3://modaco-ingest/chunks/{batch}/{i}.jsonl
 *        and emits an SQS message:
 *           { batch_id, chunk_s3_key, chunk_index }
 *     4. Update ingest_batches.total_rows on completion.
 *
 *   Timeout self-defence (plan §8): if we approach the Lambda's
 *   wall-clock budget, we should commit a byte-offset checkpoint to the
 *   batch row and self-invoke via a continuation SQS message. The shape
 *   for that is sketched below but not implemented in the case study;
 *   small files fit in one invocation.
 *
 * The AWS SDK calls are deliberately stubbed — production deployment
 * would add @aws-sdk/client-s3 + @aws-sdk/client-sqs and replace the
 * TODOs. Keeping them out of the case-study build avoids dragging in
 * a heavy dependency that's not exercised by any test.
 *
 * The Nest application context is cached across warm invocations so the
 * Prisma client and the splitter/processor singletons survive
 * cold-start amortisation.
 */

let cachedContext: Awaited<ReturnType<typeof NestFactory.createApplicationContext>> | null = null;

async function getContext() {
  if (!cachedContext) {
    cachedContext = await NestFactory.createApplicationContext(AppModule, {
      logger: ['error', 'warn', 'log'],
    });
  }
  return cachedContext;
}

export const handler: S3Handler = async (event: S3Event) => {
  const ctx = await getContext();
  const env = ctx.get<Env>(ENV_TOKEN);
  const prisma = ctx.get(PrismaService);
  const splitter = ctx.get(IngestSplitter);

  for (const record of event.Records) {
    const bucket = record.s3.bucket.name;
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));
    // Convention: vendor id is the second path segment under raw/.
    //   raw/{vendor_id}/{filename}.csv
    const [, vendorId, ...rest] = key.split('/');
    const sourceFile = rest.join('/');

    const batch = await prisma.ingestBatch.upsert({
      where: { vendorId_sourceFile: { vendorId: vendorId!, sourceFile } },
      create: { vendorId: vendorId!, sourceFile, status: 'PROCESSING' },
      update: {},
    });

    // TODO(production): replace with `S3Client.send(new GetObjectCommand(...))`
    // and pull `.Body` as a NodeJS.ReadableStream. The stream goes straight
    // into splitter.split, no buffering.
    const stream: Readable = await openS3Stream(bucket, key);

    const result = await splitter.split(stream, env.INGEST_CHUNK_SIZE, async (chunk, index) => {
      const chunkKey = `chunks/${batch.id}/${index}.jsonl`;
      // TODO(production):
      //   await s3.send(new PutObjectCommand({
      //     Bucket: bucket,
      //     Key: chunkKey,
      //     Body: chunk.map((r) => JSON.stringify(r)).join('\n'),
      //     ContentType: 'application/x-ndjson',
      //   }));
      //   await sqs.send(new SendMessageCommand({
      //     QueueUrl: env.INGEST_QUEUE_URL,
      //     MessageBody: JSON.stringify({ batchId: batch.id, chunkKey, chunkIndex: index }),
      //   }));
      void chunkKey;
      void chunk;
    });

    await prisma.ingestBatch.update({
      where: { id: batch.id },
      data: { totalRows: result.totalRows },
    });
  }
};

async function openS3Stream(_bucket: string, _key: string): Promise<Readable> {
  // Replaced by the real S3 GetObject in production. Throwing here makes the
  // Lambda fail loudly if someone deploys this without wiring the SDK.
  throw new Error(
    'openS3Stream is a deployment stub — wire @aws-sdk/client-s3 before deploying the splitter.',
  );
}
