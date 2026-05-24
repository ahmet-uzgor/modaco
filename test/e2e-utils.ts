/**
 * Helpers shared across e2e specs:
 *   - bootstrap a real Nest app against the test DB
 *   - tear it down cleanly
 *   - truncate the data tables between tests so each spec starts from zero
 *
 * The global setup (test/global-setup.ts) has already created the database
 * and run migrations by the time these run.
 */

import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Logger } from 'nestjs-pino';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/infra/prisma.service';
import { RedisService } from '../src/infra/redis.service';

export interface E2EContext {
  app: INestApplication;
  prisma: PrismaService;
  redis: RedisService;
}

export async function createTestApp(): Promise<E2EContext> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication({ bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.setGlobalPrefix('api/v1', { exclude: ['health', 'ready'] });
  // Validation is per-route via ZodValidationPipe; no global pipe needed.
  await app.init();
  return {
    app,
    prisma: app.get(PrismaService),
    redis: app.get(RedisService),
  };
}

const TRUNCATE_TABLES = [
  '"product_promotions"',
  '"promotions"',
  '"products"',
  '"categories"',
  '"ingest_row_results"',
  '"ingest_batches"',
];

export async function resetDatabase(prisma: PrismaService): Promise<void> {
  // Single TRUNCATE handles all FK ordering and resets identity. The
  // products/promotions FK cycle means we list them together.
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${TRUNCATE_TABLES.join(', ')} RESTART IDENTITY CASCADE`,
  );
}

export async function resetRedis(redis: RedisService): Promise<void> {
  await redis.getClient().flushdb();
}
