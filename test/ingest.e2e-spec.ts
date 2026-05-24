/**
 * Plan §8 / Phase 5 — Scenario A ingest pipeline e2e.
 *
 *   * Happy path: a small CSV streams through splitter→processor and
 *     ends up as products with the pricing rules applied.
 *   * Partial failure: rows that fail validation are recorded in
 *     ingest_row_results with status=FAILED while the rest of the chunk
 *     still lands.
 *   * Idempotency: re-POSTing the same (vendorId, sourceFile) returns
 *     the existing batch, doesn't double-write products, and doesn't
 *     duplicate row_results.
 *
 * INGEST_DIR is repointed at a tmpdir per spec so the test writes its
 * CSV fixtures somewhere harmless and predictable.
 */

import type { INestApplication } from '@nestjs/common';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import request from 'supertest';
import { createTestApp, resetDatabase, resetRedis, type E2EContext } from './e2e-utils';

const ROUTE = {
  ingest: '/api/v1/ingest/batches',
} as const;

describe('Ingest pipeline (e2e)', () => {
  let ctx: E2EContext;
  let app: INestApplication;
  let ingestDir: string;

  beforeAll(() => {
    // Set BEFORE createTestApp so env.ts picks it up when the Nest module is
    // built. Jest globalSetup already pointed DATABASE_URL at the test DB.
    ingestDir = mkdtempSync(path.join(tmpdir(), 'modaco-ingest-test-'));
    process.env.INGEST_DIR = ingestDir;
    process.env.INGEST_CHUNK_SIZE = '3'; // exercise chunking with small files
  });

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
  });

  afterAll(async () => {
    await ctx.jobs.flush();
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    await resetRedis(ctx.redis);
  });

  afterEach(async () => {
    await ctx.jobs.flush();
  });

  function writeCsv(filename: string, lines: readonly string[]): string {
    const fullPath = path.join(ingestDir, filename);
    writeFileSync(fullPath, lines.join('\n'));
    return filename;
  }

  async function waitForCompletion(batchId: string): Promise<unknown> {
    await ctx.jobs.flush();
    const res = await request(app.getHttpServer())
      .get(`${ROUTE.ingest}/${batchId}`)
      .expect(200);
    return res.body;
  }

  it('happy path: streams CSV → products with pricing rules applied', async () => {
    const sourceFile = writeCsv('happy.csv', [
      'sku,name,category_name,base_price,vendor_cost,stock_quantity',
      'SKU-1,Item One,Widgets,10.50,10.00,5',
      'SKU-2,Item Two,Widgets,25.00,,3',
      'SKU-3,Item Three,Gadgets,99.995,,7',
      'SKU-4,Item Four,Gadgets,5.00,8.00,2',
    ]);

    const post = await request(app.getHttpServer())
      .post(ROUTE.ingest)
      .send({ vendorId: 'acme', sourceFile })
      .expect(202);

    expect(post.body).toMatchObject({
      vendorId: 'acme',
      sourceFile,
      status: 'PROCESSING',
    });

    const finished = await waitForCompletion(post.body.id);
    expect(finished).toMatchObject({
      status: 'COMPLETED',
      totalRows: 4,
      processedRows: 4,
      failedRows: 0,
    });

    const products = await ctx.prisma.product.findMany({ orderBy: { sku: 'asc' } });
    expect(products).toHaveLength(4);

    // Pricing rules: margin floor at 10% above vendor_cost.
    const sku1 = products.find((p) => p.sku === 'SKU-1')!;
    expect(sku1.basePrice.toString()).toBe('11'); // floor lifted 10.50 → 11.00
    expect(sku1.effectivePrice.toString()).toBe('11');

    const sku2 = products.find((p) => p.sku === 'SKU-2')!;
    expect(sku2.basePrice.toString()).toBe('25'); // no cost → unchanged
    expect(sku2.effectivePrice.toString()).toBe('25');

    const sku3 = products.find((p) => p.sku === 'SKU-3')!;
    expect(sku3.basePrice.toString()).toBe('100'); // 99.995 rounds HALF_UP to 100

    const sku4 = products.find((p) => p.sku === 'SKU-4')!;
    expect(sku4.basePrice.toString()).toBe('8.8'); // floor lifted 5 → 8.80

    // All four rows recorded as OK in ingest_row_results.
    const rowResults = await ctx.prisma.ingestRowResult.findMany({
      where: { batchId: post.body.id },
      orderBy: { rowKey: 'asc' },
    });
    expect(rowResults.map((r) => r.status)).toEqual(['OK', 'OK', 'OK', 'OK']);
  });

  it('partial failure: bad rows recorded as FAILED, valid rows still land', async () => {
    const sourceFile = writeCsv('partial.csv', [
      'sku,name,category_name,base_price,stock_quantity',
      'GOOD-1,Valid,Things,10.00,5',
      ',Missing SKU,Things,5.00,1', // FAIL: empty sku
      'GOOD-2,Also valid,Things,20.00,2',
      'BAD-1,Bad price,Things,not-a-number,1', // FAIL: bad price
    ]);

    const post = await request(app.getHttpServer())
      .post(ROUTE.ingest)
      .send({ vendorId: 'acme', sourceFile })
      .expect(202);

    const finished = (await waitForCompletion(post.body.id)) as {
      status: string;
      processedRows: number;
      failedRows: number;
      totalRows: number;
    };
    expect(finished.status).toBe('COMPLETED');
    expect(finished.processedRows).toBe(2);
    expect(finished.failedRows).toBe(2);
    expect(finished.totalRows).toBe(4);

    const products = await ctx.prisma.product.findMany({ orderBy: { sku: 'asc' } });
    expect(products.map((p) => p.sku)).toEqual(['GOOD-1', 'GOOD-2']);

    const failed = await ctx.prisma.ingestRowResult.count({
      where: { batchId: post.body.id, status: 'FAILED' },
    });
    expect(failed).toBe(2);
  });

  it('idempotent: re-POSTing the same (vendorId, sourceFile) returns the existing batch', async () => {
    const sourceFile = writeCsv('idem.csv', [
      'sku,name,category_name,base_price,stock_quantity',
      'IDEM-1,Same,Things,9.00,1',
      'IDEM-2,Same,Things,10.00,2',
    ]);

    const first = await request(app.getHttpServer())
      .post(ROUTE.ingest)
      .send({ vendorId: 'acme', sourceFile })
      .expect(202);

    await waitForCompletion(first.body.id);

    // Second POST: same key, returns the existing batch row.
    const second = await request(app.getHttpServer())
      .post(ROUTE.ingest)
      .send({ vendorId: 'acme', sourceFile })
      .expect(202);

    expect(second.body.id).toBe(first.body.id);

    // Drain any (no-op) jobs the second POST might have queued.
    await ctx.jobs.flush();

    const productCount = await ctx.prisma.product.count();
    expect(productCount).toBe(2);

    const batchCount = await ctx.prisma.ingestBatch.count();
    expect(batchCount).toBe(1);

    const rowResultCount = await ctx.prisma.ingestRowResult.count({
      where: { batchId: first.body.id },
    });
    expect(rowResultCount).toBe(2);
  });

  it('rejects sourceFile with path components (no traversal)', async () => {
    await request(app.getHttpServer())
      .post(ROUTE.ingest)
      .send({ vendorId: 'acme', sourceFile: '../etc/passwd.csv' })
      .expect(400);
  });
});
