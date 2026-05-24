/**
 * Plan §11 / Phase 3 — promotion conflict rule.
 *
 * Verifies that creating a second promotion whose time window overlaps an
 * already-live one on the same product is rejected with HTTP 409, and that
 * after cancelling the first, the second can be created cleanly.
 */

import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, resetDatabase, resetRedis, type E2EContext } from './e2e-utils';

const ROUTE = {
  category: '/api/v1/categories',
  product: '/api/v1/products',
  promo: '/api/v1/promotions',
} as const;

describe('Promotion conflict rule (e2e)', () => {
  let ctx: E2EContext;
  let app: INestApplication;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
  });

  afterAll(async () => {
    // app.close() triggers onModuleDestroy on PrismaService and RedisService,
    // which in turn disconnect both clients. Doing it manually too leads to
    // double-quit warnings from ioredis.
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    await resetRedis(ctx.redis);
  });

  async function seedCategoryAndProduct(): Promise<{ categoryId: string; productId: string }> {
    const categoryRes = await request(app.getHttpServer())
      .post(ROUTE.category)
      .send({ name: 'Footwear' })
      .expect(201);
    const categoryId = categoryRes.body.id as string;

    const productRes = await request(app.getHttpServer())
      .post(ROUTE.product)
      .send({
        sku: 'SNK-001',
        name: 'Runner',
        categoryId,
        basePrice: '100.00',
        stockQuantity: 10,
      })
      .expect(201);

    return { categoryId, productId: productRes.body.id as string };
  }

  it('rejects a second active promotion on the same product with 409', async () => {
    const { productId } = await seedCategoryAndProduct();
    const startsAt = new Date(Date.now() - 60_000).toISOString(); // already live
    const endsAt = new Date(Date.now() + 60 * 60_000).toISOString();

    const first = await request(app.getHttpServer())
      .post(ROUTE.promo)
      .send({
        name: '25% off launch',
        discountType: 'PERCENTAGE',
        discountValue: '25',
        scope: 'PRODUCT',
        targetProductId: productId,
        startsAt,
        endsAt,
      })
      .expect(201);

    expect(first.body.status).toBe('ACTIVE');

    // Read-side: product's effective_price now reflects the 25% discount.
    const product = await request(app.getHttpServer())
      .get(`${ROUTE.product}/${productId}`)
      .expect(200);
    expect(product.body.effectivePrice).toBe('75.00');
    expect(product.body.activePromotionId).toBe(first.body.id);

    // Overlapping second promo → 409.
    const second = await request(app.getHttpServer())
      .post(ROUTE.promo)
      .send({
        name: '10 off',
        discountType: 'FIXED_AMOUNT',
        discountValue: '10',
        scope: 'PRODUCT',
        targetProductId: productId,
        startsAt: new Date(Date.now() + 30 * 60_000).toISOString(), // mid-window
        endsAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
      })
      .expect(409);

    // Nest serializes a payload object passed to ConflictException as the
    // top-level body, with `statusCode` and (synthesized) `message` merged in.
    expect(second.body).toMatchObject({
      error: 'PromotionConflict',
      reason: 'EXISTING_PRODUCT_PROMOTION',
      conflictingPromotionId: first.body.id,
    });
  });

  it('allows the second promotion once the first is cancelled', async () => {
    const { productId } = await seedCategoryAndProduct();
    const startsAt = new Date(Date.now() - 60_000).toISOString();
    const endsAt = new Date(Date.now() + 60 * 60_000).toISOString();

    const first = await request(app.getHttpServer())
      .post(ROUTE.promo)
      .send({
        name: 'First',
        discountType: 'PERCENTAGE',
        discountValue: '25',
        scope: 'PRODUCT',
        targetProductId: productId,
        startsAt,
        endsAt,
      })
      .expect(201);

    await request(app.getHttpServer())
      .post(`${ROUTE.promo}/${first.body.id}/cancel`)
      .expect(200);

    // After cancellation, effective_price returns to the base price and the
    // product no longer holds an active promotion id.
    const product = await request(app.getHttpServer())
      .get(`${ROUTE.product}/${productId}`)
      .expect(200);
    expect(product.body.effectivePrice).toBe('100.00');
    expect(product.body.activePromotionId).toBeNull();

    const second = await request(app.getHttpServer())
      .post(ROUTE.promo)
      .send({
        name: 'Second',
        discountType: 'FIXED_AMOUNT',
        discountValue: '10',
        scope: 'PRODUCT',
        targetProductId: productId,
        startsAt: new Date(Date.now() - 30_000).toISOString(),
        endsAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
      })
      .expect(201);

    expect(second.body.status).toBe('ACTIVE');
  });

  it('rejects two concurrent creations against the same product', async () => {
    // The row-level lock should serialize them: one wins, the other gets 409.
    const { productId } = await seedCategoryAndProduct();
    const startsAt = new Date(Date.now() - 60_000).toISOString();
    const endsAt = new Date(Date.now() + 60 * 60_000).toISOString();

    const payload = (name: string): Record<string, unknown> => ({
      name,
      discountType: 'PERCENTAGE',
      discountValue: '10',
      scope: 'PRODUCT',
      targetProductId: productId,
      startsAt,
      endsAt,
    });

    const [a, b] = await Promise.all([
      request(app.getHttpServer()).post(ROUTE.promo).send(payload('A')),
      request(app.getHttpServer()).post(ROUTE.promo).send(payload('B')),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);
  });

  it('rejects CATEGORY-scope creation in Phase 3 (501)', async () => {
    const cat = await request(app.getHttpServer())
      .post(ROUTE.category)
      .send({ name: 'Phase3' })
      .expect(201);

    await request(app.getHttpServer())
      .post(ROUTE.promo)
      .send({
        name: 'Site-wide',
        discountType: 'PERCENTAGE',
        discountValue: '10',
        scope: 'CATEGORY',
        targetCategoryId: cat.body.id,
        startsAt: new Date(Date.now() - 60_000).toISOString(),
        endsAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      })
      .expect(501);
  });
});
