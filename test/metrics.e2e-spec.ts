/**
 * Phase 6 / Plan §12 — observability smoke test.
 *
 *   1. /metrics responds with the Prometheus text format.
 *   2. The HTTP histogram records a sample for an actual matched route
 *      (we hit /health to keep the test independent of business setup —
 *      wait, /health is in the IGNORED set; use a categories request
 *      instead so the metric labels exercise the interceptor).
 */

import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, resetDatabase, resetRedis, type E2EContext } from './e2e-utils';

describe('Metrics endpoint (e2e)', () => {
  let ctx: E2EContext;
  let app: INestApplication;

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

  it('GET /metrics returns Prometheus text exposition', async () => {
    const res = await request(app.getHttpServer()).get('/metrics').expect(200);

    expect(res.headers['content-type']).toContain('text/plain');
    // Default node metrics from prom-client
    expect(res.text).toContain('process_cpu_user_seconds_total');
    expect(res.text).toContain('nodejs_eventloop_lag_seconds');
    // Our custom HELP lines
    expect(res.text).toContain('# HELP http_request_duration_seconds');
    expect(res.text).toContain('# HELP cache_operations_total');
  });

  it('records http_request_duration_seconds with route template + status', async () => {
    await request(app.getHttpServer()).get('/api/v1/categories').expect(200);

    const res = await request(app.getHttpServer()).get('/metrics').expect(200);
    expect(res.text).toMatch(
      /http_request_duration_seconds_count\{[^}]*route="\/api\/v1\/categories"[^}]*status_code="200"[^}]*\}/,
    );
  });

  it('does not record /metrics or /health in the http histogram', async () => {
    await request(app.getHttpServer()).get('/health').expect(200);
    await request(app.getHttpServer()).get('/metrics').expect(200);

    const res = await request(app.getHttpServer()).get('/metrics').expect(200);
    expect(res.text).not.toMatch(/route="\/health"/);
    expect(res.text).not.toMatch(/route="\/metrics"/);
  });

  it('records cache hit / miss / invalidate against product reads and writes', async () => {
    const cat = await request(app.getHttpServer())
      .post('/api/v1/categories')
      .send({ name: 'Footwear' })
      .expect(201);

    const product = await request(app.getHttpServer())
      .post('/api/v1/products')
      .send({
        sku: 'METRIC-1',
        name: 'Tracked',
        categoryId: cat.body.id,
        basePrice: '10.00',
        stockQuantity: 1,
      })
      .expect(201);

    // First GET — miss, populates the cache.
    await request(app.getHttpServer()).get(`/api/v1/products/${product.body.id}`).expect(200);
    // Second GET — hit.
    await request(app.getHttpServer()).get(`/api/v1/products/${product.body.id}`).expect(200);
    // PATCH — triggers invalidate.
    await request(app.getHttpServer())
      .patch(`/api/v1/products/${product.body.id}`)
      .send({ basePrice: '15.00' })
      .expect(200);

    const res = await request(app.getHttpServer()).get('/metrics').expect(200);
    expect(res.text).toMatch(
      /cache_operations_total\{[^}]*operation="miss"[^}]*resource="product"[^}]*\}\s+1/,
    );
    expect(res.text).toMatch(
      /cache_operations_total\{[^}]*operation="hit"[^}]*resource="product"[^}]*\}\s+1/,
    );
    expect(res.text).toMatch(
      /cache_operations_total\{[^}]*operation="invalidate"[^}]*resource="product"[^}]*\}\s+1/,
    );
  });

  it('records promotion creation by scope', async () => {
    const cat = await request(app.getHttpServer())
      .post('/api/v1/categories')
      .send({ name: 'Hats' })
      .expect(201);
    const product = await request(app.getHttpServer())
      .post('/api/v1/products')
      .send({
        sku: 'PROMO-1',
        name: 'Fedora',
        categoryId: cat.body.id,
        basePrice: '20.00',
        stockQuantity: 1,
      })
      .expect(201);

    const now = Date.now();
    await request(app.getHttpServer())
      .post('/api/v1/promotions')
      .send({
        name: 'P scope',
        discountType: 'PERCENTAGE',
        discountValue: '10',
        scope: 'PRODUCT',
        targetProductId: product.body.id,
        startsAt: new Date(now - 60_000).toISOString(),
        endsAt: new Date(now + 60_000).toISOString(),
      })
      .expect(201);

    // Use a second category so the conflict rule doesn't reject the CATEGORY
    // promo (Hats has no scheduled overlap, but we want to keep this test
    // isolated from any prior PRODUCT-scope state in Hats).
    const cat2 = await request(app.getHttpServer())
      .post('/api/v1/categories')
      .send({ name: 'Boots' })
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/v1/promotions')
      .send({
        name: 'C scope',
        discountType: 'FIXED_AMOUNT',
        discountValue: '5',
        scope: 'CATEGORY',
        targetCategoryId: cat2.body.id,
        startsAt: new Date(now - 60_000).toISOString(),
        endsAt: new Date(now + 60_000).toISOString(),
      })
      .expect(202);
    await ctx.jobs.flush();

    const res = await request(app.getHttpServer()).get('/metrics').expect(200);
    expect(res.text).toMatch(/promotions_created_total\{scope="PRODUCT"\}\s+1/);
    expect(res.text).toMatch(/promotions_created_total\{scope="CATEGORY"\}\s+1/);
    expect(res.text).toMatch(/promotion_materialization_seconds_count\{kind="apply"\}\s+1/);
  });
});
