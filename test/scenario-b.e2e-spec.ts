/**
 * Plan §9 / Phase 4 — Scenario B end-to-end.
 *
 *   B1: a category-wide promotion instantly affects thousands of products
 *       without blocking the storefront. We seed 1000 products, POST a
 *       category promotion, await the JobRunner, and verify every product
 *       got the new effective_price and active_promotion_id, plus a row
 *       in product_promotions.
 *
 *   B2: a new product created while a category promotion is live joins
 *       the sale automatically, inside the same transaction as its
 *       insert.
 *
 *   Also: cancelling the category promotion reverts every affected
 *   product back to base_price.
 */

import type { INestApplication } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import request from 'supertest';
import { createTestApp, resetDatabase, resetRedis, type E2EContext } from './e2e-utils';

const ROUTE = {
  category: '/api/v1/categories',
  product: '/api/v1/products',
  promo: '/api/v1/promotions',
} as const;

const PRODUCT_COUNT = 1000;

describe('Scenario B — category materialization + auto-join (e2e)', () => {
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

  afterEach(async () => {
    await ctx.jobs.flush();
  });

  async function seedCategoryAndProducts(count: number): Promise<{
    categoryId: string;
  }> {
    const category = await ctx.prisma.category.create({ data: { name: 'Footwear' } });

    // Bulk seed via Prisma createMany — at 1000 rows this is ~50ms vs
    // ~10s through the HTTP API. We're testing the materialization
    // pathway here, not the create endpoint.
    await ctx.prisma.product.createMany({
      data: Array.from({ length: count }, (_, i) => ({
        sku: `SKU-${i.toString().padStart(5, '0')}`,
        name: `Product ${i}`,
        categoryId: category.id,
        basePrice: new Prisma.Decimal('100.00'),
        stockQuantity: 10,
        effectivePrice: new Prisma.Decimal('100.00'),
      })),
    });

    return { categoryId: category.id };
  }

  it('B1: a category-wide promotion materializes across 1000 products', async () => {
    const { categoryId } = await seedCategoryAndProducts(PRODUCT_COUNT);

    const startsAt = new Date(Date.now() - 60_000).toISOString();
    const endsAt = new Date(Date.now() + 60 * 60_000).toISOString();

    const res = await request(app.getHttpServer())
      .post(ROUTE.promo)
      .send({
        name: 'Site-wide flash sale',
        discountType: 'PERCENTAGE',
        discountValue: '25',
        scope: 'CATEGORY',
        targetCategoryId: categoryId,
        startsAt,
        endsAt,
      })
      .expect(202);

    expect(res.body.scope).toBe('CATEGORY');
    expect(res.body.status).toBe('ACTIVE');
    const promotionId = res.body.id as string;

    // Wait for the async materialization to finish.
    await ctx.jobs.flush();

    // Every product reflects the 25% discount and points at this promo.
    const affected = await ctx.prisma.product.findMany({
      where: { categoryId },
      select: { effectivePrice: true, activePromotionId: true },
    });
    expect(affected).toHaveLength(PRODUCT_COUNT);
    for (const p of affected) {
      expect(p.effectivePrice.toString()).toBe('75');
      expect(p.activePromotionId).toBe(promotionId);
    }

    // The materialized link table also got 1000 rows in a single statement.
    const linkCount = await ctx.prisma.productPromotion.count({ where: { promotionId } });
    expect(linkCount).toBe(PRODUCT_COUNT);
  });

  it('B2: a product created during a live sale picks up the discount on insert', async () => {
    const { categoryId } = await seedCategoryAndProducts(0);

    const startsAt = new Date(Date.now() - 60_000).toISOString();
    const endsAt = new Date(Date.now() + 60 * 60_000).toISOString();

    const promoRes = await request(app.getHttpServer())
      .post(ROUTE.promo)
      .send({
        name: 'Footwear day',
        discountType: 'FIXED_AMOUNT',
        discountValue: '15',
        scope: 'CATEGORY',
        targetCategoryId: categoryId,
        startsAt,
        endsAt,
      })
      .expect(202);
    const promotionId = promoRes.body.id as string;
    await ctx.jobs.flush();

    // Now create a product. It should observe the live category promo
    // inside its create transaction.
    const productRes = await request(app.getHttpServer())
      .post(ROUTE.product)
      .send({
        sku: 'LATE-001',
        name: 'Latecomer',
        categoryId,
        basePrice: '100.00',
        stockQuantity: 5,
      })
      .expect(201);

    expect(productRes.body.effectivePrice).toBe('85.00');
    expect(productRes.body.activePromotionId).toBe(promotionId);

    // Link row exists too, so a later materialize() is idempotent.
    const link = await ctx.prisma.productPromotion.findUnique({
      where: {
        productId_promotionId: { productId: productRes.body.id, promotionId },
      },
    });
    expect(link).not.toBeNull();
  });

  it('cancelling the category promotion reverts effective_price to base for every affected product', async () => {
    const { categoryId } = await seedCategoryAndProducts(50);

    const startsAt = new Date(Date.now() - 60_000).toISOString();
    const endsAt = new Date(Date.now() + 60 * 60_000).toISOString();

    const promoRes = await request(app.getHttpServer())
      .post(ROUTE.promo)
      .send({
        name: 'Half off',
        discountType: 'PERCENTAGE',
        discountValue: '50',
        scope: 'CATEGORY',
        targetCategoryId: categoryId,
        startsAt,
        endsAt,
      })
      .expect(202);
    const promotionId = promoRes.body.id as string;
    await ctx.jobs.flush();

    // Sanity check: discount applied.
    const discounted = await ctx.prisma.product.findFirst({ where: { categoryId } });
    expect(discounted?.effectivePrice.toString()).toBe('50');
    expect(discounted?.activePromotionId).toBe(promotionId);

    await request(app.getHttpServer()).post(`${ROUTE.promo}/${promotionId}/cancel`).expect(200);

    const reverted = await ctx.prisma.product.findMany({
      where: { categoryId },
      select: { effectivePrice: true, activePromotionId: true, basePrice: true },
    });
    for (const p of reverted) {
      expect(p.activePromotionId).toBeNull();
      expect(p.effectivePrice.toString()).toBe(p.basePrice.toString());
    }
  });

  it('rejects a second overlapping category promotion on the same category with 409', async () => {
    const { categoryId } = await seedCategoryAndProducts(0);
    const startsAt = new Date(Date.now() - 60_000).toISOString();
    const endsAt = new Date(Date.now() + 60 * 60_000).toISOString();

    await request(app.getHttpServer())
      .post(ROUTE.promo)
      .send({
        name: 'First',
        discountType: 'PERCENTAGE',
        discountValue: '10',
        scope: 'CATEGORY',
        targetCategoryId: categoryId,
        startsAt,
        endsAt,
      })
      .expect(202);
    await ctx.jobs.flush();

    const res = await request(app.getHttpServer())
      .post(ROUTE.promo)
      .send({
        name: 'Second',
        discountType: 'PERCENTAGE',
        discountValue: '20',
        scope: 'CATEGORY',
        targetCategoryId: categoryId,
        startsAt: new Date(Date.now() + 30 * 60_000).toISOString(),
        endsAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
      })
      .expect(409);

    expect(res.body).toMatchObject({
      error: 'PromotionConflict',
      reason: 'EXISTING_CATEGORY_PROMOTION',
    });
  });
});
